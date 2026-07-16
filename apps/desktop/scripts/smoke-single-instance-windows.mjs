import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDefaultDeck, createNeutralDemoDeck } from '@htmllelujah/document-core';
import { createHdeckArchive } from '@htmllelujah/hdeck';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidencePath = path.join(
  repositoryRoot,
  'artifacts',
  'evidence',
  'single-instance-windows-v1.json',
);
const dialogAutomationPath = path.join(import.meta.dirname, 'dismiss-message-box.ps1');
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
    await sleep(100);
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

const sha256 = async (filePath) =>
  createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex');

const terminateTree = async (child) => {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
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
      stdout = (stdout + chunk.toString('utf8')).slice(-4_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
    });
    const timer = setTimeout(() => {
      void terminateTree(child);
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
              `${stderr === '' ? '' : ` ${stderr.slice(-1_000)}`}`,
          ),
        );
      }
    });
  });

const associationContract = (installedExecutable) => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$extension = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\.hdeck')",
        "if ($null -eq $extension) { throw 'Missing extension association.' }",
        "$progId = [string]$extension.GetValue('')",
        '$extension.Dispose()',
        "if ([string]::IsNullOrWhiteSpace($progId)) { throw 'Missing association identifier.' }",
        "$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(('Software\\Classes\\{0}\\shell\\open\\command' -f $progId))",
        "if ($null -eq $commandKey) { throw 'Missing association command.' }",
        "$command = [string]$commandKey.GetValue('')",
        '$commandKey.Dispose()',
        '$value = [ordered]@{',
        '  executableRegistered = $command.IndexOf($env:HTMLLELUJAH_ASSOCIATION_TARGET, [System.StringComparison]::OrdinalIgnoreCase) -ge 0',
        '  quotedFilePlaceholder = $command.Contains(\'"%1"\')',
        '}',
        '$value | ConvertTo-Json -Compress',
      ].join('\n'),
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, HTMLLELUJAH_ASSOCIATION_TARGET: installedExecutable },
    },
  );
  if (result.status !== 0 || result.stdout?.trim() === '') return undefined;
  return JSON.parse(result.stdout.trim());
};

const productAssociationState = () => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$extension = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\.hdeck')",
        "$extensionDefault = if ($null -eq $extension) { $null } else { [string]$extension.GetValue('') }",
        'if ($null -ne $extension) { $extension.Dispose() }',
        "$productClass = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\HTMLlelujah presentation')",
        '$value = [ordered]@{',
        '  extensionDefaultRegistered = -not [string]::IsNullOrWhiteSpace($extensionDefault)',
        "  extensionTargetsProduct = $extensionDefault -eq 'HTMLlelujah presentation'",
        '  productClassRegistered = $null -ne $productClass',
        '}',
        'if ($null -ne $productClass) { $productClass.Dispose() }',
        '$value | ConvertTo-Json -Compress',
      ].join('\n'),
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.status !== 0 || result.stdout?.trim() === '') {
    throw new Error('The .hdeck association state could not be inspected.');
  }
  return JSON.parse(result.stdout.trim());
};

const removeTestAssociation = () => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$extensionPath = 'Software\\Classes\\.hdeck'",
        "$productClassPath = 'Software\\Classes\\HTMLlelujah presentation'",
        '$extension = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($extensionPath)',
        "$owned = $null -ne $extension -and [string]$extension.GetValue('') -eq 'HTMLlelujah presentation'",
        'if ($null -ne $extension) { $extension.Dispose() }',
        'if ($owned) { [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($extensionPath, $false) }',
        '[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($productClassPath, $false)',
      ].join('\n'),
    ],
    { windowsHide: true, encoding: 'utf8', timeout: 15_000 },
  );
  if (result.status !== 0) throw new Error('The test-scoped .hdeck association cleanup failed.');
};

