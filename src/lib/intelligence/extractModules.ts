import * as crypto from "crypto";
import * as cheerio from "cheerio";
import { sourceHash, textExcerpt } from "./sourceManifest";
import type {
  ComplianceClaim,
  CompanyIntelligence,
  EvidenceDraft,
  EvidenceReference,
  HiringSignals,
  IntegrationSignal,
  IntelligenceModule,
  ModuleStatus,
  NewsSignal,
  PersonSignal,
  ProductPricingSignal,
  SourceManifest,
  SourcePage,
} from "./types";

const LEADERSHIP_PATTERN = /\b(head|vp\.?|vice president|director|chief|c[eo]o|cfo|cto|cmo|cro|founder|co-founder|president)\b/i;
const NAME_PATTERN = /^[A-Z][\p{L}'’-]+(?:\s+(?:[A-Z][\p{L}'’-]+|[A-Z]\.)+){1,3}$/u;
const COMPLIANCE_FRAMEWORKS: Array<ComplianceClaim["framework"]> = ["SOC 2", "ISO 27001", "HIPAA", "GDPR", "PCI", "FedRAMP"];

export interface ModuleResult<T> {
  value?: T;
  evidence: EvidenceDraft[];
  status: ModuleStatus;
}

function evidence(
  module: IntelligenceModule,
  entityType: string,
  entityKey: string,
  fieldPath: string,
  page: SourcePage,
  excerpt: string
): { draft: EvidenceDraft; reference: EvidenceReference } {
  const compact = textExcerpt(excerpt);
  const id = crypto.randomUUID();
  const draft: EvidenceDraft = {
    id,
    module,
    entityType,
    entityKey,
    fieldPath,
    sourceUrl: page.url,
    sourcePageTitle: page.title || new URL(page.url).hostname,
    excerpt: compact,
    capturedAt: page.discoveredAt,
    // The evidence row retains its source URL; its content hash identifies the
    // published claim itself so the same fact can be collapsed across subpages.
    contentHash: sourceHash(compact),
  };
  return {
    draft,
    reference: {
      id,
      sourceUrl: draft.sourceUrl,
      sourcePageTitle: draft.sourcePageTitle,
      excerpt: draft.excerpt,
      capturedAt: draft.capturedAt.toISOString(),
    },
  };
}

function attemptedPages(manifest: SourceManifest, module: IntelligenceModule): SourcePage[] {
  const candidates = new Set(manifest.moduleCandidates[module]);
  return manifest.pages.filter((page) => candidates.has(page.requestedUrl || page.url) || candidates.has(page.url) || page.sourceKind === "homepage" && module === "productPricing");
}

function relevantPages(manifest: SourceManifest, module: IntelligenceModule): SourcePage[] {
  return attemptedPages(manifest, module).filter((page) => !page.blocked && !page.softNotFound && Boolean(page.text));
}

function statusFor(module: IntelligenceModule, manifest: SourceManifest, startedAt: number, found: boolean, reason: string): ModuleStatus {
  const crawledUrls = manifest.moduleCandidates[module];
  const attempted = attemptedPages(manifest, module);
  const contentPages = attempted.filter((page) => !page.blocked && !page.softNotFound && Boolean(page.text));
  const blocked = attempted.length > 0 && attempted.every((page) => Boolean(page.blocked));
  const onlySoftNotFound = attempted.length > 0 && attempted.every((page) => Boolean(page.softNotFound) || page.httpStatus === 404);
  const emptySource = attempted.some((page) => !page.blocked && !page.softNotFound && page.httpStatus && page.httpStatus >= 200 && page.httpStatus < 300 && !page.text);
  const unavailable = attempted.some((page) => Boolean(page.fetchError) || Boolean(page.httpStatus && page.httpStatus >= 500));
  const status = found
    ? "published"
    : blocked
      ? "blocked"
      : onlySoftNotFound || attempted.length === 0
        ? "source_not_found"
        : unavailable
          ? "unavailable"
          : emptySource
            ? "source_empty"
            : contentPages.length > 0
              ? "source_found_unparsed"
              : "source_not_found";
  const statusReason = found
    ? "First-party data published by the company."
    : blocked
      ? "Relevant source page restricts automated access."
      : onlySoftNotFound || attempted.length === 0
        ? reason
        : unavailable
          ? "A candidate first-party source could not be retrieved reliably; this is a limitation of the run."
          : emptySource
            ? "A candidate first-party source was found but exposed no extractable document content; this is a limitation of the run."
            : "A candidate first-party source was found but its published structure could not be interpreted; this is a limitation of the run.";
  return { status, reason: statusReason, crawledUrls, durationMs: Date.now() - startedAt };
}

