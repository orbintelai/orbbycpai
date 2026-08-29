import * as crypto from "crypto";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import type { IntelligenceModule, SourceManifest, SourcePage } from "./types";
import { isSameRegistrableDomain } from "./lineage";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_FIRST_PARTY_PAGES = 18;
const MAX_FIRST_PARTY_PAGES_PER_MODULE = 3;
const MAX_ATS_PAGES = 2;
const CONCURRENCY = 4;
const ROBOTS_USER_AGENT = "OrbCompanyIntelligence";
const robotsPolicyCache = new Map<string, Promise<{ allowed: boolean; reason?: string }>>();

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
  // Hyphenated public paths are common (`/about-us`, `/meet-the-team`). The
  // suffix is delimiter-bound so `/newsletter` does not qualify as `/news`.
  people: [
    /\/(about|team|leadership|our-team|people|meet)(?:-[a-z0-9]+)*(\/|$)/i,
    /\/(company)(\/|$)/i,
  ],
  // Editorial blogs/resources often contain educational content rather than company
  // signals. News is intentionally limited to explicit corporate-news surfaces.
  news: [
    /\/(news|press|newsroom|updates|changelog)(?:-[a-z0-9]+)*(\/|$)/i,
    /\/(company-news)(?:-[a-z0-9]+)*(\/|$)/i,
  ],
  hiring: [/\/(careers|jobs|join|work-with-us|open)(?:-[a-z0-9]+)*(\/|$)/i],
  compliance: [/\/(security|trust|privacy|compliance|legal)(?:-[a-z0-9]+)*(\/|$)/i],
  integrations: [/\/(integrations|marketplace|apps|app)(?:-[a-z0-9]+)*(\/|$)/i],
  productPricing: [/\/(product|platform|solutions|pricing)(?:-[a-z0-9]+)*(\/|$)/i],
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
const CHROME_SELECTOR = "script,style,noscript,svg,template,nav,footer,aside,input,select,textarea,button,[role='navigation'],[role='banner'],[role='contentinfo'],[data-cookie],[data-testid*='cookie'],[id*='cookie'],[class*='cookie'],[id*='consent'],[class*='consent'],[id*='onetrust'],[class*='onetrust']";

