# Orb Pipeline Rules

Decisions, constraints, and hard-won lessons for the Orb extraction and generation pipeline.
Each rule documents **what** the rule is, **why** it exists, and **what broke** without it.

---

## 1. Pop-up / Consent Banner Suppression

### Rule
Pop-up suppression selectors in `extractDom.ts` **must cover all major consent/cookie vendors by their vendor-specific prefix**, not just generic class names like `[class*='cookie']` or `[class*='modal']`.

### Why
Each consent platform uses its own CSS class prefix. Generic selectors miss vendor-specific elements. When a cookie consent bar is not suppressed, it becomes the highest-scoring area element in the color palette (because it is large, fixed-position, and white), contaminating `classifyVisual` with the wrong brand colors.

**What broke:** Magic Mind's `classifyVisual` returned `brandPrimary: #1c1b1b` (near-black) and `accentColor: null` because `div.cky-consent-bar` (CookieYes) was not suppressed. It scored as the top area element with `score=47`, drowning out the actual brand palette.

### Known vendor prefixes — all must be in the selector list

| Vendor | CSS prefix | Notes |
|---|---|---|
| CookieYes | `cky-` | e.g. `div.cky-consent-bar` |
| OneTrust | `onetrust-` | e.g. `#onetrust-banner-sdk` |
| Osano | `osano-` | e.g. `div.osano-cm-window` |
| Cookiebot / Cybot | `CybotCookie` | e.g. `#CybotCookiebotDialog` |
| TrustArc / TRUSTe | `trustarc`, `truste` | |
| Termly | `termly` | |
| Complianz | `cmplz` | |
| Usercentrics | `usercentrics` | |

### Broader principle
When a new consent vendor is discovered in the wild (visible in `scoredPalette` sources), add its prefix to **both**:
1. The post-load DOM removal selector list in `extractDom.ts` (lines ~209–231)
2. This document

Do not patch individual brands. Fix the suppression list so all future brands benefit.

---

## 2. Color Extraction: Exclude Fixed-Position Overlays from Area Scoring

### Rule
The browser-side area color scanner (`extractDom.browser.js`) must skip elements that are `position: fixed` or `position: absolute` with high `z-index`, as these are almost always UI overlays (cookie bars, chat widgets, sticky headers) rather than brand background colors.

### Status
Partially addressed via post-load DOM removal. The area scanner itself does not yet filter by position — tracked as a future improvement.

---

## 3. classifyVisual Returns Null Colors: Root Cause Checklist

If `classifyVisual` returns `brandPrimary: null` or `accentColor: null`, check in this order:

1. **Cookie/consent bar not suppressed** — check `scoredPalette` sources for `cky-`, `onetrust-`, etc. Fix: add vendor prefix to suppression list.
2. **DNS failure** — check logs for `net::ERR_NAME_NOT_RESOLVED`. The extractor ran against a browser error page. Fix: verify the domain resolves.
3. **scoredPalette has only white/black** — the page loaded but no brand colors were found. Check if the site uses a CSS-in-JS framework that inlines styles at runtime (e.g. Emotion, styled-components). Fix: increase post-load wait time or add CSS variable extraction.
4. **Claude Vision parse failure** — check logs for `[classifyVisual] Failed to parse Claude response`. The fallback assigns roles by score order, which may produce nulls if the palette is all-neutral.

---

## 4. colorTheme Drives Layout Selection — Must Reflect Background, Not Photography

### Rule
`colorTheme` in the Creative Strategist output must be derived from the **page background luminance**, not from the mood of the brand photography.

### Why
Magic Mind uses moody, dark-toned lifestyle photography but has a light sage-green website background. If `colorTheme=dark` is inferred from photography style, the pipeline selects `dark-field-hero` layout for every generation, which is wrong for light-background brands.

### Rule
If `backgroundLuminance > 0.6` (light background), `colorTheme` must be `light` regardless of photography mood. The layout selector maps `light + social_proof + hasStat → split-stat`.

---

## 5. One Fix, One Commit

When a pipeline bug is found, fix exactly one root cause per commit. Do not bundle multiple fixes. This makes it possible to bisect regressions and confirm each fix independently before moving to the next.

## 6. The Quality Bar & Extraction Architecture (Phase 1)

### Rule
The automated pipeline must replicate the manual POC process:
1. Navigate to the brand's website in a real browser.
2. Visually inspect the rendered page (colors, fonts, hero image, copy).
3. Pull exact CSS values via `getComputedStyle` and `document.fonts` in the browser console.
4. Download key images directly from the page.
5. Read headlines, stats, and testimonials as visible text.
6. Choose the layout that best showcases the strongest available asset.
7. Build the HTML with everything correctly applied.