function parseJsonLd(page: SourcePage): unknown[] {
  const $ = cheerio.load(page.html);
  const items: unknown[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      if (Array.isArray(parsed)) items.push(...parsed);
      else if (Array.isArray(parsed?.["@graph"])) items.push(...parsed["@graph"]);
      else items.push(parsed);
    } catch {}
  });
  return items;
}

function sentenceContaining(text: string, expression: RegExp): string | null {
  return text.split(/(?<=[.!?])\s+/).find((sentence) => expression.test(sentence)) || null;
}

export function extractPeople(manifest: SourceManifest): ModuleResult<PersonSignal[]> {
  const startedAt = Date.now();
  const people = new Map<string, PersonSignal>();
  const evidenceDrafts: EvidenceDraft[] = [];
  for (const page of relevantPages(manifest, "people")) {
    const $ = cheerio.load(page.contentHtml || page.html);
    for (const item of parseJsonLd(page) as Array<Record<string, unknown>>) {
      const type = String(item?.["@type"] || "").toLowerCase();
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      const title = typeof item?.jobTitle === "string" ? item.jobTitle.trim() : "";
      if ((type.includes("person") || title) && NAME_PATTERN.test(name) && title) {
        const key = name.toLowerCase();
        const ref = evidence("people", "person", key, "people", page, `${name} — ${title}`);
        evidenceDrafts.push(ref.draft);
        people.set(key, { name, title, evidence: [ref.reference] });
      }
    }
    $("h2,h3,h4").each((_, heading) => {
      const name = $(heading).text().replace(/\s+/g, " ").trim();
      if (!NAME_PATTERN.test(name)) return;
      const container = $(heading).parent();
      const nearby = container.text().replace(/\s+/g, " ").trim();
      const title = nearby.replace(name, "").split(/[|—–\n]/).map((part) => part.trim()).find((part) => part.length >= 3 && part.length <= 100 && /[A-Za-z]/.test(part));
      if (!title || /^read more|learn more$/i.test(title)) return;
      const image = container.find("img").first().attr("src");
      const key = name.toLowerCase();
      if (people.has(key)) return;
      const ref = evidence("people", "person", key, "people", page, `${name} — ${title}`);
      evidenceDrafts.push(ref.draft);
      people.set(key, { name, title, headshotUrl: image ? new URL(image, page.url).toString() : undefined, evidence: [ref.reference] });
    });
  }
  const value = [...people.values()].sort((a, b) => Number(LEADERSHIP_PATTERN.test(b.title)) - Number(LEADERSHIP_PATTERN.test(a.title)) || a.name.localeCompare(b.name));
  return { value, evidence: evidenceDrafts, status: statusFor("people", manifest, startedAt, value.length > 0, "No public team page.") };
}

