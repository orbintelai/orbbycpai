import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { buildPerceptionPrompt, parsePerceptionResponse } from "../src/lib/pipeline/fetchAiPerception";

/**
 * Evaluation-only tool. It intentionally has no production route and refuses to
 * run unless ORB_ENV=staging. Before running it, verify all three model IDs from
 * their provider APIs and set ORB_EVAL_*_MODEL explicitly—never guess model names.
 */
if (process.env.ORB_ENV !== "staging") throw new Error("Premium perception evaluation is staging-only. Set ORB_ENV=staging.");

const [brandName, url, ...contextParts] = process.argv.slice(2);
const context = contextParts.join(" ").trim();
if (!brandName || !url) throw new Error("Usage: pnpm tsx scripts/evaluate-premium-perception.ts 'Company' https://company.com 'optional scraped context'");

const models = {
  openai: process.env.ORB_EVAL_OPENAI_MODEL,
  anthropic: process.env.ORB_EVAL_ANTHROPIC_MODEL,
  google: process.env.ORB_EVAL_GEMINI_MODEL,
};
if (!models.openai || !models.anthropic || !models.google) throw new Error("Set ORB_EVAL_OPENAI_MODEL, ORB_EVAL_ANTHROPIC_MODEL, and ORB_EVAL_GEMINI_MODEL after API verification.");

async function run() {
  const prompt = (provider: string) => buildPerceptionPrompt(provider, brandName, url, context || undefined);
  const startedAt = new Date();
  const [openaiResult, claudeResult, geminiResult] = await Promise.all([
    (async () => {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY, baseURL: "https://api.openai.com/v1" });
      const response = await client.chat.completions.create({ model: models.openai!, max_tokens: 2500, temperature: 0.4, messages: [{ role: "user", content: prompt("ChatGPT") }] });
      const text = response.choices[0]?.message?.content?.trim() || "";
      return { model: models.openai, perception: parsePerceptionResponse(text, `evaluation:${models.openai}`), usage: response.usage || null, raw: text };
    })(),
    (async () => {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({ model: models.anthropic!, max_tokens: 2500, messages: [{ role: "user", content: prompt("Claude") }] });
      const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      return { model: models.anthropic, perception: parsePerceptionResponse(text, `evaluation:${models.anthropic}`), usage: response.usage || null, raw: text };
    })(),
    (async () => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${models.google}:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt("Gemini") }] }], generationConfig: { maxOutputTokens: 8192, temperature: 0.4, responseMimeType: "application/json" } }) });
      if (!response.ok) throw new Error(`Gemini evaluation failed: HTTP ${response.status} ${await response.text()}`);
      const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: unknown };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      return { model: models.google, perception: parsePerceptionResponse(text, `evaluation:${models.google}`), usage: data.usageMetadata || null, raw: text };
    })(),
  ]);

  const record = { kind: "premium_perception_evaluation", startedAt: startedAt.toISOString(), completedAt: new Date().toISOString(), brandName, url, contextProvided: Boolean(context), models, results: { openai: openaiResult, anthropic: claudeResult, google: geminiResult }, reviewGuidance: "Compare each premium output against the production result for this same snapshot. Specifically assess whether Positioning Delta identifies a more specific self-report vs. model-perception gap and whether Category Anchor names a more defensible mental cluster. Price actual usage against the provider's current published rates before changing production." };
  const directory = path.join(process.cwd(), "eval-results");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `premium-perception-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(filename, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ saved: filename, models, positioningDelta: { openai: openaiResult.perception.positioningDelta, anthropic: claudeResult.perception.positioningDelta, google: geminiResult.perception.positioningDelta }, categoryAnchor: { openai: openaiResult.perception.categoryAnchor, anthropic: claudeResult.perception.categoryAnchor, google: geminiResult.perception.categoryAnchor } }, null, 2));
}

run().catch((error) => { console.error(error); process.exit(1); });
