import { buildSourceManifest } from "./sourceManifest";
import { runSourceModules } from "./extractModules";
import type { IntelligenceRunResult } from "./types";

/**
 * First-party company-intelligence orchestration.
 * The bounded source crawler and all deterministic module extractors run here;
 * model analysis remains explicitly separate in fetchAiPerception.
 */
export async function runCompanyIntelligence(url: string): Promise<IntelligenceRunResult> {
  const startedAt = Date.now();
  const manifest = await buildSourceManifest(url);
  const { intelligence, evidence } = await runSourceModules(manifest);
  return {
    intelligence,
    evidence,
    moduleStatuses: intelligence.moduleStatuses,
    durationMs: Date.now() - startedAt,
  };
}
