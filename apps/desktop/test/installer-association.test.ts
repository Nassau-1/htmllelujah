import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const productProgId = 'HTMLlelujah presentation';

interface AssociationState {
  readonly defaultProgId?: string;
  readonly openWithProgIds: readonly string[];
}

interface AssociationBaseline {
  readonly extensionKeyRegistered: boolean;
  readonly productClassRegistered: boolean;
}

const modelPostUninstallCleanup = (state: AssociationState): AssociationState | undefined => {
  const defaultProgId = state.defaultProgId === productProgId ? undefined : state.defaultProgId;
  const openWithProgIds = state.openWithProgIds.filter((value) => value !== productProgId);
  return defaultProgId === undefined && openWithProgIds.length === 0
    ? undefined
    : { defaultProgId, openWithProgIds };
};

const isPristineAssociationBaseline = (state: AssociationBaseline): boolean =>
  !state.extensionKeyRegistered && !state.productClassRegistered;

const modelInstalledDefault = (priorDefaultProgId?: string): string =>
  priorDefaultProgId !== undefined && priorDefaultProgId !== productProgId
    ? priorDefaultProgId
    : productProgId;

const modelFailedInstallDefault = (priorDefaultProgId?: string): string | undefined =>
  priorDefaultProgId;

describe('Windows installer association cleanup', () => {
  it('wires the post-uninstall include into the packaged NSIS configuration', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(desktopRoot, 'package.json'), 'utf8'),
    ) as {
      build?: {
        fileAssociations?: Array<{ name?: string }>;
        nsis?: { include?: string };
      };
    };

    expect(packageJson.build?.nsis?.include).toBe('scripts/installer-association.nsh');
    expect(packageJson.build?.fileAssociations?.[0]?.name).toBe(productProgId);
  });

  it('runs after the built-in association removal and only prunes owned or empty keys', async () => {
    const include = await readFile(
      path.join(desktopRoot, 'scripts', 'installer-association.nsh'),
      'utf8',
    );

    expect(include).toContain('Function un.onUninstSuccess');
    expect(include).toContain('StrCmp $R0 "${HTMLLELUJAH_HDECK_PROGID}" 0 association_not_owned');
    expect(include).toContain(
      'DeleteRegValue SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}" ""',
    );
    expect(include).toContain(
      'DeleteRegKey /ifempty SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}\\OpenWithProgids"',
    );
    expect(include).toContain(
      'DeleteRegKey /ifempty SHELL_CONTEXT "${HTMLLELUJAH_HDECK_EXTENSION_KEY}"',
    );
  });

  it('restores a foreign default after registration and across repair, upgrade, or failure', async () => {
    expect(modelInstalledDefault()).toBe(productProgId);
    expect(modelInstalledDefault(productProgId)).toBe(productProgId);
    expect(modelInstalledDefault('Another.Editor')).toBe('Another.Editor');
    expect(modelInstalledDefault('User.NewChoice')).toBe('User.NewChoice');

    expect(modelFailedInstallDefault()).toBeUndefined();
    expect(modelFailedInstallDefault(productProgId)).toBe(productProgId);
    expect(modelFailedInstallDefault('Another.Editor')).toBe('Another.Editor');

    const include = await readFile(
      path.join(desktopRoot, 'scripts', 'installer-association.nsh'),
      'utf8',
    );
    expect(include).toContain('!macro customInit');
    expect(include).toContain('ReadRegStr $htmllelujahPriorHdeckProgId SHELL_CONTEXT');
    expect(include).toContain('!macro customInstall');
    expect(include).toContain('!insertmacro HTMLLELUJAH_RESTORE_FOREIGN_HDECK_DEFAULT');
    expect(include).toContain('Function .onInstFailed');
    expect(include).toContain('!insertmacro HTMLLELUJAH_ROLL_BACK_FAILED_HDECK_DEFAULT');
    expect(include).toContain(
      '!define MUI_CUSTOMFUNCTION_ABORT HTMLlelujahRestoreHdeckDefaultOnAbort',
    );
    expect(include).toContain('Function HTMLlelujahRestoreHdeckDefaultOnAbort');
    expect(include).not.toMatch(/Function\s+\.onUserAbort\b/);
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

    expect(
      modelPostUninstallCleanup({
        openWithProgIds: [productProgId, 'Another.Editor'],
      }),
    ).toEqual({ defaultProgId: undefined, openWithProgIds: ['Another.Editor'] });
  });

  it('rejects a registry baseline whose extension key has only a foreign Open With entry', async () => {
    expect(
      isPristineAssociationBaseline({
        extensionKeyRegistered: true,
        productClassRegistered: false,
      }),
    ).toBe(false);

    const smoke = await readFile(
      path.join(desktopRoot, 'scripts', 'smoke-single-instance-windows.mjs'),
      'utf8',
    );
    expect(smoke).toContain(
      'associationBefore.extensionKeyRegistered || associationBefore.productClassRegistered',
    );
    expect(smoke).toContain(
      'associationAfter.extensionKeyRegistered || associationAfter.productClassRegistered',
    );
    expect(smoke).not.toContain('DeleteSubKeyTree($extensionPath');
    expect(smoke).toContain("$extension.DeleteValue('', $false)");
    expect(smoke).toContain('$openWith.DeleteValue([string]$ownedValueName, $false)');
  });
});
