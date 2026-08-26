import { runCompanyIntelligence } from "../src/lib/intelligence/runCompanyIntelligence";

const url = process.argv[2];
if (!url) {
  console.error("Usage: pnpm tsx scripts/smoke-company-intelligence.ts https://example.com");
  process.exit(1);
}

async function main() {
  const result = await runCompanyIntelligence(url);
  console.log(JSON.stringify({
    durationMs: result.durationMs,
    evidenceCount: result.evidence.length,
    statuses: result.moduleStatuses,
    counts: {
      people: result.intelligence.people?.length || 0,
      news: result.intelligence.news?.length || 0,
      roles: result.intelligence.hiring?.totalOpenRoles || 0,
      compliance: result.intelligence.compliance?.length || 0,
      integrations: result.intelligence.integrations?.length || 0,
      productClaims: result.intelligence.productPricing?.productClaims.length || 0,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
