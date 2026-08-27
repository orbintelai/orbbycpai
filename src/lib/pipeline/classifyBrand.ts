/**
 * Orb Brand Classifier
 * Classifies raw DOM data into a structured BrandProfile using Claude Haiku.
 * Produces both visual brand tokens AND product intelligence (Okara-style).
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import { rankHeroAssets, RankedAsset } from "./rankHeroAssets";
import type { CompanyIntelligence } from "@/lib/intelligence/types";
const CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ColorSample {
  hex: string;
  contexts: string[];
  count: number;
}

export interface ProductIntelligence {
  productName: string;
  oneLiner: string;
  whatItDoes: string;
  productCategory: string[];
  productType: string;
  targetCustomers: string;
  businessModel: string[];
  pricing: string;
  keyFeatures: string[];
  primaryCTA: string;
  techSignals: string[];
}

/**
 * DesignSignal — extracted visual design patterns from the brand's website.
 * Feeds the Art Director with real design context beyond just color/font tokens.
 */
export interface DesignSignal {
  /** How the brand organizes content: "editorial", "grid", "hero-centric", "minimal", "feature-list" */
  layoutPattern: string;
  /** Visual weight distribution: "left-heavy", "centered", "asymmetric", "full-bleed" */
  visualWeight: string;
  /** Card/container style: "borderless", "subtle-border", "elevated-shadow", "glassmorphism", "solid-fill" */
  cardStyle: string;
  /** Button/CTA style: "pill", "rounded", "sharp", "ghost", "text-only" */
  ctaStyle: string;
  /** Dominant visual element type: "photography", "illustration", "UI-screenshot", "abstract", "typography-only" */
  dominantVisualType: string;
  /** Photography treatment: "full-bleed", "contained", "masked", "overlapping-text", "side-by-side" */
  photographyTreatment: string;
  /** Text overlay style: "none", "gradient-overlay", "solid-block", "floating-card", "direct-overlay" */
  textOverlayStyle: string;
  /** Overall design density: "sparse", "balanced", "dense" */
  density: string;
  /** Paths to downloaded brand photography samples (local file paths) */
  photographySamples: string[];
  /** Raw description of what the Art Director should know about this brand's visual system */
  artDirectorNotes: string;
}

export interface BrandProfile {
  meta: {
    url: string;
    brandName: string;
    extractedAt: string;
  };
  productIntelligence: ProductIntelligence;
  tone: {
    directness: string;
    formality: string;
    emotionality: string;
    summary: string;
  };
  brandPersonality: string;
  industryContext: string;
  statistics: Array<{ value: string; label: string }>;
  testimonials: Array<{ quote: string; author: string }>;
  shapeLanguage: {
    classification: string;
    rawBorderRadii: string[];
  };
  typography: {
    headline: Record<string, string | undefined>;
    body: Record<string, string | undefined>;
    cta: Record<string, string | undefined>;
  };
  colorPalette: ColorSample[];
  primaryColor: string;
  accentColor: string;
  backgroundLuminance: number;
  logoRendering: string;
  spatialPhilosophy: {
    classification: string;
    rawSamples: Record<string, unknown>;
  };
  brandAssets: {
    logoImgs: string[];
    logoSvgs: string[];
    favicon: string;
    ogImage: string;
    downloadedAssets: Array<{
      src: string;
      localPath: string;
      localUrl: string;
      alt: string;
      width: number;
      height: number;
      ext: string;
      isGif: boolean;
      inHero: boolean;
    }>;
    rankedAssets?: RankedAsset[];
    heroAssetIndex?: number;
  };
  photography: {
    style: string;
    subject: string;
    sampleImages: string[];
    bgImages: string[];
  };
  cssVars: Record<string, string>;
  designSignal?: DesignSignal;
  // Brand Intelligence fields
  brandArchetype?: {
    archetype: string;
    rationale: string;
  };
  positioningSignal?: string;
  aiPerception?: {
    openai: { dominantAssociations?: string[]; vocabularyTells?: string; positioningDelta?: string; categoryAnchor?: string; sentimentRationale?: string; summary?: string; sentimentScore: number; model: string };
    anthropic: { dominantAssociations?: string[]; vocabularyTells?: string; positioningDelta?: string; categoryAnchor?: string; sentimentRationale?: string; summary?: string; sentimentScore: number; model: string };
    google: { dominantAssociations?: string[]; vocabularyTells?: string; positioningDelta?: string; categoryAnchor?: string; sentimentRationale?: string; summary?: string; sentimentScore: number; model: string };
  };
  companyIntelligence?: CompanyIntelligence;
  companyMetadata?: {
    foundedYear: string | null;
    employeeCount: string | null;
    hqLocation: string | null;
    fundingStage: string | null;
  };
}

