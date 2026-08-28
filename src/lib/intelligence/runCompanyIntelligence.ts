import { buildSourceManifest } from "./sourceManifest";
import { runSourceModules } from "./extractModules";
import { detectTechnologyStack } from "./techStack";
import type { IntelligenceRunResult, ModuleStatus } from "./types";

/**
 * First-party company-intelligence orchestration. The bounded source crawler and
 * deterministic extractors run here; model analysis remains separate. Tech Stack
 * is Tier 1 evidence because it is detected from artifacts the target rendered.
 */
export async function runCompanyIntelligence(url: string, renderedPage?: Record<string, unknown>): Promise<IntelligenceRunResult> {
  const startedAt = Date.now();
  const manifest = await buildSourceManifest(url);
  const { intelligence: sourcedIntelligence, evidence: sourcedEvidence } = await runSourceModules(manifest);
  const tech = renderedPage
    ? detectTechnologyStack(renderedPage)
    : {
        value: [], evidence: [], status: {
          status: "unavailable" as const,
          reason: "Live render artifacts were unavailable for this report.",
          crawledUrls: [], durationMs: 0,
        } satisfies ModuleStatus,
      };
  const intelligence = {
    ...sourcedIntelligence,
    techStack: tech.value,
    moduleStatuses: { ...sourcedIntelligence.moduleStatuses, techStack: tech.status },
  };
  return {
    intelligence,
    evidence: [...sourcedEvidence, ...tech.evidence],
    moduleStatuses: intelligence.moduleStatuses,
    durationMs: Date.now() - startedAt,
  };
}
