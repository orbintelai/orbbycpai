# Company Intelligence Data Map

**Purpose.** Orb is organized as a company-research workspace for a person preparing for a meeting, campaign, or account decision. The default report answers what the company does, where it is active, what it publicly publishes, and what has changed. It does not treat model interpretation or design classification as first-party fact.

## Information hierarchy

The default **Company Intelligence** tab places sourced company research immediately after the company summary. The retained visual, tonal, and classification output appears later as **Brand & Design Context**. **AI Perception** remains a distinct model-analysis tab because its value comes from showing how multiple models describe the company, not from presenting it as verified company evidence.

| Surface | Research question | Data available now | Source boundary shown in product |
|---|---|---|---|
| Company Summary | What does the company say it does? | Existing classification one-liner and positioning signal | Summary context; not presented as a first-party claim |
| Product & Pricing | What does the company publish about its offering, pricing, and conversion path? | First-party product and pricing pages, claims, CTA, and source excerpts | First-party source links and hoverable excerpts |
| Integrations | Which technology relationships or integration listings are publicly published? | First-party integration directories and integration evidence | First-party source links; explicit source-state labels when unavailable |
| News Signals | What has the company recently published or announced? | First-party newsroom, press, and publication pages | First-party source links and dates |
| Key People | Who does the company publicly identify? | First-party team, leadership, and company pages | First-party source links and hoverable excerpts |
| Hiring Signals | Where is the company investing or expanding? | First-party careers and jobs pages | First-party source links and role summaries |
| Compliance & Trust | What security, privacy, or compliance claims are publicly published? | First-party trust, security, legal, and compliance pages | First-party source links and hoverable excerpts |
| AI Perception | How do ChatGPT, Claude, and Gemini describe and categorize the company? | Separate model responses based on model training data and the analysis prompt | Explicitly labeled model analysis, never first-party evidence |
| Competitor Comparison | How do a primary company and chosen competitors differ across the saved records? | Immutable primary and competitor snapshots, evidence-constrained strategist output | A persisted comparison run with separate factual and strategist states |
| What Changed | What deterministically changed from the prior saved snapshot? | Immutable snapshot lineage and source-backed module differences | Snapshot comparison; first-party and model analysis remain distinct |
| Brand & Design Context | What visual, tonal, and brand-classification context is useful as supporting background? | Existing design extraction and classification fields | Supporting context, visually separated from sourced company research |

## Current user flow

A new analysis opens on **Company Intelligence**, not AI Perception. This places the account brief first while preserving the multi-model perspective as a differentiated follow-on view. A completed competitor comparison is stored as the latest successful comparison for that primary company report. It is restored after navigation or refresh. Starting a replacement comparison does not erase the existing result; the latest result changes only after the new factual comparison is saved successfully.

## Evidence rules

First-party modules retain source URL, page title, capture timestamp, and excerpt records. Their module state is visible rather than inferred: a source that could not be found, read, or accessed is not represented as proof that the company publishes nothing. Model analysis stays in AI Perception and Competitive Positioning surfaces. Brand and design context remains useful, but it is not allowed to imply factual company evidence.

## Out of scope for this revision

This revision does not add a third-party people-data integration, contact enrichment, email, phone, outbound messaging, sequencing, exports, pricing changes, capacity changes, homepage copy, or production deployment. It reorganizes and labels information that Orb already collects, while repairing persistence for a completed competitor comparison.

## References

[1]: https://github.com/orbintelai/orbbycpai "Orb source repository"
