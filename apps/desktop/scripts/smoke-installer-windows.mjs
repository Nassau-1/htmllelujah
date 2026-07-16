import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  INSTALLER_SMOKE_TEMP_PREFIXES,
  assertCleanSourceState,
  assertOwnedTemporaryPath,
  assertReleaseCandidateManifest,
  assertSourceStateUnchanged,
  assertStableArtifact,
  assertStableHarnessManifest,
  captureCreatedProductRegistryIdentities,
  expectedInstallerRegistryKeys,
  expectedUnsignedInstallerName,
  newTemporaryEntries,
  normalizeJsonArray,
  parseInstallerSmokeArguments,
  remainingCapturedRegistryIdentities,
  selectOwnedProcessRecords,
  sameAssociationState,
} from './installer-smoke-support.mjs';
import {
  assertBuildProvenance,
  gitSourceState as inspectGitSourceState,
  readPackagedBuildProvenance,
  regularFileIdentity,
  trackedSourceIdentity,
} from './build-provenance-support.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidencePath = path.join(repositoryRoot, 'artifacts', 'evidence', 'installer-v1.json');
const fixturePath = path.join(desktopRoot, 'test', 'fixtures', 'installer-smoke-v1.hdeck.base64');
const harnessPaths = [
  import.meta.filename,
  path.join(import.meta.dirname, 'installer-smoke-support.mjs'),
  path.join(import.meta.dirname, 'build-provenance-support.mjs'),
  path.join(import.meta.dirname, 'write-build-provenance.mjs'),
  path.join(import.meta.dirname, 'write-release-manifest.mjs'),
  path.join(import.meta.dirname, 'smoke-ui-electron.mjs'),
  path.join(import.meta.dirname, 'ui-smoke-performance.mjs'),
  path.join(import.meta.dirname, 'automate-save-dialog.ps1'),
  path.join(import.meta.dirname, 'smoke-mcp-electron.mjs'),
  path.join(import.meta.dirname, 'mcp-smoke-support.mjs'),
  path.join(import.meta.dirname, 'mcp-json-line-router.mjs'),
  path.join(repositoryRoot, 'scripts', 'build-windows-release.mjs'),
  path.join(repositoryRoot, 'scripts', 'windows-release-pipeline-support.mjs'),
  path.join(repositoryRoot, 'scripts', 'release-candidate-manifest.mjs'),
  path.join(repositoryRoot, 'scripts', 'release-source-state.mjs'),
  path.join(repositoryRoot, 'scripts', 'generate-release-evidence.mjs'),
  path.join(repositoryRoot, 'scripts', 'verify-release-evidence.mjs'),
  fixturePath,
];
const productProgId = 'HTMLlelujah presentation';
const temporaryPrefix = 'htmllelujah-installer-smoke-';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (operation, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(
    `${label} timed out.${lastError instanceof Error ? ` ${lastError.message}` : ''}`,
  );
};

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

const artifactIdentity = async (filePath) => {
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.size < 1_048_576) {
    throw new Error('The final installer is not a plausible regular NSIS artifact.');
  }
  return {
    sha256: await sha256(filePath),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    mtimeUtc: metadata.mtime.toISOString(),
  };
};

const harnessIdentity = async () => {
  if (harnessPaths.length === 0 || harnessPaths.length > 24) {
    throw new Error('The release harness file set is invalid.');
  }
  const digest = createHash('sha256');
  const files = [];
  for (const filePath of harnessPaths) {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1_048_576) {
      throw new Error(`Release harness file is invalid: ${path.basename(filePath)}`);
    }
    const relativePath = path.relative(repositoryRoot, filePath).split(path.sep).join('/');
    const fileSha256 = await sha256(filePath);
    digest.update(relativePath);
    digest.update('\0');
    digest.update(String(metadata.size));
    digest.update('\0');
    digest.update(fileSha256);
    digest.update('\n');
    files.push({ path: relativePath, size: metadata.size, sha256: fileSha256 });
  }
  return { sha256: digest.digest('hex'), files };
};

const terminateSpawnedProcess = (child) => {
  if (process.platform !== 'win32' || child.pid === undefined || child.exitCode !== null) return;
  // ChildProcess.kill uses the already-open process handle on Windows, avoiding PID-reuse races.
  child.kill('SIGKILL');
};

