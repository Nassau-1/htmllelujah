import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const scriptPath = new URL('../scripts/automate-save-dialog.ps1', import.meta.url);
const scriptFilePath = fileURLToPath(scriptPath);
const windowsIt = process.platform === 'win32' ? it : it.skip;

describe('native file-dialog editor selection', () => {
  it('selects the exact native file-name Edit and confirmation Button and fails closed otherwise', async () => {
    const source = (await readFile(scriptPath, 'utf8')).replace(/\r\n?/g, '\n');

    expect(source).toContain('EnumWindows');
    expect(source).toContain('EnumChildWindows');
    expect(source).toContain('GetDlgCtrlID');
    expect(source).toContain('SendMessageTimeout');
    expect(source).not.toContain('PostMessage');
    expect(source).toContain(
      "[string]::Equals($className, '#32770', [System.StringComparison]::Ordinal)",
    );
    expect(source).toContain("-ExpectedClassName 'Edit'");
    expect(source).toContain('-ExpectedControlIds @(1148, 1001)');
    expect(source).toContain("-ExpectedClassName 'Button'");
    expect(source).toContain('-ExpectedControlIds @(1)');
    expect(source).toContain('[HtmllelujahNativeDialog]::IsChild(');
    expect(source).toContain('[HtmllelujahNativeDialog]::IsWindowVisible($handle)');
    expect(source).toContain('[HtmllelujahNativeDialog]::IsWindowEnabled($handle)');
    expect(source).toContain('The exact native $Role lookup was ambiguous');
    expect(source).toContain('function Set-StableNativeEditorValue');
    expect(source).toMatch(
      /::TypeControlText\(\s*\$DialogIdentity\.Handle,\s*\$EditorIdentity\.Handle,\s*\$Value,\s*\$Deadline\.Ticks,/,
    );
    expect(source).toContain('EditSetSelection = 0x00B1');
    expect(source).toContain('ClearSelection = 0x0303');
    expect(source).toContain('CharacterInput = 0x0102');
    expect(source).toContain('IdentityRecheckIntervalCharacters = 16');
    expect(source).toContain('long deadlineUtcTicks');
    expect(source).toContain('deadlineUtcTicks - DateTime.UtcNow.Ticks');
    expect(source).toContain('AssertExactEditorIdentity(');
    expect(source).toContain('index % IdentityRecheckIntervalCharacters == 0');
    expect(source).toContain('for (int index = 0; index < value.Length; index++)');
    expect(source).toContain('"selection clearing",\n            deadlineUtcTicks');
    expect(source).toContain(
      'The exact native file-name editor changed immediately after bounded input.',
    );
    expect(source).toContain('::ReadControlText(');
    expect(source).toContain('function Test-NativeMessageTimeoutException');
    expect(source).toContain('$lastInputTimeout = $_.Exception.GetBaseException().Message');
    expect(source).toContain('attempts=$attempts,lastInputTimeout=$lastInputTimeout');
    expect(source).toContain('$current = $current.InnerException');
    expect(source).toContain('function Read-ExactNativeEditorText');
    expect(source).toContain('while ([DateTime]::UtcNow -lt $Deadline)');
    expect(source).toContain('Test-NativeDialogIdentity -DialogIdentity $DialogIdentity');
    expect(source).toContain('-ChildIdentity $EditorIdentity');
    expect(source).toContain('attempts=$attempts,lastTimeout=$lastTimeout');
    expect(source).toContain('$commandAttempted = $false');
    expect(source).toContain('DialogGetDefaultId');
    expect(source).toContain('DialogHasDefaultId');
    expect(source).toContain('GetParent(button)');
    expect(source).toContain('buttonParent != dialog && !IsChild(dialog, buttonParent)');
    expect(source).toContain('defaultMarker != DialogHasDefaultId');
    expect(source).toContain('defaultControlId != DefaultButtonControlId');
    expect(source).toContain('ButtonClick = 0x00F5');
    expect(source).toContain('::ClickExactDefaultButton(');
    expect(source).toContain("$confirmationAction = 'BM_CLICK via SendMessageTimeout'");
    expect(source).toContain('RemainingMessageTimeout(deadlineUtcTicks');
    expect(source).not.toContain('Add-Type -AssemblyName Accessibility');
    expect(source).not.toContain('AccessibleObjectFromWindow');
    expect(source).not.toContain('accDoDefaultAction');
    expect(source).toContain('immediateParentHandle = ([HtmllelujahNativeDialog]::WindowParent(');
    expect(source).not.toContain('AttachThreadInput');
    expect(source).not.toContain('SetForegroundWindow');
    expect(source).toContain('while ([DateTime]::UtcNow -lt $Deadline -and -not $stable)');
    expect(source).toContain('$firstValue = Read-ExactNativeEditorText');
    expect(source).toContain('$secondValue = Read-ExactNativeEditorText');
    expect(source).toContain('Start-Sleep -Milliseconds 150');
    expect(source).toContain('::IsExactDefaultButtonReady(');
    expect(source).toContain('$commandAttempted = $true');
    expect(source).toContain('confirmationCommandDispatched = $clickAccepted');
    expect(source).not.toContain('and -not $clickAccepted');
    expect(source).toContain('-ChildIdentity $buttonIdentity');
    expect(source).toContain('$currentEditorValue = Read-ExactNativeEditorText');
    expect(source).toContain('[HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)');
    expect(source).not.toContain('RootElement');
    expect(source).not.toContain('TreeScope');
    expect(source).not.toContain('.FindAll(');
    expect(source).not.toContain('UIAutomationClient');
    expect(source).not.toContain('SendInput');
    expect(source).not.toContain('ReplaceFocusedText');
    expect(source).toContain('[ValidateRange(1, 30)]');
    expect(source).toContain(
      '$deadline = $globalStartedAt.AddSeconds([Math]::Min($TimeoutSeconds, 30))',
    );
    expect(source).toContain('function Test-WindowsDeviceNamespacePath');
    expect(source).toContain('function Assert-SafeWindowsPathComponent');
    expect(source).toContain('[char]::IsControl($character)');
    expect(source).toContain('[System.IO.Path]::GetInvalidFileNameChars()');
    expect(source).toContain('Windows alternate data stream destinations are not supported.');
    expect(source).toContain(
      'CON|PRN|AUX|NUL|CLOCK\\$|CONIN\\$|CONOUT\\$|COM(?:[1-9]|\\u00B9|\\u00B2|\\u00B3)',
    );
    expect(source).toContain("[string]::Equals($uncServer, '?'");
    expect(source).toContain("[string]::Equals($uncServer, '.'");
    const deviceChecks = [
      ...source.matchAll(/Test-WindowsDeviceNamespacePath -PathValue \$TargetPath/g),
    ];
    expect(deviceChecks).toHaveLength(2);
    const normalizationIndex = source.indexOf(
      '$TargetPath = [System.IO.Path]::GetFullPath($TargetPath)',
    );
    expect(deviceChecks[0]?.index).toBeLessThan(normalizationIndex);
    expect(deviceChecks[1]?.index).toBeGreaterThan(normalizationIndex);
    expect(source).toContain("Write-Output 'phase=acquisition'");
    expect(normalizationIndex).toBeLessThan(source.indexOf("Write-Output 'phase=acquisition'"));
    expect(source).toContain("Write-Output 'phase=editor'");
    expect(source).toContain("Write-Output 'phase=value'");
    expect(source).toContain("Write-Output 'phase=button'");
    expect(source).toContain("[ValidateSet('Open', 'Save')]");
    expect(source).toContain("if ($DialogKind -eq 'Save' -and $targetExistedAtStart)");
    expect(source).toContain("if ($DialogKind -eq 'Open' -and -not $targetExistedAtStart)");
    expect(source).toContain('$expectedEditorValue = $TargetPath');
    expect(source).not.toContain("Write-Output 'phase=navigation'");
    expect(source).toContain("Write-Output 'phase=click'");
    expect(source).toContain("Write-Output 'phase=wait-close'");
    expect(source.indexOf("Write-Output 'phase=button'")).toBeLessThan(
      source.indexOf("Write-Output 'phase=value'"),
    );
    expect(source.indexOf("Write-Output 'phase=value'")).toBeLessThan(
      source.indexOf("Write-Output 'phase=click'"),
    );
    expect(source).toContain("Write-Output 'Windows file dialog completed.'");
    expect(source).toContain('$dialogCloseDeadline = $deadline');
    expect(source).toContain('$savePostconditionDeadline = $deadline');
    expect(source).toContain('$remainingPostconditionMilliseconds');
    expect(source).toContain('[Math]::Min(100, $remainingPostconditionMilliseconds)');
    expect(source).not.toContain('$savePostconditionDeadline = [DateTime]::UtcNow.AddSeconds(5)');
    expect(source).toContain("phase = 'wait-close-timeout'");
  });

  windowsIt(
    'rejects slash-normalized device namespaces before native window acquisition',
    () => {
      for (const targetPath of ['\\\\?/C:/Temp/blocked.hdeck', '\\\\./pipe/blocked.hdeck']) {
        const result = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptFilePath,
            '-RootProcessId',
            String(process.pid),
            '-WindowTitle',
            'HTMLlelujah invalid-path contract test',
            '-TargetPath',
            targetPath,
            '-DialogKind',
            'Save',
            '-TimeoutSeconds',
            '1',
          ],
          { encoding: 'utf8', timeout: 20_000, windowsHide: true },
        );
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(output).toContain('Windows device-namespace destinations are not supported.');
        expect(output).not.toContain('phase=acquisition');
      }
    },
    45_000,
  );

  it('keeps native-dialog failures bounded, diagnosable, and cancellable by the caller', async () => {
    const [uiSmoke, exportSmoke] = await Promise.all([
      readFile(new URL('../scripts/smoke-ui-electron.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/smoke-system-exports-windows.mjs', import.meta.url), 'utf8'),
    ]);

    expect(uiSmoke).toContain(
      'const automateFileDialog = (rootProcessId, windowTitle, targetPath, dialogKind) => {',
    );
    expect(uiSmoke).toContain("'-DialogKind',\n        dialogKind");
    expect(uiSmoke).toMatch(
      /automateFileDialog\(application\.pid, 'Insert image', imageFixturePath, 'Open'\)/,
    );
    expect(uiSmoke).toContain("closeHandshakeDeckPath,\n    'Save'");
    expect(uiSmoke).toContain("'-TimeoutSeconds',\n        '30'");
    expect(uiSmoke).toContain('return Object.assign(completion, { cancel });');
    expect(uiSmoke).toContain('void completion.catch(() => undefined);');
    expect(uiSmoke).toContain('termination ??= terminate(child');
    expect(uiSmoke).toContain('import { drainChildProcess, waitForChildClose }');
    expect(uiSmoke).toContain('return drainChildProcess({ child, label });');
    expect(uiSmoke).toContain('await waitForChildClose(child, 15_000)');
    expect(uiSmoke).toContain('let primarySmokeError;');
    expect(uiSmoke).toContain('[primarySmokeError, ...cleanupErrors]');
    expect(uiSmoke).toContain('await imageDialog.cancel();');
    expect(uiSmoke).toContain('await saveBeforeCloseDialog.cancel();');
    expect(uiSmoke.indexOf('if (!savedBeforeClose)')).toBeLessThan(
      uiSmoke.indexOf('await saveBeforeCloseDialog;'),
    );
    expect(uiSmoke).toContain('Diagnostics: ${diagnostics}');
    expect(exportSmoke).toContain('{ label: `${title} UI Automation`, timeoutMs: 40_000 }');
    expect(exportSmoke).toContain("'-DialogKind',\n      'Save'");
    expect(exportSmoke).toContain('timed out.` +');
    expect(exportSmoke).toContain('Diagnostics: ${diagnostics}');
    expect(exportSmoke).toContain('[stdout.trim(), stderr.trim()]');
    expect(exportSmoke).toContain(
      "import { drainChildProcess } from './child-process-cleanup.mjs'",
    );
    expect(exportSmoke).toContain('const timeoutError = new Error(');
    expect(exportSmoke).toContain('void drainChildProcess({');
    expect(exportSmoke).toContain('[timeoutError, terminationError]');
    expect(exportSmoke).toContain('if (timedOut) return;');
    expect(exportSmoke).not.toContain("spawnSync('taskkill'");
    expect(exportSmoke).not.toContain('const terminateTree = async');
  });

  it('publishes UI success only after every final cleanup authority succeeds', async () => {
    const uiSmoke = await readFile(
      new URL('../scripts/smoke-ui-electron.mjs', import.meta.url),
      'utf8',
    );
    const finalCleanup = uiSmoke.lastIndexOf('} finally {');
    const successReport = uiSmoke.lastIndexOf('const report = {');
    const presentationEvidenceWrite = uiSmoke.lastIndexOf(
      'writeFile(presentationScreenshotPath, successEvidence.presentationScreenshotBytes)',
    );
    const successReportWrite = uiSmoke.lastIndexOf('writeFile(reportPath');
    const successAnnouncement = uiSmoke.lastIndexOf('Electron UI smoke passed:');

    expect(finalCleanup).toBeGreaterThan(-1);
    expect(successReport).toBeGreaterThan(finalCleanup);
    expect(presentationEvidenceWrite).toBeGreaterThan(successReport);
    expect(successReportWrite).toBeGreaterThan(presentationEvidenceWrite);
    expect(successReportWrite).toBeGreaterThan(successReport);
    expect(successAnnouncement).toBeGreaterThan(successReportWrite);
    expect(uiSmoke).toContain('let successEvidence;');
    expect(uiSmoke).toContain('let finalCleanupEvidence;');
    expect(uiSmoke).toContain('cleanup: finalCleanupEvidence');
    expect(uiSmoke).toContain('applicationCleanup = await terminate(application);');
    expect(uiSmoke).toContain('temporaryProfileRemoved = true;');
    expect(uiSmoke).toContain('await closeRaceRpc.close();');
    expect(uiSmoke).not.toContain('await closeRaceRpc?.close().catch(() => undefined);');
    expect(uiSmoke).toContain('[primarySmokeError, ...cleanupErrors]');
  });
});
