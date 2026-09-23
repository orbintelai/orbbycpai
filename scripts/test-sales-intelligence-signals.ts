import assert from "node:assert/strict";
import { extractHiring, extractProductPricing } from "../src/lib/intelligence/extractModules";
import type { IntelligenceModule, SourceManifest, SourcePage } from "../src/lib/intelligence/types";

const now = new Date("2026-09-23T00:00:00.000Z");
const modules: IntelligenceModule[] = ["people", "news", "hiring", "compliance", "integrations", "productPricing"];

function page(overrides: Partial<SourcePage>): SourcePage {
  return {
    url: "https://www.timescapes.co/",
    requestedUrl: "https://www.timescapes.co/",
    title: "Timescapes",
    text: "Timescapes source text",
    html: "<main></main>",
    contentHtml: "<main></main>",
    discoveredAt: now,
    sourceKind: "homepage",
    httpStatus: 200,
    ...overrides,
  };
}

function manifest(pages: SourcePage[], candidates: Partial<Record<IntelligenceModule, string[]>>): SourceManifest {
  const moduleCandidates = Object.fromEntries(modules.map((module) => [module, candidates[module] || []])) as Record<IntelligenceModule, string[]>;
  return {
    origin: "https://www.timescapes.co",
    homepageUrl: "https://www.timescapes.co/",
    pages,
    moduleCandidates,
    blockedUrls: {},
    discoveryTelemetry: {
      pageBudget: 18,
      pagesConsumed: 0,
      pagesDeferredByBudget: 0,
      candidateCounts: Object.fromEntries(modules.map((module) => [module, moduleCandidates[module].length])) as Record<IntelligenceModule, number>,
      moduleMetrics: Object.fromEntries(modules.map((module) => [module, { candidateCount: moduleCandidates[module].length, pagesConsumed: 0, pagesDeferredByBudget: 0 }])) as SourceManifest["discoveryTelemetry"]["moduleMetrics"],
    },
  };
}

async function main() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.includes("www.workable.com/api/accounts/timescapes-co")) {
      return new Response(JSON.stringify({
        jobs: [
          { shortcode: "CSM-1", title: "Customer Success Manager", department: "Customer Success", published_on: "2026-09-17", url: "https://apply.workable.com/j/CSM-1", location: { location_str: "Oakville, Canada" }, description: "Own adoption and expansion." },
          { shortcode: "ML-1", title: "Machine Learning Engineer", department: "Engineering", published_on: "2026-05-20", url: "https://apply.workable.com/j/ML-1", locations: [{ city: "Melbourne", country: "Australia" }, { city: "Sydney", country: "Australia" }], description: "Build computer vision systems." },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const workable = page({
      url: "https://apply.workable.com/timescapes-co/",
      requestedUrl: "https://apply.workable.com/timescapes-co/",
      sourceKind: "ats",
      text: "",
      html: "<html></html>",
      contentHtml: "",
    });
    const hiring = await extractHiring(manifest([workable], { hiring: [workable.url] }));
    assert.equal(hiring.status.status, "published");
    assert.equal(hiring.value?.totalOpenRoles, 2, "Workable duplicate locations must remain one published role");
    assert.deepEqual(hiring.value?.byDepartment, [{ name: "Customer Success", count: 1 }, { name: "Engineering", count: 1 }]);
    assert.equal(hiring.value?.roles.find((role) => role.title === "Machine Learning Engineer")?.location, "Melbourne, Australia / Sydney, Australia");

    const homepage = page({
      html: `
        <main>
          <a href="/cameras">Cameras</a>
          <a href="/timescapes-platform">Platform</a>
          <a href="/general-contractors"><h3>General Contractors</h3><p>Track daily milestones and validate subcontractor work with visual evidence.</p></a>
          <a href="/owners-developers"><h3>Owners & Developers</h3><p>Verify progress claims and keep investors informed with current project data.</p></a>
        </main>`,
      contentHtml: `
        <main>
          <a href="/cameras">Cameras</a>
          <a href="/timescapes-platform">Platform</a>
          <a href="/general-contractors"><h3>General Contractors</h3><p>Track daily milestones and validate subcontractor work with visual evidence.</p></a>
          <a href="/owners-developers"><h3>Owners & Developers</h3><p>Verify progress claims and keep investors informed with current project data.</p></a>
        </main>`,
    });
    const product = extractProductPricing(manifest([homepage], { productPricing: [homepage.url] }));
    assert.deepEqual(product.value?.productLines.map((line) => line.name), ["Cameras", "Platform"]);
    assert.deepEqual(product.value?.buyerSegments.map((segment) => segment.name), ["General Contractors", "Owners & Developers"]);
    assert.ok(product.value?.buyerSegments.every((segment) => segment.evidence[0]?.sourceUrl === homepage.url));
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log("Sales intelligence signal tests passed.");
}

void main();