const terminateExactProductProcess = (record, installedExecutable) => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        '$expectedPid = [int]$env:HTMLLELUJAH_EXPECTED_PID',
        '$expectedPath = [IO.Path]::GetFullPath($env:HTMLLELUJAH_EXPECTED_EXECUTABLE)',
        '$expectedCreatedAtMs = [long]$env:HTMLLELUJAH_EXPECTED_CREATED_AT_MS',
        '$process = Get-Process -Id $expectedPid -ErrorAction SilentlyContinue',
        'if ($null -eq $process) { exit 0 }',
        'try {',
        '  $actualPath = $process.Path',
        '  $actualCreatedAtMs = ([DateTimeOffset]$process.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
        '  $samePath = [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)',
        '  if (-not $samePath -or [Math]::Abs($actualCreatedAtMs - $expectedCreatedAtMs) -gt 5) { exit 42 }',
        '  $process.Kill()',
        '  if (-not $process.WaitForExit(10000)) { exit 43 }',
        '} finally { $process.Dispose() }',
      ].join('\n'),
    ],
    {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15_000,
      env: {
        ...process.env,
        HTMLLELUJAH_EXPECTED_PID: String(record.processId),
        HTMLLELUJAH_EXPECTED_EXECUTABLE: installedExecutable,
        HTMLLELUJAH_EXPECTED_CREATED_AT_MS: String(record.createdAtMs),
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Refused to terminate product PID ${record.processId}: its exact identity was not stable.`,
    );
  }
};

const run = (command, arguments_, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? desktopRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-8_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
    });
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`${options.label ?? path.basename(command)} timed out.`)));
      terminateSpawnedProcess(child);
    }, options.timeoutMs ?? 120_000);
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, signal) => {
      settle(() => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          reject(
            new Error(
              `${options.label ?? path.basename(command)} exited ${code ?? signal}.` +
                `${stderr === '' ? '' : ` ${stderr.slice(-2_000)}`}`,
            ),
          );
        }
      });
    });
  });

const powershellJson = (script, environment = {}) => {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, ...environment },
    },
  );
  if (result.status !== 0 || result.stdout?.trim() === '') {
    throw new Error(
      `Windows state inspection failed.${result.stderr?.trim() ? ` ${result.stderr.trim().slice(-1_500)}` : ''}`,
    );
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim());
};

const tokenProfile = () =>
  powershellJson(
    [
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
      '$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      '[ordered]@{ isElevated = $isElevated; isSystem = $identity.IsSystem } | ConvertTo-Json -Compress',
    ].join('\n'),
  );

const expectedRegistryCollisionState = (keys) =>
  powershellJson(
    [
      '$installKey = $env:HTMLLELUJAH_EXPECTED_INSTALL_KEY',
      '$uninstallKey = $env:HTMLLELUJAH_EXPECTED_UNINSTALL_KEY',
      'function Test-RegistryKey([Microsoft.Win32.RegistryKey]$hive, [string]$key) {',
      '  $opened = $hive.OpenSubKey($key)',
      '  try { return $null -ne $opened } finally { if ($null -ne $opened) { $opened.Dispose() } }',
      '}',
      '[ordered]@{',
      '  currentUserInstall = Test-RegistryKey ([Microsoft.Win32.Registry]::CurrentUser) $installKey',
      '  currentUserUninstall = Test-RegistryKey ([Microsoft.Win32.Registry]::CurrentUser) $uninstallKey',
      '  localMachineInstall = Test-RegistryKey ([Microsoft.Win32.Registry]::LocalMachine) $installKey',
      '  localMachineUninstall = Test-RegistryKey ([Microsoft.Win32.Registry]::LocalMachine) $uninstallKey',
      '} | ConvertTo-Json -Compress',
    ].join('\n'),
    {
      HTMLLELUJAH_EXPECTED_INSTALL_KEY: keys.install,
      HTMLLELUJAH_EXPECTED_UNINSTALL_KEY: keys.uninstall,
    },
  );

const assertNoExpectedRegistryCollisions = (state) => {
  if (Object.values(state).some(Boolean)) {
    throw new Error(
      'An exact installer registry key already exists; the lifecycle smoke refused all mutation.',
    );
  }
};

const registryState = (installDirectory) => {
  const state = powershellJson(
    [
      "$productProgId = 'HTMLlelujah presentation'",
      '$target = $env:HTMLLELUJAH_INSTALL_TARGET',
      "$extension = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\.hdeck')",
      "$extensionDefault = if ($null -eq $extension) { $null } else { $extension.GetValue('') }",
      '$extensionKeyRegistered = $null -ne $extension',
      'if ($null -ne $extension) { $extension.Dispose() }',
      "$openWith = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\.hdeck\\OpenWithProgids')",
      '$openWithProgIds = if ($null -eq $openWith) { @() } else { @($openWith.GetValueNames() | Sort-Object) }',
      '$openWithKeyRegistered = $null -ne $openWith',
      'if ($null -ne $openWith) { $openWith.Dispose() }',
      "$productClass = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(('Software\\Classes\\{0}' -f $productProgId))",
      '$productClassRegistered = $null -ne $productClass',
      'if ($null -ne $productClass) { $productClass.Dispose() }',
      "$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(('Software\\Classes\\{0}\\shell\\open\\command' -f $productProgId))",
      "$productCommand = if ($null -eq $commandKey) { $null } else { [string]$commandKey.GetValue('') }",
      'if ($null -ne $commandKey) { $commandKey.Dispose() }',
      '$installRecords = @()',
      '$uninstallRecords = @()',
      '$installKeyIdentities = @()',
      '$uninstallKeyIdentities = @()',
      '$hives = @(',
      "  [pscustomobject]@{ Name = 'HKCU'; Hive = [Microsoft.Win32.Registry]::CurrentUser },",
      "  [pscustomobject]@{ Name = 'HKLM'; Hive = [Microsoft.Win32.Registry]::LocalMachine }",
      ')',
      'foreach ($item in $hives) {',
      "  $software = $item.Hive.OpenSubKey('Software')",
      '  if ($null -ne $software) {',
      '    foreach ($name in $software.GetSubKeyNames()) {',
      '      $installKeyIdentities += [pscustomobject]@{ hive = $item.Name; key = $name }',
      '      $key = $software.OpenSubKey($name)',
      "      $location = if ($null -eq $key) { $null } else { [string]$key.GetValue('InstallLocation') }",
      '      if (-not [string]::IsNullOrWhiteSpace($location) -and [string]::Equals($location, $target, [StringComparison]::OrdinalIgnoreCase)) {',
      '        $installRecords += [pscustomobject]@{ hive = $item.Name; key = $name }',
      '      }',
      '      if ($null -ne $key) { $key.Dispose() }',
      '    }',
      '    $software.Dispose()',
      '  }',
      "  $uninstall = $item.Hive.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall')",
      '  if ($null -ne $uninstall) {',
      '    foreach ($name in $uninstall.GetSubKeyNames()) {',
      '      $uninstallKeyIdentities += [pscustomobject]@{ hive = $item.Name; key = $name }',
      '      $key = $uninstall.OpenSubKey($name)',
      "      $displayName = if ($null -eq $key) { $null } else { [string]$key.GetValue('DisplayName') }",
      "      $location = if ($null -eq $key) { $null } else { [string]$key.GetValue('InstallLocation') }",
      "      $uninstallString = if ($null -eq $key) { $null } else { [string]$key.GetValue('UninstallString') }",
      "      $isProduct = -not [string]::IsNullOrWhiteSpace($displayName) -and $displayName.StartsWith('HTMLlelujah', [StringComparison]::OrdinalIgnoreCase)",
      '      $isTarget = (-not [string]::IsNullOrWhiteSpace($location) -and [string]::Equals($location, $target, [StringComparison]::OrdinalIgnoreCase)) -or (-not [string]::IsNullOrWhiteSpace($uninstallString) -and $uninstallString.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0)',
      '      if ($isProduct -or $isTarget) {',
      '        $uninstallRecords += [pscustomobject]@{ hive = $item.Name; key = $name; isProduct = $isProduct; isTarget = $isTarget }',
      '      }',
      '      if ($null -ne $key) { $key.Dispose() }',
      '    }',
      '    $uninstall.Dispose()',
      '  }',
      '}',
      '[ordered]@{',
      '  extensionKeyRegistered = $extensionKeyRegistered',
      '  openWithKeyRegistered = $openWithKeyRegistered',
      '  extensionDefault = $extensionDefault',
      '  openWithProgIds = @($openWithProgIds)',
      '  productClassRegistered = $productClassRegistered',
      '  productCommand = $productCommand',
      '  installRecords = @($installRecords)',
      '  uninstallRecords = @($uninstallRecords)',
      '  installKeyIdentities = @($installKeyIdentities)',
      '  uninstallKeyIdentities = @($uninstallKeyIdentities)',
      '} | ConvertTo-Json -Compress -Depth 5',
    ].join('\n'),
    { HTMLLELUJAH_INSTALL_TARGET: installDirectory },
  );
  return {
    ...state,
    openWithProgIds: normalizeJsonArray(state.openWithProgIds),
    installRecords: normalizeJsonArray(state.installRecords),
    uninstallRecords: normalizeJsonArray(state.uninstallRecords),
    installKeyIdentities: normalizeJsonArray(state.installKeyIdentities),
    uninstallKeyIdentities: normalizeJsonArray(state.uninstallKeyIdentities),
  };
};

const shortcutState = (installedExecutable) => {
  const state = powershellJson(
    [
      '$shell = New-Object -ComObject WScript.Shell',
      '$paths = @(',
      "  [pscustomobject]@{ kind = 'desktop'; path = [IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'HTMLlelujah.lnk') },",
      "  [pscustomobject]@{ kind = 'startMenu'; path = [IO.Path]::Combine([Environment]::GetFolderPath('Programs'), 'HTMLlelujah.lnk') }",
      ')',
      '$items = foreach ($item in $paths) {',
      '  $present = Test-Path -LiteralPath $item.path -PathType Leaf',
      '  $target = if ($present) { $shell.CreateShortcut($item.path).TargetPath } else { $null }',
      '  [pscustomobject]@{ kind = $item.kind; present = $present; exactTarget = $present -and [string]::Equals($target, $env:HTMLLELUJAH_EXECUTABLE, [StringComparison]::OrdinalIgnoreCase) }',
      '}',
      '@($items) | ConvertTo-Json -Compress',
    ].join('\n'),
    { HTMLLELUJAH_EXECUTABLE: installedExecutable },
  );
  return normalizeJsonArray(state);
};

const productProcesses = (installedExecutable) => {
  const state = powershellJson(
    [
      '$matches = Get-Process -ErrorAction Stop | ForEach-Object {',
      '  try {',
      '    $createdAtMs = ([DateTimeOffset]$_.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()',
      '    $executablePath = $_.Path',
      '  } catch {',
      '    $createdAtMs = $null',
      '    $executablePath = $null',
      '  }',
      '  [pscustomobject]@{',
      '    processId = [int]$_.Id',
      '    createdAtMs = $createdAtMs',
      '    executablePath = if ([string]::IsNullOrWhiteSpace($executablePath)) { $null } else { [string]$executablePath }',
      '  }',
      '  $_.Dispose()',
      '}',
      'ConvertTo-Json -InputObject @($matches) -Compress',
    ].join('\n'),
  );
  return selectOwnedProcessRecords(normalizeJsonArray(state), installedExecutable);
};

const namedProductProcesses = () => {
  const state = powershellJson(
    [
      "$matches = Get-Process -Name 'HTMLlelujah' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ processId = [int]$_.Id }; $_.Dispose() }",
      'ConvertTo-Json -InputObject @($matches) -Compress',
    ].join('\n'),
  );
  return normalizeJsonArray(state);
};

const terminateOwnedProcesses = (installedExecutable) => {
  for (const entry of productProcesses(installedExecutable)) {
    terminateExactProductProcess(entry, installedExecutable);
  }
};

const temporaryEntries = async () =>
  new Set(
    (await readdir(tmpdir(), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (INSTALLER_SMOKE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix)) ||
            /^ns[a-z0-9]+\.tmp$/iu.test(entry.name)),
      )
      .map((entry) => entry.name),
  );

const snapshotTree = async (root) => {
  if (!(await exists(root))) return { rootExists: false, entries: [] };
  const entries = [];
  let totalBytes = 0;
  const pending = [{ absolute: root, relative: '' }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current.absolute, { withFileTypes: true })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = path.join(current.relative, entry.name);
      const metadata = await lstat(absolute);
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      if (kind === 'file') {
        totalBytes += metadata.size;
        if (metadata.size > 100 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) {
          throw new Error('The application-data snapshot exceeds its byte budget.');
        }
      }
      entries.push({
        path: relative,
        kind,
        ...(kind === 'file'
          ? { size: metadata.size, mtimeMs: metadata.mtimeMs, sha256: await sha256(absolute) }
          : {}),
      });
      if (entry.isDirectory()) pending.push({ absolute, relative });
      if (entries.length > 10_000) throw new Error('The application-data snapshot is unbounded.');
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { rootExists: true, entries };
};

const sameTreeSnapshot = (before, after) => JSON.stringify(before) === JSON.stringify(after);

const removeIfEmpty = async (directory) => {
  if (!(await exists(directory))) return;
  if ((await readdir(directory)).length === 0) await rm(directory, { force: true });
};

const requiredInstalledFiles = (installDirectory) => [
  path.join(installDirectory, 'HTMLlelujah.exe'),
  path.join(installDirectory, 'HTMLlelujah-MCP.cmd'),
  path.join(installDirectory, 'Uninstall HTMLlelujah.exe'),
  path.join(installDirectory, 'EULA.txt'),
  path.join(installDirectory, 'LICENSE.txt'),
  path.join(installDirectory, 'THIRD_PARTY_NOTICES.md'),
  path.join(installDirectory, 'LICENSE.electron.txt'),
  path.join(installDirectory, 'LICENSES.chromium.html'),
];

const assertInstalledFiles = async (installDirectory) => {
  for (const required of requiredInstalledFiles(installDirectory)) {
    const metadata = await stat(required);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Installed release file is invalid: ${path.basename(required)}`);
    }
  }
};

