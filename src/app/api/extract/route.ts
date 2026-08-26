import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { analysisEvidence, generations } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { extractDom } from "@/lib/pipeline/runPipeline";
import { classifyBrand } from "@/lib/pipeline/classifyBrand";
import { fetchAiPerception } from "@/lib/pipeline/fetchAiPerception";
import { runCompanyIntelligence } from "@/lib/intelligence/runCompanyIntelligence";
import type { CompanyIntelligence, IntelligenceRunResult } from "@/lib/intelligence/types";
import {
  AccountLimitError,
  PlatformCapacityError,
  completeFullProfileUnit,
  releaseFullProfileUnit,
  reserveFullProfileUnit,
} from "@/lib/usage/circuitBreaker";

export const runtime = "nodejs";
export const maxDuration = 240;

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function normalizeInputUrl(value: string): string {
  const normalized = value.startsWith("http") ? value : `https://${value}`;
  const url = new URL(normalized);
  url.hash = "";
  return url.toString();
}

function domainFor(value: string): string {
  return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
}

function emptyIntelligence(reason: string): IntelligenceRunResult {
  const startedAt = Date.now();
  const unavailable = { status: "unavailable" as const, reason, crawledUrls: [], durationMs: 0 };
  const moduleStatuses: CompanyIntelligence["moduleStatuses"] = {
    people: { ...unavailable },
    news: { ...unavailable },
    hiring: { ...unavailable },
    compliance: { ...unavailable },
    integrations: { ...unavailable },
    productPricing: { ...unavailable },
  };
  return {
    intelligence: {
      version: "v1",
      sourcePolicy: "first_party_only",
      generatedAt: new Date().toISOString(),
      moduleStatuses,
    },
    evidence: [],
    moduleStatuses,
    durationMs: Date.now() - startedAt,
  };
}

