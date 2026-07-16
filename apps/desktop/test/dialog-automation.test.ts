import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const scriptPath = new URL('../scripts/automate-save-dialog.ps1', import.meta.url);

describe('native file-dialog editor selection', () => {
  it('selects one visible writable Edit under a native file-name host and fails closed otherwise', async () => {
    const source = await readFile(scriptPath, 'utf8');

    expect(source).toContain("foreach ($automationId in @('FileNameControlHost', '1148', '1001'))");
    expect(source).toContain("$hasKnownId = $current.AutomationId -in @('1148', '1001')");
    expect(source).toContain('$hasFileName = $current.Name -match');
    expect(source).toContain('$hasEditClass = $current.ClassName -match');
    expect(source).toContain('[System.Windows.Automation.ControlType]::Edit');
    expect(source).toContain('$current.IsOffscreen');
    expect(source).toContain('$current.BoundingRectangle');
    expect(source).toContain('$candidate.TryGetCurrentPattern(');
    expect(source).toContain('$valuePattern.Current.IsReadOnly');
    expect(source).toContain('if ($eligible.Count -gt 1)');
    expect(source).toContain("Status = 'Ambiguous'");
    expect(source).toContain('$editorDeadline = [DateTime]::UtcNow.AddSeconds(5)');
    expect(source).toContain('file-name editor lookup failed closed');
    expect(source).not.toContain(
      '$editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)',
    );
  });
});
