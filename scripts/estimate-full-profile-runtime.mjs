const measured = {
  renderedExtractionSeconds: 45.509,
  sourceCollectionSeconds: 16.686,
};

// These are intentionally explicit planning assumptions, not observed provider
// timings. Staging telemetry will replace them before production copy changes.
const scenarios = {
  expected: { classificationSeconds: 8, perceptionParallelCriticalPathSeconds: 22, databaseSeconds: 2 },
  conservative: { classificationSeconds: 15, perceptionParallelCriticalPathSeconds: 45, databaseSeconds: 4 },
  slowOrRetried: { classificationSeconds: 25, perceptionParallelCriticalPathSeconds: 105, databaseSeconds: 8 },
};

const result = Object.fromEntries(Object.entries(scenarios).map(([name, value]) => {
  const concurrentStageSeconds = Math.max(measured.sourceCollectionSeconds, value.perceptionParallelCriticalPathSeconds);
  const totalSeconds = measured.renderedExtractionSeconds + value.classificationSeconds + concurrentStageSeconds + value.databaseSeconds;
  return [name, {
    ...value,
    sourceCollectionSeconds: measured.sourceCollectionSeconds,
    concurrentStageSeconds,
    totalSeconds: Number(totalSeconds.toFixed(1)),
    minutes: Number((totalSeconds / 60).toFixed(2)),
  }];
}));

console.log(JSON.stringify({ measured, scenarios: result, methodology: "Rendered extraction and source collection are locally measured against preply.com. Source collection and perception run concurrently only after brand classification, so the critical path uses their maximum rather than their sum." }, null, 2));