const assertInstalledWindowsState = (state, baseline, installedExecutable) => {
  if (
    !state.productClassRegistered ||
    !state.openWithProgIds.some((value) => value === productProgId)
  ) {
    throw new Error('The product .hdeck class and Open With registration are incomplete.');
  }
  const expectedDefault =
    baseline.extensionDefault !== null &&
    baseline.extensionDefault !== undefined &&
    baseline.extensionDefault !== ''
      ? baseline.extensionDefault
      : productProgId;
  if (state.extensionDefault !== expectedDefault) {
    throw new Error('Installation did not preserve or establish the expected .hdeck default.');
  }
  const expectedCommand = `"${installedExecutable}" "%1"`;
  if (
    typeof state.productCommand !== 'string' ||
    state.productCommand.localeCompare(expectedCommand, undefined, { sensitivity: 'accent' }) !== 0
  ) {
    throw new Error('The installed .hdeck command does not target the exact installed executable.');
  }
  const currentUserInstall = state.installRecords.filter((entry) => entry.hive === 'HKCU');
  const localMachineInstall = state.installRecords.filter((entry) => entry.hive === 'HKLM');
  const currentUserUninstall = state.uninstallRecords.filter(
    (entry) => entry.hive === 'HKCU' && entry.isTarget,
  );
  const localMachineUninstall = state.uninstallRecords.filter(
    (entry) => entry.hive === 'HKLM' && entry.isTarget,
  );
  if (
    currentUserInstall.length < 1 ||
    currentUserUninstall.length < 1 ||
    localMachineInstall.length > 0 ||
    localMachineUninstall.length > 0
  ) {
    throw new Error('The installer did not register as a strictly per-user installation.');
  }
};

