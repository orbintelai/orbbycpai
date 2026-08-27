import * as crypto from "crypto";
import * as cheerio from "cheerio";
import type { IntelligenceModule, SourceManifest, SourcePage } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_FIRST_PARTY_PAGES = 16;
const MAX_FIRST_PARTY_PAGES_PER_MODULE = 3;
const MAX_ATS_PAGES = 2;
const CONCURRENCY = 4;

// A round-robin budget preserves coverage: a cluster of deep trust pages cannot
// consume a whole run before product, hiring, people, or news are inspected.
const MODULE_SCAN_ORDER: IntelligenceModule[] = ["productPricing", "integrations", "news", "people", "hiring", "compliance"];
const NESTED_PROBE_PATHS: Record<IntelligenceModule, string[]> = {
  people: ["company/about", "company/team", "company/leadership", "about/team", "about/leadership"],
  news: ["company/news", "resources/news", "product/updates"],
  hiring: ["company/careers", "company/jobs"],
  compliance: ["trust/security", "trust/compliance", "legal/privacy"],
  integrations: ["product/integrations", "platform/integrations", "partners/marketplace"],
  productPricing: ["products/platform", "platform/pricing", "solutions/platform"],
};

const PATH_PATTERNS: Record<IntelligenceModule, RegExp[]> = {
  people: [/\/(about|team|leadership|our-team|company|people)(\/|$)/i],
  // Editorial blogs/resources often contain educational content rather than company
  // signals. News is intentionally limited to explicit corporate-news surfaces.
  news: [/\/(news|press|newsroom|updates|changelog)(\/|$)/i],
  hiring: [/\/(careers|jobs|join|work-with-us)(\/|$)/i],
  compliance: [/\/(security|trust|privacy|compliance|legal)(\/|$)/i],
  integrations: [/\/(integrations|marketplace|apps)(\/|$)/i],
  productPricing: [/\/(product|platform|solutions|pricing)(\/|$)/i],
};

const ATS_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)$/i;
const BLOCK_TITLE_PATTERNS = [
  /vercel security checkpoint/i,
  /access denied/i,
  /just a moment/i,
  /checking your browser/i,
  /verifying you are human/i,
  /attention required/i,
  /sorry, you have been blocked/i,
  /bot detected/i,
  /are you a human/i,
  /ddos protection/i,
  /ray id/i,
];
const BLOCK_BODY_PATTERNS = [/hcaptcha/i, /recaptcha/i, /cf-ray/i, /cf-mitigated/i, /cloudflare/i, /perimeterx/i, /px-captcha/i, /human\.security/i];

// Company Intelligence publishes first-party claims, not a site's navigation or
// consent UI. Keep the unmodified HTML for link discovery and JSON-LD, while
// every claim-facing extractor receives this main-content-only representation.
const CHROME_SELECTOR = "script,style,noscript,svg,template,header,nav,footer,aside,form,[role='navigation'],[role='banner'],[role='contentinfo'],[data-cookie],[data-testid*='cookie'],[id*='cookie'],[class*='cookie'],[id*='consent'],[class*='consent'],[id*='onetrust'],[class*='onetrust']";

function contentOnly($: cheerio.CheerioAPI) {
  const content = $("body").clone();
  content.find(CHROME_SELECTOR).remove();
  content.find("*").filter((_, element) => {
    const attributes = [
      $(element).attr("role"),
      $(element).attr("aria-label"),
      $(element).attr("data-testid"),
      $(element).attr("id"),
      $(element).attr("class"),
    ].filter(Boolean).join(" ");
    return /\b(cookie|consent|privacy[-_ ]?choices?|cookiebot|quantcast|trustarc)\b/i.test(attributes);
  }).remove();
  return content;
}

function normaliseUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function firstPartyHost(hostname: string, rootHostname: string): boolean {
  const withoutWww = (value: string) => value.replace(/^www\./i, "");
  return withoutWww(hostname) === withoutWww(rootHostname);
}

function isBlockPage(title: string, body: string): string | null {
  const titleText = title.toLowerCase();
  if (BLOCK_TITLE_PATTERNS.some((pattern) => pattern.test(titleText))) return "page title indicates automated-access restriction";
  if (body.length < 300 && BLOCK_BODY_PATTERNS.some((pattern) => pattern.test(body))) return "short response with anti-bot challenge markers";
  return null;
}