function newsLabel(text: string): NewsSignal["label"] {
  const value = text.toLowerCase();
  if (/\b(funding|raised|series [a-z]|investment|financing)\b/.test(value)) return "Funding";
  if (/\b(launch|released|introduc(?:e|ing)|new product|product update)\b/.test(value)) return "Product";
  if (/\b(partner|partnership|integrat(?:e|ion))\b/.test(value)) return "Partnership";
  if (/\b(appoint|joins as|named .*chief|executive)\b/.test(value)) return "Leadership";
  if (/\b(award|recognized|named .*leader)\b/.test(value)) return "Award";
  if (/\b(event|webinar|conference|summit)\b/.test(value)) return "Event";
  return "Other";
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value.replace(/\s+/g, " ").trim());
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function firstNewsCard($: cheerio.CheerioAPI, anchor: any) {
  let current = $(anchor);
  // Modern CMS directories commonly wrap a title link, image, and date in generic
  // divs. Walk upward to the smallest bounded ancestor that carries a date instead
  // of relying on article semantics or framework-specific class names.
  for (let depth = 0; depth < 7 && current.length; depth += 1) {
    const text = current.text().replace(/\s+/g, " ").trim();
    const date = current.find("time, [datetime], [class*='date' i], [data-date], [data-published]").first();
    const dateValue = date.attr("datetime") || date.attr("data-date") || date.attr("data-published") || date.text();
    if (text.length >= 18 && text.length <= 1_800 && parseDate(dateValue)) return current;
    current = current.parent();
  }
  return null;
}

export function extractNews(manifest: SourceManifest): ModuleResult<NewsSignal[]> {
  const startedAt = Date.now();
  const items = new Map<string, NewsSignal>();
  const evidenceDrafts: EvidenceDraft[] = [];
  const publish = (page: SourcePage, headline: string, href: string, dateValue: string | undefined, body: string) => {
    const publishedAt = parseDate(dateValue);
    if (headline.length < 6 || body.length < headline.length + 12 || !publishedAt) return;
    let url: string;
    try {
      url = new URL(href, page.url).toString();
      // News entries must point to the same first-party registrable site as the
      // source page, never to a press wire or external editorial reference.
      if (new URL(url).hostname !== new URL(page.url).hostname) return;
    } catch { return; }
    if (items.has(url)) return;
    const summary = textExcerpt(body.replace(headline, ""), 260);
    const ref = evidence("news", "news_item", url, "news", page, body);
    evidenceDrafts.push(ref.draft);
    items.set(url, { headline, publishedAt, url, summary, label: newsLabel(`${headline} ${summary}`), evidence: [ref.reference] });
  };

  for (const page of relevantPages(manifest, "news")) {
    const $ = cheerio.load(page.contentHtml || page.html);

    // Prefer structured first-party newsroom content when it is published.
    for (const item of parseJsonLd(page) as Array<Record<string, unknown>>) {
      const type = String(item?.["@type"] || "").toLowerCase();
      if (!/(newsarticle|article|blogposting)/.test(type)) continue;
      const headline = String(item.headline || item.name || "").replace(/\s+/g, " ").trim();
      const href = String(item.url || item.mainEntityOfPage || page.url);
      const dateValue = String(item.datePublished || item.dateCreated || "");
      const body = String(item.description || item.articleBody || headline).replace(/\s+/g, " ").trim();
      publish(page, headline, href, dateValue, body);
    }

    // Capture both conventional heading links and cards whose heading is nested
    // inside the anchor—common on HubSpot, press centers, and CMS grids.
    $("a[href]").each((_, anchor) => {
      const link = $(anchor);
      const href = link.attr("href");
      if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return;
      const card = firstNewsCard($, anchor);
      if (!card) return;
      const heading = card.find("h1,h2,h3,h4,h5,[role='heading']").first().text().replace(/\s+/g, " ").trim();
      const headline = (heading || link.text()).replace(/\s+/g, " ").trim();
      const date = card.find("time, [datetime], [class*='date' i], [data-date], [data-published]").first();
      const dateValue = date.attr("datetime") || date.attr("data-date") || date.attr("data-published") || date.text();
      publish(page, headline, href, dateValue, card.text().replace(/\s+/g, " ").trim());
    });
  }
  const value = [...items.values()]
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .slice(0, 10);
  return { value, evidence: evidenceDrafts, status: statusFor("news", manifest, startedAt, value.length > 0, "No qualifying first-party news source was found.") };
}

