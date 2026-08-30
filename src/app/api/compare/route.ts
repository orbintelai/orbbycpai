/**
 * POST /api/compare
 *
 * Auth-required endpoint for competitor brand comparison.
 * Accepts { primaryUrl: string, competitorUrls: string[], forceRefresh?: boolean }
 *
 * Freshness policy:
 *   - Primary URL: always analyzed fresh (no cache)
 *   - Competitor URLs: reuse generations record if < 7 days old, unless forceRefresh=true
 *
 * Single source of truth: all perception data comes from the generations table.
 * The brands table is used only for structural brand data (archetype, tone, etc.),
 * never for aiPerception. See TECH_DEBT.md for long-term brands table decision.
 *
 * Response: { comparison: ComparisonResult }
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { analysisEvidence, competitorComparisons, domainLineageAliases, generations } from "@/db/schema";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractDom } from "@/lib/pipeline/runPipeline";
import { classifyBrand, type BrandProfile } from "@/lib/pipeline/classifyBrand";
import { fetchAiPerception } from "@/lib/pipeline/fetchAiPerception";
import { runCompanyIntelligence } from "@/lib/intelligence/runCompanyIntelligence";
import { buildSnapshotLineage } from "@/lib/intelligence/lineage";
import { AccountLimitError, PlatformCapacityError, completeFullProfileUnit, releaseFullProfileUnit, reserveFullProfileUnit } from "@/lib/usage/circuitBreaker";
import type { CompetitivePosition } from "@/lib/competitiveStrategist";

export const runtime = "nodejs";
export const maxDuration = 300;

// Competitors: reuse a generations record if it's younger than this
const COMPETITOR_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function fileToDataUri(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.length < 1000) return null;
    const ext = path.extname(filePath).toLowerCase().replace(".", "");
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    };
    const mime = mimeMap[ext] || "image/jpeg";
    if (buf.length > 512 * 1024) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function normalizeDomain(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeUrl(url: string): string {
  return url.startsWith("http") ? url : `https://${url}`;
}

// ─── WAF / bot-block detection ───────────────────────────────────────────────

/**
 * Thrown when the scraped page is a WAF challenge or bot-block page,
 * not the actual site. Callers should skip this URL gracefully.
 */
class SiteBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`Site blocked automated access (${reason}): ${url}`);
    this.name = "SiteBlockedError";
  }
}

// Title / H1 patterns that indicate a WAF or bot-block page
const BLOCK_TITLE_PATTERNS = [
  /vercel security checkpoint/i,
  /access denied/i,
  /just a moment/i,          // Cloudflare interstitial
  /please wait/i,
  /checking your browser/i,
  /verifying you are human/i, // Cloudflare Turnstile
  /attention required/i,      // Cloudflare block
  /sorry, you have been blocked/i,
  /bot detected/i,            // PerimeterX / HUMAN
  /are you a human/i,
  /security check/i,
  /ddos protection/i,
  /ray id/i,                  // Cloudflare Ray ID page
];

// Body text patterns — used in combination with short body length
const BLOCK_BODY_PATTERNS = [
  /hcaptcha/i,
  /recaptcha/i,
  /cf-ray/i,
  /cf-mitigated/i,
  /cloudflare/i,
  /perimeterx/i,
  /px-captcha/i,
  /human\.security/i,
  /please enable javascript/i,
  /enable cookies/i,
];

const BLOCK_BODY_MAX_CHARS = 300; // short body + block pattern = blocked

function detectBlockPage(
  title: string,
  h1s: string[],
  bodyText: string,
  url: string
): void {
  const titleAndH1 = [title, ...h1s].join(" ").toLowerCase();
  const body = bodyText.toLowerCase();

  // Title/H1 match alone is sufficient
  for (const pattern of BLOCK_TITLE_PATTERNS) {
    if (pattern.test(titleAndH1)) {
      throw new SiteBlockedError(url, `title/h1 matched: ${pattern.source}`);
    }
  }

  // Short body + body pattern match = blocked
  if (body.length < BLOCK_BODY_MAX_CHARS) {
    for (const pattern of BLOCK_BODY_PATTERNS) {
      if (pattern.test(body)) {
        throw new SiteBlockedError(url, `short body (${body.length} chars) + body pattern: ${pattern.source}`);
      }
    }
  }
}