const assertInstalledShortcuts = (shortcuts) => {
  if (
    shortcuts.length !== 2 ||
    shortcuts.some((shortcut) => !shortcut.present || !shortcut.exactTarget)
  ) {
    throw new Error('The expected per-user desktop and Start Menu shortcuts are invalid.');
  }
};

const assertNoProductRegistry = (state, baseline, capturedRegistryIdentities) => {
  if (
    !sameAssociationState(baseline, state) ||
    state.productClassRegistered ||
    state.openWithProgIds.some((value) => value === productProgId) ||
    state.installRecords.length > 0 ||
    state.uninstallRecords.length > 0 ||
    remainingCapturedRegistryIdentities(capturedRegistryIdentities, state).length > 0
  ) {
    throw new Error('Product registry state was not restored to its pre-test baseline.');
  }
};

const assertNoShortcuts = (shortcuts) => {
  if (shortcuts.some((shortcut) => shortcut.present)) {
    throw new Error('Uninstall left a product shortcut behind.');
  }
};

const hashFiles = async (filePaths) =>
  Object.fromEntries(
    await Promise.all(
      filePaths.map(async (filePath) => [path.basename(filePath), await sha256(filePath)]),
    ),
  );

const sameHashes = (before, after) => JSON.stringify(before) === JSON.stringify(after);

const seedRecoverySentinel = async (recoveryDirectory) => {
  await mkdir(recoveryDirectory, { recursive: true });
  const files = [path.join(recoveryDirectory, `installer-preservation-${randomUUID()}.sentinel`)];
  await writeFile(files[0], `opaque recovery sentinel ${randomUUID()}\n`, 'utf8');
  return {
    files,
    hashes: await hashFiles(files),
  };
};

const inspectRecoverySentinel = async (recovery, consume = false) => {
  if (!sameHashes(recovery.hashes, await hashFiles(recovery.files))) {
    throw new Error('The installer changed the opaque recovery sentinel.');
  }
  if (consume) {
    for (const filePath of recovery.files) await rm(filePath, { force: true });
  }
};

