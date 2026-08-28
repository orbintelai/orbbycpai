import { createHash, randomUUID } from "crypto";
import type { EvidenceDraft, EvidenceReference, ModuleStatus, TechnologySignal } from "./types";

type TechnologyCategory = TechnologySignal["category"];

type RenderedArtifacts = {
  scriptUrls?: string[];
  generators?: string[];
  cookieNames?: string[];
  globals?: string[];
  networkHosts?: string[];
};

type TechnologySignature = { name: string; category: TechnologyCategory; patterns: RegExp[] };

// Deliberately bounded to sales-relevant web technologies. These signatures use
// only passive artifacts exposed by Chromium after rendering the target site.
const SIGNATURES: TechnologySignature[] = [
  { name: "Shopify", category: "Ecommerce", patterns: [/shopify|myshopify|shop-pay/i] },
  { name: "BigCommerce", category: "Ecommerce", patterns: [/bigcommerce/i] },
  { name: "WooCommerce", category: "Ecommerce", patterns: [/woocommerce|wc-ajax/i] },
  { name: "Magento", category: "Ecommerce", patterns: [/magento/i] },
  { name: "Salesforce Commerce Cloud", category: "Ecommerce", patterns: [/demandware|salesforce-commerce-cloud/i] },
  { name: "Google Analytics", category: "Analytics", patterns: [/google-analytics|analytics\.google\.com|gtag\(/i] },
  { name: "Mixpanel", category: "Analytics", patterns: [/mixpanel/i] },
  { name: "Amplitude", category: "Analytics", patterns: [/amplitude\.com|amplitude-js/i] },
  { name: "PostHog", category: "Analytics", patterns: [/posthog/i] },
  { name: "Heap", category: "Analytics", patterns: [/heap\.io|heapanalytics/i] },
  { name: "Pendo", category: "Analytics", patterns: [/pendo/i] },
  { name: "Hotjar", category: "Analytics", patterns: [/hotjar/i] },
  { name: "Intercom", category: "Support", patterns: [/intercom/i] },
  { name: "Zendesk", category: "Support", patterns: [/zendesk|zopim/i] },
  { name: "Drift", category: "Support", patterns: [/drift\.com|driftt/i] },
  { name: "Gorgias", category: "Support", patterns: [/gorgias/i] },
  { name: "Kustomer", category: "Support", patterns: [/kustomer/i] },
  { name: "Freshdesk", category: "Support", patterns: [/freshdesk|freshchat/i] },
  { name: "HubSpot", category: "Marketing", patterns: [/hubspot|hs-scripts|hsforms/i] },
  { name: "Marketo", category: "Marketing", patterns: [/marketo|mkto/i] },
  { name: "Pardot", category: "Marketing", patterns: [/pardot|pi\.pardot/i] },
  { name: "Klaviyo", category: "Marketing", patterns: [/klaviyo/i] },
  { name: "Customer.io", category: "Marketing", patterns: [/customer\.io|customerio/i] },
  { name: "Braze", category: "Marketing", patterns: [/braze/i] },
  { name: "Mailchimp", category: "Marketing", patterns: [/mailchimp|list-manage\.com/i] },
  { name: "Segment", category: "CDP", patterns: [/segment\.com|segment\.io|analytics\.js/i] },
  { name: "mParticle", category: "CDP", patterns: [/mparticle/i] },
  { name: "RudderStack", category: "CDP", patterns: [/rudderstack/i] },
  { name: "Tealium", category: "CDP", patterns: [/tealium|utag\.js/i] },
  { name: "Stripe", category: "Payments", patterns: [/js\.stripe\.com|stripe\.com\/v3|__stripe/i] },
  { name: "Braintree", category: "Payments", patterns: [/braintree/i] },
  { name: "Adyen", category: "Payments", patterns: [/adyen/i] },
  { name: "PayPal", category: "Payments", patterns: [/paypalobjects|paypal\.com\/sdk/i] },
  { name: "Paddle", category: "Payments", patterns: [/paddle\.com|paddlejs/i] },
  { name: "Salesforce", category: "CRM", patterns: [/salesforce\.com|force\.com/i] },
  { name: "Pipedrive", category: "CRM", patterns: [/pipedrive/i] },
  { name: "Attio", category: "CRM", patterns: [/attio/i] },
  { name: "Next.js", category: "Framework", patterns: [/_next\/static|__next_data__/i] },
  { name: "Nuxt", category: "Framework", patterns: [/__nuxt__|nuxt\.js/i] },
  { name: "Gatsby", category: "Framework", patterns: [/gatsby/i] },
  { name: "SvelteKit", category: "Framework", patterns: [/_app\/immutable|sveltekit/i] },
  { name: "WordPress", category: "Framework", patterns: [/wp-content|wp-includes|wordpress/i] },
  { name: "Webflow", category: "Framework", patterns: [/webflow\.com|webflow\.io/i] },
  { name: "Framer", category: "Framework", patterns: [/framer\.com|framerusercontent/i] },
  { name: "Wix", category: "Framework", patterns: [/wixstatic|wix\.com/i] },
  { name: "Squarespace", category: "Framework", patterns: [/squarespace|sqsp\.net/i] },
  { name: "Cloudflare", category: "CDN", patterns: [/cloudflare|cf-ray/i] },
  { name: "CloudFront", category: "CDN", patterns: [/cloudfront\.net/i] },
  { name: "Fastly", category: "CDN", patterns: [/fastly/i] },
  { name: "Vercel", category: "CDN", patterns: [/vercel\.app|_vercel/i] },
  { name: "Akamai", category: "CDN", patterns: [/akamai/i] },
  { name: "Google Tag Manager", category: "Tag Manager", patterns: [/googletagmanager|gtm\.js/i] },
];

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function renderedArtifacts(raw: Record<string, unknown>): Array<{ artifact: string; kind: string }> {
  const input = (raw.techArtifacts || {}) as RenderedArtifacts;
  const candidates: Array<{ artifact: string; kind: string }> = [];
  for (const [kind, values] of Object.entries({ script: input.scriptUrls, generator: input.generators, cookie: input.cookieNames, global: input.globals, network: input.networkHosts })) {
    for (const value of values || []) if (typeof value === "string" && value.trim()) candidates.push({ artifact: value.trim(), kind });
  }
  return candidates;
}

export function detectTechnologyStack(raw: Record<string, unknown>): { value: TechnologySignal[]; evidence: EvidenceDraft[]; status: ModuleStatus } {
  const startedAt = Date.now();
  const artifacts = renderedArtifacts(raw);
  const findings: TechnologySignal[] = [];
  const evidence: EvidenceDraft[] = [];
  for (const signature of SIGNATURES) {
    const match = artifacts.find(({ artifact }) => signature.patterns.some((pattern) => pattern.test(artifact)));
    if (!match) continue;
    const id = randomUUID();
    const capturedAt = new Date();
    const artifactUrl = /^https?:\/\//i.test(match.artifact) ? match.artifact : String(raw.url || "");
    const reference: EvidenceReference = { id, sourceUrl: artifactUrl, sourcePageTitle: `Rendered ${match.kind} artifact`, excerpt: match.artifact, capturedAt: capturedAt.toISOString() };
    evidence.push({ id, module: "techStack", entityType: "technology", entityKey: signature.name.toLowerCase(), fieldPath: `techStack.${signature.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, sourceUrl: artifactUrl, sourcePageTitle: reference.sourcePageTitle, excerpt: match.artifact, capturedAt, contentHash: hash(`${signature.name}|${match.artifact}`) });
    findings.push({ name: signature.name, category: signature.category, artifact: match.artifact, evidence: [reference] });
  }
  return {
    value: findings,
    evidence,
    status: {
      status: findings.length ? "published" : "not_published",
      reason: findings.length ? "Technology signatures detected from live rendered artifacts." : "No supported technology signatures detected from live rendered artifacts.",
      crawledUrls: raw.url ? [String(raw.url)] : [],
      durationMs: Date.now() - startedAt,
    },
  };
}