// ─── Color helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return Math.max(...rgb) - Math.min(...rgb);
}

function contextWeight(contexts: string[]): number {
  const ctx = contexts.join(" ").toLowerCase();
  let weight = 1.0;
  // Strong boost for structural brand colors (body background, hero, page canvas).
  // Only boost true page-level backgrounds, NOT footer/nav/section backgrounds.
  // Use \barea:body\b to avoid matching 'area:footer.bg-black' etc.
  if (/\barea:body\b|\bbody\.bg-|\bbg-natural\b|\bhero\b|\bpage-bg\b/.test(ctx)) weight *= 4.0;
  // Moderate boost for section/page-level backgrounds (but NOT footer/nav)
  if (/area:section|area:main|area:article/.test(ctx)) weight *= 2.0;
  if (/subheadline|headline|h1|h2/.test(ctx)) weight *= 1.5;
  // Downweight UI element colors — CTA/button colors are not brand identity colors
  if (/cta:background/.test(ctx)) weight *= 0.3;
  // Downweight footer and nav backgrounds — these are structural, not brand identity
  if (/footer:background|nav:background|footer\.bg|nav\.bg/.test(ctx)) weight *= 0.5;
  if (/border|icon|divider/.test(ctx)) weight *= 0.5;
  return weight;
}

// ─── Shape language classifier ────────────────────────────────────────────────

function classifyShapeLanguage(borderRadii: string[]): string {
  if (!borderRadii || borderRadii.length === 0) return "geometric";
  const parsed: number[] = [];
  for (const r of borderRadii) {
    const m = r.match(/^(\d+(?:\.\d+)?)/);
    if (m) parsed.push(parseFloat(m[1]));
  }
  if (parsed.length === 0) return "geometric";
  const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
  if (avg === 0) return "geometric";
  if (avg <= 4) return "sharp";
  if (avg <= 12) return "slightly-rounded";
  if (avg <= 24) return "rounded";
  return "pill";
}

// ─── Spatial philosophy classifier ───────────────────────────────────────────

function classifySpatialPhilosophy(spatial: Record<string, unknown>): string {
  const padding = (spatial.avgPadding as number) ?? 0;
  const margin = (spatial.avgMargin as number) ?? 0;
  const avg = (padding + margin) / 2;
  if (avg < 8) return "dense";
  if (avg < 16) return "compact";
  if (avg < 32) return "balanced";
  if (avg < 48) return "airy";
  return "expansive";
}

// ─── Color deduplication ──────────────────────────────────────────────────────

function parseRgb(rgb: string): [number, number, number] | null {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
  );
}

function colorDistance(h1: string, h2: string): number {
  const r1 = hexToRgb(h1);
  const r2 = hexToRgb(h2);
  if (!r1 || !r2) return 999;
  return Math.sqrt(
    Math.pow(r1[0] - r2[0], 2) +
      Math.pow(r1[1] - r2[1], 2) +
      Math.pow(r1[2] - r2[2], 2)
  );
}