/**
 * Run a full fresh extraction + perception for a URL.
 * Passes scraped website context to fetchAiPerception so models
 * identify the correct company from content, not training data alone.
 * Throws SiteBlockedError if the scraped page is a WAF challenge.
 */
type ProfileResolution = {
  profile: BrandProfile;
  generationId: string;
  cacheHit: boolean;
};

type ComparisonSseEvent =
  | "primary_started"
  | "profile_cached"
  | "profile_started"
  | "profile_completed"
  | "profile_restricted"
  | "factual_complete"
  | "error";

type ComparisonEvent = {
  type: ComparisonSseEvent;
  [key: string]: unknown;
};

function ssePayload(event: ComparisonEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function normalizedUrlVariants(url: string): string[] {
  const normalized = normalizeUrl(url);
  try {
    const parsed = new URL(normalized);
    const bareHost = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return Array.from(new Set([
      normalized,
      `https://${bareHost}${path}`,
      `https://${bareHost}${path}/`,
      `https://www.${bareHost}${path}`,
      `https://www.${bareHost}${path}/`,
    ]));
  } catch {
    return [normalized];
  }
}

/**
 * Run a fresh profile. The reservation happens only in this function, after a
 * competitor has missed the cache. A reused competitor therefore consumes no
 * reservation or completion unit.
 */
async function extractFreshProfile(input: { url: string; userId: string; email: string; countTowardAccountLimit: boolean }): Promise<ProfileResolution> {
  const normalizedUrl = normalizeUrl(input.url);
  const reservation = await reserveFullProfileUnit({ userId: input.userId, email: input.email, countTowardAccountLimit: input.countTowardAccountLimit });
  const workDir = path.join(os.tmpdir(), `orb-compare-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const startedAt = new Date();
  let completed = false;
  try {
    const raw = await extractDom(normalizedUrl, workDir, () => {});
    const rawTyped = raw as Record<string, unknown>;
    const lineage = buildSnapshotLineage({
      submittedUrl: normalizedUrl,
      resolvedUrl: rawTyped.resolvedUrl || rawTyped.url,
      declaredCanonicalUrl: rawTyped.canonicalUrl,
      redirectChain: rawTyped.redirectChain,
    });
    const pageTitle = (rawTyped.title as string | undefined) ?? "";
    const copyText0 = rawTyped.copyText as { h1?: string[] } | undefined;
    detectBlockPage(pageTitle, copyText0?.h1 ?? [], (rawTyped.bodySnippet as string | undefined) ?? "", normalizedUrl);

    const downloadedAssets = (rawTyped.downloadedAssets as Array<{ src: string; localPath: string; localUrl: string; alt: string; width: number; height: number; ext: string; isGif: boolean; inHero: boolean }>) ?? [];
    rawTyped.downloadedAssets = downloadedAssets.map((asset) => ({ ...asset, localUrl: fileToDataUri(asset.localPath) || asset.src })).filter((asset) => asset.localUrl);
    const profile = await classifyBrand(rawTyped);
    const copyText = rawTyped.copyText as { h1?: string[]; h2?: string[]; bodyParagraphs?: string[] } | undefined;
    const bodySnippet = (rawTyped.bodySnippet as string | undefined) ?? "";
    const scrapedContext = [copyText?.h1?.join(" | "), copyText?.h2?.slice(0, 4).join(" | "), copyText?.bodyParagraphs?.slice(0, 3).join(" "), bodySnippet.slice(0, 800)].filter(Boolean).join("\n").slice(0, 2000);
    const brandName = profile.meta?.brandName || normalizeDomain(normalizedUrl);
    const [perception, intelligence] = await Promise.all([
      fetchAiPerception(brandName, normalizedUrl, scrapedContext || undefined),
      runCompanyIntelligence(normalizedUrl),
    ]);
    profile.aiPerception = perception;
    profile.companyIntelligence = intelligence.intelligence;

    const domain = lineage.registrableDomain || normalizeDomain(normalizedUrl);
    const completedAt = new Date();
    let generation: { id: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = await db.select({ id: generations.id, snapshotVersion: generations.snapshotVersion })
        .from(generations)
        .where(and(
          lineage.registrableDomain ? eq(generations.registrableDomain, lineage.registrableDomain) : eq(generations.domain, domain),
          isNotNull(generations.snapshotVersion),
          eq(generations.status, "complete"),
        ))
        .orderBy(desc(generations.snapshotVersion), desc(generations.completedAt)).limit(1);
      try {
        const inserted = await db.insert(generations).values({
          userId: input.userId,
          brandUrl: normalizedUrl,
          domain,
          submittedUrl: lineage.submittedUrl,
          resolvedUrl: lineage.resolvedUrl,
          declaredCanonicalUrl: lineage.declaredCanonicalUrl,
          registrableDomain: lineage.registrableDomain,
          redirectChain: lineage.redirectChain,
          lineageStatus: lineage.lineageStatus,
          brandProfile: profile as unknown as Record<string, unknown>,
          status: "complete",
          runOrigin: "comparison",
          snapshotVersion: (previous[0]?.snapshotVersion || 0) + 1,
          previousGenerationId: previous[0]?.id || null,
          accessTier: "full",
          moduleStatuses: intelligence.moduleStatuses,
          startedAt,
          completedAt,
          runtimeMs: completedAt.valueOf() - startedAt.valueOf(),
        }).returning({ id: generations.id });
        generation = inserted[0];
        break;
      } catch (error) {
        const collision = String(error).includes("generations_domain_snapshot_version_unique");
        if (!collision || attempt === 2) throw error;
      }
    }
    if (!generation) throw new Error("Unable to allocate an immutable snapshot version.");
    if (lineage.lineageStatus === "cross_domain_redirect_pending" && lineage.submittedRegistrableDomain && lineage.registrableDomain) {
      await db.insert(domainLineageAliases).values({
        aliasRegistrableDomain: lineage.submittedRegistrableDomain,
        canonicalRegistrableDomain: lineage.registrableDomain,
        status: "pending",
        firstGenerationId: generation.id,
      }).onConflictDoNothing();
    }
    if (intelligence.evidence.length) await db.insert(analysisEvidence).values(intelligence.evidence.map((item) => ({ ...item, generationId: generation.id })));
    try {
      await completeFullProfileUnit({ userId: input.userId, email: input.email, pool: reservation.pool, accountCounted: reservation.accountCounted });
    } catch (error) {
      console.error("[compare] capacity finalization failed", error);
    }
    completed = true;
    return { profile, generationId: generation.id, cacheHit: false };
  } finally {
    if (!completed) {
      try { await releaseFullProfileUnit({ userId: input.userId, email: input.email, pool: reservation.pool, accountCounted: reservation.accountCounted }); } catch (error) { console.error("[compare] capacity release failed", error); }
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Resolve a reusable competitor before any capacity reservation. A pending
 * cross-domain redirect is never matched through a different registrable
 * domain; matching by submitted URL is permitted for that exact prior input.
 */
async function getCompetitorProfile(url: string, forceRefresh: boolean, userId: string, email: string): Promise<ProfileResolution> {
  const normalized = normalizeUrl(url);
  const submittedLineage = buildSnapshotLineage({ submittedUrl: normalized });
  if (!forceRefresh) {
    const variants = normalizedUrlVariants(normalized);
    const cacheIdentity = submittedLineage.registrableDomain
      ? or(eq(generations.registrableDomain, submittedLineage.registrableDomain), eq(generations.brandUrl, normalized), eq(generations.submittedUrl, normalized))
      : or(...variants.map((variant) => eq(generations.brandUrl, variant)));
    const recent = await db.select()
      .from(generations)
      .where(and(cacheIdentity, eq(generations.status, "complete")))
      .orderBy(desc(generations.completedAt), desc(generations.createdAt))
      .limit(1);
    const cached = recent[0];
    if (cached?.brandProfile) {
      const ageMs = Date.now() - new Date(cached.completedAt || cached.createdAt).getTime();
      if (ageMs < COMPETITOR_CACHE_MAX_AGE_MS) {
        console.log(`[compare] Using cached generation ${cached.id} for ${normalized} (age: ${Math.round(ageMs / 3600000)}h)`);
        return { profile: cached.brandProfile as unknown as BrandProfile, generationId: cached.id, cacheHit: true };
      }
    }
  }
  console.log(`[compare] Running fresh extraction for competitor: ${normalized}`);
  return extractFreshProfile({ url: normalized, userId, email, countTowardAccountLimit: false });
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  return results;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = (session?.user as { email?: string } | undefined)?.email?.toLowerCase() || "";
  if (!userId || !email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { primaryUrl?: string; competitorUrls?: string[]; forceRefresh?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { primaryUrl, competitorUrls = [], forceRefresh = false } = body;
  if (!primaryUrl) return NextResponse.json({ error: "primaryUrl is required" }, { status: 400 });
  if (competitorUrls.length > 3) return NextResponse.json({ error: "Maximum 3 competitor URLs allowed" }, { status: 400 });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ComparisonEvent) => controller.enqueue(ssePayload(event));
      void (async () => {
        try {
          emit({ type: "primary_started", url: normalizeUrl(primaryUrl) });
          const primary = await extractFreshProfile({ url: normalizeUrl(primaryUrl), userId, email, countTowardAccountLimit: true });
          const blockedUrls: Record<string, string> = {};
          const competitors = await mapWithConcurrency(competitorUrls, 2, async (url) => {
            try {
              const resolved = await getCompetitorProfile(url, forceRefresh, userId, email);
              emit({ type: resolved.cacheHit ? "profile_cached" : "profile_completed", url: normalizeUrl(url), generationId: resolved.generationId });
              return resolved;
            } catch (error) {
              if (error instanceof SiteBlockedError) {
                const domain = normalizeDomain(url);
                blockedUrls[domain] = url;
                emit({ type: "profile_restricted", url, reason: "This site blocks automated analysis." });
                return null;
              }
              throw error;
            }
          });
          const accessible = competitors.filter((item): item is ProfileResolution => item !== null);
          const comparisonInserted = await db.insert(competitorComparisons).values({
            userId,
            primaryBrandDomain: normalizeDomain(primary.profile.meta?.url || primaryUrl),
            competitorDomains: accessible.map((item) => normalizeDomain(item.profile.meta?.url || "")),
            primaryProfile: primary.profile as unknown as Record<string, unknown>,
            competitorProfiles: accessible.map((item) => item.profile) as unknown as Record<string, unknown>,
            uspStatements: {},
            primaryGenerationId: primary.generationId,
            competitorGenerationIds: accessible.map((item) => item.generationId),
          }).returning({ id: competitorComparisons.id });
          const comparisonId = comparisonInserted[0]?.id;
          if (!comparisonId) throw new Error("Unable to persist comparison membership.");
          emit({
            type: "factual_complete",
            comparisonId,
            primaryGenerationId: primary.generationId,
            primary: primary.profile,
            competitors: accessible.map((item) => item.profile),
            competitorGenerationIds: accessible.map((item) => item.generationId),
            blockedUrls,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[compare] Error:", message);
          const code = error instanceof AccountLimitError ? "monthly_report_limit_reached" : error instanceof PlatformCapacityError ? "beta_capacity_paused" : "comparison_failed";
          emit({ type: "error", error: message, code });
        } finally {
          controller.close();
        }
      })();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
