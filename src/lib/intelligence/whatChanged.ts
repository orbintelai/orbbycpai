import type { BrandProfile } from "@/lib/pipeline/classifyBrand";
import type { CompanyIntelligence, SnapshotChange, WhatChangedResult } from "./types";

function normalized(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function display(value: string | undefined | null): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function mapBy<T>(values: T[] | undefined, key: (value: T) => string): Map<string, T> {
  return new Map((values || []).map((value) => [key(value), value]));
}

function setChanges(module: SnapshotChange["module"], label: string, before: Iterable<string>, after: Iterable<string>, detailPrefix: string): SnapshotChange[] {
  const prior = new Set([...before].filter(Boolean).map(normalized));
  const current = new Set([...after].filter(Boolean).map(normalized));
  const output: SnapshotChange[] = [];
  for (const value of current) if (!prior.has(value)) output.push({ module, type: "added", label, detail: `${detailPrefix}: ${value}` });
  for (const value of prior) if (!current.has(value)) output.push({ module, type: "removed", label, detail: `${detailPrefix}: ${value}` });
  return output;
}

export function buildWhatChanged(input: { previous?: BrandProfile | null; current: BrandProfile; previousGenerationId?: string }): WhatChangedResult {
  if (!input.previous) return { hasPreviousSnapshot: false, changes: [] };

  const previous = input.previous.companyIntelligence;
  const current = input.current.companyIntelligence;
  if (!previous || !current) return { hasPreviousSnapshot: true, previousGenerationId: input.previousGenerationId, changes: [] };

  const changes: SnapshotChange[] = [];
  const priorPeople = mapBy(previous.people, (person) => normalized(person.name));
  const currentPeople = mapBy(current.people, (person) => normalized(person.name));
  for (const [key, person] of currentPeople) {
    const prior = priorPeople.get(key);
    if (!prior) changes.push({ module: "people", type: "added", label: "New key person", detail: `${person.name} — ${person.title}`, afterEvidence: person.evidence });
    else if (normalized(prior.title) !== normalized(person.title)) changes.push({ module: "people", type: "changed", label: "Leadership title changed", detail: `${person.name}: ${prior.title} → ${person.title}`, beforeEvidence: prior.evidence, afterEvidence: person.evidence });
  }
  for (const [key, person] of priorPeople) if (!currentPeople.has(key)) changes.push({ module: "people", type: "removed", label: "Key person no longer listed", detail: `${person.name} — ${person.title}`, beforeEvidence: person.evidence });

  const priorNews = mapBy(previous.news, (item) => item.url);
  const currentNews = mapBy(current.news, (item) => item.url);
  for (const [key, item] of currentNews) if (!priorNews.has(key)) changes.push({ module: "news", type: "added", label: "New company news", detail: item.headline, afterEvidence: item.evidence });

  const priorRoles = previous.hiring?.totalOpenRoles || 0;
  const currentRoles = current.hiring?.totalOpenRoles || 0;
  if (priorRoles !== currentRoles) changes.push({ module: "hiring", type: "changed", label: "Open roles changed", detail: `${priorRoles} → ${currentRoles} publicly listed roles` });
  changes.push(...setChanges("hiring", "New hiring department", previous.hiring?.byDepartment.map((item) => item.name) || [], current.hiring?.byDepartment.map((item) => item.name) || [], "Hiring activity now listed in"));

  changes.push(...setChanges("compliance", "Compliance claim added", previous.compliance?.map((item) => item.framework) || [], current.compliance?.map((item) => item.framework) || [], "First-party claim"));
  changes.push(...setChanges("integrations", "Integration added", previous.integrations?.map((item) => item.name) || [], current.integrations?.map((item) => item.name) || [], "Integration"));

  const priorPricing = display(previous.productPricing?.pricingStatement);
  const currentPricing = display(current.productPricing?.pricingStatement);
  if (normalized(priorPricing) !== normalized(currentPricing) && (priorPricing || currentPricing)) changes.push({ module: "productPricing", type: "changed", label: "Pricing statement changed", detail: `${priorPricing || "No prior public statement"} → ${currentPricing || "No current public statement"}` });
  changes.push(...setChanges("productPricing", "Product claim added", previous.productPricing?.productClaims || [], current.productPricing?.productClaims || [], "New published claim"));

  const previousPerception = input.previous.aiPerception;
  const currentPerception = input.current.aiPerception;
  if (previousPerception && currentPerception) {
    for (const key of ["openai", "anthropic", "google"] as const) {
      const modelName = currentPerception[key]?.model || previousPerception[key]?.model || key;
      for (const field of ["positioningDelta", "categoryAnchor"] as const) {
        const before = display(previousPerception[key]?.[field]);
        const after = display(currentPerception[key]?.[field]);
        if (normalized(before) !== normalized(after) && (before || after)) changes.push({ module: "aiPerception", type: "changed", label: `${modelName}: ${field === "positioningDelta" ? "Positioning Delta" : "Category Anchor"}`, detail: `${before || "No prior model result"} → ${after || "No current model result"}` });
      }
    }
  }

  return { hasPreviousSnapshot: true, previousGenerationId: input.previousGenerationId, changes: changes.slice(0, 30) };
}

export function companyIntelligenceOf(profile: BrandProfile): CompanyIntelligence | undefined {
  return profile.companyIntelligence;
}
