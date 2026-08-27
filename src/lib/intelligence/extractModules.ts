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
    contentHash: sourceHash(`${page.url}|${fieldPath}|${compact}`),
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

function relevantPages(manifest: SourceManifest, module: IntelligenceModule): SourcePage[] {
  const candidates = new Set(manifest.moduleCandidates[module]);
  const pages = manifest.pages.filter((page) => candidates.has(page.url) || page.sourceKind === "homepage" && module === "productPricing");
  return pages.filter((page) => !page.blocked && Boolean(page.text));
}

function statusFor(module: IntelligenceModule, manifest: SourceManifest, startedAt: number, found: boolean, reason: string): ModuleStatus {
  const crawledUrls = manifest.moduleCandidates[module];
  const blocked = crawledUrls.some((url) => Boolean(manifest.blockedUrls[url]));
  return {
    status: found ? "published" : blocked ? "blocked" : "not_published",
    reason: found ? "First-party data published by the company." : blocked ? "Relevant source page restricts automated access." : reason,
    crawledUrls,
    durationMs: Date.now() - startedAt,
  };
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
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function extractNews(manifest: SourceManifest): ModuleResult<NewsSignal[]> {
  const startedAt = Date.now();
  const items = new Map<string, NewsSignal>();
  const evidenceDrafts: EvidenceDraft[] = [];
  for (const page of relevantPages(manifest, "news")) {
    const $ = cheerio.load(page.contentHtml || page.html);
    $("article").each((_, article) => {
      const root = $(article);
      const headline = root.find("h1,h2,h3,h4,a").first().text().replace(/\s+/g, " ").trim();
      const href = root.find("a[href]").first().attr("href");
      const dateValue = root.find("time").first().attr("datetime") || root.find("time").first().text();
      const text = root.text().replace(/\s+/g, " ").trim();
      if (headline.length < 6 || !href || text.length < headline.length + 12) return;
      const url = new URL(href, page.url).toString();
      const summary = textExcerpt(text.replace(headline, ""), 260);
      const key = url;
      if (items.has(key)) return;
      const ref = evidence("news", "news_item", key, "news", page, text);
      evidenceDrafts.push(ref.draft);
      items.set(key, { headline, publishedAt: parseDate(dateValue), url, summary, label: newsLabel(`${headline} ${summary}`), evidence: [ref.reference] });
    });
  }
  const value = [...items.values()]
    .sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""))
    .slice(0, 10);
  return { value, evidence: evidenceDrafts, status: statusFor("news", manifest, startedAt, value.length > 0, "No first-party news published in the last 12 months.") };
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

export function extractCompliance(manifest: SourceManifest): ModuleResult<ComplianceClaim[]> {
  const startedAt = Date.now();
  const claims: ComplianceClaim[] = [];
  const evidenceDrafts: EvidenceDraft[] = [];
  const seen = new Set<string>();
  for (const page of relevantPages(manifest, "compliance")) {
    for (const framework of COMPLIANCE_FRAMEWORKS) {
      const sentence = sentenceContaining(page.text, new RegExp(`\\b${framework.replace(/ /g, "\\s+")}\\b`, "i"));
      const key = `${framework}|${page.url}`;
      if (!sentence || seen.has(key)) continue;
      seen.add(key);
      const ref = evidence("compliance", "claim", framework.toLowerCase(), "compliance.claims", page, sentence);
      evidenceDrafts.push(ref.draft);
      claims.push({ framework, claim: textExcerpt(sentence, 300), evidence: [ref.reference] });
    }
  }
  return { value: claims, evidence: evidenceDrafts, status: statusFor("compliance", manifest, startedAt, claims.length > 0, "No qualifying compliance claims published.") };
}

export function extractIntegrations(manifest: SourceManifest): ModuleResult<IntegrationSignal[]> {
  const startedAt = Date.now();
  const integrations = new Map<string, IntegrationSignal>();
  const evidenceDrafts: EvidenceDraft[] = [];
  for (const page of relevantPages(manifest, "integrations")) {
    const $ = cheerio.load(page.contentHtml || page.html);
    $("a[href],h2,h3,h4").each((_, element) => {
      const name = $(element).text().replace(/\s+/g, " ").trim();
      if (name.length < 2 || name.length > 60 || /^(integrations?|partners?|marketplace|apps?|learn more|read more)$/i.test(name)) return;
      const href = $(element).is("a") ? $(element).attr("href") : $(element).find("a[href]").first().attr("href");
      const key = name.toLowerCase();
      if (integrations.has(key)) return;
      const ref = evidence("integrations", "integration", key, "integrations", page, name);
      evidenceDrafts.push(ref.draft);
      integrations.set(key, { name, url: href ? new URL(href, page.url).toString() : undefined, evidence: [ref.reference] });
    });
  }
  const value = [...integrations.values()].slice(0, 40);
  return { value, evidence: evidenceDrafts, status: statusFor("integrations", manifest, startedAt, value.length > 0, "No public integrations page.") };
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
