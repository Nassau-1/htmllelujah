import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const scriptPath = new URL('../scripts/automate-save-dialog.ps1', import.meta.url);

describe('native file-dialog editor selection', () => {
  it('selects the exact native file-name Edit and confirmation Button and fails closed otherwise', async () => {
    const source = await readFile(scriptPath, 'utf8');

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
    expect(source).toContain('::SetControlText($editorIdentity.Handle, $TargetPath)');
    expect(source).toContain('::ReadControlText(');
    expect(source).toContain('[HtmllelujahNativeDialog]::IsWindow($dialogIdentity.Handle)');
    expect(source).not.toContain('UIAutomation');
    expect(source).not.toContain('RootElement');
    expect(source).not.toContain('TreeScope');
    expect(source).not.toContain('.FindAll(');
    expect(source).not.toContain('SendInput');
    expect(source).not.toContain('ReplaceFocusedText');
    expect(source).toContain('[ValidateRange(1, 30)]');
    expect(source).toContain(
      '$deadline = $globalStartedAt.AddSeconds([Math]::Min($TimeoutSeconds, 30))',
    );
    expect(source).toContain("Write-Output 'phase=acquisition'");
    expect(source).toContain("Write-Output 'phase=editor'");
    expect(source).toContain("Write-Output 'phase=value'");
    expect(source).toContain("Write-Output 'phase=button'");
    expect(source).toContain("Write-Output 'phase=click'");
    expect(source).toContain("Write-Output 'phase=wait-close'");
    expect(source).toContain("phase = 'wait-close-timeout'");
  });

  it('keeps native-dialog failures bounded, diagnosable, and cancellable by the caller', async () => {
    const [uiSmoke, exportSmoke] = await Promise.all([
      readFile(new URL('../scripts/smoke-ui-electron.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/smoke-system-exports-windows.mjs', import.meta.url), 'utf8'),
    ]);

    expect(uiSmoke).toContain(
      'const automateFileDialog = (rootProcessId, windowTitle, targetPath) => {',
    );
    expect(uiSmoke).toContain("'-TimeoutSeconds',\n        '30'");
    expect(uiSmoke).toContain('return Object.assign(completion, { cancel });');
    expect(uiSmoke).toContain('void completion.catch(() => undefined);');
    expect(uiSmoke).toContain('termination ??= terminate(child');
    expect(uiSmoke).toContain('await imageDialog.cancel();');
    expect(uiSmoke).toContain('await saveBeforeCloseDialog.cancel();');
    expect(uiSmoke.indexOf('if (!savedBeforeClose)')).toBeLessThan(
      uiSmoke.indexOf('await saveBeforeCloseDialog;'),
    );
    expect(uiSmoke).toContain('Diagnostics: ${diagnostics}');
    expect(exportSmoke).toContain('{ label: `${title} UI Automation`, timeoutMs: 40_000 }');
    expect(exportSmoke).toContain('timed out.` +');
    expect(exportSmoke).toContain('Diagnostics: ${diagnostics}');
    expect(exportSmoke).toContain('[stdout.trim(), stderr.trim()]');
    expect(exportSmoke).toContain('void terminateTree(child).then(');
    expect(exportSmoke).toContain('if (timedOut) return;');
    expect(exportSmoke).toContain('did not drain after termination');
  });
});
