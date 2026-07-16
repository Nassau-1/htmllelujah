import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const productProgId = 'HTMLlelujah presentation';

interface AssociationState {
  readonly defaultProgId?: string;
  readonly openWithProgIds: readonly string[];
}

const modelPostUninstallCleanup = (state: AssociationState): AssociationState | undefined => {
  const defaultProgId = state.defaultProgId === productProgId ? undefined : state.defaultProgId;
  const openWithProgIds = state.openWithProgIds.filter((value) => value !== productProgId);
  return defaultProgId === undefined && openWithProgIds.length === 0
    ? undefined
    : { defaultProgId, openWithProgIds };
};

describe('Windows installer association cleanup', () => {
  it('wires the post-uninstall include into the packaged NSIS configuration', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as {
      build?: { nsis?: { include?: string } };
    };

    expect(packageJson.build?.nsis?.include).toBe('scripts/installer-association.nsh');
  });

  it('runs after the built-in association removal and only prunes owned or empty keys', async () => {
    const include = await readFile(
      path.join(desktopRoot, 'scripts', 'installer-association.nsh'),
      'utf8',
    );

    expect(include).toContain('Function un.onUninstSuccess');
    expect(include).toContain(`StrCmp $R0 "${productProgId}" 0 association_not_owned`);
    expect(include).toContain('DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.hdeck" ""');
    expect(include).toContain(
      'DeleteRegKey /ifempty SHELL_CONTEXT "Software\\Classes\\.hdeck\\OpenWithProgids"',
    );
    expect(include).toContain(
      'DeleteRegKey /ifempty SHELL_CONTEXT "Software\\Classes\\.hdeck"',
    );
  });

  it('removes an orphan owned association while preserving foreign defaults and Open With entries', () => {
    expect(
      modelPostUninstallCleanup({
        defaultProgId: productProgId,
        openWithProgIds: [productProgId],
      }),
    ).toBeUndefined();

    expect(
      modelPostUninstallCleanup({
        defaultProgId: 'Another.Editor',
        openWithProgIds: [productProgId, 'Another.Editor'],
      }),
    ).toEqual({ defaultProgId: 'Another.Editor', openWithProgIds: ['Another.Editor'] });

    expect(
      modelPostUninstallCleanup({
        defaultProgId: productProgId,
        openWithProgIds: [productProgId, 'Another.Editor'],
      }),
    ).toEqual({ defaultProgId: undefined, openWithProgIds: ['Another.Editor'] });
  });
});
