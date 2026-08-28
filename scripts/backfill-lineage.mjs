import { neon } from "@neondatabase/serverless";
import { getDomain } from "tldts";

if (process.env.LINEAGE_BACKFILL_CONFIRM !== "staging-only") {
  throw new Error("Refusing lineage backfill without LINEAGE_BACKFILL_CONFIRM=staging-only");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  SELECT id, brand_url
  FROM generations
  WHERE submitted_url IS NULL
     OR resolved_url IS NULL
     OR registrable_domain IS NULL
     OR lineage_status IS NULL
`;

let updated = 0;
let unresolved = 0;
for (const row of rows) {
  let registrableDomain = null;
  try { registrableDomain = getDomain(new URL(row.brand_url).hostname, { allowPrivateDomains: false }) || null; } catch {}
  if (!registrableDomain) unresolved += 1;
  await sql`
    UPDATE generations
    SET submitted_url = COALESCE(submitted_url, ${row.brand_url}),
        resolved_url = COALESCE(resolved_url, ${row.brand_url}),
        registrable_domain = COALESCE(registrable_domain, ${registrableDomain}),
        redirect_chain = COALESCE(redirect_chain, '[]'::jsonb),
        lineage_status = COALESCE(lineage_status, 'legacy_backfilled')
    WHERE id = ${row.id}
  `;
  updated += 1;
}

console.log(JSON.stringify({ updated, unresolved, snapshotVersionsModified: false }, null, 2));
