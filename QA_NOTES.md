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

## Environment-access findings

The sandbox browser did not hold an authenticated Neon session and displayed the Neon sign-in page. Project-level Neon access was subsequently enabled and used through the database integration instead. A separate `company-intelligence-staging` branch was created from production; its connection string has been retrieved for user delivery but has not been configured in Railway or written into the repository.

The Railway token supplied for staging provisioning was tested against the official GraphQL endpoint as both an account/workspace Bearer token and a project token. It returned `Not Authorized` and `Project Token not found`, respectively. No Railway mutation has been attempted.

The Railway browser session is also unauthenticated: the new-service route resolves to the public Railway site and presents a Sign in control. The supplied Railway token was rejected by the documented account/workspace and project-token authentication paths, so no service or variable mutation can be safely issued through Railway at this time.