if (process.platform !== 'win32') throw new Error('The installer smoke requires Windows.');

const sourceBefore = inspectGitSourceState(repositoryRoot);
assertCleanSourceState(sourceBefore);
const sourceTreeBefore = await trackedSourceIdentity(repositoryRoot);
const lockfileBefore = await regularFileIdentity(path.join(repositoryRoot, 'pnpm-lock.yaml'));
const harnessBefore = await harnessIdentity();

await mkdir(path.dirname(evidencePath), { recursive: true });
await rm(evidencePath, { force: true });

const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
const defaultInstaller = path.join(
  desktopRoot,
  'out',
  expectedUnsignedInstallerName(desktopPackage.version),
);
const { installer } = parseInstallerSmokeArguments(process.argv.slice(2), defaultInstaller);
if (!(await exists(installer)))
  throw new Error('The exact final HTMLlelujah installer is missing.');
if (path.basename(installer) !== expectedUnsignedInstallerName(desktopPackage.version)) {
  throw new Error('The installer file name does not match the exact desktop package version.');
}

const artifactBefore = await artifactIdentity(installer);
const candidateManifestPath = path.join(
  repositoryRoot,
  'artifacts',
  'release-evidence',
  'release-candidate-v1.json',
);
const companionRoot = path.join(desktopRoot, 'out', 'win-unpacked');
const companionExecutablePath = path.join(companionRoot, 'HTMLlelujah.exe');
const companionAsarPath = path.join(companionRoot, 'resources', 'app.asar');
const blockmapPath = path.join(
  desktopRoot,
  'out',
  `${expectedUnsignedInstallerName(desktopPackage.version)}.blockmap`,
);
const companionExecutableBefore = await regularFileIdentity(companionExecutablePath, 1_048_576);
const companionAsarBefore = await regularFileIdentity(companionAsarPath, 1_048_576);
const blockmapBefore = await regularFileIdentity(blockmapPath);
const embeddedProvenance = readPackagedBuildProvenance(companionAsarPath, desktopRoot);
const expectedProvenance = {
  productName: 'HTMLlelujah',
  version: desktopPackage.version,
  sourceCommit: sourceBefore.commit,
  sourceTree: sourceTreeBefore,
  lockfileSha256: lockfileBefore.sha256,
};
assertBuildProvenance(embeddedProvenance, expectedProvenance);
const candidateManifest = JSON.parse(await readFile(candidateManifestPath, 'utf8'));
const candidateManifestBefore = await regularFileIdentity(candidateManifestPath);
assertReleaseCandidateManifest(candidateManifest, {
  productName: 'HTMLlelujah',
  version: desktopPackage.version,
  source: {
    commit: sourceBefore.commit,
    treeSha256: sourceTreeBefore.sha256,
    fileCount: sourceTreeBefore.fileCount,
    bytes: sourceTreeBefore.bytes,
  },
  lockfileSha256: lockfileBefore.sha256,
  embeddedProvenance,
  installer: {
    path: path.basename(installer),
    ...artifactBefore,
  },
  blockmap: {
    path: path.basename(blockmapPath),
    ...blockmapBefore,
  },
  companion: {
    executable: companionExecutableBefore,
    appAsar: companionAsarBefore,
  },
});
const expectedRegistryKeys = expectedInstallerRegistryKeys(desktopPackage.build.nsis.guid);
const startedAt = new Date();
const token = tokenProfile();
if (token.isElevated || token.isSystem) {
  throw new Error('Run the final installer smoke from a non-elevated standard-user terminal.');
}

const appDataRoot = process.env.APPDATA;
if (appDataRoot === undefined) throw new Error('APPDATA is unavailable.');
const temporaryEntriesBefore = await temporaryEntries();
const temporaryRoot = assertOwnedTemporaryPath(
  await mkdtemp(path.join(tmpdir(), temporaryPrefix)),
  tmpdir(),
  temporaryPrefix,
);
const installDirectory = path.join(temporaryRoot, 'Install-é-test');
const deckPath = path.join(temporaryRoot, 'présentation préservée 你好.hdeck');
const installedExecutable = path.join(installDirectory, 'HTMLlelujah.exe');
const installedLauncher = path.join(installDirectory, 'HTMLlelujah-MCP.cmd');
const uninstaller = path.join(installDirectory, 'Uninstall HTMLlelujah.exe');
const noticePath = path.join(installDirectory, 'THIRD_PARTY_NOTICES.md');
const obsoletePayload = path.join(installDirectory, 'obsolete-v0-payload.txt');
const applicationData = path.join(appDataRoot, 'HTMLlelujah');
const recoveryDirectory = path.join(applicationData, 'recovery');
const recoveryBlobsDirectory = path.join(recoveryDirectory, 'blobs');
const marker = path.join(applicationData, `installer-smoke-${randomUUID()}.txt`);

let installed = false;
let installationMutationStarted = false;
let registryKeysWereCollisionFree = false;
let recovery;
let recoveryConsumed = false;
let lifecycleError;
const cleanupErrors = [];
const stageDurationsMs = {};
let applicationDataBaselineCaptured = false;
let applicationDataExisted = false;
let recoveryDirectoryExisted = false;
let recoveryBlobsExisted = false;
let applicationDataBefore;
let registryBefore;
let capturedRegistryIdentities = [];
let shortcutsBefore;

const stage = async (name, operation) => {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    stageDurationsMs[name] = Math.round((performance.now() - started) * 10) / 10;
  }
};