function contentOnly($: cheerio.CheerioAPI) {
  // Prefer semantic page content over the entire body. Modern sites often put
  // navigation/footer prose in generic divs, where selector-only removal is
  // insufficient. A page's largest main/article container is the safer claim
  // boundary; body fallback retains coverage for non-semantic sites.
  const candidates = $("main, [role='main'], article").toArray();
  const selected = candidates.sort((a, b) => $(b).text().length - $(a).text().length)[0];
  const content = selected ? $(selected).clone() : $("body").clone();
  content.find(CHROME_SELECTOR).remove();
  if (!selected) content.find("header, [role='banner']").remove();
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

export function cleanSourceContent(html: string): { contentHtml: string; text: string } {
  const $ = cheerio.load(html);
  const content = contentOnly($);
  return {
    contentHtml: content.html() || "",
    text: content.text().replace(/\s+/g, " ").trim(),
  };
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
  return isSameRegistrableDomain(`https://${hostname}`, `https://${rootHostname}`);
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

async function robotsPolicy(url: string): Promise<{ allowed: boolean; reason?: string }> {
  const origin = new URL(url).origin;
  let pending = robotsPolicyCache.get(origin);
  if (!pending) {
    pending = (async () => {
      const robotsUrl = new URL("/robots.txt", origin).toString();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(robotsUrl, {
          signal: controller.signal,
          headers: { "User-Agent": `${ROBOTS_USER_AGENT}/1.0 (+https://orbbycpai-production.up.railway.app)` },
        });
        // A missing robots file authorizes the host. A failed retrieval does not: preserve
        // a visible unavailable state instead of silently crawling under an unknown policy.
        if (response.status === 404) return { allowed: true };
        if (!response.ok) return { allowed: false, reason: `Could not retrieve ${robotsUrl} (HTTP ${response.status}); source skipped by robots policy.` };
        const parser = robotsParser(robotsUrl, await response.text());
        if (parser.isAllowed(url, ROBOTS_USER_AGENT) === false) {
          return { allowed: false, reason: `robots.txt disallows OrbCompanyIntelligence from accessing this host path.` };
        }
        return { allowed: true };
      } catch (error) {
        return { allowed: false, reason: `Could not retrieve host robots.txt; source skipped by robots policy (${error instanceof Error ? error.message : "request failed"}).` };
      } finally {
        clearTimeout(timeout);
      }
    })();
    robotsPolicyCache.set(origin, pending);
  }
  return pending;
}

async function fetchSourcePage(url: string, sourceKind: SourcePage["sourceKind"], linkedFrom?: string, homepageContentHash?: string): Promise<SourcePage | null> {
  const policy = await robotsPolicy(url);
  if (!policy.allowed) {
    return {
      url,
      requestedUrl: url,
      title: "",
      text: "",
      html: "",
      contentHtml: "",
      discoveredAt: new Date(),
      sourceKind,
      linkedFrom,
      blocked: true,
      blockReason: policy.reason || "robots.txt restricts automated access",
    };
  }
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
        requestedUrl: url,
        title: "",
        text: "",
        html: "",
        contentHtml: "",
        discoveredAt: new Date(),
        sourceKind,
        linkedFrom,
        httpStatus: response.status,
        blocked: response.status === 401 || response.status === 403 || response.status === 429,
        blockReason: `Source returned HTTP ${response.status}`,
      };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/(text\/html|application\/xhtml\+xml|application\/xml|text\/xml|application\/rss\+xml)/i.test(contentType)) {
      return {
        url: response.url || url,
        requestedUrl: url,
        title: "",
        text: "",
        html: "",
        contentHtml: "",
        discoveredAt: new Date(),
        sourceKind,
        linkedFrom,
        httpStatus: response.status,
        blockReason: `Source returned non-document content type ${contentType || "unknown"}`,
      };
    }
    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const $ = cheerio.load(html);
    const title = $("title").first().text().replace(/\s+/g, " ").trim();
    const { contentHtml, text } = cleanSourceContent(html);
    const finalUrl = response.url || url;
    const finalPolicy = new URL(finalUrl).origin === new URL(url).origin ? policy : await robotsPolicy(finalUrl);
    if (!finalPolicy.allowed) {
      return {
        url: finalUrl,
        requestedUrl: url,
        title: "",
        text: "",
        html: "",
        contentHtml: "",
        discoveredAt: new Date(),
        sourceKind,
        linkedFrom,
        httpStatus: response.status,
        blocked: true,
        blockReason: finalPolicy.reason || "robots.txt restricts automated access on redirected host",
      };
    }
    const blockReason = isBlockPage(title, text);
    const contentHash = sourceHash(text);
    const requestedPath = new URL(url).pathname.replace(/\/$/, "") || "/";
    const homepagePath = new URL(linkedFrom || url).pathname.replace(/\/$/, "") || "/";
    return {
      url: finalUrl,
      requestedUrl: url,
      title,
      text,
      html,
      contentHtml,
      discoveredAt: new Date(),
      sourceKind,
      linkedFrom,
      httpStatus: response.status,
      softNotFound: Boolean(homepageContentHash && requestedPath !== homepagePath && contentHash === homepageContentHash),
      blocked: Boolean(blockReason),
      blockReason: blockReason || undefined,
    };
  } catch (error) {
    return {
      url,
      requestedUrl: url,
      title: "",
      text: "",
      html: "",
      contentHtml: "",
      discoveredAt: new Date(),
      sourceKind,
      linkedFrom,
      blocked: false,
      fetchError: error instanceof Error ? error.message : "Source request failed",
      blockReason: error instanceof Error ? error.message : "Source request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function moduleMatches(url: string): IntelligenceModule[] {
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

function pathDepth(url: string): number {
  return new URL(url).pathname.split("/").filter(Boolean).length;
}

function shallowPathFirst(candidates: string[]): string[] {
  return candidates
    .map((url, index) => ({ url, index, depth: pathDepth(url) }))
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .map(({ url }) => url);
}

function provenanceThenDepth(
  candidates: string[],
  homepageDiscovered: Set<string>,
  oneHopHubDiscovered: Set<string>,
): string[] {
  const remaining = new Set(candidates);
  const takeTier = (tier: Set<string>) => shallowPathFirst(
    candidates.filter((url) => remaining.has(url) && tier.has(url)),
  ).filter((url) => {
    remaining.delete(url);
    return true;
  });

  // A public link the company exposes from its homepage is stronger evidence than
  // an allowlisted guess. One-hop hub links occupy the same middle tier when the
  // discovery plan supplies them; explicit root/nested probes are the fallback.
  return [
    ...takeTier(homepageDiscovered),
    ...takeTier(oneHopHubDiscovered),
    ...shallowPathFirst(candidates.filter((url) => remaining.has(url))),
  ];
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
  const homepageContentHash = homepage?.text ? sourceHash(homepage.text) : undefined;
  const moduleCandidates: Record<IntelligenceModule, string[]> = {
    people: [],
    news: [],
    hiring: [],
    compliance: [],
    integrations: [],
    productPricing: [],
  };
  const blockedUrls: Record<string, string> = {};
  const homepageDiscoveredCandidates: Record<IntelligenceModule, Set<string>> = {
    people: new Set(), news: new Set(), hiring: new Set(), compliance: new Set(), integrations: new Set(), productPricing: new Set(),
  };
  // The current fixed-budget crawler does not yet enqueue one-hop hub pages. Keep
  // this tier explicit so any such candidates enter deterministically between
  // homepage links and path probes without changing the discovery budget here.
  const oneHopHubCandidates: Record<IntelligenceModule, Set<string>> = {
    people: new Set(), news: new Set(), hiring: new Set(), compliance: new Set(), integrations: new Set(), productPricing: new Set(),
  };
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
      for (const module of matches) {
        moduleCandidates[module].push(link.url);
        homepageDiscoveredCandidates[module].add(link.url);
      }
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
    moduleCandidates[module] = provenanceThenDepth(
      [...new Set(moduleCandidates[module])],
      homepageDiscoveredCandidates[module],
      oneHopHubCandidates[module],
    );
  }
  const candidateCounts = Object.fromEntries(
    (Object.keys(moduleCandidates) as IntelligenceModule[]).map((module) => [module, moduleCandidates[module].length]),
  ) as Record<IntelligenceModule, number>;
  const selectedCandidates = new Set(selectFairCandidates(moduleCandidates));
  const moduleMetrics = Object.fromEntries(
    (Object.keys(moduleCandidates) as IntelligenceModule[]).map((module) => {
      const selectedForModule = moduleCandidates[module].filter((url) => selectedCandidates.has(url));
      return [module, {
        candidateCount: candidateCounts[module],
        pagesConsumed: selectedForModule.length,
        pagesDeferredByBudget: Math.max(0, candidateCounts[module] - selectedForModule.length),
      }];
    }),
  ) as SourceManifest["discoveryTelemetry"]["moduleMetrics"];
  for (const module of Object.keys(moduleCandidates) as IntelligenceModule[]) {
    // Module status and evidence disclose pages actually selected for crawl,
    // while discoveryTelemetry retains candidates that lost fair-budget selection.
    moduleCandidates[module] = moduleCandidates[module].filter((url) => selectedCandidates.has(url));
  }
  const orderedCandidates = [...selectedCandidates]
    .filter((url) => firstPartyHost(new URL(url).hostname, rootHostname));

  const fetchedPages = await boundedMap(orderedCandidates, async (url) => fetchSourcePage(url, "first_party", canonicalHomepage, homepageContentHash));
  const successfulFirstPartyPages = fetchedPages.filter((page): page is SourcePage => Boolean(page?.httpStatus && !page.fetchError));
  const abortedFirstPartyPages = fetchedPages.filter((page) => page?.fetchError === "This operation was aborted");
  const spaCatchAllWithAborts = successfulFirstPartyPages.length > 0
    && successfulFirstPartyPages.every((page) => page.softNotFound)
    && abortedFirstPartyPages.length > 0
    && successfulFirstPartyPages.length + abortedFirstPartyPages.length === fetchedPages.length;

  if (spaCatchAllWithAborts) {
    // A catch-all SPA returned the same static shell for every completed route while
    // remaining route probes timed out. Retain only the homepage so this becomes
    // honest source absence rather than an availability failure for every module.
    for (const module of Object.keys(moduleCandidates) as IntelligenceModule[]) moduleCandidates[module] = [];
  } else {
    for (const page of fetchedPages) {
      if (!page) continue;
      pages.push(page);
      if (page.blocked) {
        const reason = page.blockReason || "Source restricts automated access";
        blockedUrls[page.requestedUrl || page.url] = reason;
        blockedUrls[page.url] = reason;
      }
      for (const module of moduleMatches(page.requestedUrl || page.url)) moduleCandidates[module].push(page.requestedUrl || page.url);
    }
  }

  const atsPages = await boundedMap(atsCandidates.slice(0, MAX_ATS_PAGES), async ({ url, linkedFrom }) => fetchSourcePage(url, "ats", linkedFrom, homepageContentHash));
  for (const page of atsPages) {
    if (!page) continue;
    pages.push(page);
    if (page.blocked) {
      const reason = page.blockReason || "Source restricts automated access";
      blockedUrls[page.requestedUrl || page.url] = reason;
      blockedUrls[page.url] = reason;
    }
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
    discoveryTelemetry: {
      pageBudget: MAX_FIRST_PARTY_PAGES,
      pagesConsumed: orderedCandidates.length,
      pagesDeferredByBudget: Math.max(0, firstPartyCandidates.size - selectedCandidates.size),
      candidateCounts,
      moduleMetrics,
    },
  };
}