function dedupeColors(
  rawSamples: Array<{ hex?: string; color?: string; contexts?: string[]; count?: number }>,
  cssVars: Record<string, string>
): ColorSample[] {
  const samples: ColorSample[] = [];

  // Convert raw samples to ColorSample
  for (const s of rawSamples) {
    let hex = s.hex || s.color || "";
    if (!hex) continue;
    if (hex.startsWith("rgb")) {
      const rgb = parseRgb(hex);
      if (!rgb) continue;
      hex = rgbToHex(...rgb);
    }
    if (!hex.startsWith("#") || hex.length !== 7) continue;
    samples.push({
      hex: hex.toLowerCase(),
      contexts: s.contexts ?? [],
      count: s.count ?? 1,
    });
  }

  // Add CSS vars
  for (const [key, val] of Object.entries(cssVars)) {
    if (val && val.startsWith("#") && val.length === 7) {
      samples.push({ hex: val.toLowerCase(), contexts: [`css-var:${key}`], count: 1 });
    }
  }

  // Deduplicate by proximity (threshold 30)
  const deduped: ColorSample[] = [];
  for (const s of samples) {
    const existing = deduped.find((d) => colorDistance(d.hex, s.hex) < 30);
    if (existing) {
      existing.count += s.count;
      existing.contexts.push(...s.contexts);
    } else {
      deduped.push({ ...s });
    }
  }

  // Filter pure black and pure white, but keep dark brand colors like #212121.
  // Threshold: lum > 0.008 excludes #000000 (0.0) but includes #212121 (0.015).
  // Upper threshold: lum < 0.97 excludes #ffffff (1.0) but includes #f5f5f5 (0.956).
  return deduped
    .filter((c) => {
      const rgb = hexToRgb(c.hex);
      if (!rgb) return false;
      const lum = rgbToLuminance(c.hex);
      return lum > 0.008 && lum < 0.97;
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ─── LLM Classification ───────────────────────────────────────────────────────

interface LlmClassification {
  // Visual / tone
  tone: {
    directness: string;
    formality: string;
    emotionality: string;
    summary: string;
  };
  brandPersonality: string;
  industryContext: string;
  photographyStyle: string;
  photographySubject: string;
  statistics: Array<{ value: string; label: string }>;
  testimonials: Array<{ quote: string; author: string }>;
  // Product intelligence
  productName: string;
  oneLiner: string;
  whatItDoes: string;
  productCategory: string[];
  productType: string;
  targetCustomers: string;
  businessModel: string[];
  pricing: string;
  keyFeatures: string[];
  primaryCTA: string;
  // Brand intelligence
  brandArchetype: string;
  archetypeRationale: string;
  positioningSignal: string;
  foundedYear: string;
  employeeCount: string;
  hqLocation: string;
  fundingStage: string;
}

async function llmClassify(raw: Record<string, unknown>): Promise<LlmClassification> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const bodySnippet = (raw.bodySnippet as string) ?? "";
  const title = (raw.title as string) ?? "";
  const ogTitle = (raw.ogTitle as string) ?? "";
  const ogDesc = (raw.ogDescription as string) ?? "";
  const metaDesc = (raw.metaDescription as string) ?? "";
  const copyText = (raw.copyText as Record<string, string[]>) ?? {};
  const h1s = (copyText.h1 ?? []).slice(0, 5).join(" | ");
  const h2s = (copyText.h2 ?? []).slice(0, 6).join(" | ");
  const h3s = (copyText.h3 ?? []).slice(0, 6).join(" | ");
  const ctaTexts = (copyText.cta ?? []).join(" | ");
  const listItems = (copyText.listItems ?? []).slice(0, 8).join(" • ");
  const bodyParas = (copyText.bodyParagraphs ?? []).slice(0, 4).join(" ");
  const techSignals = ((raw.techSignals as string[]) ?? []).join(", ");

  const prompt = `You are a brand and product analyst. Analyze this website data and return a JSON object.

Website: ${raw.url}
Title: ${title}
OG Title: ${ogTitle}
OG Description: ${ogDesc}
Meta Description: ${metaDesc}
H1s: ${h1s}
H2s: ${h2s}
H3s: ${h3s}
CTAs: ${ctaTexts}
Feature list items: ${listItems}
Body paragraphs: ${bodyParas}
Tech signals detected: ${techSignals}
Body text snippet: ${bodySnippet.slice(0, 2000)}

Return ONLY this JSON object (no markdown, no explanation):
{
  "tone": {
    "directness": "direct|indirect",
    "formality": "formal|casual|professional",
    "emotionality": "emotional|rational|balanced",
    "summary": "2-3 word tone description"
  },
  "brandPersonality": "2-4 word personality archetype",
  "industryContext": "industry/sector in 3-5 words",
  "photographyStyle": "cinematic|documentary|product|lifestyle|abstract|minimal|none",
  "photographySubject": "what the photography focuses on in 3-5 words",
  "statistics": [
    {"value": "the stat number/percentage", "label": "what it measures"}
  ],
  "testimonials": [
    {"quote": "exact quote text", "author": "Name, Title"}
  ],
  "productName": "the brand or product name",
  "oneLiner": "one sentence describing what this product does",
  "whatItDoes": "2-3 sentence description of the product's core function and value",
  "productCategory": ["category 1", "category 2"],
  "productType": "SaaS|marketplace|agency|ecommerce|media|tool|platform|service|other",
  "targetCustomers": "who this product is built for, 1-2 sentences",
  "businessModel": ["access-gated platform", "self-serve subscription", "contact-based sales", "freemium", "usage-based"],
  "pricing": "pricing description only when explicitly present in supplied page text; otherwise empty string",
  "keyFeatures": ["feature 1", "feature 2", "feature 3"],
  "primaryCTA": "the main call-to-action button text",
  "brandArchetype": "one of: The Innocent|The Sage|The Explorer|The Outlaw|The Magician|The Hero|The Lover|The Jester|The Everyman|The Caregiver|The Ruler|The Creator",
  "archetypeRationale": "1-2 sentence explanation of why this archetype fits",
  "positioningSignal": "2-3 sentence summary of how this brand positions itself in the market",
  "foundedYear": "year founded if mentioned, or empty string",
  "employeeCount": "employee count or range if mentioned, or empty string",
  "hqLocation": "headquarters city/country if mentioned, or empty string",
  "fundingStage": "funding stage if mentioned (e.g. Series A, bootstrapped), or empty string"
}

Rules:
- For statistics: extract up to 4 real statistics or metrics the brand uses to prove value. If none found, return [].
- For testimonials: extract up to 3 real customer quotes from the body text. If none found, return [].
- For keyFeatures: extract up to 6 real features from the page copy. If none found, return [].
- For businessModel: pick all that apply from the list above.
- For pricing: return a pricing description only when the supplied page text explicitly states it; otherwise return an empty string. Never infer that pricing is unavailable.
- For productCategory: 2-3 category tags that describe the product space.
- All fields are required. Use empty string "" or [] for fields where data is not available.
- For brandArchetype: choose the single best-fit archetype from the provided list.
- For positioningSignal: describe how the brand differentiates itself, not just what it does.
- For company metadata (foundedYear, employeeCount, hqLocation, fundingStage): only fill if explicitly mentioned on the page. Otherwise return empty string.
- Return ONLY the JSON object, no other text.`;

  const response = await client.messages.create({
    model: CLASSIFICATION_MODEL,
    max_tokens: 1600,
    messages: [{ role: "user", content: prompt }],
  });

  const text = (response.content[0] as { text: string }).text.trim();
  // Extract JSON if wrapped in markdown
  const match = text.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : text;
  try {
    return JSON.parse(jsonStr) as LlmClassification;
  } catch (e) {
    console.error("[classifyBrand] JSON.parse failed. Raw response:", text.slice(0, 500));
    throw new Error(`Brand classification failed: LLM returned invalid JSON. ${(e as Error).message}`);
  }
}

// ─── Design Signal Extractor ─────────────────────────────────────────────────

/**
 * extractDesignSignal — analyzes the brand's website screenshot and downloaded
 * assets to extract structured visual design patterns for the Art Director.
 *
 * This is a separate, optional enrichment step. It runs after classifyBrand()
 * and attaches a designSignal to the BrandProfile.
 */
export async function extractDesignSignal(
  screenshotPath: string,
  downloadedAssets: Array<{ localPath: string; inHero: boolean; alt: string; width: number; height: number }>,
  brandProfile: BrandProfile
): Promise<DesignSignal> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Read screenshot as base64
  let screenshotBase64 = "";
  let screenshotMediaType: "image/png" | "image/jpeg" = "image/jpeg";
  try {
    if (fs.existsSync(screenshotPath)) {
      const buf = fs.readFileSync(screenshotPath);
      screenshotBase64 = buf.toString("base64");
      screenshotMediaType = screenshotPath.endsWith(".png") ? "image/png" : "image/jpeg";
    }
  } catch {
    // Screenshot unavailable — fall back to text-only analysis
  }

  // Collect photography samples: hero images first, then others, max 5
  const heroAssets = downloadedAssets.filter((a) => a.inHero && a.width >= 400);
  const otherAssets = downloadedAssets.filter((a) => !a.inHero && a.width >= 400);
  const photoSamples = [...heroAssets, ...otherAssets].slice(0, 5);
  const photographySamples = photoSamples.map((a) => a.localPath);

  // Build the vision prompt
  const brandContext = `Brand: ${brandProfile.meta?.brandName ?? "Unknown"}
Industry: ${brandProfile.industryContext ?? ""}
Shape language: ${brandProfile.shapeLanguage?.classification ?? ""}
Spatial philosophy: ${brandProfile.spatialPhilosophy?.classification ?? ""}
Primary color: ${brandProfile.primaryColor ?? ""}
Background luminance: ${(brandProfile.backgroundLuminance ?? 0.5) > 0.5 ? "light" : "dark"}`;

  const systemPrompt = `You are a senior art director analyzing a brand's website screenshot to extract structured design signal.
Your analysis will be used to brief a compositor who will create social media posts for this brand.
Be precise and specific. Your job is to describe what you actually see, not what you think the brand aspires to.`;

  const userContent: Anthropic.MessageParam["content"] = [];

  // Add screenshot if available
  if (screenshotBase64) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: screenshotMediaType,
        data: screenshotBase64,
      },
    });
  }

  userContent.push({
    type: "text",
    text: `${brandContext}

Analyze this website screenshot and return a JSON object describing the brand's visual design system.
Be specific about what you actually observe — not what the brand says about itself.

Return ONLY this JSON (no markdown, no explanation):
{
  "layoutPattern": "editorial|grid|hero-centric|minimal|feature-list",
  "visualWeight": "left-heavy|centered|asymmetric|full-bleed",
  "cardStyle": "borderless|subtle-border|elevated-shadow|glassmorphism|solid-fill",
  "ctaStyle": "pill|rounded|sharp|ghost|text-only",
  "dominantVisualType": "photography|illustration|UI-screenshot|abstract|typography-only",
  "photographyTreatment": "full-bleed|contained|masked|overlapping-text|side-by-side",
  "textOverlayStyle": "none|gradient-overlay|solid-block|floating-card|direct-overlay",
  "density": "sparse|balanced|dense",
  "artDirectorNotes": "2-3 sentences describing what makes this brand's visual system distinctive — what a compositor must know to make content that looks like it belongs on this brand's feed"
}

Rules:
- Choose exactly one value per field from the options listed
- artDirectorNotes must be specific to THIS brand, not generic design advice
- If no screenshot is available, infer from the brand context provided`,
  });

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
  });

  const text = (response.content[0] as { text: string }).text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : text;

  let parsed: Omit<DesignSignal, "photographySamples">;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Fallback: infer from brand profile tokens
    parsed = {
      layoutPattern: "hero-centric",
      visualWeight: "centered",
      cardStyle: brandProfile.shapeLanguage?.classification === "pill" ? "solid-fill" : "subtle-border",
      ctaStyle: brandProfile.shapeLanguage?.classification === "pill" ? "pill" : "rounded",
      dominantVisualType: brandProfile.photography?.style !== "none" ? "photography" : "typography-only",
      photographyTreatment: "full-bleed",
      textOverlayStyle: "gradient-overlay",
      density: brandProfile.spatialPhilosophy?.classification === "expansive" ? "sparse" : "balanced",
      artDirectorNotes: `${brandProfile.meta?.brandName ?? "Brand"} uses ${brandProfile.shapeLanguage?.classification ?? "rounded"} shapes, ${brandProfile.primaryColor ?? "brand"} as primary color, and ${brandProfile.photography?.style ?? "minimal"} photography.`,
    };
  }

  return {
    ...parsed,
    photographySamples,
  };
}

