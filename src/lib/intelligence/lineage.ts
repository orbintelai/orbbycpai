import { getDomain } from "tldts";

export type LineageStatus = "canonical" | "cross_domain_redirect_pending" | "canonical_unavailable";

export interface SnapshotLineage {
  submittedUrl: string;
  resolvedUrl: string;
  declaredCanonicalUrl: string | null;
  registrableDomain: string | null;
  submittedRegistrableDomain: string | null;
  redirectChain: string[];
  lineageStatus: LineageStatus;
}

function normalizeHttpUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function registrableDomain(value: string): string | null {
  try {
    const hostname = new URL(value).hostname;
    return getDomain(hostname, { allowPrivateDomains: false }) || null;
  } catch {
    return null;
  }
}

/**
 * Build immutable snapshot lineage from the user input and the browser's final
 * URL. Submitted URLs are never rewritten; automatic grouping is only allowed
 * when both hosts share the same PSL-aware registrable domain.
 */
export function buildSnapshotLineage(input: {
  submittedUrl: string;
  resolvedUrl?: unknown;
  declaredCanonicalUrl?: unknown;
  redirectChain?: unknown;
}): SnapshotLineage {
  const submittedUrl = normalizeHttpUrl(input.submittedUrl) || input.submittedUrl;
  const resolvedUrl = typeof input.resolvedUrl === "string"
    ? normalizeHttpUrl(input.resolvedUrl, submittedUrl) || submittedUrl
    : submittedUrl;
  const declaredCanonicalUrl = typeof input.declaredCanonicalUrl === "string"
    ? normalizeHttpUrl(input.declaredCanonicalUrl, resolvedUrl)
    : null;
  const submittedRegistrableDomain = registrableDomain(submittedUrl);
  const resolvedRegistrableDomain = registrableDomain(resolvedUrl);
  const redirectChain = Array.isArray(input.redirectChain)
    ? input.redirectChain.filter((url): url is string => typeof url === "string")
    : [];
  const crossDomain = Boolean(
    submittedRegistrableDomain &&
    resolvedRegistrableDomain &&
    submittedRegistrableDomain !== resolvedRegistrableDomain,
  );

  return {
    submittedUrl,
    resolvedUrl,
    declaredCanonicalUrl,
    registrableDomain: resolvedRegistrableDomain,
    submittedRegistrableDomain,
    redirectChain,
    lineageStatus: !resolvedRegistrableDomain
      ? "canonical_unavailable"
      : crossDomain
        ? "cross_domain_redirect_pending"
        : "canonical",
  };
}

export function isSameRegistrableDomain(candidateUrl: string, targetUrl: string): boolean {
  const candidate = registrableDomain(candidateUrl);
  const target = registrableDomain(targetUrl);
  return Boolean(candidate && target && candidate === target);
}