### Why
Headless scraping of unrendered DOMs (Puppeteer) fails on modern CSS-in-JS, WebGL, and anti-bot sites. The extraction engine must use a real browser to ensure visual rendering is complete before extraction.

## 7. Product Page Deep Dive

### Rule
The extraction engine MUST navigate to at least one product page in addition to the homepage.

### Why
Homepages are for marketing; product pages have the substance. Product pages contain ingredient lists, clinical claims, specific stats, and SKU-level copy. This is the material that makes generated copy credible, not generic.

## 8. Redundancy & Fallbacks

### Rule
Every AI call must have a non-AI fallback. If the perfect color cannot be extracted, use a close approximation. Degraded output is better than no output. Log every failure with context (URL, screenshot, extracted data, failed step) to allow for manual review.

## 9. Dual-Ingestion Model

### Rule
The platform must support both Auto-Extract (paste a URL) and Manual Profile (Brand Repository). The Manual Profile is a first-class feature, not a fallback, allowing users to upload hex codes, fonts, and product images directly into a persistent workspace.

## 10. Platform Aesthetic

### Rule
The platform aesthetic is light, warm backgrounds (e.g., `#FAF8F4` cream/off-white). Dark mode is retired. Use fluorescent accents (teal `#00e5a0`, hot pink `#ff01c7`, electric yellow `#e1ff00`) aggressively. Retain all UFO imagery and iconography. Typography must be clean, modern, confident, and large.

## 11. Development Principles

### Rule
- **Ask Before Building:** Always ask clarifying questions before building. Never start coding without confirming the approach first.
- **No Scope Creep:** Never add features that weren't explicitly requested. Build the simplest version that works, then wait for approval.
- **Diagnose Before Fixing:** When something fails, diagnose the root cause before attempting a fix. Never try more than one solution at a time.
- **Verify Completion:** Always confirm what you built works before declaring a step complete.

## 12. Subtext Design Rule — Legibility and Purpose

### Rule
Subtext on all generated images is subject to three hard constraints:

1. **12-word cap.** Subtext must never exceed 12 words. Social posts are viewed at thumbnail size on phones. If it takes more than a glance to read, it is doing the wrong job.
2. **Stat-reinforcing, not descriptive.** Subtext does not describe the product. It does one thing: reinforce the headline and/or the stat. For `split-stat` layouts, subtext names what the product is and echoes the stat's credibility (e.g. "Prebiotic soda with 9g of fiber. Zero compromise.").
3. **Minimum 40px on a 1080px canvas.** WCAG AA requires 4.5:1 contrast ratio. On a 1080px canvas rendered to a phone screen, subtext must be set at no smaller than 40px in the HTML compositor. This is a hard requirement, not a design preference.

### Why
In the POC images, subtext was illegible on mobile for users with any degree of visual impairment. A senior designer solves this with hierarchy over volume: the headline persuades, the stat credentializes, the subtext names. Three jobs, three elements, nothing more.

### Applied to layout_selector.py
The `write_subtext()` function applies this rule automatically:
- For `split-stat`: generates a stat-reinforcing line using the selected stat's value and label.
- For other layouts: caps the hero subheadline at 12 words, or falls back to the top two key messages.

### Applied to the compositor
The HTML template for every layout must enforce `font-size: 40px` minimum for subtext on a 1080px canvas. No CSS default or relative sizing may produce a smaller result.

## 13. Data Model: Generation Key is Product URL, Not Brand

### Rule
The `generations` table uses `brand_url` as its primary input field. **This column name is wrong and must be migrated to `product_url`.** A generation record represents a single pipeline run against a specific URL input — which may be a product page, a homepage, or any other URL the user provides. It is not a brand-level record.

### Why
A brand with 50 SKUs should produce 50 generation records, each scoped to a specific product page URL. Naming the column `brand_url` implies brand-level scope and conflates brand identity with product-level content generation. The `brand_id` foreign key correctly links the generation to the brand entity; the generation itself is keyed to the input URL.

### Migration Requirements
When this migration runs:
1. Rename `brand_url` → `product_url` in the `generations` table.
2. **Audit all existing `brand_url` values that are homepages.** Do not silently rename them. For any row where `brand_url` is a homepage (e.g., `https://magicmind.com`), flag it in the record's `brand_profile._orb.inputType` as `"brand"`. For rows where a product URL is known, update the value.
3. Update all code references: `DashboardClient.tsx`, `generate/route.ts`, `generations/route.ts`, `schema.ts`, `drizzle.config.ts`, and any seed scripts.
4. This is a breaking schema change. Run it as a standalone migration with a rollback plan. Do not bundle it with other changes.

