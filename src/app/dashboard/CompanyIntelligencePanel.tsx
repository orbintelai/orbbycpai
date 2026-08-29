"use client";

import { useEffect, useState } from "react";
import type { CompanyIntelligence, EvidenceReference, IntelligenceModule, ModuleStatus, SnapshotChange, WhatChangedResult } from "@/lib/intelligence/types";

const LABELS: Record<IntelligenceModule, string> = {
  people: "Key People",
  news: "News Signals",
  hiring: "Hiring Signals",
  compliance: "Compliance & Trust",
  integrations: "Integrations",
  productPricing: "Product & Pricing",
};

const MODULES: IntelligenceModule[] = ["productPricing", "integrations", "news", "people", "hiring", "compliance"];

const cardStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(255,255,255,0.025)",
  borderRadius: 12,
  padding: "16px 18px",
};

function EvidenceLinks({ items }: { items?: EvidenceReference[] }) {
  if (!items?.length) return null;
  return (
    <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", marginLeft: 8, verticalAlign: "middle" }}>
      {items.slice(0, 3).map((item, index) => (
        <a
          key={item.id}
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer"
          title={`${item.sourcePageTitle}\n\n${item.excerpt}\n\nCaptured ${new Date(item.capturedAt).toLocaleString()}`}
          style={{ fontSize: 10, color: "#50e3c2", textDecoration: "none", border: "1px solid rgba(80,227,194,0.24)", background: "rgba(80,227,194,0.07)", borderRadius: 99, padding: "2px 7px" }}
        >
          Source {index + 1}
        </a>
      ))}
    </span>
  );
}

function ModuleHeading({ module, status }: { module: IntelligenceModule; status?: ModuleStatus }) {
  const tone = status?.status === "published" ? "#50e3c2" : status?.status === "blocked" ? "#f3b562" : status?.status === "source_not_found" ? "rgba(255,255,255,0.38)" : "#e6b7ff";
  const text = status?.status === "published"
    ? "First-party source"
    : status?.status === "blocked"
      ? "Source restricted access"
      : status?.status === "source_not_found"
        ? "No source found"
        : status?.status === "source_empty"
          ? "Source found; no extractable content"
          : status?.status === "source_found_unparsed"
            ? "Found a source we couldn't read"
            : "Source unavailable";
  const sourceUrl = status?.status === "source_found_unparsed" ? status.crawledUrls?.[0] : undefined;
  const style: React.CSSProperties = { color: tone, fontSize: 10, border: `1px solid ${tone}33`, borderRadius: 99, padding: "3px 8px", whiteSpace: "nowrap" };
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "rgba(255,255,255,0.82)", letterSpacing: "0.01em" }}>{LABELS[module]}</div>
      {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" title={`${status?.reason || ""}\n\nOpen source: ${sourceUrl}`} style={{ ...style, textDecoration: "none" }}>{text}</a> : <span title={status?.reason || ""} style={style}>{text}</span>}
    </div>
  );
}

function SourceLimitation({ status }: { status?: ModuleStatus }) {
  const sourceUrl = status?.status === "source_found_unparsed" ? status.crawledUrls?.[0] : undefined;
  return <p style={{ margin: 0, color: "rgba(255,255,255,0.48)", fontSize: 12, lineHeight: 1.6 }}>{status?.status === "source_found_unparsed" ? <>Found a first-party source we couldn’t read{sourceUrl ? <>. <a href={sourceUrl} target="_blank" rel="noreferrer" style={{ color: "#50e3c2", textDecoration: "none" }}>Open source ↗</a></> : "."}</> : status?.reason || "The relevant first-party source could not be interpreted in this run."}</p>;
}

function ModuleCard({ module, status, children }: { module: IntelligenceModule; status?: ModuleStatus; children: React.ReactNode }) {
  return <div style={cardStyle}><ModuleHeading module={module} status={status} />{children}</div>;
}

function CoverageStrip({ statuses }: { statuses: CompanyIntelligence["moduleStatuses"] }) {
  const unavailable = MODULES.filter((module) => statuses[module]?.status === "source_not_found");
  if (!unavailable.length) return null;
  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,0.07)", padding: "13px 2px 0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ color: "rgba(255,255,255,0.34)", fontSize: 11 }}>No source found:</span>
      {unavailable.map((module) => <span key={module} title={`${statuses[module]?.reason || "No qualifying first-party source was found for this module."}\n\nChecked paths:\n${statuses[module]?.crawledUrls?.join("\n") || "No qualifying path was selected."}`} style={{ color: "rgba(255,255,255,0.54)", fontSize: 11, cursor: "help" }}>{LABELS[module]}</span>)}
    </div>
  );
}

