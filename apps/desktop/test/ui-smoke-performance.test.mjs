import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assessInteractiveReadiness,
  assessInteractiveReadinessSamples,
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

  it('uses the deterministic median of three while preserving visible outliers', () => {
    const report = assessInteractiveReadinessSamples([2_100, 3_612.974, 1_949.592]);

    expect(report).toEqual({
      interactiveReadyMs: 2_100,
      warmStartBudgetMs: 3_000,
      withinWarmStartBudget: true,
      aggregation: 'median',
      sampleCount: 3,
      sampleInteractiveReadyMs: [2_100, 3_612.974, 1_949.592],
      samplesAboveBudget: [{ sample: 2, interactiveReadyMs: 3_612.974 }],
    });
  });

  it('rejects missing, extra, and invalid warm-start samples', () => {
    expect(() => assessInteractiveReadinessSamples([1, 2])).toThrow(/Exactly three/u);
    expect(() => assessInteractiveReadinessSamples([1, 2, 3, 4])).toThrow(/Exactly three/u);
    expect(() => assessInteractiveReadinessSamples([1, Number.NaN, 3])).toThrow(
      /Every warm-start sample/u,
    );
  });

  it('warms and measures the same profile only through clean native-close boundaries', async () => {
    const source = await readFile(
      new URL('../scripts/smoke-ui-electron.mjs', import.meta.url),
      'utf8',
    );
    const warmup = source.indexOf('warmupEvidence = await runCleanLaunchProbe');
    const measuredClock = source.indexOf('const launchStartedAt = performance.now()');
    const measuredSpawn = source.indexOf(
      'const application = spawn(launchCommand, createLaunchArguments(true)',
    );
    const staleEvidenceCleanup = source.indexOf(
      '[reportPath, screenshotPath, presentationScreenshotPath].map',
    );

    expect(warmup).toBeGreaterThan(-1);
    expect(staleEvidenceCleanup).toBeGreaterThan(-1);
    expect(staleEvidenceCleanup).toBeLessThan(warmup);
    expect(source).not.toContain('launchArguments: createLaunchArguments(false)');
    expect(source).toContain("measurement: 'median-of-three-clean-warm-starts-same-profile'");
    expect(source).toContain('profileReusedForMeasuredLaunch: true');
    expect(source).toContain('for (const ordinal of [1, 2])');
    expect(source).toContain('await requestNativeWindowClose(child.pid)');
    expect(source).toContain('__HTMLLELUJAH_PROCESS_TREE__');
    expect(source).toContain('await waitForProcessTreeExit(nativeClose.processIds, label)');
    expect(source).toContain("automateMessageBox(child.pid, 'Unsaved changes', 'Discard')");
    expect(source).toContain('await assertRecoveryArtifactsRemoved(userData, sessionId, label)');
    expect(source).toContain('initialized.recoveryCandidates !== 0');
    expect(source).toContain('assessInteractiveReadinessSamples([');
    expect(source).toContain('gracefulClose: finalGracefulClose');
    expect(measuredClock).toBeGreaterThan(warmup);
    expect(measuredSpawn).toBeGreaterThan(measuredClock);
  });
});
