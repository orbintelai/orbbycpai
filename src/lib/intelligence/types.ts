export type IntelligenceModule =
  | "people"
  | "news"
  | "hiring"
  | "compliance"
  | "integrations"
  | "productPricing"
  | "techStack";

export type ModuleStatusKind = "published" | "not_published" | "blocked" | "unavailable";

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
  url: string;
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
}

export interface SourceManifest {
  origin: string;
  homepageUrl: string;
  pages: SourcePage[];
  moduleCandidates: Record<IntelligenceModule, string[]>;
  blockedUrls: Record<string, string>;
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

export interface TechnologySignal {
  name: string;
  category: "Ecommerce" | "Analytics" | "Support" | "Marketing" | "CDP" | "Payments" | "CRM" | "Framework" | "CDN" | "Tag Manager";
  artifact: string;
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
  /** Tier 1 detection from artifacts rendered by the target's own live site. */
  techStack?: TechnologySignal[];
  moduleStatuses: Record<IntelligenceModule, ModuleStatus>;
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
