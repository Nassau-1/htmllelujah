export const WARM_START_BUDGET_MS = 3_000;
export const UI_SMOKE_TIMEOUT_MS = 6 * 60_000;

export const assessInteractiveReadiness = (
  interactiveReadyMs,
  warmStartBudgetMs = WARM_START_BUDGET_MS,
) => {
  if (!Number.isFinite(interactiveReadyMs) || interactiveReadyMs < 0) {
    throw new RangeError('Interactive readiness must be a finite, non-negative duration.');
  }
  if (!Number.isFinite(warmStartBudgetMs) || warmStartBudgetMs <= 0) {
    throw new RangeError('The warm-start budget must be a finite, positive duration.');
  }

  return {
    interactiveReadyMs,
    warmStartBudgetMs,
    withinWarmStartBudget: interactiveReadyMs <= warmStartBudgetMs,
  };
};

export const assessInteractiveReadinessSamples = (
  sampleInteractiveReadyMs,
  warmStartBudgetMs = WARM_START_BUDGET_MS,
) => {
  if (!Array.isArray(sampleInteractiveReadyMs) || sampleInteractiveReadyMs.length !== 3) {
    throw new RangeError('Exactly three warm-start samples are required.');
  }
  const samples = sampleInteractiveReadyMs.map((value) => {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('Every warm-start sample must be a finite, non-negative duration.');
    }
    return value;
  });
  const sorted = [...samples].sort((left, right) => left - right);
  const median = sorted[1];
  const assessment = assessInteractiveReadiness(median, warmStartBudgetMs);

  return {
    ...assessment,
    aggregation: 'median',
    sampleCount: samples.length,
    sampleInteractiveReadyMs: samples,
    samplesAboveBudget: samples.flatMap((interactiveReadyMs, index) =>
      interactiveReadyMs > warmStartBudgetMs ? [{ sample: index + 1, interactiveReadyMs }] : [],
    ),
  };
};

export const assertInteractiveReadiness = (performanceReport) => {
  if (performanceReport.withinWarmStartBudget) return;

  const error = new Error(
    `Interactive readiness took ${performanceReport.interactiveReadyMs} ms, exceeding the ` +
      `${performanceReport.warmStartBudgetMs} ms warm-start budget.`,
  );
  error.code = 'WARM_START_BUDGET_EXCEEDED';
  throw error;
};
