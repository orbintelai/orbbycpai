import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { competitorComparisons, competitorStrategistResults } from "@/db/schema";

export const runtime = "nodejs";

type BrandProfile = Record<string, unknown>;
type StrategistStatus = "idle" | "loading" | "complete" | "failed";

function normalizeDomain(value: string): string | null {
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function profileList(value: unknown): BrandProfile[] {
  return Array.isArray(value) ? value.filter((item): item is BrandProfile => Boolean(item) && typeof item === "object") : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function profileDomain(profile: BrandProfile): string {
  const meta = profile.meta;
  const url = meta && typeof meta === "object" && "url" in meta && typeof meta.url === "string" ? meta.url : "";
  return normalizeDomain(url) || "unknown";
}

/**
 * Restores the latest successful comparison for the requested primary company.
 * The comparison row is user-owned; competitor snapshots remain inaccessible
 * unless they were recorded as members of that same persisted comparison.
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const primaryUrl = req.nextUrl.searchParams.get("primaryUrl") || "";
  const primaryGenerationId = req.nextUrl.searchParams.get("primaryGenerationId") || "";
  const primaryDomain = normalizeDomain(primaryUrl);
  if (!primaryDomain) return NextResponse.json({ error: "A valid primaryUrl is required" }, { status: 400 });

  const exactRows = primaryGenerationId
    ? await db.select()
      .from(competitorComparisons)
      .where(and(
        eq(competitorComparisons.userId, userId),
        eq(competitorComparisons.primaryGenerationId, primaryGenerationId),
      ))
      .orderBy(desc(competitorComparisons.createdAt))
      .limit(1)
    : [];

  const rows = exactRows.length ? exactRows : await db.select()
    .from(competitorComparisons)
    .where(and(
      eq(competitorComparisons.userId, userId),
      eq(competitorComparisons.primaryBrandDomain, primaryDomain),
    ))
    .orderBy(desc(competitorComparisons.createdAt))
    .limit(1);
  const comparison = rows[0];
  if (!comparison) return NextResponse.json({ comparison: null }, { headers: { "Cache-Control": "no-store" } });

  const competitorGenerationIds = stringList(comparison.competitorGenerationIds);
  const competitorProfiles = profileList(comparison.competitorProfiles);
  const strategistRows = competitorGenerationIds.length
    ? await db.select({
      competitorGenerationId: competitorStrategistResults.competitorGenerationId,
      status: competitorStrategistResults.status,
      result: competitorStrategistResults.result,
    }).from(competitorStrategistResults)
      .where(eq(competitorStrategistResults.comparisonId, comparison.id))
    : [];
  const strategistByGenerationId = new Map(strategistRows.map((row) => [row.competitorGenerationId, row]));
  const competitivePositions: Record<string, unknown> = {};
  const strategistStatuses: Record<string, StrategistStatus> = {};

  competitorProfiles.forEach((profile, index) => {
    const domain = profileDomain(profile);
    const persisted = competitorGenerationIds[index] ? strategistByGenerationId.get(competitorGenerationIds[index]) : undefined;
    if (persisted?.status === "complete" && persisted.result) competitivePositions[domain] = persisted.result;
    strategistStatuses[domain] = persisted?.status === "complete"
      ? "complete"
      : persisted?.status === "failed"
        ? "failed"
        : persisted?.status === "pending"
          ? "loading"
          : "idle";
  });

  const submittedUrls = stringList(comparison.submittedCompetitorUrls);
  const fallbackUrls = competitorProfiles.map((profile) => {
    const meta = profile.meta;
    return meta && typeof meta === "object" && "url" in meta && typeof meta.url === "string" ? meta.url : "";
  }).filter(Boolean);

  return NextResponse.json({
    comparison: {
      comparisonId: comparison.id,
      primaryGenerationId: comparison.primaryGenerationId || undefined,
      primary: comparison.primaryProfile as BrandProfile,
      competitors: competitorProfiles,
      competitorGenerationIds,
      competitivePositions,
      strategistStatuses,
      blockedUrls: stringMap(comparison.blockedUrls),
      competitorUrls: submittedUrls.length ? submittedUrls : fallbackUrls,
      createdAt: comparison.createdAt.toISOString(),
    },
  }, { headers: { "Cache-Control": "no-store" } });
}
