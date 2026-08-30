import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { competitorComparisons, competitorStrategistResults, generations } from "@/db/schema";
import { generateCompetitivePosition } from "@/lib/competitiveStrategist";
import type { BrandProfile } from "@/lib/pipeline/classifyBrand";

export const runtime = "nodejs";
export const maxDuration = 90;

type StrategistRequest = {
  comparisonId?: string;
  competitorGenerationId?: string;
};

function comparisonMemberIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: StrategistRequest;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const { comparisonId, competitorGenerationId } = body;
  if (!comparisonId || !competitorGenerationId) {
    return NextResponse.json({ error: "comparisonId and competitorGenerationId are required" }, { status: 400 });
  }

  // The comparison itself is the authorization boundary. A valid user-owned primary
  // alone is insufficient: the requested competitor ID must be a recorded member.
  const comparison = await db.select().from(competitorComparisons)
    .where(and(eq(competitorComparisons.id, comparisonId), eq(competitorComparisons.userId, userId)))
    .limit(1);
  const comparisonRow = comparison[0];
  const memberIds = comparisonMemberIds(comparisonRow?.competitorGenerationIds);
  if (!comparisonRow || !comparisonRow.primaryGenerationId || !memberIds.includes(competitorGenerationId)) {
    return NextResponse.json({ error: "Requested competitor is not a member of this comparison." }, { status: 404 });
  }

  const existingRows = await db.select().from(competitorStrategistResults)
    .where(and(
      eq(competitorStrategistResults.comparisonId, comparisonId),
      eq(competitorStrategistResults.competitorGenerationId, competitorGenerationId),
    ))
    .limit(1);
  const existing = existingRows[0];
  if (existing?.status === "complete" && existing.result) {
    return NextResponse.json({ status: "complete", competitorGenerationId, result: existing.result });
  }
  if (existing?.status === "pending") {
    return NextResponse.json({ status: "pending", competitorGenerationId }, { status: 202 });
  }

  let ownsGeneration = false;
  if (existing?.status === "failed") {
    const claimed = await db.update(competitorStrategistResults)
      .set({ status: "pending", errorMessage: null, updatedAt: new Date() })
      .where(and(eq(competitorStrategistResults.id, existing.id), eq(competitorStrategistResults.status, "failed")))
      .returning({ id: competitorStrategistResults.id });
    ownsGeneration = claimed.length > 0;
  } else {
    const inserted = await db.insert(competitorStrategistResults).values({
      comparisonId,
      primaryGenerationId: comparisonRow.primaryGenerationId,
      competitorGenerationId,
      status: "pending",
    }).onConflictDoNothing().returning({ id: competitorStrategistResults.id });
    ownsGeneration = inserted.length > 0;
  }
  if (!ownsGeneration) return NextResponse.json({ status: "pending", competitorGenerationId }, { status: 202 });

  try {
    const profiles = await db.select({ id: generations.id, brandProfile: generations.brandProfile, status: generations.status })
      .from(generations)
      .where(eq(generations.id, comparisonRow.primaryGenerationId));
    const primary = profiles[0];
    const competitorRows = await db.select({ id: generations.id, brandProfile: generations.brandProfile, status: generations.status })
      .from(generations)
      .where(eq(generations.id, competitorGenerationId));
    const competitor = competitorRows[0];
    if (primary?.status !== "complete" || competitor?.status !== "complete" || !primary.brandProfile || !competitor.brandProfile) {
      throw new Error("Comparison member profile is unavailable.");
    }
    const result = await generateCompetitivePosition(
      primary.brandProfile as unknown as BrandProfile,
      competitor.brandProfile as unknown as BrandProfile,
    );
    await db.update(competitorStrategistResults)
      .set({ status: "complete", result, errorMessage: null, updatedAt: new Date() })
      .where(and(
        eq(competitorStrategistResults.comparisonId, comparisonId),
        eq(competitorStrategistResults.competitorGenerationId, competitorGenerationId),
      ));
    return NextResponse.json({ status: "complete", competitorGenerationId, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[compare/strategist] Failed:", message);
    await db.update(competitorStrategistResults)
      .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
      .where(and(
        eq(competitorStrategistResults.comparisonId, comparisonId),
        eq(competitorStrategistResults.competitorGenerationId, competitorGenerationId),
      ));
    return NextResponse.json({ status: "failed", competitorGenerationId, error: "Strategist analysis unavailable." }, { status: 502 });
  }
}
