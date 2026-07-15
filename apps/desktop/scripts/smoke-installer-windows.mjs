import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultDeck } from '@htmllelujah/document-core';
import { createHdeckArchive } from '@htmllelujah/hdeck';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidencePath = path.join(repositoryRoot, 'artifacts', 'evidence', 'installer-v1.json');
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

const terminateTree = (processId) => {
  if (process.platform !== 'win32' || processId === undefined) return;
  spawnSync('taskkill', ['/PID', String(processId), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 10_000,
  });
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
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-8_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8_000);
    });
    const timer = setTimeout(() => {
      terminateTree(child.pid);
      reject(new Error(`${options.label ?? path.basename(command)} timed out.`));
    }, options.timeoutMs ?? 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
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

const sha256 = async (filePath) =>
  createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

const registryAssociation = () => {
  const result = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\.hdeck', '/s'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return {
    exists: result.status === 0,
    text: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
};

if (process.platform !== 'win32') throw new Error('The installer smoke requires Windows.');
const installer = path.resolve(
  process.argv[2] ?? path.join(desktopRoot, 'out', 'HTMLlelujah-1.0.0-x64-unsigned-Setup.exe'),
);
if (!path.basename(installer).includes('-unsigned-Setup.exe') || !(await exists(installer))) {
  throw new Error('A labelled unsigned HTMLlelujah NSIS installer is required.');
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-installer-smoke-'));
const safePrefix = path.join(path.resolve(tmpdir()), 'htmllelujah-installer-smoke-');
if (!path.resolve(temporaryRoot).startsWith(safePrefix)) {
  throw new Error('Refusing unsafe installer smoke directory.');
}
const installDirectory = path.join(temporaryRoot, 'Install-é-test');
const deckPath = path.join(temporaryRoot, 'preserved-user-deck.hdeck');
const installedExecutable = path.join(installDirectory, 'HTMLlelujah.exe');
const installedLauncher = path.join(installDirectory, 'HTMLlelujah-MCP.cmd');
const uninstaller = path.join(installDirectory, 'Uninstall HTMLlelujah.exe');
const appDataRoot = process.env.APPDATA;
if (appDataRoot === undefined) throw new Error('APPDATA is unavailable.');
const applicationData = path.join(appDataRoot, 'HTMLlelujah');
const applicationDataExisted = await exists(applicationData);
const marker = path.join(applicationData, `installer-smoke-${randomUUID()}.txt`);
const associationBefore = registryAssociation();
let installed = false;
let markerWritten = false;

try {
  const document = createDefaultDeck({
    name: 'Installed V1 verification',
    creator: 'HTMLlelujah release smoke',
  });
  await writeFile(deckPath, createHdeckArchive({ document }));
  const deckHashBefore = await sha256(deckPath);

  await run(installer, ['/S', `/D=${installDirectory}`], {
    label: 'NSIS install',
    timeoutMs: 180_000,
  });
  installed = true;
  await waitFor(() => exists(installedExecutable), 30_000, 'Installed application');
  for (const required of [
    installedLauncher,
    uninstaller,
    path.join(installDirectory, 'EULA.txt'),
    path.join(installDirectory, 'LICENSE.txt'),
    path.join(installDirectory, 'THIRD_PARTY_NOTICES.md'),
    path.join(installDirectory, 'LICENSE.electron.txt'),
    path.join(installDirectory, 'LICENSES.chromium.html'),
  ]) {
    const metadata = await stat(required);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`Installed release file is invalid: ${path.basename(required)}`);
    }
  }

  const associationInstalled = registryAssociation();
  if (!associationInstalled.exists || !/HTMLlelujah/iu.test(associationInstalled.text)) {
    throw new Error('The per-user .hdeck association was not registered.');
  }

  await run(process.execPath, [path.join(desktopRoot, 'scripts', 'smoke-ui-electron.mjs')], {
    label: 'Installed editor UI smoke',
    timeoutMs: 120_000,
    env: {
      ...process.env,
      HTMLLELUJAH_EXECUTABLE: installedExecutable,
      HTMLLELUJAH_OPEN_PATH: deckPath,
      HTMLLELUJAH_EXPECTED_DECK_NAME: document.name,
    },
  });
  if ((await sha256(deckPath)) !== deckHashBefore) {
    throw new Error('Opening and editing in memory unexpectedly changed the source deck.');
  }
  await run(process.execPath, [path.join(desktopRoot, 'scripts', 'smoke-mcp-electron.mjs')], {
    label: 'Installed MCP launcher smoke',
    timeoutMs: 120_000,
    env: {
      ...process.env,
      HTMLLELUJAH_EXECUTABLE: installedExecutable,
      HTMLLELUJAH_MCP_LAUNCHER: installedLauncher,
    },
  });

  await mkdir(applicationData, { recursive: true });
  await writeFile(marker, 'installer preservation marker\n', 'utf8');
  markerWritten = true;
  await run(installer, ['/S', `/D=${installDirectory}`], {
    label: 'NSIS in-place upgrade',
    timeoutMs: 180_000,
  });
  if (!(await exists(marker)) || !(await exists(deckPath))) {
    throw new Error('In-place upgrade removed user data.');
  }

  await run(uninstaller, ['/S'], { label: 'NSIS uninstall', timeoutMs: 180_000 });
  installed = false;
  await waitFor(async () => !(await exists(installedExecutable)), 30_000, 'Application removal');
  if (!(await exists(marker)) || !(await exists(deckPath))) {
    throw new Error('Uninstall removed user data or the user presentation.');
  }
  const associationAfter = registryAssociation();
  if (
    !associationBefore.exists &&
    associationAfter.exists &&
    associationAfter.text.toLowerCase().includes(installDirectory.toLowerCase())
  ) {
    throw new Error('Uninstall left the temporary .hdeck association registered.');
  }

  const report = {
    schemaVersion: 1,
    passed: true,
    testedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    installer: {
      fileName: path.basename(installer),
      sha256: await sha256(installer),
      labelledUnsigned: true,
    },
    checks: {
      perUserSilentInstall: true,
      unicodeInstallDirectory: true,
      requiredLicensesInstalled: true,
      hdeckAssociationRegistered: true,
      existingHdeckOpenedInRealEditor: true,
      installedMcpLauncherRoundTrip: true,
      inPlaceUpgradePreservedUserData: true,
      uninstallPreservedUserData: true,
      sourceDeckUnchangedWithoutSave: true,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    'Windows installer smoke passed: install, open, MCP, upgrade, uninstall, and preservation verified.\n',
  );
} finally {
  if (installed && (await exists(uninstaller))) {
    await run(uninstaller, ['/S'], { label: 'NSIS cleanup uninstall', timeoutMs: 180_000 }).catch(
      () => undefined,
    );
  }
  if (markerWritten) await rm(marker, { force: true }).catch(() => undefined);
  if (!applicationDataExisted && (await exists(applicationData))) {
    const remaining = await readdir(applicationData).catch(() => ['unknown']);
    if (remaining.length === 0) await rm(applicationData, { force: true }).catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
