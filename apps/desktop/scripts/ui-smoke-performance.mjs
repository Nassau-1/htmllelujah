export const WARM_START_BUDGET_MS = 3_000;

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

export const assertInteractiveReadiness = (performanceReport) => {
  if (performanceReport.withinWarmStartBudget) return;

  const error = new Error(
    `Interactive readiness took ${performanceReport.interactiveReadyMs} ms, exceeding the ` +
      `${performanceReport.warmStartBudgetMs} ms warm-start budget.`,
  );
  error.code = 'WARM_START_BUDGET_EXCEEDED';
  throw error;
};
