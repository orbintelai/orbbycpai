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
import { analysisEvidence, domainLineageAliases, generations } from "@/db/schema";
import { and, eq, desc, isNotNull } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import OpenAI from "openai";
import { extractDom } from "@/lib/pipeline/runPipeline";
import { classifyBrand, type BrandProfile } from "@/lib/pipeline/classifyBrand";
import { fetchAiPerception } from "@/lib/pipeline/fetchAiPerception";
import { runCompanyIntelligence } from "@/lib/intelligence/runCompanyIntelligence";
import { buildSnapshotLineage } from "@/lib/intelligence/lineage";
import { AccountLimitError, PlatformCapacityError, completeFullProfileUnit, releaseFullProfileUnit, reserveFullProfileUnit } from "@/lib/usage/circuitBreaker";

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
async function extractFreshProfile(input: { url: string; userId: string; email: string; countTowardAccountLimit: boolean }): Promise<BrandProfile> {
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
    // The immutable ledger's unique key is global per domain. Re-read and retry
    // only when a concurrent report claims the same next snapshot version first.
    const completedAt = new Date();
    let generation: { id: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = await db.select({ id: generations.id, snapshotVersion: generations.snapshotVersion })
        .from(generations)
        .where(and(
          lineage.registrableDomain
            ? eq(generations.registrableDomain, lineage.registrableDomain)
            : eq(generations.domain, domain),
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
    if (
      lineage.lineageStatus === "cross_domain_redirect_pending" &&
      lineage.submittedRegistrableDomain &&
      lineage.registrableDomain
    ) {
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
      // Snapshot is saved, so retain the consumed unit rather than undercounting.
      console.error("[compare] capacity finalization failed", error);
    }
    completed = true;
    return profile;
  } finally {
    if (!completed) {
      try { await releaseFullProfileUnit({ userId: input.userId, email: input.email, pool: reservation.pool, accountCounted: reservation.accountCounted }); } catch (error) { console.error("[compare] capacity release failed", error); }
    }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * For competitors: check the generations table for a recent record.
 * Falls back to a fresh extraction if none found or record is stale.
 */
async function getCompetitorProfile(url: string, forceRefresh: boolean, userId: string, email: string): Promise<BrandProfile> {
  const normalized = normalizeUrl(url);

  if (!forceRefresh) {
    // Look for a recent complete generations record for this URL
    const recent = await db
      .select()
      .from(generations)
      .where(eq(generations.brandUrl, normalized))
      .orderBy(desc(generations.createdAt))
      .limit(1);

    if (recent.length > 0 && recent[0].status === "complete" && recent[0].brandProfile) {
      const ageMs = Date.now() - new Date(recent[0].createdAt).getTime();
      if (ageMs < COMPETITOR_CACHE_MAX_AGE_MS) {
        console.log(`[compare] Using cached generations record for ${normalized} (age: ${Math.round(ageMs / 3600000)}h)`);
        return recent[0].brandProfile as unknown as BrandProfile;
      }
    }
  }

  console.log(`[compare] Running fresh extraction for competitor: ${normalized}`);
  return extractFreshProfile({ url: normalized, userId, email, countTowardAccountLimit: false });
}

// ─── Competitive Position prompt ─────────────────────────────────────────────

interface CompetitivePosition {
  categoryPosition: string;
  positioningOverlap: string;
  positioningGap: string;
  narrativeTension: string;
  recommendedMove: string;
}

async function generateCompetitivePosition(
  primaryProfile: BrandProfile,
  competitorProfile: BrandProfile
): Promise<CompetitivePosition> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY,
    baseURL: "https://api.openai.com/v1",
  });

  const primaryName = primaryProfile.meta?.brandName || "Primary Brand";
  const competitorName = competitorProfile.meta?.brandName || "Competitor";

  // Pull positioningDelta and categoryAnchor from all three models for each company
  const primaryPerception = primaryProfile.aiPerception;
  const competitorPerception = competitorProfile.aiPerception;

  const primaryPerceptionBlock = primaryPerception ? `
${primaryName} — AI Perception (across 3 models):
- ChatGPT positioning delta: ${primaryPerception.openai?.positioningDelta || "unavailable"}
- ChatGPT category anchor: ${primaryPerception.openai?.categoryAnchor || "unavailable"}
- Claude positioning delta: ${primaryPerception.anthropic?.positioningDelta || "unavailable"}
- Claude category anchor: ${primaryPerception.anthropic?.categoryAnchor || "unavailable"}
- Gemini positioning delta: ${primaryPerception.google?.positioningDelta || "unavailable"}
- Gemini category anchor: ${primaryPerception.google?.categoryAnchor || "unavailable"}` : "";

  const competitorPerceptionBlock = competitorPerception ? `
${competitorName} — AI Perception (across 3 models):
- ChatGPT positioning delta: ${competitorPerception.openai?.positioningDelta || "unavailable"}
- ChatGPT category anchor: ${competitorPerception.openai?.categoryAnchor || "unavailable"}
- Claude positioning delta: ${competitorPerception.anthropic?.positioningDelta || "unavailable"}
- Claude category anchor: ${competitorPerception.anthropic?.categoryAnchor || "unavailable"}
- Gemini positioning delta: ${competitorPerception.google?.positioningDelta || "unavailable"}
- Gemini category anchor: ${competitorPerception.google?.categoryAnchor || "unavailable"}` : "";

  const prompt = `You are a neutral brand strategist. Analyze the competitive positioning between ${primaryName} and ${competitorName} based on the data below. Do not describe what either company does — analyze the strategic relationship between their positions. Where the three AI models agree on positioning, treat it as signal. Where they diverge, name the divergence.

${primaryName} — Structural data:
- Positioning signal: ${primaryProfile.positioningSignal || primaryProfile.productIntelligence?.oneLiner || ""}
- Category: ${(primaryProfile.productIntelligence?.productCategory || []).join(", ")}
- Archetype: ${primaryProfile.brandArchetype?.archetype || ""}
- Target customers: ${primaryProfile.productIntelligence?.targetCustomers || ""}
${primaryPerceptionBlock}

${competitorName} — Structural data:
- Positioning signal: ${competitorProfile.positioningSignal || competitorProfile.productIntelligence?.oneLiner || ""}
- Category: ${(competitorProfile.productIntelligence?.productCategory || []).join(", ")}
- Archetype: ${competitorProfile.brandArchetype?.archetype || ""}
- Target customers: ${competitorProfile.productIntelligence?.targetCustomers || ""}
${competitorPerceptionBlock}

Return ONLY this JSON object — no markdown, no explanation, no code fences:

{
  "categoryPosition": "1-2 sentences. Where does each company sit in the category mental map? Category-defining, challenger, alternative, adjacent, or specialist? Be specific about both. Use the AI model consensus where available.",
  "positioningOverlap": "1-2 sentences. Where do the two companies compete on the same claims? Name the specific territory both are fighting for. If the AI models show divergence on where each company sits, note it.",
  "positioningGap": "2-3 sentences. Where does each company claim territory the other doesn't? Name the specific gaps — these are either defensive moats or attack vectors.",
  "narrativeTension": "1-2 sentences. Where does one company's positioning create pressure on the other's? What is the strategic implication of that tension?",
  "recommendedMove": "1-2 sentences. One specific, actionable recommendation for ${primaryName} based on this analysis. Not generic advice — name the specific gap or tension to exploit."
}`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 800,
      temperature: 0.4,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : text;
    return JSON.parse(jsonStr) as CompetitivePosition;
  } catch (err) {
    console.error("[compare] competitivePosition generation failed:", (err as Error).message);
    return {
      categoryPosition: "Analysis unavailable.",
      positioningOverlap: "Analysis unavailable.",
      positioningGap: "Analysis unavailable.",
      narrativeTension: "Analysis unavailable.",
      recommendedMove: "Analysis unavailable.",
    };
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const email = (session?.user as { email?: string } | undefined)?.email?.toLowerCase() || "";
  if (!userId || !email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { primaryUrl?: string; competitorUrls?: string[]; forceRefresh?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { primaryUrl, competitorUrls = [], forceRefresh = false } = body;
  if (!primaryUrl) {
    return NextResponse.json({ error: "primaryUrl is required" }, { status: 400 });
  }
  if (competitorUrls.length > 3) {
    return NextResponse.json({ error: "Maximum 3 competitor URLs allowed" }, { status: 400 });
  }

  try {
    // Primary: always fresh (no cache)
    const primaryProfile = await extractFreshProfile({ url: normalizeUrl(primaryUrl), userId, email, countTowardAccountLimit: true });

    // Competitors: 7-day cache from generations, unless forceRefresh.
    // SiteBlockedError is caught per-competitor — blocked URLs are skipped
    // and surfaced in the response rather than aborting the whole comparison.
    const blockedUrls: Record<string, string> = {}; // domain -> input URL
    const competitorResults = await Promise.all(
      competitorUrls.map(async (url) => {
        try {
          return await getCompetitorProfile(url, forceRefresh, userId, email);
        } catch (err) {
          if (err instanceof SiteBlockedError) {
            const domain = normalizeDomain(url);
            blockedUrls[domain] = url;
            console.warn(`[compare] Skipping blocked competitor: ${url}`);
            return null;
          }
          throw err; // re-throw unexpected errors
        }
      })
    );
    const competitorProfiles = competitorResults.filter((p): p is BrandProfile => p !== null);

    // Generate structured competitive position for each accessible competitor
    const competitivePositions: Record<string, CompetitivePosition> = {};
    await Promise.all(
      competitorProfiles.map(async (competitor) => {
        const domain = normalizeDomain(competitor.meta?.url || "");
        competitivePositions[domain] = await generateCompetitivePosition(primaryProfile, competitor);
      })
    );

    return NextResponse.json({
      comparison: {
        primary: primaryProfile,
        competitors: competitorProfiles,
        competitivePositions,
        // blockedUrls: { [domain]: inputUrl } for each competitor that returned a WAF page
        blockedUrls,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[compare] Error:", message);
    if (err instanceof AccountLimitError || err instanceof PlatformCapacityError) return NextResponse.json({ error: message, code: err instanceof AccountLimitError ? "monthly_report_limit_reached" : "beta_capacity_paused" }, { status: 429 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