### Status
**Deferred.** Flagged 2026-04-06. Implement as a standalone migration in a future session.

---

## 14. URL Intent: Homepage vs. Product Page

### Rule
The URL the user inputs is their creative brief. The pipeline must detect and respect the intent of the URL:

- **Homepage URL** (e.g., `https://magicmind.com`) → Generate brand awareness content. Scrape the homepage only. Do not crawl to product pages.
- **Product URL** (e.g., `https://drinkolipop.com/products/vintage-cola`) → Generate product-specific content. Scrape that page only. Do not fall back to the homepage.

No crawling. No inference. No mixing of homepage and product page data in a single generation run.

### UI Requirement
The generate form must display a single confirmation line below the URL input field **before** the user submits, showing detected intent:

- For a homepage: `Generating brand content from homepage`
- For a product page: `Generating product content for [product name]` (where product name is parsed from the URL slug or page title if available)

This confirmation line is not optional. It is the user's only signal that the system understood their input correctly before a generation run starts.

### Implementation Notes
- Intent detection is URL-structure-based, not AI-based. A URL containing `/products/`, `/shop/`, `/item/`, `/p/`, or `/collections/[name]/products/` is a product URL. All others default to homepage/brand intent.
- The confirmation line must update in real time as the user types, with no submit required.
- The `brand_profile._orb.inputType` field must be set to `"product"` or `"brand"` on every generation record to preserve this distinction for calibration and analytics.

---
## 15. Asset Ranking: Claude Vision Hero Image Selection

### Rule
After downloading candidate brand assets, run a single Claude Vision batch call to rank them before the Image Director agent runs. This ensures the Image Director receives visual quality scores, not just text metadata.

### Implementation
- `rankHeroAssets()` in `src/lib/pipeline/rankHeroAssets.ts`
- Filters candidates: width ≥ 300px, height ≥ 300px, not GIF, file exists locally
- Sorts candidates: inHero first, then by pixel area (largest first)
- Takes top 10 candidates, sends all in a single Claude Vision call (claude-haiku-4-5-20251001)
- Scores each on three criteria:
  - **Product Visibility** (0–3): Is the product clearly visible and the main subject?
  - **Background Cleanliness** (0–3): Is the background solid/clean/transparent?
  - **Hero Usability** (0–4): How well would this work as the main visual anchor in a social post?
- Returns `rankedAssets[]` (sorted by totalScore desc) and `heroAssetIndex` (index into original downloadedAssets)
- Both are stored on `brandProfile.brandAssets`

### Image Director Integration
- `compositorAgents.ts` Image Director receives Vision Scores and heroReason for each candidate
- Instruction added: "If Vision Scores are provided, strongly prefer the image with the highest score unless the visual concept explicitly requires a different scene"

### Color Quantization Integration
- `runPipeline.ts` color quantization pass now reads `heroAssetIndex` from the ranked result
- Falls back to `inHero` flag, then first asset if ranking is unavailable

### Fallback
- Non-fatal: if ranking fails, falls back to inHero[0] as before
- One batch call per generation run — not per post

### Rationale
The Image Director was previously guessing from alt text and URL patterns. For DTC brands (Liquid Death, OLIPOP, Poppi), the product image is the largest, squarest, most prominently placed asset — but alt text is often empty. Vision scoring eliminates the guesswork and ensures the correct hero asset is selected.

### Committed
`abedf3f` (rankHeroAssets + classifyBrand + compositorAgents), `6e57146` (runPipeline color quantization)

---


---

## 16. Company Intelligence Evidence and Source Policy

### Rule
Every factual Company Intelligence claim must be sourced from a **first-party company page** and persist an evidence record containing the source URL, page title, direct excerpt, capture timestamp, module, entity key, and content hash. Each report item exposes its evidence in the UI and export.

### Explicit exception
AI Perception and Competitive Position are model analysis, not first-party claims. They must remain clearly labeled with the contributing model(s) and must never be presented as verified company-site facts.

### Why
A credibility product cannot make sourced and model-derived claims look equivalent. Evidence is captured during extraction, rather than retrofitted, because deterministic citations and snapshot diffs depend on it.

---

## 17. Immutable Company Snapshots and What Changed