const verifyPreservedState = async (deckHash, markerHash, recoveryState) => {
  if ((await sha256(deckPath)) !== deckHash || (await sha256(marker)) !== markerHash) {
    throw new Error('Installer maintenance changed the user deck or application-data marker.');
  }
  if (!sameHashes(recoveryState.hashes, await hashFiles(recoveryState.files))) {
    throw new Error('Installer maintenance changed the durable recovery files.');
  }
  await inspectRecoverySentinel(recoveryState);
};

try {
  applicationDataExisted = await exists(applicationData);
  recoveryDirectoryExisted = await exists(recoveryDirectory);
  recoveryBlobsExisted = await exists(recoveryBlobsDirectory);
  applicationDataBefore = await snapshotTree(applicationData);
  applicationDataBaselineCaptured = true;
  registryBefore = registryState(installDirectory);
  shortcutsBefore = shortcutState(installedExecutable);
  assertNoExpectedRegistryCollisions(expectedRegistryCollisionState(expectedRegistryKeys));
  registryKeysWereCollisionFree = true;

  if (
    registryBefore.productClassRegistered ||
    registryBefore.openWithProgIds.some((value) => value === productProgId) ||
    registryBefore.extensionDefault === productProgId ||
    registryBefore.uninstallRecords.some((entry) => entry.isProduct) ||
    shortcutsBefore.some((shortcut) => shortcut.present) ||
    namedProductProcesses().length > 0
  ) {
    throw new Error(
      'A prior HTMLlelujah installation or association is present; the lifecycle smoke refused to alter it.',
    );
  }
  if (applicationDataBefore.entries.length > 0) {
    throw new Error(
      'Existing HTMLlelujah application data is present; use a clean standard-user profile for release evidence.',
    );
  }

  const deckBytes = Buffer.from((await readFile(fixturePath, 'utf8')).trim(), 'base64');
  if (deckBytes.length < 1_024 || deckBytes.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new Error('The tracked installer smoke deck fixture is invalid.');
  }
  await writeFile(deckPath, deckBytes);
  const deckHash = await sha256(deckPath);

  installationMutationStarted = true;
  await stage('install', () =>
    run(installer, ['/S', `/D=${installDirectory}`], {
      label: 'NSIS standard-user install',
      timeoutMs: 180_000,
    }),
  );
  installed = true;
  await waitFor(() => exists(installedExecutable), 30_000, 'Installed application');
  await assertInstalledFiles(installDirectory);
  const installedRegistryState = registryState(installDirectory);
  assertInstalledWindowsState(installedRegistryState, registryBefore, installedExecutable);
  capturedRegistryIdentities = captureCreatedProductRegistryIdentities(
    registryBefore,
    installedRegistryState,
  );
  assertInstalledShortcuts(shortcutState(installedExecutable));
  const installedExecutableHash = await sha256(installedExecutable);
  const installedExecutableIdentity = await regularFileIdentity(installedExecutable, 1_048_576);
  const installedAsarPath = path.join(installDirectory, 'resources', 'app.asar');
  const installedAsarIdentity = await regularFileIdentity(installedAsarPath, 1_048_576);
  if (
    installedExecutableIdentity.sha256 !== companionExecutableBefore.sha256 ||
    installedExecutableIdentity.size !== companionExecutableBefore.size ||
    installedAsarIdentity.sha256 !== companionAsarBefore.sha256 ||
    installedAsarIdentity.size !== companionAsarBefore.size
  ) {
    throw new Error('The installer payload differs from the attested companion application.');
  }
  const installedProvenance = readPackagedBuildProvenance(installedAsarPath, desktopRoot);
  assertBuildProvenance(installedProvenance, expectedProvenance);
  if (JSON.stringify(installedProvenance) !== JSON.stringify(embeddedProvenance)) {
    throw new Error('The installed application contains unexpected build provenance.');
  }

  await stage('installedEditor', () =>
    run(process.execPath, [path.join(desktopRoot, 'scripts', 'smoke-ui-electron.mjs')], {
      label: 'Installed editor UI smoke',
      timeoutMs: 150_000,
      env: {
        ...process.env,
        HTMLLELUJAH_EXECUTABLE: installedExecutable,
        HTMLLELUJAH_OPEN_PATH: deckPath,
        HTMLLELUJAH_EXPECTED_DECK_NAME: 'Installed V1 verification',
      },
    }),
  );
  if ((await sha256(deckPath)) !== deckHash) {
    throw new Error('Opening and editing in memory unexpectedly changed the source deck.');
  }
  await waitFor(
    () => (productProcesses(installedExecutable).length === 0 ? true : false),
    15_000,
    'Installed editor process cleanup',
  );

  await stage('installedMcp', () =>
    run(process.execPath, [path.join(desktopRoot, 'scripts', 'smoke-mcp-electron.mjs')], {
      label: 'Installed MCP launcher smoke',
      timeoutMs: 150_000,
      env: {
        ...process.env,
        HTMLLELUJAH_EXECUTABLE: installedExecutable,
        HTMLLELUJAH_MCP_LAUNCHER: installedLauncher,
      },
    }),
  );
  await waitFor(
    () => (productProcesses(installedExecutable).length === 0 ? true : false),
    15_000,
    'Installed MCP process cleanup',
  );

  await mkdir(applicationData, { recursive: true });
  await writeFile(marker, 'installer preservation marker\n', 'utf8');
  const markerHash = await sha256(marker);
  recovery = await seedRecoverySentinel(recoveryDirectory);
  await verifyPreservedState(deckHash, markerHash, recovery);

  await rm(noticePath, { force: true });
  if (await exists(noticePath)) throw new Error('The repair fixture could not be staged.');
  await stage('repairRerun', () =>
    run(installer, ['/S', `/D=${installDirectory}`], {
      label: 'NSIS repair rerun',
      timeoutMs: 180_000,
    }),
  );
  await waitFor(() => exists(noticePath), 30_000, 'Repaired installed notice');
  await assertInstalledFiles(installDirectory);
  if ((await sha256(installedExecutable)) !== installedExecutableHash) {
    throw new Error('The repair rerun did not restore the exact final executable.');
  }
  assertInstalledWindowsState(registryState(installDirectory), registryBefore, installedExecutable);
  assertInstalledShortcuts(shortcutState(installedExecutable));
  await verifyPreservedState(deckHash, markerHash, recovery);

  await writeFile(obsoletePayload, 'obsolete payload must not survive an upgrade-like reinstall\n');
  await stage('upgradeLikeReinstall', () =>
    run(installer, ['/S', `/D=${installDirectory}`], {
      label: 'NSIS upgrade-like reinstall',
      timeoutMs: 180_000,
    }),
  );
  await waitFor(() => exists(installedExecutable), 30_000, 'Reinstalled application');
  if (await exists(obsoletePayload)) {
    throw new Error('The upgrade-like reinstall retained an obsolete product payload.');
  }
  await assertInstalledFiles(installDirectory);
  if ((await sha256(installedExecutable)) !== installedExecutableHash) {
    throw new Error('The upgrade-like reinstall did not publish the exact final executable.');
  }
  assertInstalledWindowsState(registryState(installDirectory), registryBefore, installedExecutable);
  assertInstalledShortcuts(shortcutState(installedExecutable));
  await verifyPreservedState(deckHash, markerHash, recovery);

  await stage('uninstall', () =>
    run(uninstaller, ['/S'], { label: 'NSIS uninstall', timeoutMs: 180_000 }),
  );
  installed = false;
  await waitFor(async () => !(await exists(installDirectory)), 60_000, 'Installation removal');
  await waitFor(
    () => (productProcesses(installedExecutable).length === 0 ? true : false),
    15_000,
    'Uninstalled process cleanup',
  );
  await waitFor(
    () => {
      const state = registryState(installDirectory);
      return sameAssociationState(registryBefore, state) &&
        state.installRecords.length === 0 &&
        remainingCapturedRegistryIdentities(capturedRegistryIdentities, state).length === 0
        ? state
        : false;
    },
    30_000,
    'Registry cleanup',
  );
  assertNoProductRegistry(
    registryState(installDirectory),
    registryBefore,
    capturedRegistryIdentities,
  );
  await waitFor(
    () => (shortcutState(installedExecutable).every((entry) => !entry.present) ? true : false),
    30_000,
    'Shortcut cleanup',
  );
  assertNoShortcuts(shortcutState(installedExecutable));
  await verifyPreservedState(deckHash, markerHash, recovery);
  await inspectRecoverySentinel(recovery, true);
  recoveryConsumed = true;
} catch (error) {
  lifecycleError = error;
} finally {
  try {
    terminateOwnedProcesses(installedExecutable);
    await waitFor(
      () => (productProcesses(installedExecutable).length === 0 ? true : false),
      15_000,
      'Owned process cleanup',
    );
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    if (
      registryKeysWereCollisionFree &&
      installationMutationStarted &&
      (installed || (await exists(installedExecutable))) &&
      (await exists(uninstaller))
    ) {
      await run(uninstaller, ['/S'], { label: 'NSIS cleanup uninstall', timeoutMs: 180_000 });
      installed = false;
    }
    if (await exists(installDirectory)) {
      throw new Error('The owned installation directory remains after cleanup uninstall.');
    }
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (recovery !== undefined && !recoveryConsumed) {
    try {
      await inspectRecoverySentinel(recovery, true);
      recoveryConsumed = true;
    } catch (error) {
      cleanupErrors.push(error);
      for (const filePath of recovery.files) {
        await rm(filePath, { force: true }).catch((cleanupError) =>
          cleanupErrors.push(cleanupError),
        );
      }
    }
  }

  await rm(marker, { force: true }).catch((error) => cleanupErrors.push(error));
  if (applicationDataBaselineCaptured && !recoveryBlobsExisted) {
    await removeIfEmpty(recoveryBlobsDirectory).catch((error) => cleanupErrors.push(error));
  }
  if (applicationDataBaselineCaptured && !recoveryDirectoryExisted) {
    await removeIfEmpty(recoveryDirectory).catch((error) => cleanupErrors.push(error));
  }
  if (applicationDataBaselineCaptured && !applicationDataExisted) {
    await removeIfEmpty(applicationData).catch((error) => cleanupErrors.push(error));
  }

  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
    (error) => cleanupErrors.push(error),
  );
}

