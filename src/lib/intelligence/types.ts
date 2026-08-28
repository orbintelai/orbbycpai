export type IntelligenceModule =
  | "people"
  | "news"
  | "hiring"
  | "compliance"
  | "integrations"
  | "productPricing";

export type ModuleStatusKind =
  | "published"
  | "blocked"
  | "source_not_found"
  | "source_found_unparsed"
  | "source_empty"
  | "unavailable";

export interface ModuleStatus {
  status: ModuleStatusKind;
  reason: string;
  crawledUrls: string[];
  durationMs: number;
}

export interface EvidenceDraft {
  // Assigned before insertion so the immutable report payload can cite the exact row.
  id: string;
  module: IntelligenceModule;
  entityType: string;
  entityKey: string;
  fieldPath: string;
  sourceUrl: string;
  sourcePageTitle: string;
  excerpt: string;
  capturedAt: Date;
  contentHash: string;
}

export interface EvidenceReference {
  id: string;
  sourceUrl: string;
  sourcePageTitle: string;
  excerpt: string;
  capturedAt: string;
}

export interface SourcePage {
  /** Final URL after redirects. */
  url: string;
  /** URL requested by Orb before redirects; used for reliable per-module source state. */
  requestedUrl?: string;
  title: string;
  text: string;
  html: string;
  /** HTML after navigation, footer, consent, and other chrome are removed. */
  contentHtml: string;
  discoveredAt: Date;
  sourceKind: "homepage" | "first_party" | "rss" | "sitemap" | "ats";
  blocked?: boolean;
  blockReason?: string;
  linkedFrom?: string;
  /** A successful route that serves the canonical homepage rather than its requested content. */
  softNotFound?: boolean;
  /** HTTP status is retained for source-state diagnostics and evidence quality. */
  httpStatus?: number;
  /** Transport failure separate from a valid but non-content source response. */
  fetchError?: string;
}

export interface ModuleDiscoveryTelemetry {
  candidateCount: number;
  pagesConsumed: number;
  pagesDeferredByBudget: number;
}

export interface DiscoveryTelemetry {
  pageBudget: number;
  pagesConsumed: number;
  pagesDeferredByBudget: number;
  candidateCounts: Record<IntelligenceModule, number>;
  moduleMetrics: Record<IntelligenceModule, ModuleDiscoveryTelemetry>;
}

export interface SourceManifest {
  origin: string;
  homepageUrl: string;
  pages: SourcePage[];
  moduleCandidates: Record<IntelligenceModule, string[]>;
  blockedUrls: Record<string, string>;
  discoveryTelemetry: DiscoveryTelemetry;
}

export interface PersonSignal {
  name: string;
  title: string;
  headshotUrl?: string;
  evidence: EvidenceReference[];
}

export interface NewsSignal {
  headline: string;
  publishedAt?: string;
  url: string;
  summary: string;
  label: "Funding" | "Product" | "Partnership" | "Leadership" | "Award" | "Event" | "Other";
  evidence: EvidenceReference[];
}

export interface HiringSignals {
  totalOpenRoles: number;
  byDepartment: Array<{ name: string; count: number }>;
  byLocation: Array<{ name: string; count: number }>;
  roles: Array<{ title: string; department?: string; location?: string; url?: string; leadership: boolean; evidence: EvidenceReference[] }>;
}

export interface ComplianceClaim {
  framework: "SOC 2" | "ISO 27001" | "HIPAA" | "GDPR" | "PCI" | "FedRAMP";
  claim: string;
  evidence: EvidenceReference[];
}

export interface IntegrationSignal {
  name: string;
  url?: string;
  evidence: EvidenceReference[];
}

export interface ProductPricingSignal {
  productClaims: string[];
  targetCustomerClaims: string[];
  primaryCta?: string;
  pricingStatement?: string;
  /** Exact first-party evidence for each displayed claim or pricing statement. */
  claimEvidence: Record<string, EvidenceReference[]>;
  targetCustomerEvidence: Record<string, EvidenceReference[]>;
  pricingEvidence?: EvidenceReference[];
  evidence: EvidenceReference[];
}

export interface CompanyIntelligence {
  version: "v1";
  sourcePolicy: "first_party_only";
  generatedAt: string;
  people?: PersonSignal[];
  news?: NewsSignal[];
  hiring?: HiringSignals;
  compliance?: ComplianceClaim[];
  integrations?: IntegrationSignal[];
  productPricing?: ProductPricingSignal;
  moduleStatuses: Record<IntelligenceModule, ModuleStatus>;
  /** First-party crawl accounting persisted with the immutable report for coverage QA. */
  discoveryTelemetry?: DiscoveryTelemetry;
}

export interface IntelligenceRunResult {
  intelligence: CompanyIntelligence;
  evidence: EvidenceDraft[];
  moduleStatuses: Record<IntelligenceModule, ModuleStatus>;
  durationMs: number;
}

export interface SnapshotChange {
  module: IntelligenceModule | "aiPerception";
  type: "added" | "removed" | "changed";
  label: string;
  detail: string;
  beforeEvidence?: EvidenceReference[];
  afterEvidence?: EvidenceReference[];
}

export interface WhatChangedResult {
  hasPreviousSnapshot: boolean;
  previousGenerationId?: string;
  changes: SnapshotChange[];
}
