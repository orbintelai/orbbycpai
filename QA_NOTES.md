# Company Intelligence Release — QA Notes

## Local homepage visual verification

- **Date:** 2026-08-26
- **Environment:** Local production build, `http://localhost:3000`
- **Result:** Rendered successfully with the required dark Orb aesthetic, teal glow, clean high-contrast hero, live URL entry panel, pricing removed, beta entitlement copy visible, and the ten approved intelligence-signal cards present.
- **Hero copy:** “Know the company. Before the call.”
- **Runtime claim:** No public duration claim is present. This remains intentionally deferred until staging measures three full runs.
- **Copy correction:** The duplicate outer beta line was removed. The rebuilt homepage was visually rechecked; the entitlement now appears once beneath the URL input.

## Local source collector smoke test

- **Target:** `https://preply.com`
- **Paid model calls:** None.
- **Result after source-policy correction:** 16.7 seconds, 10 evidence records, Product & Pricing published with 5 claims. The collector correctly marked People, News, Hiring, Compliance, and Integrations as `not_published` where qualifying first-party signals were not present.
- **Policy correction applied:** Generic editorial blogs and resource hubs are no longer treated as Company News Signals; this avoids conflating educational content with corporate updates.

## Compilation / build checkpoints

- `npx tsc --noEmit`: passed after current changes.
- `pnpm build`: passed. The local bundle exposes the new snapshot diff and evidence export routes.

## Remaining before staging user QA

1. Create a separate Railway staging service and Neon database branch; Railway credentials are not available in the current session.
2. Apply migration `0002_company_intelligence_foundation.sql` only to staging.
3. Verify authenticated full run, evidence write, snapshot diff, 10-report quota, platform reserve, comparison persistence, and WAF skip behavior.
4. Run three owner-selected staging URLs, then execute one premium-model evaluation run after verifying model IDs from each provider API.