try {
  if (await exists(temporaryRoot)) throw new Error('The owned installer smoke directory remains.');
  if (productProcesses(installedExecutable).length > 0 || namedProductProcesses().length > 0) {
    throw new Error('A product process remains after the installer lifecycle.');
  }
  if (registryBefore !== undefined) {
    assertNoProductRegistry(
      registryState(installDirectory),
      registryBefore,
      capturedRegistryIdentities,
    );
  }
  if (shortcutsBefore !== undefined) {
    assertNoShortcuts(shortcutState(installedExecutable));
  }
  if (applicationDataBefore !== undefined) {
    const applicationDataAfter = await snapshotTree(applicationData);
    if (!sameTreeSnapshot(applicationDataBefore, applicationDataAfter)) {
      throw new Error('Harness cleanup did not restore the prior application-data tree.');
    }
  }
  const leakedTemporaryEntries = newTemporaryEntries(
    temporaryEntriesBefore,
    await temporaryEntries(),
  );
  if (leakedTemporaryEntries.length > 0) {
    throw new Error(
      `Installer lifecycle left temporary directories: ${leakedTemporaryEntries.join(', ')}`,
    );
  }
  const harnessAfter = await harnessIdentity();
  assertStableHarnessManifest(harnessBefore.files, harnessAfter.files);
  assertSourceStateUnchanged(sourceBefore, inspectGitSourceState(repositoryRoot));
  const sourceTreeAfter = await trackedSourceIdentity(repositoryRoot);
  if (JSON.stringify(sourceTreeBefore) !== JSON.stringify(sourceTreeAfter)) {
    throw new Error('The tracked source tree changed while the installer smoke was running.');
  }
  assertStableArtifact(artifactBefore, await artifactIdentity(installer));
  assertStableArtifact(candidateManifestBefore, await regularFileIdentity(candidateManifestPath));
  assertStableArtifact(blockmapBefore, await regularFileIdentity(blockmapPath));
  assertStableArtifact(
    lockfileBefore,
    await regularFileIdentity(path.join(repositoryRoot, 'pnpm-lock.yaml')),
  );
  assertStableArtifact(
    companionExecutableBefore,
    await regularFileIdentity(companionExecutablePath, 1_048_576),
  );
  assertStableArtifact(
    companionAsarBefore,
    await regularFileIdentity(companionAsarPath, 1_048_576),
  );
  const finalEmbeddedProvenance = readPackagedBuildProvenance(companionAsarPath, desktopRoot);
  assertBuildProvenance(finalEmbeddedProvenance, expectedProvenance);
  if (JSON.stringify(finalEmbeddedProvenance) !== JSON.stringify(embeddedProvenance)) {
    throw new Error('The companion build provenance changed during the installer smoke.');
  }
} catch (error) {
  cleanupErrors.push(error);
}