export function sourceHash(value: string): string {
  return crypto.createHash("sha256").update(value.trim().replace(/\s+/g, " ")).digest("hex");
}

export function textExcerpt(value: string, maxLength = 420): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

async function fetchSourcePage(url: string, sourceKind: SourcePage["sourceKind"], linkedFrom?: string): Promise<SourcePage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OrbCompanyIntelligence/1.0; +https://orbbycpai-production.up.railway.app)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!response.ok) {
      return {
        url,
        title: "",
        text: "",
        html: "",
        contentHtml: "",
        discoveredAt: new Date(),
        sourceKind,
        linkedFrom,
        blocked: response.status === 401 || response.status === 403 || response.status === 429,
        blockReason: `Source returned HTTP ${response.status}`,
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/(text\/html|application\/xhtml\+xml|application\/xml|text\/xml|application\/rss\+xml)/i.test(contentType)) return null;
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const $ = cheerio.load(html);
    const title = $("title").first().text().replace(/\s+/g, " ").trim();
    const content = contentOnly($);
    const contentHtml = content.html() || "";
    const text = content.text().replace(/\s+/g, " ").trim();
    const blockReason = isBlockPage(title, text);
    return {
      url: response.url || url,
      title,
      text,
      html,
      contentHtml,
      discoveredAt: new Date(),
      sourceKind,
      linkedFrom,
      blocked: Boolean(blockReason),
      blockReason: blockReason || undefined,
    };
  } catch (error) {
    return {
      url,
      title: "",
      text: "",
      html: "",
      contentHtml: "",
      discoveredAt: new Date(),
      sourceKind,
      linkedFrom,
      blocked: false,
      blockReason: error instanceof Error ? error.message : "Source request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function moduleMatches(url: string): IntelligenceModule[] {
  return (Object.entries(PATH_PATTERNS) as Array<[IntelligenceModule, RegExp[]]>)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(new URL(url).pathname)))
    .map(([module]) => module);
}

function discoverLinks(page: SourcePage, rootHostname: string): Array<{ url: string; target: "first_party" | "ats" }> {
  const $ = cheerio.load(page.html);
  const links: Array<{ url: string; target: "first_party" | "ats" }> = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = normaliseUrl(href, page.url);
    if (!url) return;
    const parsed = new URL(url);
    if (firstPartyHost(parsed.hostname, rootHostname)) links.push({ url, target: "first_party" });
    else if (ATS_HOSTS.test(parsed.hostname)) links.push({ url, target: "ats" });
  });
  return links;
}

async function boundedMap<T, R>(values: T[], mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const current = values[cursor++];
      results.push(await mapper(current));
    }
  });
  await Promise.all(workers);
  return results;
}

function selectFairCandidates(moduleCandidates: Record<IntelligenceModule, string[]>): string[] {
  const selected = new Set<string>();
  const allocated: Record<IntelligenceModule, number> = {
    people: 0, news: 0, hiring: 0, compliance: 0, integrations: 0, productPricing: 0,
  };
  for (let round = 0; round < MAX_FIRST_PARTY_PAGES_PER_MODULE && selected.size < MAX_FIRST_PARTY_PAGES; round += 1) {
    let selectedInRound = false;
    for (const module of MODULE_SCAN_ORDER) {
      if (selected.size >= MAX_FIRST_PARTY_PAGES || allocated[module] >= MAX_FIRST_PARTY_PAGES_PER_MODULE) continue;
      const candidate = moduleCandidates[module].find((url) => !selected.has(url));
      if (!candidate) continue;
      selected.add(candidate);
      allocated[module] += 1;
      selectedInRound = true;
    }
    if (!selectedInRound) break;
  }
  return [...selected];
}

/**
 * Builds a first-party-only crawl manifest. The initial homepage capture already
 * happened in the browser pipeline; this crawler fetches narrowly allowlisted
 * source pages in bounded parallel batches for evidence-backed modules.
 */
