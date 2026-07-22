import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalRpcClient } from '@htmllelujah/mcp-server';

import { drainChildProcess, waitForChildClose } from './child-process-cleanup.mjs';
import {
  assessInteractiveReadinessSamples,
  assertInteractiveReadiness,
  WARM_START_BUDGET_MS,
  WARM_START_TARGET_MS,
} from './ui-smoke-performance.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidenceDirectory = path.join(repositoryRoot, 'artifacts', 'evidence');
const screenshotPath = path.join(evidenceDirectory, 'v1-editor-electron.png');
const presentationScreenshotPath = path.join(evidenceDirectory, 'v1-presentation-electron.png');
const reportPath = path.join(evidenceDirectory, 'v1-editor-electron.json');
const dialogAutomationPath = path.join(import.meta.dirname, 'automate-save-dialog.ps1');
const messageBoxAutomationPath = path.join(import.meta.dirname, 'dismiss-message-box.ps1');
const windowCloseAutomationPath = path.join(import.meta.dirname, 'request-window-close.ps1');
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

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

const waitForExit = (child, timeoutMs) => {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
};

const terminate = async (child, label = 'Electron process') => {
  return drainChildProcess({ child, label });
};

const automateFileDialog = (rootProcessId, windowTitle, targetPath, dialogKind) => {
  let child;
  let cancelled = false;
  let timedOut = false;
  let termination;
  let stdout = '';
  let stderr = '';
  const stopAutomation = () => {
    if (child === undefined || hasExited(child)) return Promise.resolve();
    termination ??= terminate(child, `Native file-dialog automation for "${windowTitle}"`);
    return termination;
  };
  const completion = new Promise((resolve, reject) => {
    child = spawn(
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
        windowTitle,
        '-TargetPath',
        targetPath,
        '-DialogKind',
        dialogKind,
        '-TimeoutSeconds',
        '30',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-2_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
      void stopAutomation().then(
        () => {
          if (cancelled) resolve();
          else
            reject(
              new Error(
                `Native file-dialog automation timed out for "${windowTitle}".` +
                  (diagnostics === '' ? '' : ` Diagnostics: ${diagnostics}`),
              ),
            );
        },
        (terminationError) =>
          reject(
            new AggregateError(
              [terminationError],
              `Native file-dialog automation timed out for "${windowTitle}" and its process tree could not be drained.` +
                (diagnostics === '' ? '' : ` Diagnostics: ${diagnostics}`),
            ),
          ),
      );
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (cancelled) resolve();
      else reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (cancelled || code === 0) resolve();
      else {
        const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
        reject(
          new Error(
            `Native file-dialog automation for "${windowTitle}" exited ${code ?? signal}.` +
              (diagnostics === '' ? '' : ` Diagnostics: ${diagnostics}`),
          ),
        );
      }
    });
  });
  void completion.catch(() => undefined);
  const cancel = async () => {
    if (cancelled) {
      await stopAutomation();
      await Promise.allSettled([completion]);
      return;
    }
    cancelled = true;
    await stopAutomation();
    await Promise.allSettled([completion]);
  };
  return Object.assign(completion, { cancel });
};

const automateMessageBox = (
  rootProcessId,
  windowTitle,
  buttonName,
  delayMilliseconds = 0,
  releasePath = '',
) => {
  let child;
  let cancelled = false;
  let timedOut = false;
  let termination;
  let signalReady;
  let readySignaled = false;
  let stdout = '';
  let stderr = '';
  const stopAutomation = () => {
    if (child === undefined || hasExited(child)) return Promise.resolve();
    termination ??= terminate(child, `Native message-box automation for "${windowTitle}"`);
    return termination;
  };
  const ready = new Promise((resolve) => {
    signalReady = (value) => {
      if (readySignaled) return;
      readySignaled = true;
      resolve(value);
    };
  });
  const completion = new Promise((resolve, reject) => {
    child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        messageBoxAutomationPath,
        '-RootProcessId',
        String(rootProcessId),
        '-WindowTitle',
        windowTitle,
        '-ButtonName',
        buttonName,
        '-DelayMilliseconds',
        String(delayMilliseconds),
        '-ReleasePath',
        releasePath,
        '-TimeoutSeconds',
        '30',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-2_000);
      if (stdout.includes('__HTMLLELUJAH_MESSAGE_BOX_READY__')) signalReady(true);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalReady(false);
      const diagnostics = [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
      void stopAutomation().then(
        () => {
          if (cancelled) resolve();
          else
            reject(
              new Error(
                `Native message-box automation timed out for "${windowTitle}".` +
                  (diagnostics === '' ? '' : ` Diagnostics: ${diagnostics}`),
              ),
            );
        },
        (terminationError) =>
          reject(
            new AggregateError(
              [terminationError],
              `Native message-box automation timed out for "${windowTitle}" and its process tree could not be drained.` +
                (diagnostics === '' ? '' : ` Diagnostics: ${diagnostics}`),
            ),
          ),
      );
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      signalReady(false);
      if (timedOut) return;
      if (cancelled) resolve();
      else reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!readySignaled) signalReady(false);
      if (timedOut) return;
      if (cancelled || code === 0) resolve();
      else
        reject(
          new Error(
            `Native message-box automation for "${windowTitle}" / "${buttonName}" exited ${code ?? signal}.` +
              ([stdout.trim(), stderr.trim()].filter(Boolean).length === 0
                ? ''
                : ` Diagnostics: ${[stdout.trim(), stderr.trim()].filter(Boolean).join(' | ')}`),
          ),
        );
    });
  });
  void completion.catch(() => undefined);
  const cancel = async () => {
    if (cancelled) {
      await stopAutomation();
      await Promise.allSettled([completion]);
      return;
    }
    cancelled = true;
    signalReady(false);
    await stopAutomation();
    await Promise.allSettled([completion]);
  };
  const diagnostics = () => [stdout.trim(), stderr.trim()].filter(Boolean).join(' | ');
  return Object.assign(completion, { ready, cancel, diagnostics });
};

const requestNativeWindowClose = (rootProcessId) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowCloseAutomationPath,
        '-RootProcessId',
        String(rootProcessId),
        '-TimeoutSeconds',
        '10',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-2_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native window-close automation timed out.'));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && stdout.includes('__HTMLLELUJAH_NATIVE_CLOSE_REQUESTED__')) {
        const processTreeLine = stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith('__HTMLLELUJAH_PROCESS_TREE__'));
        let processIds;
        try {
          processIds = JSON.parse(processTreeLine?.slice('__HTMLLELUJAH_PROCESS_TREE__'.length));
        } catch {
          processIds = undefined;
        }
        if (
          !Array.isArray(processIds) ||
          processIds.length < 1 ||
          processIds.some((processId) => !Number.isInteger(processId) || processId < 1)
        ) {
          reject(
            new Error(`Native window-close automation returned no valid process tree. ${stdout}`),
          );
          return;
        }
        resolve({ processIds: [...new Set(processIds)] });
      } else {
        reject(
          new Error(`Native window-close automation exited ${code ?? signal}. ${stderr || stdout}`),
        );
      }
    });
  });

const processIsAlive = (processId) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
};

const waitForProcessTreeExit = (processIds, label) =>
  waitFor(
    () => {
      const remaining = processIds.filter(processIsAlive);
      if (remaining.length === 0) return true;
      throw new Error(`${remaining.length} scoped process(es) remain.`);
    },
    15_000,
    `${label} process-tree exit`,
  );

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