export function CompanyIntelligencePanel({ profile, generationId }: { profile: { companyIntelligence?: CompanyIntelligence }; generationId: string }) {
  const intel = profile.companyIntelligence;
  const [showAllCompliance, setShowAllCompliance] = useState(false);
  const download = () => { window.location.assign(`/api/generations/${generationId}/export`); };

  if (!intel) return null;
  const statuses = intel.moduleStatuses;
  const visible = (module: IntelligenceModule, hasPublishedData: boolean) => hasPublishedData || (statuses[module]?.status !== "source_not_found" && Boolean(statuses[module]));
  const complianceClaims = intel.compliance || [];
  const displayedCompliance = showAllCompliance ? complianceClaims : complianceClaims.slice(0, 6);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, padding: "2px 2px 0" }}>
        <div>
          <div style={{ color: "#50e3c2", fontSize: 10, fontWeight: 700, letterSpacing: "0.11em", textTransform: "uppercase", marginBottom: 5 }}>Company Intelligence</div>
          <p style={{ color: "rgba(255,255,255,0.45)", fontSize: 12, lineHeight: 1.5, margin: 0 }}>Factual signals are extracted only from first-party company sources. Hover a source label to inspect the supporting excerpt.</p>
        </div>
        <button onClick={download} style={{ flexShrink: 0, background: "rgba(80,227,194,0.1)", color: "#50e3c2", border: "1px solid rgba(80,227,194,0.24)", borderRadius: 8, padding: "8px 11px", cursor: "pointer", fontSize: 11, fontWeight: 700 }}>Export with sources</button>
      </div>

      {visible("productPricing", Boolean(intel.productPricing?.productClaims.length || intel.productPricing?.pricingStatement)) && (
        <ModuleCard module="productPricing" status={statuses.productPricing}>
          {intel.productPricing?.productClaims.length || intel.productPricing?.pricingStatement ? <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 20, alignItems: "start" }}><div><div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 7 }}>Published product claims</div><div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{intel.productPricing?.productClaims.slice(0, 6).map((claim) => <div key={claim} style={{ color: "rgba(255,255,255,0.68)", fontSize: 12, lineHeight: 1.45 }}>• {claim}<EvidenceLinks items={intel.productPricing?.claimEvidence?.[claim]} /></div>)}</div></div><div><div style={{ color: "rgba(255,255,255,0.35)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 7 }}>Pricing / conversion</div><div style={{ color: "rgba(255,255,255,0.68)", fontSize: 12, lineHeight: 1.5 }}>{intel.productPricing?.pricingStatement || "No public pricing statement found."}<EvidenceLinks items={intel.productPricing?.pricingEvidence || intel.productPricing?.evidence} /></div>{intel.productPricing?.primaryCta && <div style={{ color: "#50e3c2", fontSize: 11, marginTop: 10 }}>Primary CTA: {intel.productPricing.primaryCta}</div>}</div></div> : <SourceLimitation status={statuses.productPricing} />}
        </ModuleCard>
      )}

      {(visible("integrations", Boolean(intel.integrations?.length)) || visible("news", Boolean(intel.news?.length))) && <div style={{ display: "grid", gridTemplateColumns: "1.15fr 0.85fr", gap: 16, alignItems: "start" }}>
        {visible("integrations", Boolean(intel.integrations?.length)) && <ModuleCard module="integrations" status={statuses.integrations}>{intel.integrations?.length ? <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>{intel.integrations.slice(0, 30).map((integration) => <a key={integration.name} href={integration.url || "#"} target="_blank" rel="noreferrer" title={integration.evidence?.[0]?.excerpt || integration.name} style={{ textDecoration: "none", fontSize: 11, border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.65)", background: "rgba(255,255,255,0.04)", borderRadius: 7, padding: "6px 8px" }}>{integration.name}</a>)}</div> : <SourceLimitation status={statuses.integrations} />}</ModuleCard>}
        {visible("news", Boolean(intel.news?.length)) && <ModuleCard module="news" status={statuses.news}>{intel.news?.length ? <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{intel.news.slice(0, 6).map((item) => <a key={item.url} href={item.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", display: "block", borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 10 }}><div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}><span style={{ color: "#50e3c2", fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{item.label}</span>{item.publishedAt && <span style={{ color: "rgba(255,255,255,0.28)", fontSize: 10 }}>{new Date(item.publishedAt).toLocaleDateString()}</span>}</div><div style={{ color: "rgba(255,255,255,0.78)", fontSize: 12, lineHeight: 1.45 }}>{item.headline}<EvidenceLinks items={item.evidence} /></div></a>)}</div> : <SourceLimitation status={statuses.news} />}</ModuleCard>}
      </div>}

      {(visible("people", Boolean(intel.people?.length)) || visible("hiring", Boolean(intel.hiring?.totalOpenRoles)) || visible("compliance", Boolean(complianceClaims.length))) && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, alignItems: "start" }}>
        {visible("people", Boolean(intel.people?.length)) && <ModuleCard module="people" status={statuses.people}>{intel.people?.length ? <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{intel.people.slice(0, 8).map((person) => <div key={`${person.name}-${person.title}`} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}><div style={{ width: 25, height: 25, borderRadius: "50%", background: "rgba(80,227,194,0.14)", color: "#50e3c2", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>{person.name.split(" ").map((part) => part[0]).slice(0, 2).join("")}</div><div style={{ minWidth: 0 }}><div style={{ color: "rgba(255,255,255,0.82)", fontSize: 12, fontWeight: 600 }}>{person.name}<EvidenceLinks items={person.evidence} /></div><div style={{ color: "rgba(255,255,255,0.45)", fontSize: 11, marginTop: 2 }}>{person.title}</div></div></div>)}</div> : <SourceLimitation status={statuses.people} />}</ModuleCard>}
        {visible("hiring", Boolean(intel.hiring?.totalOpenRoles)) && <ModuleCard module="hiring" status={statuses.hiring}>{intel.hiring?.totalOpenRoles ? <><div style={{ fontSize: 30, lineHeight: 1, color: "#fff", fontWeight: 750 }}>{intel.hiring.totalOpenRoles}</div><div style={{ color: "rgba(255,255,255,0.42)", fontSize: 11, marginTop: 5, marginBottom: 13 }}>publicly listed open roles</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{intel.hiring.byDepartment.slice(0, 6).map((item) => <span key={item.name} style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.62)", borderRadius: 99, fontSize: 10, padding: "4px 8px" }}>{item.name} · {item.count}</span>)}</div>{intel.hiring.roles.some((role) => role.leadership) && <div style={{ color: "#f3b562", marginTop: 12, fontSize: 11 }}>Leadership hiring: {intel.hiring.roles.filter((role) => role.leadership).slice(0, 3).map((role) => role.title).join(", ")}</div>}</> : <SourceLimitation status={statuses.hiring} />}</ModuleCard>}
        {visible("compliance", Boolean(complianceClaims.length)) && <ModuleCard module="compliance" status={statuses.compliance}>{complianceClaims.length ? <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>{displayedCompliance.map((claim) => <div key={`${claim.framework}-${claim.claim}`}><div style={{ color: "#e6b7ff", fontSize: 11, fontWeight: 700 }}>{claim.framework}<EvidenceLinks items={claim.evidence} /></div><div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, lineHeight: 1.5, marginTop: 3 }}>{claim.claim}</div></div>)}{complianceClaims.length > 6 && <button onClick={() => setShowAllCompliance((current) => !current)} style={{ alignSelf: "flex-start", padding: 0, color: "#e6b7ff", background: "none", border: 0, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>{showAllCompliance ? "Show fewer" : `Show all ${complianceClaims.length}`}</button>}</div> : <SourceLimitation status={statuses.compliance} />}</ModuleCard>}
      </div>}

      <CoverageStrip statuses={statuses} />
    </section>
  );
}

function ChangeRow({ change }: { change: SnapshotChange }) {
  const color = change.type === "added" ? "#50e3c2" : change.type === "removed" ? "#f68a8a" : "#f3b562";
  return <div style={{ borderLeft: `2px solid ${color}`, padding: "2px 0 2px 12px", marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}><span style={{ fontSize: 10, color, textTransform: "uppercase", fontWeight: 700 }}>{change.type}</span><span style={{ fontSize: 12, color: "rgba(255,255,255,0.8)", fontWeight: 650 }}>{change.label}</span></div><div style={{ fontSize: 12, color: "rgba(255,255,255,0.48)", lineHeight: 1.55 }}>{change.detail}</div></div>;
}

export function WhatChangedPanel({ generationId }: { generationId: string }) {
  const [state, setState] = useState<WhatChangedResult | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setState(null); setError("");
    fetch(`/api/generations/${generationId}/changes`).then(async (response) => {
      if (!response.ok) throw new Error("Changes are unavailable for this report.");
      return response.json() as Promise<{ comparison: WhatChangedResult }>;
    }).then((payload) => { if (!cancelled) setState(payload.comparison); }).catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [generationId]);

  return <div style={cardStyle}><div style={{ color: "#50e3c2", fontSize: 10, fontWeight: 700, letterSpacing: "0.11em", textTransform: "uppercase", marginBottom: 7 }}>What Changed</div><p style={{ color: "rgba(255,255,255,0.42)", fontSize: 12, lineHeight: 1.5, margin: "0 0 18px" }}>A deterministic comparison with the immediately prior saved snapshot. First-party facts and model analysis remain visibly distinct.</p>{!state && !error && <div style={{ color: "rgba(255,255,255,0.38)", fontSize: 12 }}>Comparing snapshots…</div>}{error && <div style={{ color: "rgba(246,138,138,0.8)", fontSize: 12 }}>{error}</div>}{state && !state.hasPreviousSnapshot && <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>This is the first saved snapshot for this company. Re-run later to see a source-backed change log.</div>}{state && state.hasPreviousSnapshot && !state.changes.length && <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>No deterministic changes were found against the prior snapshot.</div>}{state?.changes.map((change, index) => <ChangeRow key={`${change.module}-${change.type}-${index}`} change={change} />)}</div>;
}