function fileToDataUri(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 1000 || buffer.length > 512 * 1024) return null;
    const extension = path.extname(filePath).toLowerCase().replace(".", "");
    const mime = ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" } as Record<string, string>)[extension] || "image/jpeg";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * POST /api/extract
 *
 * A fresh direct report is a capacity-reserved, immutable snapshot. First-party
 * modules run in parallel with the three-model perception call after the initial
 * rendered homepage capture completes. Existing snapshots are never overwritten.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  const userEmail = (session?.user as { email?: string } | undefined)?.email?.toLowerCase() || "";
  if (!userId || !userEmail) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawUrl = (body.url || "").trim();
  if (!rawUrl) return Response.json({ error: "url is required" }, { status: 400 });

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeInputUrl(rawUrl);
  } catch {
    return Response.json({ error: "Invalid URL" }, { status: 400 });
  }

  let reservation: Awaited<ReturnType<typeof reserveFullProfileUnit>>;
  try {
    reservation = await reserveFullProfileUnit({ userId, email: userEmail });
  } catch (error) {
    if (error instanceof AccountLimitError) {
      return Response.json({ error: "monthly_report_limit_reached", message: error.message, limit: 10 }, { status: 429 });
    }
    if (error instanceof PlatformCapacityError) {
      return Response.json({ error: "beta_capacity_paused", message: error.message }, { status: 429 });
    }
    console.error("[extract] capacity reservation failed", error);
    return Response.json({ error: "capacity_check_failed", message: "Orb could not reserve analysis capacity. Please retry." }, { status: 503 });
  }

  const workDir = path.join(os.tmpdir(), `orb-extract-${randomUUID()}`);
  fs.mkdirSync(workDir, { recursive: true });
  const startedAt = new Date();
  const domain = domainFor(normalizedUrl);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (data: object) => controller.enqueue(encoder.encode(sse(data)));
      let completed = false;
      try {
        emit({ type: "status", step: 1, total: 9, message: "Reading the company homepage..." });
        const raw = await extractDom(normalizedUrl, workDir, emit);
        const rawTyped = raw as Record<string, unknown>;
        const downloadedAssets = (rawTyped.downloadedAssets as Array<{ src: string; localPath: string; localUrl: string; alt: string; width: number; height: number; ext: string; isGif: boolean; inHero: boolean }>) || [];
        rawTyped.downloadedAssets = downloadedAssets
          .map((asset) => ({ ...asset, localUrl: fileToDataUri(asset.localPath) || asset.src }))
          .filter((asset) => asset.localUrl);

        emit({ type: "status", step: 6, total: 9, message: "Classifying company identity..." });
        const profile = await classifyBrand(rawTyped);
        const brandName = profile.meta?.brandName || domain;
        const copyText = rawTyped.copyText as { h1?: string[]; h2?: string[]; bodyParagraphs?: string[] } | undefined;
        const bodySnippet = (rawTyped.bodySnippet as string | undefined) || "";
        const scrapedContext = [
          copyText?.h1?.join(" | "),
          copyText?.h2?.slice(0, 4).join(" | "),
          copyText?.bodyParagraphs?.slice(0, 3).join(" "),
          bodySnippet.slice(0, 800),
        ].filter(Boolean).join("\n").slice(0, 2000);

        // These two branches are intentionally parallel: model perception is
        // model-labelled analysis; company intelligence is first-party extraction.
        emit({ type: "status", step: 7, total: 9, message: "Collecting first-party company signals and AI perception..." });
        const [aiPerception, intelligenceResult] = await Promise.all([
          fetchAiPerception(brandName, normalizedUrl, scrapedContext || undefined),
          runCompanyIntelligence(normalizedUrl).catch((error) => {
            console.error("[extract] company intelligence branch failed", error);
            return emptyIntelligence("Source-backed intelligence could not be collected for this run.");
          }),
        ]);
        profile.aiPerception = aiPerception;
        profile.companyIntelligence = intelligenceResult.intelligence;

        emit({ type: "status", step: 8, total: 9, message: "Creating immutable intelligence snapshot..." });
        const previous = await db
          .select({ id: generations.id, snapshotVersion: generations.snapshotVersion })
          .from(generations)
          .where(and(eq(generations.domain, domain), eq(generations.status, "complete"), eq(generations.userId, userId)))
          .orderBy(desc(generations.snapshotVersion), desc(generations.completedAt))
          .limit(1);
        const snapshotVersion = (previous[0]?.snapshotVersion || 0) + 1;
        const completedAt = new Date();
        const [generation] = await db
          .insert(generations)
          .values({
            userId,
            brandUrl: normalizedUrl,
            domain,
            brandProfile: profile as unknown as Record<string, unknown>,
            status: "complete",
            runOrigin: "direct",
            snapshotVersion,
            previousGenerationId: previous[0]?.id || null,
            accessTier: "full",
            moduleStatuses: intelligenceResult.moduleStatuses,
            startedAt,
            completedAt,
            runtimeMs: completedAt.valueOf() - startedAt.valueOf(),
          })
          .returning({ id: generations.id });

        if (intelligenceResult.evidence.length > 0) {
          await db.insert(analysisEvidence).values(intelligenceResult.evidence.map((item) => ({ ...item, generationId: generation.id })));
        }

        let capacity = reservation.snapshot;
        try {
          capacity = await completeFullProfileUnit({ userId, email: userEmail, pool: reservation.pool });
        } catch (error) {
          // The report is already durably saved. Keep the reservation consumed
          // rather than undercounting capacity if dashboard telemetry is delayed.
          console.error("[extract] failed to finalize capacity telemetry", error);
        }
        completed = true;
        emit({ type: "status", step: 9, total: 9, message: "Report ready." });
        emit({
          type: "complete",
          generationId: generation.id,
          brandProfile: profile,
          accessTier: "full",
          snapshotVersion,
          capacity,
          runtimeMs: completedAt.valueOf() - startedAt.valueOf(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[extract] pipeline failed", error);
        emit({ type: "error", message });
      } finally {
        if (!completed) {
          try {
            await releaseFullProfileUnit({ userId, email: userEmail, pool: reservation.pool });
          } catch (error) {
            console.error("[extract] failed to release capacity reservation", error);
          }
        }
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