if (lifecycleError !== undefined || cleanupErrors.length > 0) {
  const errors = [lifecycleError, ...cleanupErrors].filter((error) => error !== undefined);
  throw new AggregateError(
    errors,
    'Windows installer lifecycle smoke failed; no evidence was written.',
  );
}

const completedAt = new Date();
const report = {
  schemaVersion: 4,
  passed: true,
  startedAt: startedAt.toISOString(),
  completedAt: completedAt.toISOString(),
  durationMs: completedAt.getTime() - startedAt.getTime(),
  platform: `${process.platform}-${process.arch}`,
  sourceCommit: sourceBefore.commit,
  sourceCleanAndStable: true,
  sourceTree: sourceTreeBefore,
  lockfileSha256: lockfileBefore.sha256,
  harness: {
    ...harnessBefore,
    finalArtifactGate: true,
  },
  installer: {
    fileName: path.basename(installer),
    version: desktopPackage.version,
    sha256: artifactBefore.sha256,
    size: artifactBefore.size,
    mtimeUtc: artifactBefore.mtimeUtc,
    hashReverifiedAfterCleanup: true,
    labelledUnsigned: true,
  },
  releaseCandidateManifest: {
    fileName: path.basename(candidateManifestPath),
    sha256: candidateManifestBefore.sha256,
    sourceAndPayloadBindingVerified: true,
    embeddedBuildProvenanceVerified: true,
    blockmapSha256: blockmapBefore.sha256,
    companionExecutableSha256: companionExecutableBefore.sha256,
    companionAppAsarSha256: companionAsarBefore.sha256,
    installedPayloadMatchedCompanion: true,
  },
  stageDurationsMs,
  checks: {
    nonElevatedCurrentUserToken: true,
    dedicatedNonAdministratorAccount: 'not-tested',
    perUserRegistryOnly: true,
    perUserSilentInstall: true,
    unicodeInstallDirectory: true,
    requiredLicensesInstalled: true,
    exactDesktopAndStartMenuShortcuts: true,
    hdeckAssociationRegistered: true,
    hdeckDefaultPolicyVerified: true,
    hdeckDefaultOutcome:
      registryBefore.extensionDefault === null ||
      registryBefore.extensionDefault === undefined ||
      registryBefore.extensionDefault === ''
        ? 'product-established'
        : 'foreign-default-preserved',
    existingHdeckOpenedInRealEditor: true,
    installedMcpLauncherRoundTrip: true,
    repairRerunRestoredMissingPayload: true,
    upgradeLikeReinstallRemovedObsoletePayload: true,
    maintenancePreservedUserDeck: true,
    uninstallPreservedUserDeck: true,
    sourceDeckUnchangedWithoutSave: true,
    noResidualProductProcesses: true,
    noResidualProductRegistry: true,
    noResidualProductShortcuts: true,
    noResidualHarnessOrChildSmokeTemp: true,
    priorApplicationDataTreeRestored: true,
  },
  recoveryWorkspace: {
    validationScope: 'installer-file-preservation-only',
    installedExecutableRecoveryExecution: 'not-tested',
    opaqueRecoverySentinelPreserved: true,
    recoveryReplayCoveredByRuntimeTests: true,
  },
};
const evidenceTemporary = `${evidencePath}.${randomUUID()}.tmp`;
try {
  await writeFile(evidenceTemporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(evidenceTemporary, evidencePath);
} finally {
  await rm(evidenceTemporary, { force: true });
}
process.stdout.write(
  `Windows installer lifecycle smoke passed for sha256 ${artifactBefore.sha256}.\nEvidence: ${evidencePath}\n`,
);