### Rule
Every fresh profile run appends a new generation/snapshot. It must never overwrite or delete an earlier completed snapshot. `What Changed` compares the current snapshot with the immediately prior completed snapshot for the same canonical domain and only reports deterministic, source-backed additions, removals, or changed values.

### Why
Historical reports are the basis for trust and explainability. A cache is an optimization; it is not a substitute for an immutable evidence ledger.

---

## 18. Capacity, Entitlement, and Admin Reserve

### Rule
Normal beta accounts receive **10 full reports per UTC calendar month**. `tyler@yanaapp.com` bypasses that personal limit. The platform maintains a monthly shared pool of **300 fresh full-profile units** plus a **20-unit admin-only reserve**. Normal accounts can never consume the reserve; the admin account draws from it only after shared capacity is exhausted. The hard maximum is 320 fresh profile units per month.

The application reserves **$0.05 per fresh full-profile unit** against the platform cost envelope. Dashboard-only notices appear at 50% and 80% aggregate capacity. No transactional-email provider is in scope.

### Why
Per-account quotas prevent one visitor from consuming the beta. The shared ceiling protects aggregate spend. The separate admin reserve ensures external traffic cannot lock the owner out of a daily-use tool.

---

## 19. Competitor Comparison Persistence

### Rule
A completed comparison persists per primary company until the user submits a new competitor set. Tab switches and page refreshes must not discard the result. This behavior is independent of snapshot caching and must not be changed by Company Intelligence work.

---

## 20. Staging, Premium-Model Evaluation, and Production Safety

### Rule
The Company Intelligence release is built and migrated on an isolated staging branch and database. Production remains unchanged until the owner personally QA-tests three companies and explicitly approves cutover.

During the three staging tests, run one company's AI Perception through a larger model from each provider in an evaluation-only path. Capture cost and qualitative differences in Positioning Delta and Category Anchor. Do not alter the production model mix without a separate owner decision.

---

## 21. Dynamic Directory Sources

### Rule

Orb does **not** automatically render, scroll, click, wait for client-side XHR, or otherwise operate a dynamic directory page to recover factual module data. When a robots-authorized, first-party candidate exposes no static document content, preserve `source_empty` and show: **“This page loads its content dynamically — open it directly.”** The message links to the exact fetched first-party source URL.

### Why

The staging-only one-render Integrations pilot recovered zero entries from both HubSpot Marketplace and Dropbox Apps while adding 12.6–18.7 seconds of latency (and a HubSpot navigation timeout). A user-triggered version is also out of scope: operating a site after load changes Orb’s deliberate posture from reading publicly served documents to interacting with a remote application.

---

## 22. Source Content and Path Boundaries

### Rule

Source cleaning removes interactive form controls (`input`, `select`, `textarea`, and `button`) but never removes a generic enclosing `form`. Form-wrapped published content must remain available to every factual module. Navigation, headers, footers, consent UI, and related chrome remain excluded.

Allowlisted source-path matching supports delimiter-bounded hyphenated public variants for all factual modules, including `/about-us`, `/company-news`, `/press-releases`, `/app-integrations`, `/trust-center`, `/meet-the-team`, `/open-roles`, and `/product-pricing`. The matching must not overmatch `/newsletter` as news or `/company/management` as news.

### Why

The former generic `form` selector silently removed 41,874 characters from Dropbox’s rendered body. A matched eight-domain current-versus-legacy no-model control found 35 form-wrapped pages; the control changed no current module status, item count, or evidence count in that sample, but the boundary defect is real and cross-module. The path fix recovered Anagram’s published People data from `anagramhq.com/about-us/` and HubSpot’s published News data from `www.hubspot.com/company-news` without treating all `/company/...` pages as news.

### Verification

`/newsletter` does not match News; `/company/management` matches People but not News. Full application TypeScript compilation and production build passed locally. No production or staging deployment occurred.

---

---

## 23. Fair Allocation and Shallow Source Selection

### Rule

The fixed first-party source allocation is **18 pages**: six factual modules with a maximum of three pages each. Candidate ordering within each module is deterministic and two-tiered: **(1)** homepage-discovered links, then one-hop hub links, then explicit root/nested probes; **(2)** ascending URL path depth within each tier, followed by original discovery order as the tie-breaker. This keeps a company-published path such as `/company/about-us` ahead of a speculative `/about` probe, while favoring a directory/index page such as `/trust` over `/trust/cookie-policy` when both originate in the same tier.

### Why