const electronProcessIds = () => {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$items = @(Get-Process -Name 'HTMLlelujah' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)",
        '$items | ConvertTo-Json -Compress',
      ].join('\n'),
    ],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  if (result.status !== 0) throw new Error('Windows process enumeration failed.');
  const output = result.stdout?.trim();
  if (output === undefined || output === '' || output === 'null') return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter(Number.isInteger);
};

const dismissOpenFailure = async (rootProcessId) => {
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      dialogAutomationPath,
      '-RootProcessId',
      String(rootProcessId),
      '-WindowTitle',
      'Presentation could not be opened',
      '-TimeoutSeconds',
      '3',
    ],
    { label: 'Native open-failure dialog', timeoutMs: 18_000 },
  );
};

const invokeAssociationSecondary = async ({ executable, profile, targetPath }) => {
  const startedAt = Date.now();
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      [
        "$extension = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Classes\\.hdeck')",
        "if ($null -eq $extension) { throw 'Missing extension association.' }",
        "$progId = [string]$extension.GetValue('')",
        '$extension.Dispose()',
        "$keyPath = 'Software\\Classes\\{0}\\shell\\open\\command' -f $progId",
        '$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)',
        "if ($null -eq $commandKey) { throw 'Missing writable association command.' }",
        "$original = [string]$commandKey.GetValue('')",
        '$testCommand = (\'"{0}" --user-data-dir="{1}" "%1"\' -f $env:HTMLLELUJAH_ASSOCIATION_EXECUTABLE, $env:HTMLLELUJAH_ASSOCIATION_PROFILE)',
        'try {',
        "  $commandKey.SetValue('', $testCommand, [Microsoft.Win32.RegistryValueKind]::String)",
        '  $commandKey.Flush()',
        '  $commandKey.Dispose()',
        '  $commandKey = $null',
        '  $secondary = Start-Process -FilePath $env:HTMLLELUJAH_ASSOCIATION_DOCUMENT -Verb Open -PassThru',
        "  if (-not $secondary.WaitForExit(15000)) { throw 'Associated invocation did not delegate.' }",
        "  if ($secondary.ExitCode -ne 0) { throw 'Associated invocation failed.' }",
        '}',
        'finally {',
        '  if ($null -ne $commandKey) { $commandKey.Dispose() }',
        '  $restoreKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)',
        "  if ($null -eq $restoreKey) { throw 'Association command could not be restored.' }",
        "  $restoreKey.SetValue('', $original, [Microsoft.Win32.RegistryValueKind]::String)",
        '  $restoreKey.Flush()',
        '  $restoreKey.Dispose()',
        '}',
      ].join('\n'),
    ],
    {
      label: 'Windows .hdeck shell association invocation',
      timeoutMs: 30_000,
      env: {
        ...process.env,
        HTMLLELUJAH_ASSOCIATION_EXECUTABLE: executable,
        HTMLLELUJAH_ASSOCIATION_PROFILE: profile,
        HTMLLELUJAH_ASSOCIATION_DOCUMENT: targetPath,
      },
    },
  );
  return Date.now() - startedAt;
};

class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #socket;

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('CDP WebSocket connection timed out.')),
        5_000,
      );
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP WebSocket connection failed.'));
        },
        { once: true },
      );
    });
    return new CdpSession(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error(`CDP closed while waiting for ${pending.method}.`));
      }
      this.#pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#socket.close();
  }
}

const readEditorState = async (cdp) => {
  const response = await cdp.send('Runtime.evaluate', {
    expression: `(() => ({
      ready: document.readyState === 'complete' && document.querySelector('.app-shell') !== null,
      name: document.querySelector('.document-title span')?.textContent?.trim() ?? '',
      slideCount: document.querySelectorAll('.canonical-thumbnail').length,
    }))()`,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error('The installed renderer could not be inspected.');
  }
  return response.result?.value;
};

const invokeSecondary = async ({ executable, profile, targetPath, label }) => {
  const startedAt = Date.now();
  const child = spawn(
    executable,
    [targetPath, `--user-data-dir=${profile}`, '--force-device-scale-factor=1'],
    {
      cwd: desktopRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
  });
  const outcome = await Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    sleep(15_000).then(() => undefined),
  ]);
  if (outcome === undefined) {
    await terminateTree(child);
    throw new Error(`${label} did not delegate to the existing instance.`);
  }
  if (outcome.code !== 0) {
    throw new Error(
      `${label} exited ${outcome.code ?? outcome.signal}.${stderr === '' ? '' : ' Diagnostics were emitted.'}`,
    );
  }
  return Date.now() - startedAt;
};