const waitForDebuggingPort = (child, userData, getStderr, getSpawnError, label) =>
  waitFor(
    async () => {
      const spawnError = getSpawnError();
      if (spawnError !== undefined) throw spawnError;
      if (hasExited(child)) {
        throw new Error(`${label} exited before its debugging endpoint was ready.`);
      }
      try {
        const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
        const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
        if (Number.isInteger(port) && port > 0) return port;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const match = getStderr().match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
      return match === null ? undefined : Number.parseInt(match[1], 10);
    },
    15_000,
    `${label} remote debugging endpoint`,
  );

const waitForRendererTarget = (debuggingPort, label) =>
  waitFor(
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
    15_000,
    `${label} renderer target`,
  );

const evaluateCdp = async (session, expression, userGesture = false) => {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  if (response.exceptionDetails !== undefined) {
    const detail =
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new Error(`Renderer evaluation failed: ${detail}`);
  }
  return response.result?.value;
};

const waitForDecodedImages = async (session, selector, label, timeoutMs = 10_000) => {
  let latestState;
  try {
    return await waitFor(
      async () => {
        latestState = await evaluateCdp(
          session,
          `(async () => {
            const images = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(
              (candidate) => candidate instanceof HTMLImageElement,
            );
            const states = await Promise.all(images.map(async (image) => {
              const decoded = typeof image.decode !== 'function'
                ? true
                : await Promise.race([
                    image.decode().then(() => true, () => false),
                    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
                  ]);
              return {
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                decoded,
              };
            }));
            return {
              ready: states.length > 0 && states.every(
                (state) =>
                  state.complete &&
                  state.naturalWidth > 0 &&
                  state.naturalHeight > 0 &&
                  state.decoded,
              ),
              count: states.length,
              states,
            };
          })()`,
        );
        return latestState?.ready === true ? latestState : undefined;
      },
      timeoutMs,
      label,
    );
  } catch (error) {
    const detail = latestState === undefined ? 'no image state' : JSON.stringify(latestState);
    throw new Error(
      `${label} failed (${detail}).${error instanceof Error ? ` ${error.message}` : ''}`,
    );
  }
};

const recoveryArtifactPaths = (userData, sessionId) => [
  path.join(userData, 'recovery', `${sessionId}.base.hdeck`),
  path.join(userData, 'recovery', `${sessionId}.journal`),
  path.join(userData, 'recovery', `${sessionId}.meta.json`),
];

const assertRecoveryArtifactsRemoved = async (userData, sessionId, label) => {
  for (const artifactPath of recoveryArtifactPaths(userData, sessionId)) {
    try {
      await access(artifactPath);
      throw new Error(`${label} left a recovery artifact behind: ${artifactPath}.`);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
};

const closeLaunchGracefully = async ({
  child,
  userData,
  sessionId,
  label,
  expectUnsavedPrompt,
}) => {
  if (child.pid === undefined) throw new Error(`${label} process ID is unavailable.`);
  const discard = expectUnsavedPrompt
    ? automateMessageBox(child.pid, 'Unsaved changes', 'Discard')
    : undefined;
  let nativeClose;
  void discard?.catch(() => undefined);
  try {
    nativeClose = await requestNativeWindowClose(child.pid);
    if (discard !== undefined) {
      if (!(await discard.ready)) await discard;
      await discard;
    }
    if (!(await waitForExit(child, 30_000))) {
      const automationDiagnostics = discard?.diagnostics() ?? '';
      throw new Error(
        `${label} did not exit after its native close request.` +
          (automationDiagnostics === ''
            ? ''
            : ` Native message-box diagnostics: ${automationDiagnostics}`),
      );
    }
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error(
        `${label} exited abnormally after its native close request (code ${child.exitCode}, signal ${child.signalCode}).`,
      );
    }
    if (!(await waitForChildClose(child, 15_000))) {
      throw new Error(`${label} exited but did not close its inherited process handles.`);
    }
    await waitForProcessTreeExit(nativeClose.processIds, label);
  } finally {
    if (discard !== undefined) await discard.cancel();
  }
  await assertRecoveryArtifactsRemoved(userData, sessionId, label);
  return {
    requestedViaNativeWindowClose: true,
    unsavedChoice: expectUnsavedPrompt ? 'discard' : 'not-required',
    processExited: true,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    processTreeSize: nativeClose.processIds.length,
    processTreeExited: true,
    recoveryArtifactsRemoved: true,
  };
};

const runCleanLaunchProbe = async ({
  launchCommand,
  launchArguments,
  launchEnvironment,
  userData,
  label,
  role,
  ordinal,
  expectedDeckName,
  expectUnsavedPrompt,
}) => {
  const debuggingPortPath = path.join(userData, 'DevToolsActivePort');
  await rm(debuggingPortPath, { force: true });

  const startedAt = performance.now();
  const child = spawn(launchCommand, launchArguments, {
    cwd: desktopRoot,
    env: launchEnvironment,
    windowsHide: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let launchError = '';
  let launchSpawnError;
  child.once('error', (error) => {
    launchSpawnError = error;
  });
  child.stderr.on('data', (chunk) => {
    launchError += chunk.toString('utf8');
  });

  let launchCdp;
  let probeError;
  try {
    const debuggingPort = await waitForDebuggingPort(
      child,
      userData,
      () => launchError,
      () => launchSpawnError,
      label,
    );
    const debuggingPortReadyAt = performance.now();
    const target = await waitForRendererTarget(debuggingPort, label);
    const rendererTargetReadyAt = performance.now();
    launchCdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await launchCdp.send('Runtime.enable');
    await waitFor(
      async () =>
        (await evaluateCdp(
          launchCdp,
          `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
        )) || undefined,
      15_000,
      `${label} application shell`,
    );
    const applicationShellReadyAt = performance.now();
    await evaluateCdp(launchCdp, `document.fonts.ready.then(() => true)`);
    const fontsReadyAt = performance.now();
    await waitForDecodedImages(
      launchCdp,
      '.brand-lockup img.brand-mark',
      `${label} decoded official HTMLlelujah identity`,
    );
    const initialized = await evaluateCdp(
      launchCdp,
      `(async () => {
        const result = await window.htmllelujah.initialize();
        if (!result.ok) return { ok: false, errorCode: result.error.code };
        return {
          ok: true,
          sessionId: result.value.session.snapshot.sessionId,
          documentName: result.value.session.snapshot.document.name,
          recoveryCandidates: result.value.recoveryCandidates.length,
        };
      })()`,
    );
    if (
      initialized?.ok !== true ||
      typeof initialized.sessionId !== 'string' ||
      initialized.recoveryCandidates !== 0
    ) {
      throw new Error(`${label} did not initialize cleanly: ${JSON.stringify(initialized)}.`);
    }
    if (expectedDeckName !== undefined && initialized.documentName !== expectedDeckName) {
      throw new Error(
        `${label} opened ${initialized.documentName} instead of ${expectedDeckName}.`,
      );
    }
    const duration = (end, start) => Number((end - start).toFixed(3));
    const gracefulClose = await closeLaunchGracefully({
      child,
      userData,
      sessionId: initialized.sessionId,
      label,
      expectUnsavedPrompt,
    });
    return {
      role,
      ordinal,
      interactiveReadyMs: duration(fontsReadyAt, startedAt),
      milestonesMs: {
        debuggingPort: duration(debuggingPortReadyAt, startedAt),
        rendererTarget: duration(rendererTargetReadyAt, startedAt),
        applicationShell: duration(applicationShellReadyAt, startedAt),
        fontsReady: duration(fontsReadyAt, startedAt),
      },
      phasesMs: {
        spawnToDebuggingPort: duration(debuggingPortReadyAt, startedAt),
        debuggingPortToRendererTarget: duration(rendererTargetReadyAt, debuggingPortReadyAt),
        rendererTargetToApplicationShell: duration(applicationShellReadyAt, rendererTargetReadyAt),
        applicationShellToFontsReady: duration(fontsReadyAt, applicationShellReadyAt),
      },
      recoveryCandidatesAtReady: initialized.recoveryCandidates,
      profileReusedForMeasuredLaunch: true,
      documentName: initialized.documentName,
      gracefulClose,
    };
  } catch (error) {
    probeError = error;
    if (launchError !== '') {
      process.stderr.write(`[${label} desktop stderr]\n${launchError.slice(0, 4_000)}\n`);
    }
    throw error;
  } finally {
    launchCdp?.close();
    if (!hasExited(child)) {
      try {
        await terminate(child, `${label} process`);
      } catch (cleanupError) {
        if (probeError !== undefined) {
          throw new AggregateError(
            [probeError, cleanupError],
            `${label} failed and its process tree could not be drained.`,
          );
        }
        throw cleanupError;
      }
    }
    await rm(debuggingPortPath, { force: true });
  }
};

await Promise.all(
  [reportPath, screenshotPath, presentationScreenshotPath].map((outputPath) =>
    rm(outputPath, { force: true }),
  ),
);
const userData = await mkdtemp(path.join(tmpdir(), 'htmllelujah-ui-smoke-'));
const imageFixturePath = path.join(userData, 'native-image-import.png');
const closeHandshakeDeckPath = path.join(userData, 'close-handshake.hdeck');
const staleDiscardReleasePath = path.join(userData, 'release-stale-discard.signal');
await writeFile(
  imageFixturePath,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const executable = process.env.HTMLLELUJAH_EXECUTABLE;
const openPath = process.env.HTMLLELUJAH_OPEN_PATH;
const expectedDeckName = process.env.HTMLLELUJAH_EXPECTED_DECK_NAME;
const launchEnvironment = {
  ...process.env,
  ...(executable === undefined
    ? {}
    : { VITE_DEV_SERVER_URL: 'https://packaged-renderer-override.invalid/' }),
};
const launchCommand =
  executable === undefined ? (await import('electron')).default : path.resolve(executable);
const createLaunchArguments = (includeOpenPath) => [
  ...(executable === undefined ? ['.'] : []),
  ...(includeOpenPath && openPath !== undefined ? [path.resolve(openPath)] : []),
  `--user-data-dir=${userData}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--force-device-scale-factor=1',
];
let warmupEvidence;
let measuredProbeEvidence;
try {
  warmupEvidence = await runCleanLaunchProbe({
    launchCommand,
    launchArguments: createLaunchArguments(true),
    launchEnvironment,
    userData,
    label: 'Electron unmeasured warm-up',
    role: 'warmup',
    ordinal: 0,
    expectedDeckName,
    expectUnsavedPrompt: openPath === undefined,
  });
  measuredProbeEvidence = [];
  for (const ordinal of [1, 2]) {
    measuredProbeEvidence.push(
      await runCleanLaunchProbe({
        launchCommand,
        launchArguments: createLaunchArguments(true),
        launchEnvironment,
        userData,
        label: `Electron measured probe ${ordinal}`,
        role: 'probe',
        ordinal,
        expectedDeckName,
        expectUnsavedPrompt: openPath === undefined,
      }),
    );
  }
} catch (error) {
  await rm(userData, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  throw error;
}

const launchStartedAt = performance.now();
const application = spawn(launchCommand, createLaunchArguments(true), {
  cwd: desktopRoot,
  env: launchEnvironment,
  windowsHide: false,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let applicationError = '';
let applicationSpawnError;
application.once('error', (error) => {
  applicationSpawnError = error;
});
application.stderr.on('data', (chunk) => {
  applicationError += chunk.toString('utf8');
});

let cdp;
let evaluateRenderer;
let closeRaceRpc;
let primarySmokeError;
let successEvidence;
let finalCleanupEvidence;
try {
  const debuggingPort = await waitForDebuggingPort(
    application,
    userData,
    () => applicationError,
    () => applicationSpawnError,
    'Electron measured launch',
  );
  const debuggingPortReadyAt = performance.now();

  const target = await waitForRendererTarget(debuggingPort, 'HTMLlelujah measured launch');
  const rendererTargetReadyAt = performance.now();

  cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.bringToFront');

  const evaluate = (expression) => evaluateCdp(cdp, expression, true);
  evaluateRenderer = evaluate;

  const waitForRenderer = (expression, label, timeoutMs = 10_000) =>
    waitFor(async () => ((await evaluate(expression)) ? true : undefined), timeoutMs, label);

  const click = async (selector, label) => {
    const clicked = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLButtonElement)) return false;
      if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
      element.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`${label} was not found.`);
  };

  const clickButtonWithText = async (text, label) => {
    const clicked = await evaluate(`(() => {
      const element = [...document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)},
      );
      if (!(element instanceof HTMLButtonElement)) return false;
      if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
      element.click();
      return true;
    })()`);
    if (!clicked) throw new Error(`${label} was not found.`);
  };

  const clickWithPointer = async (selector, label) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLButtonElement)) return null;
      if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
      const bounds = element.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    if (point === null) throw new Error(`${label} was not found.`);
    await cdp.send('Page.bringToFront');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  };

  const dragElement = async (selector, deltaX, deltaY, label) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) return null;
      const bounds = element.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    if (point === null) throw new Error(`${label} was not found.`);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x + deltaX,
      y: point.y + deltaY,
      button: 'left',
      buttons: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x + deltaX,
      y: point.y + deltaY,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  };

  const selectedCanvasFrame = () =>
    evaluate(`(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      if (selected.length !== 1 || !(element instanceof HTMLElement)) return null;
      return {
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height,
        transform: element.style.transform,
      };
    })()`);

  const setInputValue = async (selector, value, label, blur = false, focus = false) => {
    const updated = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
        return false;
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (${JSON.stringify(focus)}) element.focus();
      setter?.call(element, ${JSON.stringify(String(value))});
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (${JSON.stringify(blur)}) element.blur();
      return true;
    })()`);
    if (!updated) throw new Error(`${label} was not found.`);
  };

  await waitForRenderer(
    `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
    'Editor application shell',
    15_000,
  );
  const applicationShellReadyAt = performance.now();
  await evaluate(`document.fonts.ready.then(() => true)`);
  const fontsReadyAt = performance.now();
  await waitForDecodedImages(
    cdp,
    '.brand-lockup img.brand-mark',
    'Decoded official HTMLlelujah identity at interactive readiness',
  );
  const measuredInitialization = await evaluate(`(async () => {
    const result = await window.htmllelujah.initialize();
    if (!result.ok) return { ok: false, errorCode: result.error.code };
    return {
      ok: true,
      sessionId: result.value.session.snapshot.sessionId,
      documentName: result.value.session.snapshot.document.name,
      recoveryCandidates: result.value.recoveryCandidates.length,
    };
  })()`);
  if (
    measuredInitialization?.ok !== true ||
    typeof measuredInitialization.sessionId !== 'string' ||
    measuredInitialization.recoveryCandidates !== 0
  ) {
    throw new Error(
      `Electron functional launch did not initialize cleanly: ${JSON.stringify(
        measuredInitialization,
      )}.`,
    );
  }
  if (expectedDeckName !== undefined && measuredInitialization.documentName !== expectedDeckName) {
    throw new Error('The measured launch opened the wrong presentation.');
  }
  const duration = (end, start) => Number((end - start).toFixed(3));
  const functionalPerformanceSample = {
    role: 'functional',
    ordinal: 3,
    interactiveReadyMs: duration(fontsReadyAt, launchStartedAt),
    milestonesMs: {
      debuggingPort: duration(debuggingPortReadyAt, launchStartedAt),
      rendererTarget: duration(rendererTargetReadyAt, launchStartedAt),
      applicationShell: duration(applicationShellReadyAt, launchStartedAt),
      fontsReady: duration(fontsReadyAt, launchStartedAt),
    },
    phasesMs: {
      spawnToDebuggingPort: duration(debuggingPortReadyAt, launchStartedAt),
      debuggingPortToRendererTarget: duration(rendererTargetReadyAt, debuggingPortReadyAt),
      rendererTargetToApplicationShell: duration(applicationShellReadyAt, rendererTargetReadyAt),
      applicationShellToFontsReady: duration(fontsReadyAt, applicationShellReadyAt),
    },
    recoveryCandidatesAtReady: measuredInitialization.recoveryCandidates,
    profileReusedForMeasuredLaunch: true,
    documentName: measuredInitialization.documentName,
  };
  const readiness = assessInteractiveReadinessSamples([
    ...measuredProbeEvidence.map((sample) => sample.interactiveReadyMs),
    functionalPerformanceSample.interactiveReadyMs,
  ]);
  let performanceReport = {
    ...readiness,
    measurement: 'median-of-three-clean-warm-starts-same-profile',
    samples: [...measuredProbeEvidence, functionalPerformanceSample],
    warnings: readiness.samplesAboveTarget.map(
      (sample) =>
        `Warm-start sample ${sample.sample} took ${sample.interactiveReadyMs} ms, above the ${WARM_START_TARGET_MS} ms optimization target; the blocking V1 ceiling is ${WARM_START_BUDGET_MS} ms.`,
    ),
    warmup: warmupEvidence,
  };
  try {
    assertInteractiveReadiness(performanceReport);
  } catch (error) {
    const failureReport = {
      passed: false,
      testedAt: new Date().toISOString(),
      launchMode: executable === undefined ? 'source-build' : 'packaged-executable',
      failedPhase: 'interactive-readiness',
      performance: performanceReport,
      failure: {
        code: error instanceof Error && 'code' in error ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      },
    };
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(failureReport, null, 2)}\n`, 'utf8');
    throw error;
  }

  const initial = await evaluate(`(() => ({
    title: document.title,
    documentName: document.querySelector('.document-title span')?.textContent?.trim() ?? '',
    brand: document.querySelector('[aria-label="HTMLlelujah"]') !== null,
    applicationMenu: document.querySelector('nav[aria-label="Application menu"]') !== null,
    toolbar: document.querySelector('[role="toolbar"][aria-label="Editing tools"]') !== null,
    slidesPanel: document.querySelector('aside[aria-label="Slides"]') !== null,
    workspace: document.querySelector('section[aria-label="Slide workspace"]') !== null,
    inspector: document.querySelector('aside[aria-label="Inspector"]') !== null,
    statusBar: document.querySelector('.status-bar') !== null,
    slideCount: document.querySelectorAll('.canonical-thumbnail').length,
    elementCount: document.querySelectorAll('[data-canvas-element-id]').length,
  }))()`);
  if (!initial.title.includes('HTMLlelujah')) throw new Error('The renderer title is incorrect.');
  if (expectedDeckName !== undefined && initial.documentName !== expectedDeckName) {
    throw new Error('The requested .hdeck did not open in the editor.');
  }
  for (const surface of [
    'brand',
    'applicationMenu',
    'toolbar',
    'slidesPanel',
    'workspace',
    'inspector',
    'statusBar',
  ]) {
    if (!initial[surface]) throw new Error(`The essential ${surface} surface is missing.`);
  }
  if (initial.slideCount < 1) throw new Error('The editor opened without a slide.');

  const selectedText = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].find(
      (candidate) => candidate.getAttribute('aria-label')?.includes(', text'),
    );
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  if (!selectedText) throw new Error('The initial text object could not be selected.');
  await waitForRenderer(`document.querySelector('.text-content-editor') !== null`, 'Text editor');
  const draftValue = 'V1 smoke draft preserved across revisions';
  await setInputValue('.text-content-editor', draftValue, 'Text draft');
  await waitForRenderer(
    `document.querySelector('.text-editor-section .section-status')?.textContent?.includes('Draft not applied')`,
    'Dirty text draft status',
  );
  const currentX = await evaluate(
    `Number(document.querySelector('.inspector .field-grid input[type="number"]')?.value ?? 0)`,
  );
  await setInputValue(
    '.inspector .field-grid input[type="number"]',
    currentX + 1,
    'Object X position',
  );
  await sleep(500);
  await waitForRenderer(
    `document.querySelector('.text-content-editor')?.value === ${JSON.stringify(draftValue)}`,
    'Text draft preserved after unrelated revision',
  );
  await click('.text-editor-section .primary-inspector-action', 'Apply text draft');
  await waitForRenderer(
    `document.querySelector('.text-editor-section .section-status')?.textContent?.includes('Up to date')`,
    'Applied text draft status',
  );
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes(${JSON.stringify(draftValue)})`,
    'Applied text rendered on canvas',
  );

  const preservedConflictDraft = 'Local draft preserved across an external text revision';
  const externalTextValue = 'External text revision accepted by the runtime';
  await setInputValue(
    '.text-content-editor',
    preservedConflictDraft,
    'Conflicting local text draft',
  );
  const externalTextApplied = await evaluate(`(async () => {
    const initialized = await window.htmllelujah.initialize();
    if (!initialized.ok) return false;
    const session = initialized.value.session;
    const selectedId = document
      .querySelector('.canonical-hitbox.is-selected')
      ?.getAttribute('data-canvas-element-id');
    const slide = session.snapshot.document.slides.find((candidate) =>
      candidate.elements.some((element) => element.id === selectedId && element.type === 'text'),
    );
    const text = slide?.elements.find(
      (element) => element.id === selectedId && element.type === 'text',
    );
    if (slide === undefined || text === undefined || text.type !== 'text') return false;
    const firstRun = text.content.blocks
      .flatMap((block) => block.type === 'paragraph' || block.type === 'heading' ? block.runs : [])
      .at(0);
    const result = await window.htmllelujah.execute({
      sessionId: session.snapshot.sessionId,
      expectedRevision: session.snapshot.revision,
      label: 'UI smoke external text revision',
      commands: [{
        type: 'text.replace-content',
        slideId: slide.id,
        textId: text.id,
        content: {
          blocks: [{
            id: crypto.randomUUID(),
            type: 'paragraph',
            alignment: 'left',
            runs: [{
              text: ${JSON.stringify(externalTextValue)},
              marks: firstRun?.marks ?? {
                bold: false,
                italic: false,
                underline: false,
                strikethrough: false,
              },
            }],
          }],
        },
      }],
    });
    return result.ok;
  })()`);
  if (!externalTextApplied) throw new Error('The external text revision could not be applied.');
  await waitForRenderer(
    `document.querySelector('.draft-conflict') !== null &&
      document.querySelector('.text-content-editor')?.value === ${JSON.stringify(preservedConflictDraft)}`,
    'External text conflict preserves the local draft',
  );
  await click('[aria-label="Add shape"]', 'Blocked shape insertion during text conflict');
  await sleep(300);
  const countWhileConflicted = Number(
    await evaluate(`document.querySelectorAll('[data-canvas-element-id]').length`),
  );
  if (countWhileConflicted !== initial.elementCount) {
    throw new Error('A document mutation bypassed the preserved text conflict.');
  }
  await click('.draft-conflict button', 'Revert conflicting text draft');
  await waitForRenderer(
    `document.querySelector('.draft-conflict') === null &&
      document.querySelector('.canonical-slide-surface')?.textContent?.includes(${JSON.stringify(externalTextValue)})`,
    'External text retained after reverting the local draft',
  );
  const postRecoveryDraft = 'Text editing remains writable after conflict recovery';
  await setInputValue('.text-content-editor', postRecoveryDraft, 'Post-recovery text draft');
  await click('.text-editor-section .primary-inspector-action', 'Apply post-recovery text draft');
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes(${JSON.stringify(postRecoveryDraft)})`,
    'Post-recovery text commit',
  );

  await click('[aria-label="Add shape"]', 'Add shape');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 1}`,
    'Shape insertion',
  );
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 1`,
    'Inserted shape selection',
  );
  const insertedShapeId = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox.is-selected')].find(
      (candidate) => candidate.getAttribute('aria-label')?.includes(', shape'),
    );
    return element?.getAttribute('data-canvas-element-id') ?? null;
  })()`);
  if (typeof insertedShapeId !== 'string' || insertedShapeId === '') {
    throw new Error('The inserted shape identity is unavailable.');
  }

  await click('[aria-label="Undo"]', 'Undo');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount}`,
    'Undo shape insertion',
  );
  await click('[aria-label="Redo"]', 'Redo');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 1}`,
    'Redo shape insertion',
  );
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 0`,
    'Redone shape starts unselected',
  );
  const reselected = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('[data-canvas-element-id]')];
    const element = elements.find(
      (candidate) =>
        candidate.getAttribute('data-canvas-element-id') === ${JSON.stringify(insertedShapeId)},
    );
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    return true;
  })()`);
  if (!reselected) throw new Error('The redone shape could not be selected.');
  await waitForRenderer(
    `(() => {
      const selected = [...document.querySelectorAll('.canonical-hitbox.is-selected')];
      return selected.length === 1 &&
        selected[0]?.getAttribute('data-canvas-element-id') === ${JSON.stringify(insertedShapeId)};
    })()`,
    'Redone shape keyboard selection',
  );
  await waitForRenderer(
    `document.querySelector('.app-shell')?.getAttribute('aria-busy') !== 'true'`,
    'Editor idle before native image import',
  );

  if (application.pid === undefined) throw new Error('The Electron process ID is unavailable.');
  const imageDialog = automateFileDialog(application.pid, 'Insert image', imageFixturePath, 'Open');
  try {
    await clickWithPointer('[aria-label="Add image"]', 'Add image');
  } catch (error) {
    try {
      await imageDialog.cancel();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Add image failed and its native file-dialog automation could not be drained.',
      );
    }
    throw error;
  }
  await imageDialog;
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 2}`,
    'Native image insertion',
    15_000,
  );
  await waitForRenderer(
    `document.querySelector('.canonical-hitbox.is-selected')?.getAttribute('aria-label')?.includes(', image') === true`,
    'Imported image selection',
  );
  await click('[aria-label="Undo"]', 'Undo image import');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 1}`,
    'Undo native image import',
  );
  await click('[aria-label="Redo"]', 'Redo image import');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 2}`,
    'Redo native image import',
  );

  await waitForDecodedImages(
    cdp,
    '.canonical-canvas-scaled .canonical-slide-surface img[alt="Presentation image"]',
    'Decoded imported image in editor canvas',
  );

  await click('[aria-label="Add table"]', 'Add table');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 3}`,
    'Native table insertion',
  );
  await waitForRenderer(
    `document.querySelector('[aria-label="Table cells (tab-separated values)"]') !== null`,
    'Table TSV editor',
  );
  await setInputValue(
    '[aria-label="Table cells (tab-separated values)"]',
    'Company\tValue\nAlpha\t42',
    'Table TSV data',
  );
  await clickButtonWithText('Paste TSV into table', 'Paste TSV into table');
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes('Alpha') === true && document.querySelector('.canonical-slide-surface')?.textContent?.includes('42') === true`,
    'TSV rendered in native table',
  );
  await click('[aria-label="Undo"]', 'Undo TSV paste');
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes('Alpha') !== true`,
    'Undo TSV paste result',
  );
  await click('[aria-label="Redo"]', 'Redo TSV paste');
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes('Alpha') === true`,
    'Redo TSV paste result',
  );
  const contentSlideIndex = await evaluate(
    `[...document.querySelectorAll('.canonical-thumbnail')].findIndex((thumbnail) => thumbnail.classList.contains('is-selected'))`,
  );
  if (!Number.isInteger(contentSlideIndex) || contentSlideIndex < 0) {
    throw new Error('The native-content slide index is unavailable.');
  }

  await click('[aria-label="Add icon"]', 'Add icon');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 4}`,
    'Native icon insertion',
  );
  await click('[aria-label="Add flag"]', 'Add flag');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 5}`,
    'Unicode flag insertion',
  );
  await click('[aria-label="Add connector"]', 'Add connector');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 6}`,
    'Native connector insertion',
  );

  await clickButtonWithText('File', 'File menu');
  await waitForRenderer(
    `document.querySelector('[role="menu"][aria-label="File menu"]') !== null`,
    'File menu opening',
  );
  await clickButtonWithText('File', 'File menu close');
  await waitForRenderer(
    `document.querySelector('[role="menu"][aria-label="File menu"]') === null`,
    'File menu closing',
  );

  await clickButtonWithText('Codex', 'Codex dialog');
  await waitForRenderer(`document.querySelector('#mcp-title') !== null`, 'Codex dialog opening');
  await waitForRenderer(
    `document.querySelector('#mcp-title')?.textContent === 'Work with Codex through MCP'`,
    'Codex dialog content',
  );
  await click('[aria-labelledby="mcp-title"] button[aria-label="Close"]', 'Codex dialog close');
  await waitForRenderer(`document.querySelector('#mcp-title') === null`, 'Codex dialog closing');

  await clickButtonWithText('Share', 'Share dialog');
  await waitForRenderer(`document.querySelector('#share-title') !== null`, 'Share dialog opening');
  await waitForRenderer(
    `document.querySelector('#share-title')?.textContent === 'Edit together on your LAN'`,
    'Share dialog content',
  );
  await click('[aria-labelledby="share-title"] button[aria-label="Close"]', 'Share dialog close');
  await waitForRenderer(`document.querySelector('#share-title') === null`, 'Share dialog closing');

  await clickButtonWithText('Present', 'Presentation window');
  const presentationTarget = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      if (!response.ok) return undefined;
      const targets = await response.json();
      return targets.find(
        (candidate) =>
          candidate.type === 'page' &&
          candidate.id !== target.id &&
          typeof candidate.url === 'string' &&
          candidate.url.startsWith('htmllelujah-app://app/'),
      );
    },
    10_000,
    'Presentation renderer target',
  );
  const presentationCdp = await CdpSession.connect(presentationTarget.webSocketDebuggerUrl);
  let presentationScreenshotBytes;
  try {
    await presentationCdp.send('Page.enable');
    await presentationCdp.send('Runtime.enable');
    await waitFor(
      async () => {
        const response = await presentationCdp.send('Runtime.evaluate', {
          expression:
            "document.readyState === 'complete' && document.querySelector('[data-testid=\"presentation-root\"]') !== null",
          returnByValue: true,
        });
        return response.result?.value === true ? true : undefined;
      },
      10_000,
      'Presentation surface',
    );
    await waitForDecodedImages(
      presentationCdp,
      '[data-testid="presentation-root"] img[alt="Presentation image"]',
      'Decoded imported image in presentation',
    );
    const presentationScreenshot = await presentationCdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    if (
      typeof presentationScreenshot.data !== 'string' ||
      presentationScreenshot.data.length < 1_000
    ) {
      throw new Error('The presentation window returned an invalid screenshot.');
    }
    presentationScreenshotBytes = Buffer.from(presentationScreenshot.data, 'base64');
    try {
      await presentationCdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('CDP closed')) throw error;
    }
  } finally {
    presentationCdp.close();
  }
  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
      if (!response.ok) return undefined;
      const targets = await response.json();
      return targets.some((candidate) => candidate.id === presentationTarget.id) ? undefined : true;
    },
    10_000,
    'Presentation Escape close',
  );

  await click('[role="tab"]:not(.is-active)', 'Design inspector tab');
  await waitForRenderer(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === 'Design'`,
    'Design inspector tab',
  );
  await waitForRenderer(
    `[...document.querySelectorAll('.inspector-section h3')].some((heading) => heading.textContent === 'Layout editor') && [...document.querySelectorAll('.inspector-section h3')].some((heading) => heading.textContent === 'Master editor')`,
    'Master and layout editors',
  );

  await click('.design-breadcrumb button:nth-child(3)', 'Master design surface');
  await waitForRenderer(
    `document.querySelector('.canvas-context-badge')?.textContent?.includes('Master:') === true`,
    'Master canvas context',
  );
  const masterObjectCountBefore = await evaluate(
    `document.querySelectorAll('.master-object-row').length`,
  );
  const addedMasterShape = await evaluate(`(() => {
    const controls = document.querySelector('[aria-label="Add master objects"]');
    const button = [...(controls?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim().endsWith('shape'),
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!addedMasterShape) throw new Error('The dedicated master-shape action was unavailable.');
  await waitForRenderer(
    `document.querySelectorAll('.master-object-row').length === ${masterObjectCountBefore + 1}`,
    'Master shape insertion',
  );
  const selectedMasterObject = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.master-object-select')].at(-1);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (!selectedMasterObject) throw new Error('The inserted master object could not be selected.');
  const masterFrameBefore = await selectedCanvasFrame();
  if (masterFrameBefore === null) throw new Error('The selected master object has no hit frame.');
  await dragElement('.canonical-hitbox.is-selected', 18, 12, 'Master shape drag target');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        (element.style.left !== ${JSON.stringify(masterFrameBefore.left)} ||
          element.style.top !== ${JSON.stringify(masterFrameBefore.top)});
    })()`,
    'Master selection and moved frame retained after drag revision',
  );
  const masterFrameAfterMove = await selectedCanvasFrame();
  if (masterFrameAfterMove === null) throw new Error('The dragged master object lost selection.');
  await dragElement(
    '.canonical-hitbox.is-selected .canonical-resize-handle.handle-south-east',
    16,
    10,
    'Master shape resize handle',
  );
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        (element.style.width !== ${JSON.stringify(masterFrameAfterMove.width)} ||
          element.style.height !== ${JSON.stringify(masterFrameAfterMove.height)});
    })()`,
    'Master selection and resized frame retained after resize revision',
  );
  const masterFrameAfterResize = await selectedCanvasFrame();
  if (masterFrameAfterResize === null) throw new Error('The resized master object lost selection.');
  const rotatedMasterObject = await evaluate(`(() => {
    const handle = document.querySelector('.canonical-rotation-handle');
    if (!(handle instanceof HTMLButtonElement)) return false;
    handle.focus();
    handle.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        code: 'ArrowRight',
        bubbles: true,
      }),
    );
    return true;
  })()`);
  if (!rotatedMasterObject) throw new Error('The selected master object could not be rotated.');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const transform = selected[0] instanceof HTMLElement ? selected[0].style.transform : '';
      return selected.length === 1 && transform !== ${JSON.stringify(masterFrameAfterResize.transform)};
    })()`,
    'Master selection retained after transform revision',
  );
  await waitForRenderer(
    `[...document.querySelectorAll('.toolbar .add-tools button')].length >= 7 && [...document.querySelectorAll('.toolbar .add-tools button')].every((button) => button instanceof HTMLButtonElement && button.disabled)`,
    'Slide-only toolbar disabled on master surface',
  );
  await clickButtonWithText('Edit', 'Edit menu on master surface');
  await waitForRenderer(
    `(() => {
      const menu = document.querySelector('[role="menu"][aria-label="Edit menu"]');
      const actions = [...(menu?.querySelectorAll('button') ?? [])].filter((button) =>
        ['Duplicate', 'Delete'].some((label) => button.textContent?.includes(label)),
      );
      return actions.length === 2 && actions.every((button) => button instanceof HTMLButtonElement && button.disabled);
    })()`,
    'Slide-only Edit actions disabled on master surface',
  );
  await clickButtonWithText('Edit', 'Edit menu close on master surface');
  await click('[aria-label="Undo"]', 'Undo master shape rotation');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const transform = selected[0] instanceof HTMLElement ? selected[0].style.transform : '';
      return selected.length === 1 && transform === ${JSON.stringify(masterFrameAfterResize.transform)};
    })()`,
    'Master selection retained after transform undo',
  );
  await click('[aria-label="Undo"]', 'Undo master shape resize');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        element.style.left === ${JSON.stringify(masterFrameAfterMove.left)} &&
        element.style.top === ${JSON.stringify(masterFrameAfterMove.top)} &&
        element.style.width === ${JSON.stringify(masterFrameAfterMove.width)} &&
        element.style.height === ${JSON.stringify(masterFrameAfterMove.height)};
    })()`,
    'Master selection retained after resize undo',
  );
  await click('[aria-label="Undo"]', 'Undo master shape drag');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        element.style.left === ${JSON.stringify(masterFrameBefore.left)} &&
        element.style.top === ${JSON.stringify(masterFrameBefore.top)} &&
        element.style.width === ${JSON.stringify(masterFrameBefore.width)} &&
        element.style.height === ${JSON.stringify(masterFrameBefore.height)};
    })()`,
    'Master selection retained after drag undo',
  );
  await click('[aria-label="Undo"]', 'Undo master shape insertion');
  await waitForRenderer(
    `document.querySelectorAll('.master-object-row').length === ${masterObjectCountBefore}`,
    'Undo master shape insertion',
  );

  await click('.design-breadcrumb button:nth-child(2)', 'Layout design surface');
  await waitForRenderer(
    `document.querySelector('.canvas-context-badge')?.textContent?.includes('Layout:') === true`,
    'Layout canvas context',
  );
  await waitForRenderer(
    `[...document.querySelectorAll('.toolbar .add-tools button')].every((button) => button instanceof HTMLButtonElement && button.disabled)`,
    'Slide-only toolbar disabled on layout surface',
  );
  const selectedLayoutPlaceholder = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('Title placeholder'),
    );
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    return true;
  })()`);
  if (!selectedLayoutPlaceholder) throw new Error('The title layout placeholder was unavailable.');
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 1 && document.querySelector('.canonical-resize-handle.handle-south-east') !== null`,
    'Layout placeholder selection',
  );
  const layoutFrameBeforeResize = await selectedCanvasFrame();
  if (layoutFrameBeforeResize === null) {
    throw new Error('The selected layout placeholder has no hit frame.');
  }
  await dragElement(
    '.canonical-hitbox.is-selected .canonical-resize-handle.handle-south-east',
    14,
    8,
    'Layout placeholder resize handle',
  );
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        (element.style.width !== ${JSON.stringify(layoutFrameBeforeResize.width)} ||
          element.style.height !== ${JSON.stringify(layoutFrameBeforeResize.height)});
    })()`,
    'Layout selection and resized frame retained after revision',
  );
  await click('[aria-label="Undo"]', 'Undo layout placeholder resize');
  await waitForRenderer(
    `(() => {
      const selected = document.querySelectorAll('.canonical-hitbox.is-selected');
      const element = selected[0];
      return selected.length === 1 && element instanceof HTMLElement &&
        element.style.left === ${JSON.stringify(layoutFrameBeforeResize.left)} &&
        element.style.top === ${JSON.stringify(layoutFrameBeforeResize.top)} &&
        element.style.width === ${JSON.stringify(layoutFrameBeforeResize.width)} &&
        element.style.height === ${JSON.stringify(layoutFrameBeforeResize.height)};
    })()`,
    'Layout selection retained after resize undo',
  );
  const layoutPlaceholderFrames = await evaluate(`(() => {
    const frame = (name) => {
      const element = [...document.querySelectorAll('.canonical-hitbox')].find((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith(name),
      );
      if (!(element instanceof HTMLElement)) return null;
      return {
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height,
      };
    };
    return { title: frame('Title placeholder'), body: frame('Body placeholder') };
  })()`);
  if (layoutPlaceholderFrames.title === null || layoutPlaceholderFrames.body === null) {
    throw new Error('The active layout did not expose title and body placeholder frames.');
  }
  const slideCountBeforeLayoutInstantiation = await evaluate(
    `document.querySelectorAll('.canonical-thumbnail').length`,
  );
  await click('[aria-label="Add slide"]', 'Add layout-aware slide');
  await waitForRenderer(
    `document.querySelectorAll('.canonical-thumbnail').length === ${slideCountBeforeLayoutInstantiation + 1}`,
    'Layout-aware slide insertion',
  );
  await click('.design-breadcrumb button:nth-child(1)', 'Slide design surface');
  await waitForRenderer(
    `document.querySelector('.canvas-context-badge')?.textContent?.includes('Slide:') === true`,
    'New slide canvas context',
  );
  const instantiatedFrames = await evaluate(`(() => {
    const frame = (name) => {
      const element = [...document.querySelectorAll('.canonical-hitbox')].find((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith(name),
      );
      if (!(element instanceof HTMLElement)) return null;
      return {
        left: element.style.left,
        top: element.style.top,
        width: element.style.width,
        height: element.style.height,
      };
    };
    return {
      title: frame('Title, text'),
      body: frame('Body, text'),
      canvasText: document.querySelector('.canonical-slide-surface')?.textContent ?? '',
    };
  })()`);
  if (
    JSON.stringify(instantiatedFrames.title) !== JSON.stringify(layoutPlaceholderFrames.title) ||
    JSON.stringify(instantiatedFrames.body) !== JSON.stringify(layoutPlaceholderFrames.body) ||
    !instantiatedFrames.canvasText.includes('New slide') ||
    !instantiatedFrames.canvasText.includes('Add your content')
  ) {
    throw new Error('A new slide did not instantiate the active layout placeholders exactly.');
  }
  await click('[aria-label="Undo"]', 'Undo layout-aware slide insertion');
  await waitForRenderer(
    `document.querySelectorAll('.canonical-thumbnail').length === ${slideCountBeforeLayoutInstantiation}`,
    'Undo layout-aware slide insertion',
  );

  const changedPageFormat = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('.inspector-section h3')].find(
      (candidate) => candidate.textContent === 'Page format',
    );
    const select = heading?.closest('.inspector-section')?.querySelector('select');
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, 'standard');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!changedPageFormat) throw new Error('The page-format control was unavailable.');
  await waitForRenderer(
    `document.querySelector('[data-page-width-pt="720"][data-page-height-pt="540"]') !== null`,
    'Standard 4:3 page format',
  );
  await click('[aria-label="Undo"]', 'Undo page-format change');
  await waitForRenderer(
    `document.querySelector('[data-page-width-pt="960"][data-page-height-pt="540"]') !== null`,
    'Restored widescreen page format',
  );
  const layoutCountBefore = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('.inspector-section h3')].find(
      (candidate) => candidate.textContent === 'Layout editor',
    );
    const select = heading?.closest('.inspector-section')?.querySelector('select');
    return select instanceof HTMLSelectElement ? select.options.length : 0;
  })()`);
  const duplicatedLayout = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('.inspector-section h3')].find(
      (candidate) => candidate.textContent === 'Layout editor',
    );
    const section = heading?.closest('.inspector-section');
    const button = [...(section?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent?.includes('Duplicate'),
    );
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!duplicatedLayout) throw new Error('The layout duplicate action was unavailable.');
  await waitForRenderer(
    `(() => {
      const heading = [...document.querySelectorAll('.inspector-section h3')].find(
        (candidate) => candidate.textContent === 'Layout editor',
      );
      const select = heading?.closest('.inspector-section')?.querySelector('select');
      return select instanceof HTMLSelectElement && select.options.length > ${layoutCountBefore};
    })()`,
    'Layout duplication',
  );
  await click('[aria-label="Undo"]', 'Undo layout duplication');
  await click('[role="tab"]:not(.is-active)', 'Properties inspector tab');
  await waitForRenderer(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === 'Properties'`,
    'Properties inspector tab',
  );

  const finalReselected = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].at(-1);
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    return true;
  })()`);
  if (!finalReselected) throw new Error('The final slide object could not be selected.');
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 1`,
    'Final stable slide selection',
  );

  if (application.pid === undefined) throw new Error('The Electron process ID is unavailable.');
  const saveBeforeCloseDialog = automateFileDialog(
    application.pid,
    'Save presentation',
    closeHandshakeDeckPath,
    'Save',
  );
  try {
    await clickButtonWithText('File', 'File menu before close-handshake save');
    await waitForRenderer(
      `document.querySelector('[role="menu"][aria-label="File menu"]') !== null`,
      'File menu before close-handshake save',
    );
    const savedBeforeClose = await evaluate(`(() => {
      const element = [...document.querySelectorAll(
        '[role="menu"][aria-label="File menu"] button',
      )].find((candidate) => candidate.textContent?.trim().startsWith('Save as'));
      if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
      element.click();
      return true;
    })()`);
    if (!savedBeforeClose) throw new Error('The close-handshake baseline could not be saved.');
    await saveBeforeCloseDialog;
  } catch (error) {
    try {
      await saveBeforeCloseDialog.cancel();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Save presentation failed and its native file-dialog automation could not be drained.',
      );
    }
    throw error;
  }
  await waitForRenderer(
    `document.querySelector('.save-state.is-saved') !== null`,
    'Clean close-handshake baseline',
  );
  await click('[role="tab"]:not(.is-active)', 'Design tab before rejected close commit');
  await waitForRenderer(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === 'Design'`,
    'Design tab before rejected close commit',
  );
  const originalThemeName = await evaluate(
    `document.querySelector('.theme-card input[maxlength="120"]')?.value ?? null`,
  );
  if (typeof originalThemeName !== 'string' || originalThemeName === '') {
    throw new Error('The theme name field was unavailable for the rejected close-commit test.');
  }
  const invalidThemeName = 'x'.repeat(300);
  await setInputValue(
    '.theme-card input[maxlength="120"]',
    invalidThemeName,
    'Invalid focused theme name',
    false,
    true,
  );
  const acknowledgeInvalidFieldFailure = automateMessageBox(
    application.pid,
    'Presentation remains open',
    'OK',
  );
  void acknowledgeInvalidFieldFailure.catch(() => undefined);
  let applicationExitListener;
  const unexpectedApplicationExit = new Promise((resolve) => {
    applicationExitListener = () => resolve('closed');
    application.once('exit', applicationExitListener);
  });
  try {
    await requestNativeWindowClose(application.pid);
    const rejectedCommitCloseResult = await Promise.race([
      acknowledgeInvalidFieldFailure.ready.then((visible) =>
        visible ? 'failure' : new Promise(() => undefined),
      ),
      unexpectedApplicationExit,
      sleep(12_000).then(() => 'timeout'),
    ]);
    if (rejectedCommitCloseResult !== 'failure') {
      throw new Error(
        rejectedCommitCloseResult === 'closed'
          ? 'A rejected focused-field commit was allowed to close the presentation.'
          : 'A rejected focused-field commit did not produce a bounded close failure.',
      );
    }
    await acknowledgeInvalidFieldFailure;
  } finally {
    if (applicationExitListener !== undefined) application.off('exit', applicationExitListener);
    await acknowledgeInvalidFieldFailure.cancel();
  }
  const rejectedThemeCommitRetainedWindow = await evaluate(`(async () => {
    const initialized = await window.htmllelujah.initialize();
    return initialized.ok &&
      !initialized.value.session.snapshot.dirty &&
      initialized.value.session.snapshot.document.themes.every(
        (theme) => theme.name !== ${JSON.stringify(invalidThemeName)},
      );
  })()`);
  if (!rejectedThemeCommitRetainedWindow) {
    throw new Error('The rejected close-time theme edit changed the clean presentation.');
  }
  await setInputValue(
    '.theme-card input[maxlength="120"]',
    originalThemeName,
    'Restore rejected theme name field',
    true,
    true,
  );
  await click('[role="tab"]:not(.is-active)', 'Properties tab after rejected close commit');
  await waitForRenderer(
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() === 'Properties'`,
    'Properties tab after rejected close commit',
  );
  const contentSlideSelected = await evaluate(`(() => {
    const thumbnails = [...document.querySelectorAll('.canonical-thumbnail')];
    const element = thumbnails[${contentSlideIndex}];
    if (!(element instanceof HTMLButtonElement)) return false;
    element.click();
    return true;
  })()`);
  if (!contentSlideSelected) {
    throw new Error('The original native-content slide could not be restored.');
  }
  await waitForRenderer(
    `document.querySelector('.canonical-slide-surface')?.textContent?.includes('Alpha') === true &&
      [...document.querySelectorAll('.canonical-hitbox')].some(
        (candidate) => candidate.getAttribute('aria-label')?.includes(', table'),
      )`,
    'Original native-content slide restored before close handshake',
  );

  const closeCellSelected = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].find(
      (candidate) => candidate.getAttribute('aria-label')?.includes(', table'),
    );
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    return true;
  })()`);
  if (!closeCellSelected) throw new Error('The close-handshake table was unavailable.');
  await waitForRenderer(
    `document.querySelector('[role="gridcell"]') !== null`,
    'Table cell before native close',
  );
  const closeHandshakeCellValue = 'Focused cell committed by native close';
  await setInputValue(
    '[role="gridcell"]',
    closeHandshakeCellValue,
    'Immediate-close table cell',
    false,
    true,
  );
  const cancelFocusedCellDialog = automateMessageBox(application.pid, 'Unsaved changes', 'Cancel');
  const acknowledgeFocusedCellFailure = automateMessageBox(
    application.pid,
    'Presentation remains open',
    'OK',
  );
  void cancelFocusedCellDialog.catch(() => undefined);
  void acknowledgeFocusedCellFailure.catch(() => undefined);
  try {
    await requestNativeWindowClose(application.pid);
    const focusedCellCloseDialog = await Promise.race([
      cancelFocusedCellDialog.ready.then((visible) =>
        visible ? 'unsaved' : new Promise(() => undefined),
      ),
      acknowledgeFocusedCellFailure.ready.then((visible) =>
        visible ? 'failure' : new Promise(() => undefined),
      ),
      sleep(12_000).then(() => 'timeout'),
    ]);
    if (focusedCellCloseDialog !== 'unsaved') {
      throw new Error(
        focusedCellCloseDialog === 'failure'
          ? 'The renderer could not flush the focused table cell before close.'
          : 'Neither the focused-cell unsaved prompt nor a bounded close failure appeared.',
      );
    }
    await cancelFocusedCellDialog;
  } finally {
    await Promise.all([cancelFocusedCellDialog.cancel(), acknowledgeFocusedCellFailure.cancel()]);
  }
  await waitForRenderer(
    `document.querySelector('.app-shell') !== null &&
      document.querySelector('.save-state:not(.is-saved)') !== null &&
      document.querySelector('.canonical-slide-surface')?.textContent?.includes(${JSON.stringify(closeHandshakeCellValue)})`,
    'Native close handshake committed the focused table cell before Cancel',
    10_000,
  );
  const closeDraftSelected = await evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].find(
      (candidate) => candidate.getAttribute('aria-label')?.includes(', text'),
    );
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  if (!closeDraftSelected) throw new Error('The close-handshake text object was unavailable.');
  await waitForRenderer(
    `document.querySelector('.canonical-inline-text-input') !== null`,
    'Inline editor before native close',
  );
  const closeHandshakeDraft = 'Immediate close preserves this inline draft';
  await setInputValue(
    '.canonical-inline-text-input',
    closeHandshakeDraft,
    'Immediate-close inline draft',
  );
  const cancelUnsavedDialog = automateMessageBox(application.pid, 'Unsaved changes', 'Cancel');
  const acknowledgeHandshakeFailure = automateMessageBox(
    application.pid,
    'Presentation remains open',
    'OK',
  );
  void cancelUnsavedDialog.catch(() => undefined);
  void acknowledgeHandshakeFailure.catch(() => undefined);
  try {
    await requestNativeWindowClose(application.pid);
    const firstCloseDialog = await Promise.race([
      cancelUnsavedDialog.ready.then((visible) =>
        visible ? 'unsaved' : new Promise(() => undefined),
      ),
      acknowledgeHandshakeFailure.ready.then((visible) =>
        visible ? 'failure' : new Promise(() => undefined),
      ),
      sleep(12_000).then(() => 'timeout'),
    ]);
    if (firstCloseDialog !== 'unsaved') {
      throw new Error(
        firstCloseDialog === 'failure'
          ? 'The renderer could not flush the immediate inline draft before close.'
          : 'Neither the unsaved prompt nor a bounded close failure appeared.',
      );
    }
    await cancelUnsavedDialog;
  } finally {
    await Promise.all([cancelUnsavedDialog.cancel(), acknowledgeHandshakeFailure.cancel()]);
  }
  await waitForRenderer(
    `document.querySelector('.app-shell') !== null &&
      document.querySelector('.save-state:not(.is-saved)') !== null &&
      document.querySelector('.canonical-slide-surface')?.textContent?.includes(${JSON.stringify(closeHandshakeDraft)})`,
    'Native close handshake flushed the draft before Cancel',
    10_000,
  );

  const concurrentCloseName = 'Concurrent agent edit retained after stale Discard consent';
  closeRaceRpc = new LocalRpcClient(path.join(userData, 'mcp', 'endpoint-v1.json'));
  const closeRaceDocuments = await closeRaceRpc.listOpenDocuments();
  const closeRaceDocument = closeRaceDocuments.at(0);
  if (
    closeRaceDocument === undefined ||
    typeof closeRaceDocument.documentId !== 'string' ||
    typeof closeRaceDocument.revision !== 'string'
  ) {
    throw new Error('The local MCP bridge did not expose the active presentation.');
  }
  const discardStaleSnapshot = automateMessageBox(
    application.pid,
    'Unsaved changes',
    'Discard',
    0,
    staleDiscardReleasePath,
  );
  const acknowledgeRetainedWindow = automateMessageBox(
    application.pid,
    'Presentation remains open',
    'OK',
  );
  void discardStaleSnapshot.catch(() => undefined);
  void acknowledgeRetainedWindow.catch(() => undefined);
  try {
    await requestNativeWindowClose(application.pid);
    if (!(await discardStaleSnapshot.ready)) await discardStaleSnapshot;
    const concurrentCloseProposal = await closeRaceRpc.proposeCommands({
      documentId: closeRaceDocument.documentId,
      expectedRevision: closeRaceDocument.revision,
      label: 'UI smoke concurrent close mutation',
      commands: [{ type: 'deck.rename', name: concurrentCloseName }],
    });
    if (concurrentCloseProposal.requiresApproval) {
      throw new Error('The safe close-race rename unexpectedly required approval.');
    }
    await closeRaceRpc.commitProposal({ proposalId: concurrentCloseProposal.proposalId });
    await writeFile(staleDiscardReleasePath, 'release\n', 'utf8');
    await discardStaleSnapshot;
    await acknowledgeRetainedWindow;
    const concurrentMutationRetained = await evaluate(`(async () => {
      const initialized = await window.htmllelujah.initialize();
      return initialized.ok &&
        initialized.value.session.snapshot.dirty &&
        initialized.value.session.snapshot.document.name === ${JSON.stringify(concurrentCloseName)};
    })()`);
    if (!concurrentMutationRetained) {
      throw new Error('Stale Discard consent removed a concurrent agent mutation.');
    }
  } finally {
    await Promise.all([discardStaleSnapshot.cancel(), acknowledgeRetainedWindow.cancel()]);
  }
  await closeRaceRpc.close();
  closeRaceRpc = undefined;
  await waitForRenderer(
    `document.querySelector('.app-shell') !== null &&
      document.querySelector('.save-state:not(.is-saved)') !== null`,
    'Concurrent close mutation retained after stale Discard',
    10_000,
  );

  await evaluate(`(() => {
    const toastClose = document.querySelector('.toast button[aria-label="Dismiss"]');
    if (toastClose instanceof HTMLButtonElement) toastClose.click();
    return true;
  })()`);
  await sleep(350);

  const finalState = await evaluate(`(() => ({
    title: document.title,
    windowTitle: document.querySelector('.document-title span')?.textContent ?? '',
    slideCount: document.querySelectorAll('.canonical-thumbnail').length,
    elementCount: document.querySelectorAll('[data-canvas-element-id]').length,
    selectedCount: document.querySelectorAll('.canonical-hitbox.is-selected').length,
    openDialogs: document.querySelectorAll('[role="dialog"]').length,
    activeInspectorTab:
      document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? '',
  }))()`);
  if (finalState.elementCount !== initial.elementCount + 6 || finalState.selectedCount !== 1) {
    throw new Error('The user edit was not preserved after undo and redo.');
  }
  if (finalState.openDialogs !== 0 || finalState.activeInspectorTab !== 'Properties') {
    throw new Error('The editor did not return to a stable post-interaction state.');
  }

  await waitForDecodedImages(
    cdp,
    '.brand-lockup img.brand-mark',
    'Decoded official HTMLlelujah identity before editor evidence capture',
  );
  await waitForDecodedImages(
    cdp,
    '.canonical-canvas-scaled .canonical-slide-surface img[alt="Presentation image"]',
    'Decoded imported image before editor evidence capture',
  );
  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof screenshot.data !== 'string' || screenshot.data.length < 1_000) {
    throw new Error('Electron returned an invalid screenshot.');
  }
  if (presentationScreenshotBytes === undefined) {
    throw new Error('Presentation visual evidence was not captured.');
  }
  const finalGracefulClose = await closeLaunchGracefully({
    child: application,
    userData,
    sessionId: measuredInitialization.sessionId,
    label: 'Electron functional launch',
    expectUnsavedPrompt: true,
  });
  performanceReport = {
    ...performanceReport,
    samples: [
      ...measuredProbeEvidence,
      { ...functionalPerformanceSample, gracefulClose: finalGracefulClose },
    ],
  };

  const reportPayload = {
    launchMode: executable === undefined ? 'source-build' : 'packaged-executable',
    performance: performanceReport,
    rendererTitle: initial.title,
    initial,
    final: finalState,
    checks: [
      'real Electron renderer opened through the secure app protocol',
      ...(executable === undefined
        ? []
        : ['packaged application ignored a hostile development-renderer environment override']),
      'one clean warm-up and three clean measured launches reused the same user-data profile',
      'all measured launches started with zero recovery candidates and closed without residue',
      'essential editor surfaces rendered',
      'shape insertion, undo, and redo converged',
      'native image chooser imported and decoded one image in the editor with atomic undo and redo',
      'native table insertion and literal TSV paste undid and redid cleanly',
      'native icon, Unicode flag, and connector insertions rendered',
      'File menu opened and closed',
      'Codex MCP dialog opened and closed',
      'LAN collaboration dialog opened and closed',
      'page format changed through the Design inspector and undid cleanly',
      'master and layout scopes disabled slide-only toolbar and menu mutations',
      'master object drag, resize, rotate, undo, and selection retention stayed inside the master',
      'layout placeholder resize, undo, and selection retention stayed inside the layout',
      'new slide instantiated title/body frames from the active layout exactly',
      'a rejected focused onBlur commit kept the clean presentation open',
      'Alt+F4-equivalent close committed a focused onBlur table cell before the native save prompt',
      'Alt+F4-equivalent close flushed an immediate inline draft before the native save prompt',
      'stale Discard consent could not discard a concurrent agent mutation',
      'Design and Properties inspector tabs switched',
      'official HTMLlelujah identity decoded in the real editor window',
      'stable PNG screenshot captured from the real window',
      'stable PNG screenshot captured after the real presentation window decoded its image',
    ],
  };
  successEvidence = {
    reportPayload,
    editorScreenshotBytes: Buffer.from(screenshot.data, 'base64'),
    presentationScreenshotBytes,
  };
} catch (error) {
  primarySmokeError = error;
  if (evaluateRenderer !== undefined) {
    try {
      const diagnostic = await Promise.race([
        evaluateRenderer(`(() => ({
          readyState: document.readyState,
          title: document.title,
          bodyText: document.body?.innerText?.slice(0, 1_000) ?? '',
          bodyHtml: document.body?.innerHTML?.slice(0, 1_000) ?? '',
        }))()`),
        sleep(2_000).then(() => {
          throw new Error('Renderer diagnostic timed out.');
        }),
      ]);
      process.stderr.write(`[renderer diagnostic]\n${JSON.stringify(diagnostic, null, 2)}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`[renderer diagnostic failed] ${String(diagnosticError)}\n`);
    }
  }
  if (applicationError !== '') {
    process.stderr.write(`[desktop stderr]\n${applicationError.slice(0, 4_000)}\n`);
  }
  throw error;
} finally {
  const cleanupErrors = [];
  let rpcClosed = closeRaceRpc === undefined;
  try {
    if (closeRaceRpc !== undefined) {
      await closeRaceRpc.close();
      closeRaceRpc = undefined;
      rpcClosed = true;
    }
  } catch (error) {
    cleanupErrors.push(error);
  }
  let cdpClosed = cdp === undefined;
  try {
    cdp?.close();
    cdp = undefined;
    cdpClosed = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  let applicationCleanup;
  try {
    applicationCleanup = await terminate(application);
  } catch (error) {
    cleanupErrors.push(error);
  }
  let temporaryProfileRemoved = false;
  try {
    await waitFor(
      async () => {
        try {
          await rm(userData, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          return true;
        } catch (error) {
          if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
          throw error;
        }
      },
      10_000,
      'Electron UI smoke cleanup',
    );
    temporaryProfileRemoved = true;
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    if (primarySmokeError !== undefined) {
      throw new AggregateError(
        [primarySmokeError, ...cleanupErrors],
        'Electron UI smoke failed and its cleanup did not complete.',
      );
    }
    throw new AggregateError(cleanupErrors, 'Electron UI smoke cleanup did not complete.');
  }
  finalCleanupEvidence = {
    rpcClosed,
    cdpClosed,
    application: applicationCleanup,
    temporaryProfileRemoved,
  };
}

if (successEvidence === undefined || finalCleanupEvidence === undefined) {
  throw new Error('Electron UI smoke completed without publishable cleanup evidence.');
}
const report = {
  passed: true,
  testedAt: new Date().toISOString(),
  ...successEvidence.reportPayload,
  cleanup: finalCleanupEvidence,
  checks: [
    ...successEvidence.reportPayload.checks,
    'RPC client, CDP session, Electron process tree, and temporary profile closed without residue',
  ],
};
await mkdir(evidenceDirectory, { recursive: true });
await Promise.all([
  writeFile(screenshotPath, successEvidence.editorScreenshotBytes),
  writeFile(presentationScreenshotPath, successEvidence.presentationScreenshotBytes),
]);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.stdout.write(
  `Electron UI smoke passed: real window edited, undo/redo verified, dialogs exercised.\n` +
    `Screenshots: ${screenshotPath}, ${presentationScreenshotPath}\nReport: ${reportPath}\n`,
);
