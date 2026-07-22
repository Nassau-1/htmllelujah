import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assessInteractiveReadiness,
  assessInteractiveReadinessSamples,
  assertInteractiveReadiness,
  WARM_START_BUDGET_MS,
  WARM_START_TARGET_MS,
} from '../scripts/ui-smoke-performance.mjs';

describe('Electron UI smoke interactive-readiness gate', () => {
  it('accepts a launch at or below the 4 second instrumented budget', () => {
    const belowBudget = assessInteractiveReadiness(WARM_START_BUDGET_MS - 0.001);
    const atBudget = assessInteractiveReadiness(WARM_START_BUDGET_MS);

    expect(belowBudget.withinWarmStartBudget).toBe(true);
    expect(atBudget.withinWarmStartBudget).toBe(true);
    expect(() => assertInteractiveReadiness(atBudget)).not.toThrow();
  });

  it('fails with an explicit diagnostic as soon as the budget is exceeded', () => {
    const report = assessInteractiveReadiness(WARM_START_BUDGET_MS + 0.001);

    expect(report).toEqual({
      interactiveReadyMs: 4_000.001,
      warmStartBudgetMs: WARM_START_BUDGET_MS,
      withinWarmStartBudget: false,
    });
    expect(() => assertInteractiveReadiness(report)).toThrowError(
      /4000\.001 ms, exceeding the 4000 ms warm-start budget/u,
    );
  });

  it('rejects invalid measurements instead of silently passing them', () => {
    expect(() => assessInteractiveReadiness(Number.NaN)).toThrow(RangeError);
    expect(() => assessInteractiveReadiness(-1)).toThrow(RangeError);
  });

  it('uses the deterministic median of three while preserving visible outliers', () => {
    const report = assessInteractiveReadinessSamples([2_100, 4_612.974, 1_949.592]);

    expect(report).toEqual({
      interactiveReadyMs: 2_100,
      warmStartBudgetMs: WARM_START_BUDGET_MS,
      withinWarmStartBudget: true,
      warmStartTargetMs: WARM_START_TARGET_MS,
      withinWarmStartTarget: true,
      aggregation: 'median',
      sampleCount: 3,
      sampleInteractiveReadyMs: [2_100, 4_612.974, 1_949.592],
      samplesAboveTarget: [{ sample: 2, interactiveReadyMs: 4_612.974 }],
      samplesAboveBudget: [{ sample: 2, interactiveReadyMs: 4_612.974 }],
    });
  });

  it('keeps the 3 second target visible while enforcing the 4 second V1 ceiling', () => {
    const report = assessInteractiveReadinessSamples([3_300, 3_200, 4_500]);

    expect(report.interactiveReadyMs).toBe(3_300);
    expect(report.withinWarmStartTarget).toBe(false);
    expect(report.withinWarmStartBudget).toBe(true);
    expect(report.samplesAboveTarget).toHaveLength(3);
    expect(report.samplesAboveBudget).toEqual([{ sample: 3, interactiveReadyMs: 4_500 }]);
    expect(() => assertInteractiveReadiness(report)).not.toThrow();
  });

  it('keeps the written V1 requirements aligned with the measured target and ceiling', async () => {
    const [platformSpec, releaseSpec, testMatrix, decision] = await Promise.all([
      readFile(new URL('../../../specs/001-platform-fidelity/spec.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../specs/002-v1-release/spec.md', import.meta.url), 'utf8'),
      readFile(new URL('../../../specs/002-v1-release/test-matrix.md', import.meta.url), 'utf8'),
      readFile(
        new URL('../../../docs/decisions/ADR-012-packaged-warm-start-envelope.md', import.meta.url),
        'utf8',
      ),
    ]);

    for (const source of [platformSpec, releaseSpec, testMatrix, decision]) {
      expect(source).toContain('4,000 ms');
      expect(source).toContain('3,000 ms');
    }
    expect(releaseSpec).not.toMatch(/warm start under 3 seconds/iu);
    expect(testMatrix).toContain('median of three clean packaged warm starts');
  });

  it('rejects missing, extra, and invalid warm-start samples', () => {
    expect(() => assessInteractiveReadinessSamples([1, 2])).toThrow(/Exactly three/u);
    expect(() => assessInteractiveReadinessSamples([1, 2, 3, 4])).toThrow(/Exactly three/u);
    expect(() => assessInteractiveReadinessSamples([1, Number.NaN, 3])).toThrow(
      /Every warm-start sample/u,
    );
    expect(() => assessInteractiveReadinessSamples([1, 2, 3], 4_000, 4_001)).toThrow(
      /target must be positive and no greater/u,
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
    expect(source).toContain("automateMessageBox(child.pid, 'Unsaved changes', 'Discard', 150)");
    expect(source).toContain("automateMessageBox(child.pid, 'Presentation remains open', 'OK')");
    expect(source).toContain("closeOutcome.kind === 'retained'");
    expect(source).toContain('A detached TSV draft was allowed to close the presentation.');
    expect(source).toContain('window.htmllelujah.onWindowCloseReleased');
    expect(source).toContain('Exact correlated close release after Cancel');
    expect(source).not.toContain('firstCancelCompletedAt');
    expect(source).not.toContain('performance.now() - firstCancelCompletedAt');
    expect(source).toContain(
      'An immediate close retry after Cancel was rejected by a stale renderer seal.',
    );
    expect(source).toContain('await assertRecoveryArtifactsRemoved(userData, sessionId, label)');
    expect(source).toContain('initialized.recoveryCandidates !== 0');
    expect(source).toContain('assessInteractiveReadinessSamples([');
    expect(source).toContain('gracefulClose: finalGracefulClose');
    expect(measuredClock).toBeGreaterThan(warmup);
    expect(measuredSpawn).toBeGreaterThan(measuredClock);
  });

  it('scopes native message-box automation to one exact owned Win32 dialog', async () => {
    const source = await readFile(
      new URL('../scripts/dismiss-message-box.ps1', import.meta.url),
      'utf8',
    );

    expect(source).toContain('EnumWindows');
    expect(source).toContain('EnumerateTopLevelWindows');
    expect(source).toContain('[HtmllelujahMessageBoxInput]::IsWindowVisible($handle)');
    expect(source).toContain("[string]::Equals($className, '#32770', [StringComparison]::Ordinal)");
    expect(source).toContain('$AllowedProcessIds.Contains($processId)');
    expect(source).toContain('[System.Windows.Automation.AutomationElement]::FromHandle(');
    expect(source.match(/::FromHandle\(/gu)).toHaveLength(1);
    expect(source).not.toContain('RootElement');
    expect(source).not.toContain('[System.Windows.Automation.TreeScope]');
    expect(source).not.toContain('.FindAll(');
    expect(source).not.toContain('SendInput');
    expect(source).toContain('SendMessageTimeout');
    expect(source).not.toContain('PostMessage');
    expect(source).not.toContain('Find-Window');
    expect(source).toContain('More than one visible owned #32770 dialog matched');
    expect(source).toContain('EnumerateChildWindowHandles');
    expect(source).toContain('[HtmllelujahMessageBoxInput]::IsWindowEnabled($handle)');
    expect(source).toContain("'Button',");
    expect(source).toContain('More than one visible enabled native button matched');
    expect(source).toContain('while ([DateTime]::UtcNow -lt $deadline -and $null -eq $button)');
    expect(source).toContain('$dialogHandle = [IntPtr]$nativeDialog.Handle');
    expect(source).toContain('$buttonHandle = [IntPtr]$button.Handle');
    expect(source).toContain('function Get-DialogGenerationFingerprint');
    expect(source).toContain(
      '$dialogGenerationFingerprint = Get-DialogGenerationFingerprint -NativeDialog $nativeDialog',
    );
    expect(source).toContain('-ExpectedGenerationFingerprint $dialogGenerationFingerprint');
    expect(source).toContain('[HtmllelujahMessageBoxInput]::IsWindow($dialogHandle)');
    expect(source).toContain('[HtmllelujahMessageBoxInput]::IsChild($dialogHandle, $buttonHandle)');
    expect(source).toContain("phase = 'identity-changed-before-click'");
    expect(source).toContain('__HTMLLELUJAH_MESSAGE_BOX_PHASE__:waiting-release');
    expect(source).toContain('__HTMLLELUJAH_MESSAGE_BOX_PHASE__:waiting-close');
    expect(source).toContain('$operationTimeoutSeconds = [Math]::Min($TimeoutSeconds, 30)');
    expect(source).toContain(
      'allowedProcessIds = @($allowedProcessIds | Sort-Object | Select-Object -First 32)',
    );
    expect(source).toContain('if ($closeDeadline -gt $deadline) { $closeDeadline = $deadline }');
  });
});