interface NormalizedJob {
  title: string;
  department?: string;
  location?: string;
  url?: string;
  excerpt: string;
  source: SourcePage;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "OrbCompanyIntelligence/1.0", Accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

const NON_ROLE_LABEL = /^(apply|apply now|learn more|read more|view (?:all )?(?:jobs|openings|positions)|see (?:all )?(?:jobs|openings|positions)(?: in .+)?|careers?|jobs?|open positions?|current openings?|get future-ready\.?)$/i;
const JOB_TARGET_PATH = /\/(?:careers?|jobs?|positions?|openings?|vacancies?)(?:\/|$)|\/job-offers?\.html(?:$|[?#])/i;
const CAREER_PORTAL_DETAIL_PATH = /-j\d+\.html(?:$|[?#])/i;
const ROLE_TITLE_PATTERN = /\b(engineer|developer|architect|designer|manager|director|executive|specialist|analyst|scientist|researcher|recruiter|coordinator|associate|assistant|officer|counsel|consultant|administrator|technician|representative|partner|intern|lead|head|president|vice president|vp)\b/i;

function staticJobs(page: SourcePage): NormalizedJob[] {
  // Some career portals place their actual job grid outside the marketing page's
  // semantic main container. Use the full source document for an explicit hiring
  // page, but remove all global chrome and accept only a provable job-detail URL.
  const $ = cheerio.load(page.html);
  $("script,style,noscript,svg,template,nav,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[data-cookie],[data-testid*='cookie'],[id*='cookie'],[class*='cookie'],[id*='consent'],[class*='consent'],[id*='onetrust'],[class*='onetrust']").remove();
  const jobs: NormalizedJob[] = [];
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href");
    if (!href || /^mailto:|^tel:|^javascript:|^#/i.test(href)) return;
    let url: string;
    try { url = new URL(href, page.url).toString(); } catch { return; }
    const target = new URL(url);
    const careerPortal = /career portal|open jobs/i.test(`${page.title} ${page.text.slice(0, 240)}`);
    const validJobPath = JOB_TARGET_PATH.test(target.pathname)
      || (careerPortal && target.origin === new URL(page.url).origin && CAREER_PORTAL_DETAIL_PATH.test(target.pathname));
    if (!validJobPath || target.toString() === page.url) return;
    const heading = anchor.find("h1,h2,h3,h4,h5,h6,[role='heading'],[class*='title' i],[class*='job' i]").first().text().replace(/\s+/g, " ").trim();
    const rawTitle = (heading || anchor.text()).replace(/\s+/g, " ").trim();
    if (rawTitle.length < 4 || rawTitle.length > 150 || NON_ROLE_LABEL.test(rawTitle) || !ROLE_TITLE_PATTERN.test(rawTitle)) return;
    let card = anchor;
    for (let depth = 0; depth < 5 && card.length; depth += 1) {
      const attributes = [card.attr("class"), card.attr("id"), card.attr("data-testid")].filter(Boolean).join(" ");
      const text = card.text().replace(/\s+/g, " ").trim();
      if (/(job|position|opening|vacanc|career|role)/i.test(attributes) || /\b(location|department|team|type|remote|full[- ]time|part[- ]time)\b/i.test(text)) break;
      card = card.parent();
    }
    const cardText = card.text().replace(/\s+/g, " ").trim();
    // A role entry needs more than a generic navigation label: accept an explicit
    // job-route only when its bounded card supplies hiring metadata or meaningful
    // role context.
    const explicitCareerPortalRole = careerPortal && CAREER_PORTAL_DETAIL_PATH.test(target.pathname);
    if ((cardText.length < rawTitle.length + 6 && !explicitCareerPortalRole) || cardText.length > 700) return;
    const location = cardText.match(/\b(?:location|based in)\s*[:—-]?\s*([^|·•]{2,90})/i)?.[1]?.trim()
      || cardText.match(/\b(remote|hybrid|on-?site)\b/i)?.[1];
    const department = cardText.match(/\b(?:department|team|function)\s*[:—-]?\s*([^|·•]{2,90})/i)?.[1]?.trim();
    jobs.push({ title: rawTitle, department, location, url, excerpt: cardText, source: page });
  });
  return jobs;
}

async function atsJobs(page: SourcePage): Promise<NormalizedJob[]> {
  const parsed = new URL(page.url);
  const pathParts = parsed.pathname.split("/").filter(Boolean);
  if (/jobs\.ashbyhq\.com$/i.test(parsed.hostname) && pathParts[0]) {
    const payload = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(pathParts[0])}`) as { jobs?: Array<Record<string, unknown>> } | null;
    return (payload?.jobs || []).filter((job) => job.isListed !== false).map((job) => ({
      title: String(job.title || ""), department: String(job.department || job.team || "") || undefined,
      location: String(job.location || job.workplaceType || "") || undefined, url: String(job.jobUrl || job.applyUrl || "") || undefined,
      excerpt: String(job.descriptionPlain || job.title || ""), source: page,
    })).filter((job) => job.title);
  }
  if (/boards\.greenhouse\.io$/i.test(parsed.hostname) && pathParts[0]) {
    const payload = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(pathParts[0])}/jobs?content=true`) as { jobs?: Array<Record<string, unknown>> } | null;
    return (payload?.jobs || []).map((job) => ({
      title: String(job.title || ""), department: String((job.departments as Array<{ name?: string }> | undefined)?.[0]?.name || "") || undefined,
      location: String((job.location as { name?: string } | undefined)?.name || "") || undefined, url: String(job.absolute_url || "") || undefined,
      excerpt: String(job.content || job.title || ""), source: page,
    })).filter((job) => job.title);
  }
  if (/jobs\.lever\.co$/i.test(parsed.hostname) && pathParts[0]) {
    const payload = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(pathParts[0])}?mode=json`) as Array<Record<string, unknown>> | null;
    return (payload || []).map((job) => ({
      title: String(job.text || ""), department: String((job.categories as { team?: string } | undefined)?.team || "") || undefined,
      location: String((job.categories as { location?: string } | undefined)?.location || "") || undefined, url: String(job.hostedUrl || "") || undefined,
      excerpt: String(job.descriptionPlain || job.text || ""), source: page,
    })).filter((job) => job.title);
  }
  return [];
}

export async function extractHiring(manifest: SourceManifest): Promise<ModuleResult<HiringSignals>> {
  const startedAt = Date.now();
  const jobs: NormalizedJob[] = [];
  const seen = new Set<string>();
  for (const page of relevantPages(manifest, "hiring")) {
    jobs.push(...staticJobs(page));
    for (const item of parseJsonLd(page) as Array<Record<string, unknown>>) {
      if (!String(item?.["@type"] || "").toLowerCase().includes("jobposting")) continue;
      const title = String(item.title || "");
      if (!title) continue;
      jobs.push({ title, department: String(item?.hiringOrganization || "") || undefined, location: String(item?.jobLocation || "") || undefined, url: String(item.url || "") || undefined, excerpt: String(item.description || title), source: page });
    }
    if (page.sourceKind === "ats") jobs.push(...await atsJobs(page));
  }
  const roles: HiringSignals["roles"] = [];
  const evidenceDrafts: EvidenceDraft[] = [];
  for (const job of jobs) {
    const key = `${job.title}|${job.location || ""}|${job.department || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = evidence("hiring", "job", key, "hiring.roles", job.source, `${job.title}${job.department ? ` — ${job.department}` : ""}${job.location ? ` — ${job.location}` : ""}. ${textExcerpt(job.excerpt, 180)}`);
    evidenceDrafts.push(ref.draft);
    roles.push({ title: job.title, department: job.department, location: job.location, url: job.url, leadership: LEADERSHIP_PATTERN.test(job.title), evidence: [ref.reference] });
  }
  const countBy = (values: Array<string | undefined>) => [...values.filter(Boolean).reduce((map, value) => map.set(value!, (map.get(value!) || 0) + 1), new Map<string, number>()).entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const value: HiringSignals = { totalOpenRoles: roles.length, byDepartment: countBy(roles.map((role) => role.department)), byLocation: countBy(roles.map((role) => role.location)), roles };
  return { value, evidence: evidenceDrafts, status: statusFor("hiring", manifest, startedAt, roles.length > 0, "No public open roles found.") };
}

function localComplianceExcerpt(page: SourcePage, framework: string): string | null {
  const $ = cheerio.load(page.contentHtml || page.html);
  const frameworkPattern = new RegExp(`\\b${framework.split(/\\s+/).join("\\s+")}\\b`, "i");
  const candidates = $("p,li,dt,dd,a,span,td,th,h1,h2,h3,h4,h5,h6").toArray()
    .filter((element) => frameworkPattern.test($(element).text()))
    .flatMap((element) => {
      const own = $(element).text().replace(/\\s+/g, " ").trim();
      const parent = $(element).parent().text().replace(/\\s+/g, " ").trim();
      // A nearby parent gives a framework label the immediately associated
      // description without ever falling back to document-wide page text.
      return [parent, own].filter((text) => text.length >= framework.length && text.length <= 420 && frameworkPattern.test(text));
    })
    .sort((a, b) => a.length - b.length);
  const descriptive = candidates.find((text) => text.length >= Math.max(20, framework.length + 12));
  return descriptive ? textExcerpt(descriptive, 300) : candidates[0] ? textExcerpt(candidates[0], 300) : null;
}

export function extractCompliance(manifest: SourceManifest): ModuleResult<ComplianceClaim[]> {
  const startedAt = Date.now();
  const claims = new Map<string, ComplianceClaim>();
  const evidenceDrafts: EvidenceDraft[] = [];
  const seenEvidence = new Set<string>();
  for (const page of relevantPages(manifest, "compliance")) {
    for (const framework of COMPLIANCE_FRAMEWORKS) {
      const excerpt = localComplianceExcerpt(page, framework);
      if (!excerpt) continue;
      const ref = evidence("compliance", "claim", framework.toLowerCase(), "compliance.claims", page, excerpt);
      // One company fact per framework / field path. A company may publish the
      // same certification on several trust subpages; those are supporting
      // sources, not separate SOC 2, HIPAA, or GDPR claims.
      const claimKey = `${ref.draft.entityKey}|${ref.draft.fieldPath}`;
      const existing = claims.get(claimKey);
      const evidenceKey = `${ref.draft.sourceUrl}|${ref.draft.contentHash}`;
      if (!seenEvidence.has(evidenceKey)) {
        evidenceDrafts.push(ref.draft);
        seenEvidence.add(evidenceKey);
      }
      if (existing) {
        if (!existing.evidence.some((item) => item.sourceUrl === ref.reference.sourceUrl && item.excerpt === ref.reference.excerpt)) {
          existing.evidence.push(ref.reference);
        }
        continue;
      }
      claims.set(claimKey, { framework, claim: excerpt, evidence: [ref.reference] });
    }
  }
  const value = [...claims.values()];
  return { value, evidence: evidenceDrafts, status: statusFor("compliance", manifest, startedAt, value.length > 0, "No qualifying compliance claims published.") };
}

const INTEGRATION_CONTEXT = /\b(integration|connector|marketplace|app directory|partner ecosystem|technology partner|works with|connects with|supported app)\b/i;
const NON_INTEGRATION_LABEL = /^(about|company|pricing|log ?in|sign ?up|start free|get started(?: with .+)?|request (?:a )?demo|book (?:a )?demo|talk to sales|contact|careers?|open positions|privacy|cookie policy|trust(?: center)?|security|terms|help|support|learn more|read more|product|solutions?)$/i;

function integrationContext($: cheerio.CheerioAPI, element: any): boolean {
  let current = $(element);
  for (let depth = 0; depth < 5 && current.length; depth += 1) {
    const attributes = [current.attr("class"), current.attr("id"), current.attr("data-testid"), current.attr("aria-label")].filter(Boolean).join(" ");
    const nearbyText = current.text().replace(/\s+/g, " ").trim();
    if (INTEGRATION_CONTEXT.test(attributes) || INTEGRATION_CONTEXT.test(nearbyText)) return true;
    if (current.is("article,li") && nearbyText.length <= 260) return true;
    current = current.parent();
  }
  return false;
}

function integrationDocument(page: SourcePage): cheerio.CheerioAPI {
  // The generic claim boundary deliberately removes every form because forms often
  // contain lead-capture and consent copy. Richpanel’s first-party directory is a
  // counterexample: its real integration grid lives inside a Webflow form wrapper.
  // Use raw document markup only on an explicitly crawled integrations page, strip
  // all known chrome, then retain a form only when it contains directory-entry URLs.
  const $ = cheerio.load(page.html);
  $("script,style,noscript,svg,template,nav,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[data-cookie],[data-testid*='cookie'],[id*='cookie'],[class*='cookie'],[id*='consent'],[class*='consent'],[id*='onetrust'],[class*='onetrust']").remove();
  const sourcePath = new URL(page.url).pathname.replace(/\/$/, "");
  $("form").each((_, form) => {
    const hasDirectoryEntry = $(form).find("a[href]").toArray().some((anchor) => {
      const href = $(anchor).attr("href");
      if (!href) return false;
      try {
        const target = new URL(href, page.url);
        return target.pathname.startsWith(`${sourcePath}/`);
      } catch { return false; }
    });
    if (!hasDirectoryEntry) $(form).remove();
  });
  return $;
}

function integrationCardLabel($: cheerio.CheerioAPI, anchor: any): string {
  const card = $(anchor);
  const heading = card.find("h1,h2,h3,h4,h5,h6,[class*='title' i],[class*='name' i]").first().text().replace(/\s+/g, " ").trim();
  const imageAlt = card.find("img[alt]").first().attr("alt")?.replace(/\s+/g, " ").trim() || "";
  const ariaLabel = card.attr("aria-label")?.replace(/\s+/g, " ").trim() || "";
  const text = card.text().replace(/\s+/g, " ").trim();
  return heading || imageAlt || ariaLabel || text;
}

function isDirectoryEntryUrl(href: string, page: SourcePage): string | null {
  try {
    const target = new URL(href, page.url);
    if (!/^https?:$/i.test(target.protocol)) return null;
    const source = new URL(page.url);
    const sourcePath = source.pathname.replace(/\/$/, "");
    // A directory navigation link points to the hub itself; a card points to an
    // entry below it. Requiring the child path removes nav/CTA links by structure.
    if (!sourcePath || !target.pathname.startsWith(`${sourcePath}/`)) return null;
    return target.toString();
  } catch { return null; }
}

export function extractIntegrations(manifest: SourceManifest): ModuleResult<IntegrationSignal[]> {
  const startedAt = Date.now();
  const integrations = new Map<string, IntegrationSignal>();
  const evidenceDrafts: EvidenceDraft[] = [];
  for (const page of relevantPages(manifest, "integrations")) {
    const $ = integrationDocument(page);
    $("a[href]").each((_, element) => {
      const anchor = $(element);
      const name = integrationCardLabel($, element);
      const href = anchor.attr("href");
      if (!href || name.length < 2 || name.length > 80 || NON_INTEGRATION_LABEL.test(name) || !integrationContext($, element)) return;
      const url = isDirectoryEntryUrl(href, page);
      if (!url) return;
      const key = name.toLowerCase();
      if (integrations.has(key)) return;
      const ref = evidence("integrations", "integration", key, "integrations", page, name);
      evidenceDrafts.push(ref.draft);
      integrations.set(key, { name, url, evidence: [ref.reference] });
    });
  }
  const value = [...integrations.values()].slice(0, 40);
  return { value, evidence: evidenceDrafts, status: statusFor("integrations", manifest, startedAt, value.length > 0, "No public integrations directory found.") };
}

export function extractProductPricing(manifest: SourceManifest): ModuleResult<ProductPricingSignal> {
  const startedAt = Date.now();
  const pages = relevantPages(manifest, "productPricing");
  const claims: string[] = [];
  const targetCustomers: string[] = [];
  const evidenceDrafts: EvidenceDraft[] = [];
  const evidenceReferences: EvidenceReference[] = [];
  const claimEvidence: Record<string, EvidenceReference[]> = {};
  const targetCustomerEvidence: Record<string, EvidenceReference[]> = {};
  let pricingEvidence: EvidenceReference[] | undefined;
  let primaryCta: string | undefined;
  let pricingStatement: string | undefined;
  for (const page of pages) {
    const $ = cheerio.load(page.contentHtml || page.html);
    $("h1,h2,h3,p,li").each((_, element) => {
      const value = $(element).text().replace(/\s+/g, " ").trim();
      if (value.length < 20 || value.length > 360) return;
      if (/\b(pricing|\$\d|per month|contact sales|talk to sales|custom pricing|quote)\b/i.test(value) && !pricingStatement) {
        pricingStatement = textExcerpt(value, 300);
        const record = evidence("productPricing", "pricing", "pricing", "productPricing.pricing", page, value);
        evidenceDrafts.push(record.draft);
        evidenceReferences.push(record.reference);
        pricingEvidence = [record.reference];
      }
      if (/\b(for |built for |designed for |teams?|companies|enterprises?|developers?|marketers?|sales)\b/i.test(value) && targetCustomers.length < 4) {
        const claim = textExcerpt(value, 240);
        targetCustomers.push(claim);
        const record = evidence("productPricing", "target_customer", sourceHash(value).slice(0, 16), "productPricing.targetCustomers", page, value);
        evidenceDrafts.push(record.draft);
        evidenceReferences.push(record.reference);
        targetCustomerEvidence[claim] = [...(targetCustomerEvidence[claim] || []), record.reference];
      } else if (claims.length < 6) {
        const claim = textExcerpt(value, 240);
        claims.push(claim);
        const record = evidence("productPricing", "product_claim", sourceHash(value).slice(0, 16), "productPricing.productClaims", page, value);
        evidenceDrafts.push(record.draft);
        evidenceReferences.push(record.reference);
        claimEvidence[claim] = [...(claimEvidence[claim] || []), record.reference];
      }
    });
    if (!primaryCta) primaryCta = $("a,button").map((_, element) => $(element).text().replace(/\s+/g, " ").trim()).get().find((value) => /^(get started|start free|request demo|book a demo|contact sales|talk to sales|sign up)$/i.test(value));
  }
  const value: ProductPricingSignal = { productClaims: [...new Set(claims)].slice(0, 6), targetCustomerClaims: [...new Set(targetCustomers)].slice(0, 4), primaryCta, pricingStatement, claimEvidence, targetCustomerEvidence, pricingEvidence, evidence: evidenceReferences };
  return { value, evidence: evidenceDrafts, status: statusFor("productPricing", manifest, startedAt, Boolean(value.productClaims.length || value.pricingStatement), "Product details not published.") };
}

export async function runSourceModules(manifest: SourceManifest): Promise<{ intelligence: CompanyIntelligence; evidence: EvidenceDraft[] }> {
  const [people, news, hiring, compliance, integrations, productPricing] = await Promise.all([
    Promise.resolve(extractPeople(manifest)),
    Promise.resolve(extractNews(manifest)),
    extractHiring(manifest),
    Promise.resolve(extractCompliance(manifest)),
    Promise.resolve(extractIntegrations(manifest)),
    Promise.resolve(extractProductPricing(manifest)),
  ]);
  const results = { people, news, hiring, compliance, integrations, productPricing };
  return {
    intelligence: {
      version: "v1",
      sourcePolicy: "first_party_only",
      generatedAt: new Date().toISOString(),
      people: people.value,
      news: news.value,
      hiring: hiring.value,
      compliance: compliance.value,
      integrations: integrations.value,
      productPricing: productPricing.value,
      discoveryTelemetry: manifest.discoveryTelemetry,
      moduleStatuses: {
        people: people.status,
        news: news.status,
        hiring: hiring.status,
        compliance: compliance.status,
        integrations: integrations.status,
        productPricing: productPricing.status,
      },
    },
    evidence: Object.values(results).flatMap((result) => result.evidence),
  };
}
