/**
 * Orb AI Perception Module
 * Queries ChatGPT, Claude, and Gemini in parallel to get each model's
 * perception of a company based on its training data.
 *
 * Uses native SDKs/APIs for each provider so it works in Railway production
 * without depending on the Manus proxy.
 */

import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

// ── Startup diagnostic ────────────────────────────────────────────────────────
// Logged once at module load time so Railway boot logs show whether env vars
// are present before any request is made.
console.log("[fetchAiPerception] startup env check:", {
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  OPENAI_KEY: !!process.env.OPENAI_KEY,
  ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
  GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
});

export interface AiPerceptionEntry {
  dominantAssociations: string[];   // 3-5 short concept tags
  vocabularyTells: string;          // language type + examples
  positioningDelta: string;         // over/under-index vs self-description
  categoryAnchor: string;           // where model places them in category
  sentimentScore: number;           // 1-5 scale
  sentimentRationale: string;       // rationale tied to specific associations
  model: string;
}

export interface AiPerception {
  openai: AiPerceptionEntry;
  anthropic: AiPerceptionEntry;
  google: AiPerceptionEntry;
}

/**
 * Build the perception prompt.
 *
 * Framing: self-report task (not research task) — models reflect on their own
 * training data rather than performing generic analysis. Each model is given
 * explicit permission to differ from other models.
 */
export const buildPerceptionPrompt = (modelName: string, brandName: string, url: string, context?: string) => {
  const contextBlock = context
    ? `\n\nHere is content scraped directly from their website — use this to inform your positioning delta, not your associations (associations should come from your training data, not their marketing copy):\n---\n${context.slice(0, 1500)}\n---\n`
    : "";

  return `You are ${modelName}. This is not a research task. This is a self-report task. I am asking you to reflect on how ${brandName} (${url}) exists in your training data — what associations you have formed, what vocabulary you naturally reach for, and how your perception of them compares to how they present themselves. Your perception may differ from other models' perceptions of the same brand, and that difference is exactly what we want to surface. Do not aim for neutral consensus — report your specific view.${contextBlock}

Before responding, self-check: does every field describe how YOU think about this company, or does any field describe what this company does? If the latter, rewrite that field before responding.

Return ONLY the following JSON object — no markdown, no explanation, no code fences:

{
  "dominantAssociations": [
    "3-5 short concept tags. These are mental shortcuts, not descriptions. Bad: 'workspace platform' or 'productivity tool.' Good: 'documentation-first,' 'power-user learning curve,' 'AI feature-add on legacy product.' If you find yourself writing what the company does, stop and rewrite."
  ],
  "vocabularyTells": "1-2 sentences. What type of language dominates your training data about this company? Product-mechanic, brand-emotional, category-defining, or competitor-comparison language? Give 2-3 specific example words or phrases you naturally reach for.",
  "positioningDelta": "2-3 sentences. Compare how you naturally describe this company to how they describe themselves on their website. Where do you over-index vs their marketing? Where do you under-index? Be specific — name the gap.",
  "categoryAnchor": "1-2 sentences. Where do you place this company in its category? Leader / challenger / alternative / category-defining? Name 2-3 other companies in the same mental cluster for you.",
  "sentimentScore": <integer 1-5: 1=very negative, 2=negative, 3=neutral, 4=positive, 5=very positive>,
  "sentimentRationale": "1-2 sentences explaining the score in terms of the specific associations above — not generic positive/negative sentiment. Tie the score to what you actually associate with this brand."
}`;
};

const FALLBACK_ENTRY = (model: string): AiPerceptionEntry => ({
  dominantAssociations: [],
  vocabularyTells: "",
  positioningDelta: "",
  categoryAnchor: "",
  sentimentScore: 3,
  sentimentRationale: "",
  model,
});

export function parsePerceptionResponse(text: string, model: string): AiPerceptionEntry {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : text;
    const parsed = JSON.parse(jsonStr) as Partial<AiPerceptionEntry>;

    // Validate required fields are present and non-empty
    const associations = Array.isArray(parsed.dominantAssociations) ? parsed.dominantAssociations : [];
    const sentimentScore = typeof parsed.sentimentScore === "number"
      ? Math.min(5, Math.max(1, Math.round(parsed.sentimentScore)))
      : 3;

    return {
      dominantAssociations: associations,
      vocabularyTells: parsed.vocabularyTells || "",
      positioningDelta: parsed.positioningDelta || "",
      categoryAnchor: parsed.categoryAnchor || "",
      sentimentScore,
      sentimentRationale: parsed.sentimentRationale || "",
      model,
    };
  } catch {
    console.error("[fetchAiPerception] JSON parse failed, raw text:", text.slice(0, 300));
    return FALLBACK_ENTRY(model);
  }
}