if (process.platform !== 'win32') throw new Error('The single-instance smoke requires Windows.');
const installer = path.resolve(
  process.argv[2] ?? path.join(desktopRoot, 'out', 'HTMLlelujah-1.0.0-x64-unsigned-Setup.exe'),
);
const finalArtifact = process.argv.slice(3).includes('--final-artifact');
if (!path.basename(installer).includes('-unsigned-Setup.exe') || !(await exists(installer))) {
  throw new Error('A labelled unsigned HTMLlelujah NSIS installer is required.');
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-single-instance-smoke-'));
const safePrefix = path.join(path.resolve(tmpdir()), 'htmllelujah-single-instance-smoke-');
if (!path.resolve(temporaryRoot).startsWith(safePrefix)) {
  throw new Error('Refusing unsafe single-instance smoke directory.');
}
const installDirectory = path.join(temporaryRoot, 'Install single instance é');
const profileDirectory = path.join(temporaryRoot, 'Profil isolé');
const deckAPath = path.join(temporaryRoot, 'Deck A with quoted spaces.hdeck');
const deckBPath = path.join(temporaryRoot, 'Deck B – été with quoted spaces.HDECK');
const malformedPath = path.join(temporaryRoot, 'Deck malformed é.HdEcK');
const missingPath = path.join(temporaryRoot, 'Deck missing é.HDECK');
const installedExecutable = path.join(installDirectory, 'HTMLlelujah.exe');
const uninstaller = path.join(installDirectory, 'Uninstall HTMLlelujah.exe');
let installed = false;
let application;
let cdp;
let nativeFailureDialogsDismissed = 0;
let cleanAssociationBaseline = false;

try {
  const associationBefore = productAssociationState();
  if (associationBefore.extensionDefaultRegistered || associationBefore.productClassRegistered) {
    throw new Error('The installer smoke requires an isolated .hdeck association state.');
  }
  cleanAssociationBaseline = true;
  const documentA = createDefaultDeck({
    name: 'Single-instance deck A',
    creator: 'HTMLlelujah release smoke',
  });
  const neutralB = createNeutralDemoDeck();
  const documentB = { ...neutralB, name: 'Single-instance deck B' };
  await mkdir(profileDirectory, { recursive: true });
  await Promise.all([
    writeFile(deckAPath, createHdeckArchive({ document: documentA })),
    writeFile(deckBPath, createHdeckArchive({ document: documentB })),
    writeFile(malformedPath, 'This is intentionally not an hdeck archive.\n', 'utf8'),
  ]);
  const validHashesBefore = await Promise.all([sha256(deckAPath), sha256(deckBPath)]);

  await run(installer, ['/S', `/D=${installDirectory}`], {
    label: 'NSIS install',
    timeoutMs: 180_000,
  });
  installed = true;
  await waitFor(() => exists(installedExecutable), 30_000, 'Installed application');
  const executableMetadata = await stat(installedExecutable);
  if (!executableMetadata.isFile() || executableMetadata.size === 0) {
    throw new Error('The installed application executable is invalid.');
  }
  const association = associationContract(installedExecutable);
  if (
    association === undefined ||
    !association.executableRegistered ||
    !association.quotedFilePlaceholder
  ) {
    throw new Error('The installed .hdeck shell association command is incomplete.');
  }
  if (electronProcessIds().length !== 0) {
    throw new Error('The single-instance smoke requires an isolated product process state.');
  }

  const launchArguments = [
    deckAPath,
    `--user-data-dir=${profileDirectory}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--force-device-scale-factor=1',
  ];
  application = spawn(installedExecutable, launchArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let applicationError = '';
  application.stderr.on('data', (chunk) => {
    applicationError = (applicationError + chunk.toString('utf8')).slice(-4_000);
  });
  const debuggingPort = await waitFor(
    async () => {
      if (application.exitCode !== null || application.signalCode !== null) {
        throw new Error('The installed application exited before opening a window.');
      }
      try {
        const value = await readFile(path.join(profileDirectory, 'DevToolsActivePort'), 'utf8');
        const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
        if (Number.isInteger(port) && port > 0) return port;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const match = applicationError.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
      return match === null ? undefined : Number.parseInt(match[1], 10);
    },
    20_000,
    'Installed application debugging endpoint',
  );
  const target = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      if (!response.ok) return undefined;
      const targets = await response.json();
      return targets.find(
        (candidate) =>
          candidate.type === 'page' &&
          typeof candidate.url === 'string' &&
          candidate.url.startsWith('htmllelujah-app://app/'),
      );
    },
    20_000,
    'Installed editor target',
  );
  cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');
  const initial = await waitFor(
    async () => {
      const state = await readEditorState(cdp);
      return state?.ready && state.name === documentA.name ? state : undefined;
    },
    20_000,
    'Deck A editor state',
  );
  if (initial.slideCount !== documentA.slides.length) {
    throw new Error('Deck A opened with an unexpected slide count.');
  }
  if (application.pid === undefined) throw new Error('The primary process ID is unavailable.');
  const initialProcesses = electronProcessIds();
  if (!initialProcesses.includes(application.pid)) {
    throw new Error('The initial application process could not be observed.');
  }

  const secondaryDurationMs = await invokeAssociationSecondary({
    executable: installedExecutable,
    profile: profileDirectory,
    targetPath: deckBPath,
  });
  const switched = await waitFor(
    async () => {
      const state = await readEditorState(cdp);
      return state?.name === documentB.name && state.slideCount === documentB.slides.length
        ? state
        : undefined;
    },
    20_000,
    'Existing window deck replacement',
  );
  const afterValidInvocation = electronProcessIds();
  const targetsAfterValidInvocation = await (
    await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
  ).json();
  const editorTargetCount = targetsAfterValidInvocation.filter(
    (candidate) =>
      candidate.type === 'page' &&
      typeof candidate.url === 'string' &&
      candidate.url.startsWith('htmllelujah-app://app/'),
  ).length;
  if (
    !afterValidInvocation.includes(application.pid) ||
    switched.slideCount === initial.slideCount ||
    editorTargetCount !== 1
  ) {
    throw new Error('The second invocation did not reuse exactly the existing editor process.');
  }
  const restoredAssociation = associationContract(installedExecutable);
  if (
    restoredAssociation === undefined ||
    !restoredAssociation.executableRegistered ||
    !restoredAssociation.quotedFilePlaceholder
  ) {
    throw new Error('The scoped shell invocation did not restore the installed association.');
  }

  await invokeSecondary({
    executable: installedExecutable,
    profile: profileDirectory,
    targetPath: malformedPath,
    label: 'Malformed-deck invocation',
  });
  await sleep(750);
  const afterMalformed = await readEditorState(cdp);
  if (
    afterMalformed.name !== documentB.name ||
    afterMalformed.slideCount !== documentB.slides.length
  ) {
    throw new Error('A malformed .hdeck replaced the current editor session.');
  }
  if (
    await dismissOpenFailure(application.pid)
      .then(() => true)
      .catch(() => false)
  ) {
    nativeFailureDialogsDismissed += 1;
  }

  await invokeSecondary({
    executable: installedExecutable,
    profile: profileDirectory,
    targetPath: missingPath,
    label: 'Missing-deck invocation',
  });
  await sleep(750);
  const afterMissing = await readEditorState(cdp);
  if (afterMissing.name !== documentB.name || afterMissing.slideCount !== documentB.slides.length) {
    throw new Error('A missing .hdeck replaced the current editor session.');
  }
  if (
    await dismissOpenFailure(application.pid)
      .then(() => true)
      .catch(() => false)
  ) {
    nativeFailureDialogsDismissed += 1;
  }
  const finalProcesses = electronProcessIds();
  if (!finalProcesses.includes(application.pid)) {
    throw new Error('The primary process did not survive the edge-case invocations.');
  }
  const validHashesAfter = await Promise.all([sha256(deckAPath), sha256(deckBPath)]);
  if (JSON.stringify(validHashesAfter) !== JSON.stringify(validHashesBefore)) {
    throw new Error('Opening presentations without saving changed a source file.');
  }

  await cdp.send('Browser.close').catch(() => undefined);
  cdp.close();
  cdp = undefined;
  await waitFor(
    () => (application.exitCode !== null || application.signalCode !== null ? true : undefined),
    15_000,
    'Primary application shutdown',
  ).catch(async () => terminateTree(application));
  await waitFor(
    () => (electronProcessIds().length === 0 ? true : undefined),
    15_000,
    'Installed process cleanup',
  );

  await run(uninstaller, ['/S'], { label: 'NSIS uninstall', timeoutMs: 180_000 });
  installed = false;
  await waitFor(async () => !(await exists(installedExecutable)), 30_000, 'Application removal');
  const associationAfter = productAssociationState();
  if (associationAfter.extensionTargetsProduct || associationAfter.productClassRegistered) {
    throw new Error('Uninstall left a product-owned .hdeck association behind.');
  }
  if (
    (await sha256(deckAPath)) !== validHashesBefore[0] ||
    (await sha256(deckBPath)) !== validHashesBefore[1]
  ) {
    throw new Error('Uninstall changed a user presentation.');
  }

  const report = {
    schemaVersion: 1,
    passed: true,
    testedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    artifactFinality: finalArtifact ? 'final-release-candidate' : 'harness-validation-only',
    freshForRelease: finalArtifact,
    installer: {
      fileName: path.basename(installer),
      sha256: await sha256(installer),
      labelledUnsigned: true,
    },
    checks: {
      perUserSilentInstall: true,
      registeredShellCommandTargetsInstalledExecutable: true,
      registeredShellCommandQuotesFilePlaceholder: true,
      hdeckOpenedThroughWindowsShellAssociation: true,
      installedAssociationRestoredAfterScopedIsolation: true,
      quotedUnicodeCommandLinePathOpened: true,
      mixedCaseHdeckExtensionAccepted: true,
      secondInvocationExitedWithinMs: secondaryDurationMs,
      existingWindowSwitchedFromDeckAToDeckB: true,
      slideCountChangedWithDocument: true,
      exactlyOneDurablePrimaryProcess: true,
      editorRendererTargetsAfterSecondInvocation: editorTargetCount,
      malformedArchivePreservedCurrentSession: true,
      missingArchivePreservedCurrentSession: true,
      nativeFailureDialogsDismissedWhenExposed: nativeFailureDialogsDismissed,
      sourceDecksUnchangedWithoutSave: true,
      allInstalledProcessesExitedBeforeUninstall: true,
      silentUninstallRemovedApplication: true,
      uninstallRemovedProductAssociation: true,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    'Windows single-instance smoke passed: association, reuse, edge cases, and cleanup verified.\n' +
      (finalArtifact
        ? 'Evidence is marked as a final-release-candidate run.\n'
        : 'Evidence is marked stale: harness validation only.\n'),
  );
} finally {
  cdp?.close();
  await terminateTree(application).catch(() => undefined);
  if (installed && (await exists(uninstaller))) {
    await run(uninstaller, ['/S'], {
      label: 'NSIS cleanup uninstall',
      timeoutMs: 180_000,
    }).catch(() => undefined);
  }
  if (cleanAssociationBaseline) removeTestAssociation();
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
