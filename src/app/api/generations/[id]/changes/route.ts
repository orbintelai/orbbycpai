import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, lt } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { generations } from "@/db/schema";
import type { BrandProfile } from "@/lib/pipeline/classifyBrand";
import { buildWhatChanged } from "@/lib/intelligence/whatChanged";

export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const currentRows = await db
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.userId, userId)))
    .limit(1);
  const current = currentRows[0];
  if (!current?.brandProfile) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  // Current-report access is private. Snapshot lineage is intentionally global,
  // so the predecessor must not be filtered to the current account.
  const previousRows = current.previousGenerationId
    ? await db.select().from(generations).where(eq(generations.id, current.previousGenerationId)).limit(1)
    : current.registrableDomain && current.snapshotVersion !== null
      ? await db
        .select()
        .from(generations)
        .where(and(
          eq(generations.registrableDomain, current.registrableDomain),
          eq(generations.status, "complete"),
          lt(generations.snapshotVersion, current.snapshotVersion),
        ))
        .orderBy(desc(generations.snapshotVersion), desc(generations.completedAt))
        .limit(1)
      : [];
  const previous = previousRows[0];
  const result = buildWhatChanged({
    previous: previous?.brandProfile as BrandProfile | undefined,
    current: current.brandProfile as BrandProfile,
    previousGenerationId: previous?.id,
  });
  return NextResponse.json({ comparison: result, currentSnapshotVersion: current.snapshotVersion });
}