The prior 16-page allocation could never fulfill six three-page module caps. Across the eight-domain measurement, Hiring and Compliance were each capped at two pages in all eight runs. The 18-page correction restores the existing configured per-module allocation; it is not a discovery-budget expansion beyond those caps.

---

## 24. SPA Catch-All Availability Guard

### Rule

When every successful first-party route response is a soft-404 match to the homepage hash and all remaining selected route requests abort, retain only the homepage and classify source modules from that honest homepage-only manifest. Do not emit `unavailable` merely because a static SPA shell served identically for its candidate paths.

### Why

TylerMatheny.com returned an identical 12-character static shell for every successfully fetched candidate route, while remaining parallel requests hit the 10-second request timeout. This is a catch-all SPA posture, not evidence that six independent factual module sources are unavailable. The guard is intentionally strict and does not relabel runs containing a materially distinct source response.

---

## 25. Paessler Integrations False Positive

### Rule

Do not restore Paessler’s historical `Apple Watch` Integration result. It linked to a knowledge-base article rather than a first-party partner-directory entry. Retain `source_found_unparsed` until a qualifying static directory item can be extracted.

### Baseline Treatment

The historical eight-domain raw published count of 14 includes this false positive. The valid comparison baseline is therefore **13 published**.

---

## 26. Resolved-Host Probes and Homepage Structured People Data

### Rule

After the initial homepage request resolves, all first-party root and nested probes must be constructed from the final resolved homepage URL and evaluated against its registrable domain. The submitted input URL remains the lineage input, but it must not determine crawl paths after a valid redirect.

People extraction always evaluates the already-fetched homepage, including valid `application/ld+json` Person records, before source-route outcomes determine absence. Homepage JSON-LD is first-party evidence even when a static SPA shell has little visible text.

### Why

`anagram.io` resolves to `anagramhq.com`; building probes from the submitted host sent every guessed people path to the wrong host and produced HTTP 404 despite a published `/about-us/` page with five named people. TylerMatheny.com publishes a Person JSON-LD record in the document head while its visible SPA body is only a static shell. Structured data must not be excluded by source-route candidate selection.

---

## 27. Evidence-Bound Competitive Strategist and Directionality

### Rule

Competitive Position uses a dedicated strategist restricted to a pre-filtered object containing only first-party Product & Pricing, Integrations, and Compliance claims plus labelled OpenAI, Anthropic, and Google Category Anchor and Positioning Delta outputs. It does not browse or use unprovided background knowledge. Every conclusion names its evidence type and source inline.

The five visible sections remain prose: **Where each of you sits**, **What you both claim**, **What only you can say**, **Where they’re exposed**, and **What to lead with**. Each is capped at three concise sentences. The final sales move must be executable language a representative can say or ask, rooted in a primary-company input.

Directional competitive-pressure claims are stricter than overlap claims. The strategist may state that the primary company pressures, exposes, or threatens a competitor only when the competitor’s own Category Anchor or Positioning Delta explicitly names the primary company. Shared category membership, one-sided positioning, or a primary first-party claim is insufficient. Otherwise the narrative-tension field must explicitly say that no directional pressure is supported by the record.

### Why

A prior comparison asserted that Richpanel creates pressure on Zendesk, Gorgias, and Gladly even though their own model category anchors did not name Richpanel. That is an unsupported directional claim. Evidence-supported overlap may remain useful, but it cannot be upgraded to reciprocal competitive pressure without reciprocal evidence.

---

## 28. Streamed Comparison, Canonical Reuse, and Deferred Strategist

### Rule

Competitor reuse is resolved before any capacity reservation using completed snapshots younger than seven days and the submitted URL’s PSL registrable-domain identity, with exact submitted URL compatibility for pending cross-domain redirects. Unconfirmed aliases never merge cache identities. A cache hit performs no extraction, model call, capacity reservation, or capacity completion.

Comparisons stream factual progress and return the factual table once profile resolution completes. Fresh competitor resolution is limited to two concurrent workers. Strategist analysis is a separate authenticated request and cannot block factual delivery.

Each comparison records its primary and competitor generation IDs. Strategist output is persisted per `(comparison_id, competitor_generation_id)` and the endpoint accepts only a user-owned comparison plus a competitor ID recorded in that comparison. Arbitrary generation IDs are rejected.

### Why

Exact `brand_url` equality missed completed `www` snapshots for Zendesk, Gorgias, and Gladly, causing unnecessary full reruns. A single blocking route also held the client spinner after factual snapshots had completed. Comparison membership prevents globally reusable competitor records from becoming a UUID-addressable evidence endpoint.

---
