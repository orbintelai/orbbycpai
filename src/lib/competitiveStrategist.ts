import OpenAI from "openai";
import type { BrandProfile } from "@/lib/pipeline/classifyBrand";

export interface CompetitivePosition {
  categoryPosition: string;
  positioningOverlap: string;
  positioningGap: string;
  narrativeTension: string;
  recommendedMove: string;
}

type StrategistModelAnalysis = {
  model: string;
  categoryAnchor?: string;
  positioningDelta?: string;
};

type StrategistCompanyInput = {
  name: string;
  firstParty: {
    productClaims: string[];
    pricingStatement?: string;
    integrations: string[];
    complianceClaims: string[];
  };
  aiPerception: StrategistModelAnalysis[];
};

type StrategistComparisonInput = {
  primary: StrategistCompanyInput;
  competitor: StrategistCompanyInput;
};

function strategistCompanyInput(profile: BrandProfile, fallbackName: string): StrategistCompanyInput {
  const intelligence = profile.companyIntelligence;
  const perception = profile.aiPerception;
  const perceptionEntries: Array<[string, NonNullable<BrandProfile["aiPerception"]>["openai"] | undefined]> = [
    ["OpenAI", perception?.openai],
    ["Anthropic", perception?.anthropic],
    ["Google", perception?.google],
  ];
  return {
    name: profile.meta?.brandName || fallbackName,
    firstParty: {
      productClaims: intelligence?.productPricing?.productClaims?.slice(0, 6) || [],
      pricingStatement: intelligence?.productPricing?.pricingStatement,
      integrations: intelligence?.integrations?.slice(0, 12).map((item) => item.name) || [],
      complianceClaims: intelligence?.compliance?.slice(0, 6).map((item) => item.claim) || [],
    },
    aiPerception: perceptionEntries.flatMap(([model, entry]) => entry && (entry.categoryAnchor || entry.positioningDelta)
      ? [{ model, categoryAnchor: entry.categoryAnchor, positioningDelta: entry.positioningDelta }]
      : []),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDirectionalEvidence(primaryName: string, competitor: StrategistCompanyInput): boolean {
  const primaryPattern = new RegExp(`\\b${escapeRegExp(primaryName)}\\b`, "i");
  return competitor.aiPerception.some((entry) => primaryPattern.test(`${entry.categoryAnchor || ""} ${entry.positioningDelta || ""}`));
}

export function enforceDirectionalNarrativeTension(primaryName: string, competitor: StrategistCompanyInput, narrativeTension: string): string {
  if (hasDirectionalEvidence(primaryName, competitor)) return narrativeTension;
  return `No directional competitive pressure is supported by this record: none of ${competitor.name}'s available OpenAI, Anthropic, or Google analyses names ${primaryName}.`;
}

function unavailableCompetitivePosition(): CompetitivePosition {
  return {
    categoryPosition: "Analysis unavailable.",
    positioningOverlap: "Analysis unavailable.",
    positioningGap: "Analysis unavailable.",
    narrativeTension: "Analysis unavailable.",
    recommendedMove: "Analysis unavailable.",
  };
}

export async function generateCompetitivePosition(
  primaryProfile: BrandProfile,
  competitorProfile: BrandProfile
): Promise<CompetitivePosition> {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY,
    baseURL: "https://api.openai.com/v1",
  });
  const comparisonInput: StrategistComparisonInput = {
    primary: strategistCompanyInput(primaryProfile, "Primary company"),
    competitor: strategistCompanyInput(competitorProfile, "Competitor"),
  };
  const { primary, competitor } = comparisonInput;
  const hasReciprocalDirectionality = hasDirectionalEvidence(primary.name, competitor);

  const prompt = `You are Orb’s evidence-bound Brand Strategist. Analyze the primary company against exactly one accessible competitor.

Your only permitted inputs are the structured comparison object below. First-party fields are factual claims published by the company. AI Perception fields are model analysis and identify the individual model. Do not browse. Do not use background knowledge. Do not introduce customers, category facts, pricing, product features, market share, analyst opinions, or competitive claims absent from the input.

Return ONLY JSON with exactly these string fields: categoryPosition, positioningOverlap, positioningGap, narrativeTension, recommendedMove.

Rules:
1. Write no more than three concise sentences per field.
2. Name the input behind each conclusion inline.
3. Say “first-party claim” for factual inputs and identify OpenAI, Anthropic, or Google for model analysis.
4. If the record does not support a conclusion, say so plainly rather than filling the gap.
5. Do not assume the primary company wins; state a competitor strength when the inputs support it.
6. recommendedMove must recommend one specific sales or positioning move rooted in a primary-company input and name that input.
7. Use a neutral analytical tone; avoid superlatives and unsupported certainty.
8. When the evidence supports a clear conclusion, state it plainly; false balance is not neutrality.
9. When models disagree on category placement, report the divergence and name which model said what; do not average it into a false consensus.
10. When both companies have pricing or business-model evidence, state the supported economic implication of that difference.
11. recommendedMove must say what a representative should say or ask on a call, not merely what to emphasize. It must be executable without translation.
12. Directionality is strict: state that the primary company creates pressure on, exposes, or threatens the competitor only if the competitor’s own AI Perception categoryAnchor or positioningDelta explicitly names the primary company. Shared category, product overlap, or the primary company’s self-description are not directional evidence. If no directional evidence exists, narrativeTension must say that no directional competitive pressure is supported by this record.

Comparison input:
${JSON.stringify(comparisonInput)}`;

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1000,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text) as Partial<CompetitivePosition>;
    const result: CompetitivePosition = {
      categoryPosition: parsed.categoryPosition || "Analysis unavailable.",
      positioningOverlap: parsed.positioningOverlap || "Analysis unavailable.",
      positioningGap: parsed.positioningGap || "Analysis unavailable.",
      narrativeTension: parsed.narrativeTension || "Analysis unavailable.",
      recommendedMove: parsed.recommendedMove || "Analysis unavailable.",
    };
    result.narrativeTension = hasReciprocalDirectionality
      ? result.narrativeTension
      : enforceDirectionalNarrativeTension(primary.name, competitor, result.narrativeTension);
    return result;
  } catch (err) {
    console.error("[compare] competitivePosition generation failed:", (err as Error).message);
    return unavailableCompetitivePosition();
  }
}