export async function buildSourceManifest(homepageUrl: string): Promise<SourceManifest> {
  const canonicalHomepage = normaliseUrl(homepageUrl);
  if (!canonicalHomepage) throw new Error("Invalid source URL");
  const rootHostname = new URL(canonicalHomepage).hostname;
  const homepage = await fetchSourcePage(canonicalHomepage, "homepage");
  const moduleCandidates: Record<IntelligenceModule, string[]> = {
    people: [],
    news: [],
    hiring: [],
    compliance: [],
    integrations: [],
    productPricing: [],
  };
  const blockedUrls: Record<string, string> = {};
  const pages: SourcePage[] = [];

  if (homepage) {
    pages.push(homepage);
    if (homepage.blocked) blockedUrls[homepage.url] = homepage.blockReason || "Source restricts automated access";
  }

  const homepageLinks = homepage?.html ? discoverLinks(homepage, rootHostname) : [];
  const firstPartyCandidates = new Set<string>();
  const atsCandidates: Array<{ url: string; linkedFrom: string }> = [];
  for (const link of homepageLinks) {
    if (link.target === "ats") {
      atsCandidates.push({ url: link.url, linkedFrom: canonicalHomepage });
      moduleCandidates.hiring.push(link.url);
      continue;
    }
    const matches = moduleMatches(link.url);
    if (matches.length > 0) {
      firstPartyCandidates.add(link.url);
      for (const module of matches) moduleCandidates[module].push(link.url);
    }
  }

  // Probe every supported root path and a small, explicit set of common nested
  // paths. The former slice(0, 2) silently made leadership, newsroom, and
  // changelog probes unreachable.
  for (const module of Object.keys(PATH_PATTERNS) as IntelligenceModule[]) {
    for (const pattern of PATH_PATTERNS[module]) {
      const candidates = pattern.source.match(/\(([^)]+)\)/)?.[1]?.split("|") ?? [];
      for (const candidate of candidates) {
        const url = new URL(`/${candidate}`, canonicalHomepage).toString();
        firstPartyCandidates.add(url);
        moduleCandidates[module].push(url);
      }
    }
    for (const path of NESTED_PROBE_PATHS[module]) {
      const url = new URL(`/${path}`, canonicalHomepage).toString();
      firstPartyCandidates.add(url);
      moduleCandidates[module].push(url);
    }
  }

  for (const module of Object.keys(moduleCandidates) as IntelligenceModule[]) {
    moduleCandidates[module] = [...new Set(moduleCandidates[module])];
  }
  const selectedCandidates = new Set(selectFairCandidates(moduleCandidates));
  for (const module of Object.keys(moduleCandidates) as IntelligenceModule[]) {
    // Module status and evidence now disclose pages actually selected for crawl,
    // not every discovered link that lost the bounded fair-budget selection.
    moduleCandidates[module] = moduleCandidates[module].filter((url) => selectedCandidates.has(url));
  }
  const orderedCandidates = [...selectedCandidates]
    .filter((url) => firstPartyHost(new URL(url).hostname, rootHostname));

  const fetchedPages = await boundedMap(orderedCandidates, async (url) => fetchSourcePage(url, "first_party", canonicalHomepage));
  for (const page of fetchedPages) {
    if (!page) continue;
    if (page.title || page.text || page.blocked) pages.push(page);
    if (page.blocked) blockedUrls[page.url] = page.blockReason || "Source restricts automated access";
    for (const module of moduleMatches(page.url)) moduleCandidates[module].push(page.url);
  }

  const atsPages = await boundedMap(atsCandidates.slice(0, MAX_ATS_PAGES), async ({ url, linkedFrom }) => fetchSourcePage(url, "ats", linkedFrom));
  for (const page of atsPages) {
    if (!page) continue;
    if (page.title || page.text || page.blocked) pages.push(page);
    if (page.blocked) blockedUrls[page.url] = page.blockReason || "Source restricts automated access";
  }

  for (const module of Object.keys(moduleCandidates) as IntelligenceModule[]) {
    moduleCandidates[module] = [...new Set(moduleCandidates[module])];
  }

  return {
    origin: new URL(canonicalHomepage).origin,
    homepageUrl: canonicalHomepage,
    pages,
    moduleCandidates,
    blockedUrls,
  };
}