/** Query ChatGPT via OpenAI SDK (direct, no proxy) */
async function queryOpenAI(brandName: string, url: string, context?: string): Promise<AiPerceptionEntry> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) {
    console.error("[fetchAiPerception] ChatGPT SKIPPED — OPENAI_API_KEY not set in environment.", {
      availableKeys: Object.keys(process.env).filter((k) => k.includes("OPENAI")),
    });
    return FALLBACK_ENTRY("chatgpt");
  }
  const chatgptModel = "gpt-4o-mini";
  const chatgptUrl = "https://api.openai.com/v1/chat/completions";
  try {
    console.log("[fetchAiPerception] Calling ChatGPT:", { model: chatgptModel, brandName });
    const client = new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1" });
    const response = await client.chat.completions.create({
      model: chatgptModel,
      max_tokens: 1000,
      temperature: 0.4,
      messages: [{ role: "user", content: buildPerceptionPrompt("ChatGPT", brandName, url, context) }],
    });
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    console.log("[fetchAiPerception] ChatGPT raw response:", text.slice(0, 200));
    const parsed = parsePerceptionResponse(text, "chatgpt");
    console.log("[fetchAiPerception] ChatGPT parsed score:", parsed.sentimentScore);
    return parsed;
  } catch (err) {
    const error = err as Error;
    console.error("[fetchAiPerception] ChatGPT FAILED:", {
      message: error.message,
      model: chatgptModel,
      url: chatgptUrl,
      stack: error.stack,
    });
    return FALLBACK_ENTRY("chatgpt");
  }
}

/** Query Claude via Anthropic SDK (direct) */
async function queryAnthropic(brandName: string, url: string, context?: string): Promise<AiPerceptionEntry> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[fetchAiPerception] Claude SKIPPED — ANTHROPIC_API_KEY not set in environment.");
    return FALLBACK_ENTRY("claude");
  }
  const claudeModel = "claude-haiku-4-5-20251001";
  try {
    console.log("[fetchAiPerception] Calling Claude:", { model: claudeModel, brandName });
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: claudeModel,
      max_tokens: 1000,
      messages: [{ role: "user", content: buildPerceptionPrompt("Claude", brandName, url, context) }],
    });
    const text =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    console.log("[fetchAiPerception] Claude raw response:", text.slice(0, 200));
    const parsed = parsePerceptionResponse(text, "claude");
    console.log("[fetchAiPerception] Claude parsed score:", parsed.sentimentScore);
    return parsed;
  } catch (err) {
    const error = err as Error;
    console.error("[fetchAiPerception] Claude FAILED:", {
      message: error.message,
      model: claudeModel,
      stack: error.stack,
    });
    return FALLBACK_ENTRY("claude");
  }
}

/** Query Gemini via REST API */
async function queryGemini(brandName: string, url: string, context?: string): Promise<AiPerceptionEntry> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[fetchAiPerception] Gemini SKIPPED — GEMINI_API_KEY not set in environment.", {
      availableKeys: Object.keys(process.env).filter((k) => k.includes("GEMINI") || k.includes("GOOGLE")),
    });
    return FALLBACK_ENTRY("gemini");
  }
  const geminiModel = "gemini-3.6-flash";
  const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: buildPerceptionPrompt("Gemini", brandName, url, context) }] }],
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: {
          dominantAssociations: { type: "array", items: { type: "string" } },
          vocabularyTells: { type: "string" },
          positioningDelta: { type: "string" },
          categoryAnchor: { type: "string" },
          sentimentScore: { type: "integer" },
          sentimentRationale: { type: "string" },
        },
        required: ["dominantAssociations", "vocabularyTells", "positioningDelta", "categoryAnchor", "sentimentScore", "sentimentRationale"],
      },
    },
  };

  // Retry up to 3 times with exponential backoff — Gemini returns HTTP 503
  // under high demand, which is transient and usually resolves in 1-2s.
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[fetchAiPerception] Calling Gemini (attempt ${attempt}/${MAX_RETRIES}):`, { model: geminiModel, brandName });
      const res = await fetch(geminiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        const isRetryable = res.status === 503 || res.status === 429;
        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * attempt;
          console.warn(`[fetchAiPerception] Gemini ${res.status} on attempt ${attempt} — retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(`Gemini HTTP ${res.status}: ${errorBody}`);
      }

      const data = await res.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
      console.log("[fetchAiPerception] Gemini raw response:", text.slice(0, 200));
      const parsed = parsePerceptionResponse(text, "gemini");
      console.log("[fetchAiPerception] Gemini parsed score:", parsed.sentimentScore);
      return parsed;

    } catch (err) {
      const error = err as Error;
      if (attempt < MAX_RETRIES && (error.message.includes("503") || error.message.includes("429"))) {
        const delay = BASE_DELAY_MS * attempt;
        console.warn(`[fetchAiPerception] Gemini error on attempt ${attempt} — retrying in ${delay}ms:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      console.error("[fetchAiPerception] Gemini FAILED after all retries:", {
        message: error.message,
        model: geminiModel,
        url: geminiEndpoint.replace(apiKey, "***"),
        stack: error.stack,
      });
      return FALLBACK_ENTRY("gemini");
    }
  }

  return FALLBACK_ENTRY("gemini");
}

/**
 * Fetch AI perception from all three LLM families in parallel.
 * Pass optional scraped context (page copy) to ground the analysis.
 * Each provider uses its own native SDK/API — gracefully degrades if a key is missing.
 */
export async function fetchAiPerception(
  brandName: string,
  url: string,
  context?: string
): Promise<AiPerception> {
  console.log("[fetchAiPerception] Starting parallel perception fetch for:", brandName);
  const [openaiResult, anthropicResult, googleResult] = await Promise.all([
    queryOpenAI(brandName, url, context),
    queryAnthropic(brandName, url, context),
    queryGemini(brandName, url, context),
  ]);

  console.log("[fetchAiPerception] All three complete:", {
    chatgpt: openaiResult.sentimentScore,
    claude: anthropicResult.sentimentScore,
    gemini: googleResult.sentimentScore,
  });

  return {
    openai: openaiResult,
    anthropic: anthropicResult,
    google: googleResult,
  };
}
