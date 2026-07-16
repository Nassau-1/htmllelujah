import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assessInteractiveReadiness,
  assertInteractiveReadiness,
} from '../scripts/ui-smoke-performance.mjs';

describe('Electron UI smoke interactive-readiness gate', () => {
  it('accepts a launch at or below the 3 second budget', () => {
    const belowBudget = assessInteractiveReadiness(2_999.999);
    const atBudget = assessInteractiveReadiness(3_000);

    expect(belowBudget.withinWarmStartBudget).toBe(true);
    expect(atBudget.withinWarmStartBudget).toBe(true);
    expect(() => assertInteractiveReadiness(atBudget)).not.toThrow();
  });

  it('fails with an explicit diagnostic as soon as the budget is exceeded', () => {
    const report = assessInteractiveReadiness(3_000.001);

    expect(report).toEqual({
      interactiveReadyMs: 3_000.001,
      warmStartBudgetMs: 3_000,
      withinWarmStartBudget: false,
    });
    expect(() => assertInteractiveReadiness(report)).toThrowError(
      /3000\.001 ms, exceeding the 3000 ms warm-start budget/u,
    );
  });

  it('rejects invalid measurements instead of silently passing them', () => {
    expect(() => assessInteractiveReadiness(Number.NaN)).toThrow(RangeError);
    expect(() => assessInteractiveReadiness(-1)).toThrow(RangeError);
  });

  it('warms the same profile before starting the measured launch clock', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-ui-electron.mjs', import.meta.url),
      'utf8',
    );
    const warmup = source.indexOf('warmupEvidence = await warmUpApplication');
    const measuredClock = source.indexOf('const launchStartedAt = performance.now()');
    const measuredSpawn = source.indexOf(
      'const application = spawn(launchCommand, createLaunchArguments(true)',
    );

    expect(warmup).toBeGreaterThan(-1);
    expect(source).toContain('launchArguments: createLaunchArguments(false)');
    expect(source).toContain("measurement: 'second-launch-same-profile'");
    expect(source).toContain('profileReusedForMeasuredLaunch: true');
    expect(measuredClock).toBeGreaterThan(warmup);
    expect(measuredSpawn).toBeGreaterThan(measuredClock);
  });
});
