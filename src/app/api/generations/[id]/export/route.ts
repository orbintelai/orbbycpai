import { NextRequest } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { analysisEvidence, generations } from "@/db/schema";
import type { BrandProfile } from "@/lib/pipeline/classifyBrand";

export const runtime = "nodejs";

function clean(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const current = await db.select().from(generations).where(and(eq(generations.id, id), eq(generations.userId, userId))).limit(1);
  const generation = current[0];
  if (!generation?.brandProfile) return Response.json({ error: "Report not found" }, { status: 404 });

  const profile = generation.brandProfile as BrandProfile;
  const intelligence = profile.companyIntelligence;
  const evidence = await db.select().from(analysisEvidence).where(eq(analysisEvidence.generationId, id)).orderBy(asc(analysisEvidence.module), asc(analysisEvidence.createdAt));
  const name = clean(profile.meta?.brandName || profile.productIntelligence?.productName || generation.domain || generation.brandUrl);
  const lines = [
    `# Orb Company Intelligence — ${name}`,
    "",
    `- **Source URL:** ${generation.brandUrl}`,
    `- **Snapshot:** ${generation.snapshotVersion || 1}`,
    `- **Captured:** ${(generation.completedAt || generation.createdAt).toISOString()}`,
    `- **Source policy:** First-party pages only for factual modules. AI Perception is model analysis and is labeled separately.`,
    "",
    "## Positioning",
    "",
    clean(profile.positioningSignal || profile.productIntelligence?.oneLiner) || "Not published.",
    "",
    "## First-party Company Intelligence",
    "",
  ];

  if (intelligence?.people?.length) {
    lines.push("### Key People", "", ...intelligence.people.map((person) => `- **${person.name}** — ${person.title}`), "");
  }
  if (intelligence?.hiring) {
    lines.push("### Hiring Signals", "", `- **Open roles:** ${intelligence.hiring.totalOpenRoles}`, ...intelligence.hiring.byDepartment.map((item) => `- ${item.name}: ${item.count}`), "");
  }
  if (intelligence?.news?.length) {
    lines.push("### News Signals", "", ...intelligence.news.map((item) => `- **${item.label}:** [${item.headline}](${item.url})${item.publishedAt ? ` (${item.publishedAt.slice(0, 10)})` : ""}`), "");
  }
  if (intelligence?.compliance?.length) {
    lines.push("### Compliance & Trust", "", ...intelligence.compliance.map((item) => `- **${item.framework}:** ${item.claim}`), "");
  }
  if (intelligence?.integrations?.length) {
    lines.push("### Integrations", "", ...intelligence.integrations.map((item) => `- ${item.url ? `[${item.name}](${item.url})` : item.name}`), "");
  }
  if (intelligence?.productPricing) {
    lines.push("### Product & Pricing", "", ...intelligence.productPricing.productClaims.map((claim) => `- ${claim}`));
    if (intelligence.productPricing.pricingStatement) lines.push(`- **Pricing statement:** ${intelligence.productPricing.pricingStatement}`);
    lines.push("");
  }

  const perception = profile.aiPerception;
  if (perception) {
    lines.push("## AI Perception — Model Analysis", "", "This section reflects model training-data associations, not first-party company facts.", "");
    for (const [label, entry] of [["ChatGPT", perception.openai], ["Claude", perception.anthropic], ["Gemini", perception.google]] as const) {
      lines.push(`### ${label}`, "", `- **Model:** ${entry.model}`, `- **Category Anchor:** ${clean(entry.categoryAnchor)}`, `- **Positioning Delta:** ${clean(entry.positioningDelta)}`, `- **Sentiment:** ${entry.sentimentScore}/5 — ${clean(entry.sentimentRationale)}`, "");
    }
  }

  lines.push("## Evidence Ledger", "", "| Module | Claim / item | Source | Captured |", "|---|---|---|---|");
  for (const item of evidence) {
    lines.push(`| ${item.module} | ${clean(item.excerpt).replace(/\|/g, "\\|")} | [${clean(item.sourcePageTitle).replace(/\|/g, "\\|")}](${item.sourceUrl}) | ${item.capturedAt.toISOString()} |`);
  }
  lines.push("");

  const filename = `orb-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report"}-snapshot-${generation.snapshotVersion || 1}.md`;
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