// ─── Main classifier ──────────────────────────────────────────────────────────

export async function classifyBrand(raw: Record<string, unknown>): Promise<BrandProfile> {
  const shape = classifyShapeLanguage((raw.borderRadii as string[]) ?? []);
  const spatialClass = classifySpatialPhilosophy((raw.spatial as Record<string, unknown>) ?? {});
  const colors = dedupeColors(
    (raw.colorSamples as ColorSample[]) ?? [],
    (raw.cssVars as Record<string, string>) ?? {}
  );

  const llmData = await llmClassify(raw);

  // Background luminance + logo rendering
  // Use raw.backgroundColor (body background) directly — it may be white/black which gets
  // filtered out of the deduped palette. This gives the most accurate luminance reading.
  let bgColor: string | null = null;
  const rawBgColor = raw.backgroundColor as string | undefined;
  if (rawBgColor) {
    // Convert rgb(...) to hex if needed
    if (rawBgColor.startsWith("rgb")) {
      const rgb = parseRgb(rawBgColor);
      if (rgb) bgColor = rgbToHex(...rgb);
    } else if (rawBgColor.startsWith("#")) {
      bgColor = rawBgColor;
    }
  }
  // Fallback 1: look in the deduped palette for background-context colors
  if (!bgColor) {
    for (const c of colors) {
      const ctx = c.contexts.join(" ").toLowerCase();
      if (/background|page/.test(ctx)) {
        bgColor = c.hex;
        break;
      }
    }
  }
  // Fallback 2: use the highest-luminance color in the palette (most likely the page canvas).
  // Most websites have light backgrounds; defaulting to 0.5 ("dark") produces wrong results
  // for brands like HubSpot whose body background is transparent (rgba(0,0,0,0)).
  if (!bgColor && colors.length > 0) {
    const byLuminance = [...colors].sort(
      (a, b) => rgbToLuminance(b.hex) - rgbToLuminance(a.hex)
    );
    bgColor = byLuminance[0].hex;
  }
  // Final fallback: assume light (0.9) — the vast majority of brand sites are light-background
  const bgLuminance = bgColor ? rgbToLuminance(bgColor) : 0.9;
  const logoRendering = bgLuminance < 0.5 ? "white" : "dark";

  // Primary and accent colors
  // Rank by frequency × context weight (how often the color appears in brand-relevant contexts).
  // Saturation is used only as a secondary tiebreaker — many strong brand identities use
  // low-saturation neutrals (Allbirds warm taupe, Apple white, etc.) as their primary color.
  const sortedColors = [...colors].sort((a, b) => {
    const scoreA = a.count * contextWeight(a.contexts);
    const scoreB = b.count * contextWeight(b.contexts);
    if (Math.abs(scoreA - scoreB) > 5) return scoreB - scoreA; // frequency wins
    return saturation(b.hex) - saturation(a.hex); // tiebreak by saturation
  });
  // Use visual classification colors if available (they were extracted from the actual screenshot
  // and are more reliable than the DOM palette for CSS-in-JS sites like Magic Mind).
  // raw.brandPrimary is set by runPipeline after classifyVisual runs.
  const visualPrimary = raw.brandPrimary as string | undefined;
  const visualAccent = (raw.accentColor ?? raw.brandSecondary) as string | undefined;
  const domPrimary = sortedColors[0]?.hex ?? "#000000";
  const domAccent = sortedColors[1]?.hex ?? domPrimary;
  // Prefer visual classification over DOM if it found a non-neutral color
  const primaryColor = (visualPrimary && visualPrimary !== "#000000" && visualPrimary !== "#ffffff")
    ? visualPrimary
    : domPrimary;
  const accentColor = (visualAccent && visualAccent !== "#000000" && visualAccent !== "#ffffff")
    ? visualAccent
    : domAccent;

  // Build typography from discoveredFonts + fontElementMap (raw.typography is never set by
  // the browser script — the actual data lives in raw.discoveredFonts and raw.fontElementMap).
  const fontElementMap = (raw.fontElementMap as Record<string, string | null>) ?? {};
  const discoveredFonts = (raw.discoveredFonts as Array<{ family: string; seenOn: string[]; score: number }>) ?? [];

  // Headline font: prefer h1 element mapping, fall back to top-scored font seen on headings
  const headlineFont =
    fontElementMap["h1"] ||
    fontElementMap["h2"] ||
    fontElementMap["h3"] ||
    discoveredFonts.find((f) => f.seenOn.some((s) => /h1|h2|h3|h4/.test(s)))?.family ||
    discoveredFonts[0]?.family ||
    null;

  // Body font: prefer p/li element mapping, fall back to second-ranked font or body element
  const bodyFontFamily =
    fontElementMap["p"] ||
    fontElementMap["li"] ||
    fontElementMap["body"] ||
    discoveredFonts.find((f) => f.seenOn.some((s) => /^(p|li|body|blockquote)$/.test(s)))?.family ||
    discoveredFonts[1]?.family ||
    headlineFont ||
    null;

  // CTA font: prefer button/nav mapping
  const ctaFontFamily =
    fontElementMap["button"] ||
    fontElementMap["nav"] ||
    headlineFont ||
    null;

  // Also check raw.typography for any legacy data (won't be present but safe to merge)
  const typo = (raw.typography as Record<string, Record<string, string>>) ?? {};
  const h1Font = typo.h1 ?? {};
  const bodyFont = typo.body ?? {};

  const brandName =
    llmData.productName ||
    (raw.brandName as string) ||
    (raw.ogTitle as string) ||
    (raw.title as string) ||
    ((raw.copyText as Record<string, string[]>)?.h1?.[0] ?? "").split(".")[0].trim();

  // Tech signals: merge browser-detected + LLM-inferred
  const browserTechSignals = (raw.techSignals as string[]) ?? [];

  // Downloaded brand assets
  const downloadedAssets = (raw.downloadedAssets as Array<{
    src: string;
    localPath: string;
    localUrl: string;
    alt: string;
    width: number;
    height: number;
    ext: string;
    isGif: boolean;
    inHero: boolean;
  }>) ?? [];

  // Use pre-computed ranking from runPipeline (passed via raw.rankedAssets / raw.heroAssetIndex)
  // rankHeroAssets runs in runPipeline before color quantization so both passes use the same hero
  const rankedAssets = (raw.rankedAssets as RankedAsset[] | undefined) ?? [];
  const heroAssetIndex = (raw.heroAssetIndex as number | undefined) ?? 0;

  return {
    meta: {
      url: raw.url as string,
      brandName,
      extractedAt: new Date().toISOString(),
    },
    productIntelligence: {
      productName: llmData.productName || brandName,
      oneLiner: llmData.oneLiner || "",
      whatItDoes: llmData.whatItDoes || "",
      productCategory: Array.isArray(llmData.productCategory) ? llmData.productCategory : [],
      productType: llmData.productType || "other",
      targetCustomers: llmData.targetCustomers || "",
      businessModel: Array.isArray(llmData.businessModel) ? llmData.businessModel : [],
      // Pricing is source-backed in Company Intelligence. Never manufacture an unavailable claim here.
      pricing: llmData.pricing || "",
      keyFeatures: Array.isArray(llmData.keyFeatures) ? llmData.keyFeatures : [],
      primaryCTA: llmData.primaryCTA || "",
      techSignals: browserTechSignals,
    },
    tone: llmData.tone,
    brandPersonality: llmData.brandPersonality,
    industryContext: llmData.industryContext,
    statistics: llmData.statistics ?? [],
    testimonials: llmData.testimonials ?? [],
    shapeLanguage: {
      classification: shape,
      rawBorderRadii: ((raw.borderRadii as string[]) ?? []).slice(0, 5),
    },
    typography: {
      headline: {
        fontFamily: headlineFont ?? h1Font.fontFamily ?? "Inter",
        fontSize: h1Font.fontSize ?? "48px",
        fontWeight: h1Font.fontWeight ?? "700",
        lineHeight: h1Font.lineHeight ?? "1.1",
        letterSpacing: h1Font.letterSpacing ?? "normal",
        textTransform: h1Font.textTransform ?? "none",
        color: h1Font.color,
      },
      body: {
        fontFamily: bodyFontFamily ?? bodyFont.fontFamily ?? "Inter",
        fontSize: bodyFont.fontSize ?? "16px",
        fontWeight: bodyFont.fontWeight ?? "400",
        lineHeight: bodyFont.lineHeight ?? "1.5",
      },
      cta: {
        fontFamily: ctaFontFamily ?? "Inter",
        ...((typo.cta as Record<string, string>) ?? {}),
      },
    },
    colorPalette: colors,
    primaryColor,
    accentColor,
    backgroundLuminance: Math.round(bgLuminance * 1000) / 1000,
    logoRendering,
    spatialPhilosophy: {
      classification: spatialClass,
      rawSamples: (raw.spatial as Record<string, unknown>) ?? {},
    },
    brandAssets: {
      logoImgs: (raw.logoImgs as string[]) ?? [],
      logoSvgs: (raw.logoSvgs as string[]) ?? [],
      favicon: (raw.favicon as string) ?? "",
      ogImage: (raw.ogImage as string) ?? "",
      downloadedAssets,
      rankedAssets,
      heroAssetIndex,
    },
    photography: {
      style: llmData.photographyStyle,
      subject: llmData.photographySubject,
      sampleImages: ((raw.images as string[]) ?? []).slice(0, 5),
      bgImages: ((raw.bgImages as string[]) ?? []).slice(0, 3),
    },
    cssVars: (raw.cssVars as Record<string, string>) ?? {},
    brandArchetype: {
      archetype: llmData.brandArchetype || "The Creator",
      rationale: llmData.archetypeRationale || "",
    },
    positioningSignal: llmData.positioningSignal || "",
    companyMetadata: {
      foundedYear: llmData.foundedYear || null,
      employeeCount: llmData.employeeCount || null,
      hqLocation: llmData.hqLocation || null,
      fundingStage: llmData.fundingStage || null,
    },
    // aiPerception is populated by the extract API after calling fetchAiPerception
    aiPerception: undefined,
  };
}
