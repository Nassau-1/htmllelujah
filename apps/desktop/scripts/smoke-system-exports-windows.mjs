import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createNeutralDemoDeck } from '@htmllelujah/document-core';
import { createHdeckArchive, parseHdeckArchive } from '@htmllelujah/hdeck';
import electronPath from 'electron';

import {
  CdpSession,
  fetchJsonWithTimeout,
  runtimeWindowFingerprint,
  sameRuntimeWindows,
  sleep,
  waitFor,
} from './system-export-harness.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const runtimeInspectionPath = path.join(import.meta.dirname, 'inspect-electron-runtime.ps1');
const pagePresets = {
  widescreen: { widthPt: 960, heightPt: 540 },
  standard: { widthPt: 720, heightPt: 540 },
  'a4-landscape': { widthPt: 841.89, heightPt: 595.28 },
};
const requestedPagePreset = process.env.HTMLLELUJAH_EXPORT_PAGE_PRESET ?? 'widescreen';
if (!(requestedPagePreset in pagePresets)) {
  throw new Error('HTMLLELUJAH_EXPORT_PAGE_PRESET must be widescreen, standard, or a4-landscape.');
}

const parseExportRun = (arguments_) => {
  let stress = false;
  let requestedCount;
  let countProvided = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--stress') {
      stress = true;
      continue;
    }
    if (argument === '--stress-count') {
      if (countProvided) throw new Error('--stress-count can only be provided once.');
      if (arguments_[index + 1] === undefined) {
        throw new Error('--stress-count requires an integer value.');
      }
      requestedCount = arguments_[index + 1];
      countProvided = true;
      index += 1;
      stress = true;
      continue;
    }
    if (argument.startsWith('--stress-count=')) {
      if (countProvided) throw new Error('--stress-count can only be provided once.');
      requestedCount = argument.slice('--stress-count='.length);
      countProvided = true;
      stress = true;
      continue;
    }
    throw new Error(`Unknown system export smoke argument: ${argument}`);
  }
  if (!stress) return { mode: 'short', exportCount: 2 };
  const exportCount = requestedCount === undefined ? 50 : Number(requestedCount);
  if (!Number.isInteger(exportCount) || exportCount < 2 || exportCount > 50) {
    throw new Error('--stress-count must be an integer from 2 through 50.');
  }
  return { mode: 'stress', exportCount };
};

const exportRun = parseExportRun(process.argv.slice(2));
const stressEvidenceSuffix =
  exportRun.mode === 'stress'
    ? `-stress${exportRun.exportCount === 50 ? '' : `-${exportRun.exportCount}`}`
    : '';
const pageEvidenceSuffix =
  process.env.HTMLLELUJAH_EXPORT_PAGE_PRESET === undefined ? '' : `-${requestedPagePreset}`;
const evidencePath = path.join(
  repositoryRoot,
  'artifacts',
  'evidence',
  `system-exports-v1${stressEvidenceSuffix}${pageEvidenceSuffix}.json`,
);
const evidenceDirectory = path.dirname(evidencePath);
const dialogAutomationPath = path.join(import.meta.dirname, 'automate-save-dialog.ps1');
const runtimeStabilitySamples = 2;
const cdpCommandTimeoutMs = 5_000;
const fetchAttemptTimeoutMs = 2_000;

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const terminateTree = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
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
      if (child.pid !== undefined && process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5_000,
        });
      } else child.kill('SIGKILL');
      reject(new Error(`${options.label ?? path.basename(command)} timed out.`));
    }, options.timeoutMs ?? 45_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${options.label ?? path.basename(command)} exited ${code ?? signal}.` +
              (stderr === '' ? '' : ` ${stderr.slice(-1_000)}`),
          ),
        );
    });
  });

const browserCandidates = [
  process.env.HTMLLELUJAH_BROWSER_EXECUTABLE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter((candidate) => typeof candidate === 'string' && candidate.trim() !== '');

const findBrowserExecutable = async () => {
  for (const candidate of browserCandidates) {
    const resolved = path.resolve(candidate);
    if (await exists(resolved)) return resolved;
  }
  throw new Error(
    'No supported local Edge/Chrome executable was found for export visual evidence.',
  );
};

const pngDimensions = (bytes) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error('The browser visual evidence is not a valid PNG.');
  }
  return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
};

const captureLocalVisual = async ({
  browserExecutable,
  sourcePath,
  screenshotPath,
  profilePath,
  fragment = '',
}) => {
  await mkdir(profilePath, { recursive: true });
  await rm(screenshotPath, { force: true });
  const target = `${pathToFileURL(sourcePath).href}${fragment}`;
  await run(
    browserExecutable,
    [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--no-first-run',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=3000',
      '--window-size=1280,800',
      `--user-data-dir=${profilePath}`,
      `--screenshot=${screenshotPath}`,
      target,
    ],
    { label: `Visual capture for ${path.extname(sourcePath)}`, timeoutMs: 45_000 },
  );
  const bytes = await readFile(screenshotPath);
  const dimensions = pngDimensions(bytes);
  if (bytes.length < 5_000 || dimensions.widthPx !== 1_280 || dimensions.heightPx !== 800) {
    throw new Error('The browser returned incomplete export visual evidence.');
  }
  return { bytes: bytes.length, sha256: sha256(bytes), ...dimensions };
};

const inspectRuntime = async (rootProcessId) => {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runtimeInspectionPath,
      '-RootProcessId',
      String(rootProcessId),
    ],
    { label: 'Electron runtime inspection', timeoutMs: 20_000 },
  );
  const sample = JSON.parse(stdout.trim());
  const validProcessIds =
    Array.isArray(sample?.processIds) &&
    sample.processIds.every((processId) => Number.isInteger(processId) && processId > 0) &&
    new Set(sample.processIds).size === sample.processIds.length;
  const validWindows =
    validProcessIds &&
    Array.isArray(sample?.topLevelWindows) &&
    sample.topLevelWindows.every(
      (window) =>
        window !== null &&
        typeof window === 'object' &&
        typeof window.handle === 'string' &&
        /^[0-9a-f]{16}$/u.test(window.handle) &&
        Number.isInteger(window.processId) &&
        sample.processIds.includes(window.processId) &&
        typeof window.visible === 'boolean',
    ) &&
    new Set(sample?.topLevelWindows?.map((window) => window.handle)).size ===
      sample?.topLevelWindows?.length;
  if (
    sample?.schemaVersion !== 2 ||
    !Number.isInteger(sample.processCount) ||
    !Number.isInteger(sample.topLevelWindowCount) ||
    !Number.isInteger(sample.visibleWindowCount) ||
    typeof sample.processTreeComplete !== 'boolean' ||
    typeof sample.workingSetAvailable !== 'boolean' ||
    (sample.workingSetBytes !== null &&
      (!Number.isFinite(sample.workingSetBytes) || sample.workingSetBytes < 0)) ||
    !validProcessIds ||
    !validWindows ||
    sample.processCount !== sample.processIds.length ||
    sample.topLevelWindowCount !== sample.topLevelWindows.length ||
    sample.visibleWindowCount !== sample.topLevelWindows.filter((window) => window.visible).length
  ) {
    throw new Error('Electron runtime inspection returned an invalid result.');
  }
  return sample;
};

const waitForStableRuntime = async (rootProcessId, label) => {
  let previousFingerprint;
  let stableSamples = 0;
  return waitFor(
    async () => {
      const sample = await inspectRuntime(rootProcessId);
      if (
        !sample.processTreeComplete ||
        sample.processCount < 1 ||
        sample.topLevelWindowCount < 1
      ) {
        previousFingerprint = undefined;
        stableSamples = 0;
        return undefined;
      }
      const fingerprint = runtimeWindowFingerprint(sample);
      if (fingerprint === previousFingerprint) stableSamples += 1;
      else {
        previousFingerprint = fingerprint;
        stableSamples = 1;
      }
      return stableSamples >= runtimeStabilitySamples ? sample : undefined;
    },
    20_000,
    label,
  );
};

const waitForBaselineWindows = async (rootProcessId, baseline, label) => {
  let stableMatches = 0;
  return waitFor(
    async () => {
      const sample = await inspectRuntime(rootProcessId);
      if (!sample.processTreeComplete || !sameRuntimeWindows(baseline, sample)) {
        stableMatches = 0;
        return undefined;
      }
      stableMatches += 1;
      return stableMatches >= runtimeStabilitySamples ? sample : undefined;
    },
    20_000,
    label,
  );
};

const percentile = (values, percentage) => {
  if (values.length === 0) throw new Error('Cannot compute a percentile without samples.');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)];
};

const summarizeDurations = (values) => ({
  p50Ms: Math.round(percentile(values, 50) * 10) / 10,
  p95Ms: Math.round(percentile(values, 95) * 10) / 10,
  maxMs: Math.round(Math.max(...values) * 10) / 10,
});

const summarizeRuntimeGrowth = (baseline, samples) => {
  const windowSize = Math.min(5, Math.max(2, Math.floor(samples.length / 4)));
  const earlySamples = samples.slice(0, windowSize);
  const lateSamples = samples.slice(-windowSize);
  const stabilizedProcessPeak = Math.max(
    baseline.processCount,
    ...earlySamples.map((sample) => sample.processCount),
  );
  const allowedProcessCount = stabilizedProcessPeak + 1;
  const laterProcessPeak = Math.max(
    ...samples.slice(windowSize).map((sample) => sample.processCount),
    0,
  );
  const finalProcessCount = samples.at(-1)?.processCount ?? baseline.processCount;
  const processCountStable =
    laterProcessPeak <= allowedProcessCount && finalProcessCount <= allowedProcessCount;

  const memorySamples = samples.filter(
    (sample) => sample.workingSetAvailable && sample.workingSetBytes !== null,
  );
  const memoryAvailable =
    baseline.workingSetAvailable &&
    baseline.workingSetBytes !== null &&
    memorySamples.length === samples.length;
  if (!memoryAvailable) {
    return {
      processCountStable,
      stabilizedProcessPeak,
      laterProcessPeak,
      finalProcessCount,
      allowedProcessCount,
      workingSet: {
        available: false,
        limitation: 'Windows process working-set data was not available for every sample.',
      },
    };
  }

  const earlyWorkingSet = percentile(
    earlySamples.map((sample) => sample.workingSetBytes),
    50,
  );
  const lateWorkingSet = percentile(
    lateSamples.map((sample) => sample.workingSetBytes),
    50,
  );
  const growthBytes = lateWorkingSet - earlyWorkingSet;
  const growthBudgetBytes = Math.max(96 * 1024 * 1024, Math.round(earlyWorkingSet * 0.25));
  return {
    processCountStable,
    stabilizedProcessPeak,
    laterProcessPeak,
    finalProcessCount,
    allowedProcessCount,
    workingSet: {
      available: true,
      earlyMedianBytes: earlyWorkingSet,
      lateMedianBytes: lateWorkingSet,
      growthBytes,
      growthBudgetBytes,
      withinBudget: growthBytes <= growthBudgetBytes,
    },
  };
};

const waitForRuntimeExit = async (rootProcessId, label) =>
  waitFor(
    async () => {
      const sample = await inspectRuntime(rootProcessId);
      return sample.processCount === 0 &&
        sample.topLevelWindowCount === 0 &&
        sample.visibleWindowCount === 0
        ? sample
        : undefined;
    },
    20_000,
    label,
  );

const launchEditor = async ({ deckPath, userData }) => {
  const executable = process.env.HTMLLELUJAH_EXECUTABLE;
  const launchCommand = executable === undefined ? electronPath : path.resolve(executable);
  const launchArguments = [
    ...(executable === undefined ? ['.'] : []),
    deckPath,
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--force-device-scale-factor=1',
  ];
  const application = spawn(launchCommand, launchArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let applicationError = '';
  application.stderr.on('data', (chunk) => {
    applicationError = (applicationError + chunk.toString('utf8')).slice(-4_000);
  });

  let cdp;
  try {
    const debuggingPort = await waitFor(
      async () => {
        try {
          const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
          const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
          if (Number.isInteger(port) && port > 0) return port;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const match = applicationError.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
        return match === null ? undefined : Number.parseInt(match[1], 10);
      },
      20_000,
      'Electron remote debugging endpoint',
    );
    const target = await waitFor(
      async (remainingMs) => {
        const targets = await fetchJsonWithTimeout(
          `http://127.0.0.1:${debuggingPort}/json/list`,
          Math.min(fetchAttemptTimeoutMs, remainingMs),
          'Electron target discovery request',
        );
        if (!Array.isArray(targets)) return undefined;
        return targets.find(
          (candidate) =>
            candidate.type === 'page' &&
            typeof candidate.url === 'string' &&
            candidate.url.startsWith('htmllelujah-app://app/'),
        );
      },
      20_000,
      'HTMLlelujah renderer target',
    );
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl, {
      timeoutMs: cdpCommandTimeoutMs,
      commandTimeoutMs: cdpCommandTimeoutMs,
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');

    const evaluate = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (response.exceptionDetails !== undefined) {
        const detail =
          response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
        throw new Error(`Renderer evaluation failed: ${detail}`);
      }
      return response.result?.value;
    };
    const waitForRenderer = (expression, label, timeoutMs = 15_000) =>
      waitFor(async () => ((await evaluate(expression)) ? true : undefined), timeoutMs, label);

    await waitForRenderer(
      `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
      'Editor application shell',
      20_000,
    );

    return {
      application,
      applicationError: () => applicationError,
      cdp,
      evaluate,
      waitForRenderer,
      async close() {
        cdp?.close();
        await terminateTree(application);
      },
    };
  } catch (error) {
    cdp?.close();
    await terminateTree(application);
    if (applicationError !== '') process.stderr.write(`[desktop stderr]\n${applicationError}\n`);
    throw error;
  }
};

const clickButtonWithPrefix = async (editor, prefix, label) => {
  const clicked = await editor.evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim().startsWith(${JSON.stringify(prefix)}),
    );
    if (!(element instanceof HTMLButtonElement)) return false;
    if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${label} was not found.`);
};

const chooseNativeDestination = async (application, title, targetPath) => {
  if (application.pid === undefined) throw new Error('Electron process ID is unavailable.');
  await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-File',
      dialogAutomationPath,
      '-RootProcessId',
      String(application.pid),
      '-WindowTitle',
      title,
      '-TargetPath',
      targetPath,
      '-TimeoutSeconds',
      '30',
    ],
    { label: `${title} UI Automation`, timeoutMs: 40_000 },
  );
};

const openFileMenu = async (editor) => {
  await clickButtonWithPrefix(editor, 'File', 'File menu');
  await editor.waitForRenderer(
    `document.querySelector('[role="menu"][aria-label="File menu"]') !== null`,
    'File menu opening',
  );
};

const runSaveOperation = async ({ editor, menuPrefix, dialogTitle, targetPath, successText }) => {
  await openFileMenu(editor);
  await clickButtonWithPrefix(editor, menuPrefix, menuPrefix);
  await chooseNativeDestination(editor.application, dialogTitle, targetPath);
  await sleep(500);
  const immediateToasts = await editor.evaluate(
    `([...document.querySelectorAll('.toast')].map((toast) => toast.textContent?.trim() ?? ''))`,
  );
  if (immediateToasts.length > 0 && !immediateToasts.some((text) => text.includes(successText))) {
    throw new Error(`${menuPrefix} returned an application error: ${immediateToasts.join(' | ')}`);
  }
  await waitFor(
    async () => {
      if (!(await exists(targetPath))) return undefined;
      const metadata = await stat(targetPath);
      return metadata.isFile() && metadata.size > 0 ? metadata : undefined;
    },
    30_000,
    `${menuPrefix} output`,
  );
  await editor.waitForRenderer(
    `[...document.querySelectorAll('.toast')].some((toast) => toast.textContent?.includes(${JSON.stringify(successText)}))`,
    `${menuPrefix} completion toast`,
    30_000,
  );
};

const decodeHtmlAttribute = (value) =>
  value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');

const validateStandaloneHtml = (bytes, expectedTitle) => {
  const html = bytes.toString('utf8');
  if (!/^<!doctype html>/iu.test(html)) throw new Error('Standalone HTML has no doctype.');
  if (!html.includes('data-htmllelujah-export="standalone-v1"')) {
    throw new Error('Standalone HTML export marker is missing.');
  }
  if (!html.includes(`<title>${expectedTitle}</title>`)) {
    throw new Error('Standalone HTML title does not match the deck.');
  }
  const cspMatch = html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/iu,
  );
  if (cspMatch === null) throw new Error('Standalone HTML CSP is missing.');
  const csp = decodeHtmlAttribute(cspMatch[1]);
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    if (!csp.includes(directive)) throw new Error(`Standalone HTML CSP lacks ${directive}.`);
  }
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/iu);
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/iu);
  if (scriptMatch === null || styleMatch === null) {
    throw new Error('Standalone HTML inline runtime or stylesheet is missing.');
  }
  const scriptHash = createHash('sha256').update(scriptMatch[1], 'utf8').digest('base64');
  const styleHash = createHash('sha256').update(styleMatch[1], 'utf8').digest('base64');
  if (!csp.includes(`script-src 'sha256-${scriptHash}'`)) {
    throw new Error('Standalone HTML script does not match its CSP hash.');
  }
  if (!csp.includes(`style-src-elem 'sha256-${styleHash}'`)) {
    throw new Error('Standalone HTML stylesheet does not match its CSP hash.');
  }
  if (/<(?:script|iframe|object|embed|link)\b[^>]*(?:src|href)\s*=/iu.test(html)) {
    throw new Error('Standalone HTML references an external executable resource.');
  }
  if (/\b(?:https?:|wss?:|ftp:|file:|\/\/)/iu.test(html)) {
    throw new Error('Standalone HTML contains a network or local-file URL.');
  }
  return { csp, scriptHash, styleHash };
};

const numberPattern = '(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
const validatePdf = (bytes, expectedPages, expectedPage) => {
  if (!bytes.subarray(0, 8).toString('latin1').startsWith('%PDF-1.')) {
    throw new Error('PDF signature is invalid.');
  }
  if (
    !bytes
      .subarray(Math.max(0, bytes.length - 1_024))
      .toString('latin1')
      .includes('%%EOF')
  ) {
    throw new Error('PDF EOF marker is missing.');
  }
  const text = bytes.toString('latin1');
  const explicitPages = [...text.matchAll(/\/Type\s*\/Page\b/gu)].length;
  const counts = [...text.matchAll(/\/Count\s+(\d+)\b/gu)].map((match) => Number(match[1]));
  const pageCount = explicitPages > 0 ? explicitPages : Math.max(0, ...counts);
  if (pageCount !== expectedPages) {
    throw new Error(`PDF page count is ${pageCount}; expected ${expectedPages}.`);
  }
  const mediaBoxExpression = new RegExp(
    `\\/MediaBox\\s*\\[\\s*${numberPattern}\\s+${numberPattern}\\s+${numberPattern}\\s+${numberPattern}\\s*\\]`,
    'u',
  );
  const mediaBox = text.match(mediaBoxExpression);
  if (mediaBox === null) throw new Error('PDF MediaBox was not found.');
  const coordinates = mediaBox.slice(1, 5).map(Number);
  const widthPt = Math.abs(coordinates[2] - coordinates[0]);
  const heightPt = Math.abs(coordinates[3] - coordinates[1]);
  if (
    Math.abs(widthPt - expectedPage.widthPt) > 0.5 ||
    Math.abs(heightPt - expectedPage.heightPt) > 0.5
  ) {
    throw new Error('PDF MediaBox does not match the presentation page size.');
  }
  return { pageCount, widthPt, heightPt };
};

if (process.platform !== 'win32') throw new Error('The system export smoke requires Windows.');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-system-export-smoke-'));
const safePrefix = path.join(path.resolve(tmpdir()), 'htmllelujah-system-export-smoke-');
if (!path.resolve(temporaryRoot).startsWith(safePrefix)) {
  throw new Error('Refusing unsafe system export smoke directory.');
}
let temporaryRootRemoved = false;
const removeTemporaryRoot = async () => {
  await waitFor(
    async () => {
      try {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        return true;
      } catch (error) {
        if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
        throw error;
      }
    },
    15_000,
    'System export smoke cleanup',
  );
  temporaryRootRemoved = true;
};

const workingDirectory = path.join(temporaryRoot, 'Vérification système 你好');
const sourcePath = path.join(workingDirectory, 'Présentation source – été.hdeck');
const savedPath = path.join(workingDirectory, 'Copie enregistrée – 你好.hdeck');
const firstUserData = path.join(temporaryRoot, 'Profil source');
const reopenUserData = path.join(temporaryRoot, 'Profil réouverture');
let editor;
let activeApplicationPid;
let executionError;

try {
  await mkdir(workingDirectory, { recursive: true });
  const baseDocument = createNeutralDemoDeck();
  const document = {
    ...baseDocument,
    name: 'Vérification système V1',
    page: pagePresets[requestedPagePreset],
  };
  await writeFile(sourcePath, createHdeckArchive({ document }));
  const sourceBytes = await readFile(sourcePath);

  editor = await launchEditor({ deckPath: sourcePath, userData: firstUserData });
  activeApplicationPid = editor.application.pid;
  if (activeApplicationPid === undefined) throw new Error('Electron process ID is unavailable.');
  const initial = await editor.evaluate(`(() => ({
    name: document.querySelector('.document-title span')?.textContent?.trim() ?? '',
    slideCount: document.querySelectorAll('.canonical-thumbnail').length,
  }))()`);
  if (initial.name !== document.name || initial.slideCount !== document.slides.length) {
    throw new Error('The source deck did not open completely in the real editor.');
  }

  await runSaveOperation({
    editor,
    menuPrefix: 'Save as',
    dialogTitle: 'Save presentation',
    targetPath: savedPath,
    successText: 'Saved locally.',
  });

  const runtimeBaseline = await waitForStableRuntime(
    activeApplicationPid,
    'Observable editor runtime before exports',
  );
  if (!runtimeBaseline.processTreeComplete) {
    throw new Error('Windows did not permit complete Electron process-tree inspection.');
  }
  if (runtimeBaseline.processCount < 1 || runtimeBaseline.topLevelWindowCount < 1) {
    throw new Error(
      `The real editor runtime was not observable before exports (processes=${runtimeBaseline.processCount}, windows=${runtimeBaseline.topLevelWindowCount}).`,
    );
  }

  const exportRecords = [];
  const exportTargets = new Set();
  const firstExportPathByFormat = new Map();
  const runtimeSamples = [];
  for (let index = 0; index < exportRun.exportCount; index += 1) {
    const ordinal = index + 1;
    const format = index % 2 === 0 ? 'html' : 'pdf';
    const targetPath = path.join(
      workingDirectory,
      `Export ${String(ordinal).padStart(2, '0')} – 你好.${format}`,
    );
    if (exportTargets.has(targetPath) || (await exists(targetPath))) {
      throw new Error(`Export ${ordinal} did not receive a unique empty destination.`);
    }
    exportTargets.add(targetPath);
    if (!firstExportPathByFormat.has(format)) firstExportPathByFormat.set(format, targetPath);
    const startedAt = performance.now();
    await runSaveOperation({
      editor,
      menuPrefix: format === 'html' ? 'Export standalone HTML' : 'Export PDF',
      dialogTitle: format === 'html' ? 'Export standalone HTML' : 'Export PDF',
      targetPath,
      successText: format === 'html' ? 'HTML exported:' : 'PDF exported:',
    });
    const durationMs = performance.now() - startedAt;
    const bytes = await readFile(targetPath);
    const validation =
      format === 'html'
        ? (() => {
            const result = validateStandaloneHtml(bytes, document.name);
            return {
              offline: true,
              cspHashesValid: Boolean(result.scriptHash && result.styleHash),
              externalResourceReferences: 0,
            };
          })()
        : (() => {
            const result = validatePdf(bytes, document.slides.length, document.page);
            return {
              signatureAndEofValid: true,
              pageCount: result.pageCount,
              mediaBoxPt: [result.widthPt, result.heightPt],
            };
          })();
    const runtimeSample = await waitForBaselineWindows(
      activeApplicationPid,
      runtimeBaseline,
      `Closed native dialog after export ${ordinal}`,
    );
    if (!runtimeSample.processTreeComplete) {
      throw new Error(
        `Electron process-tree inspection became incomplete after export ${ordinal}.`,
      );
    }
    if (runtimeSample.topLevelWindowCount !== runtimeBaseline.topLevelWindowCount) {
      throw new Error(`A native or renderer window remained after export ${ordinal}.`);
    }
    if (
      runtimeSample.visibleWindowCount !== runtimeBaseline.visibleWindowCount ||
      !sameRuntimeWindows(runtimeBaseline, runtimeSample)
    ) {
      throw new Error(`The editor window identity changed after export ${ordinal}.`);
    }
    if (runtimeSample.processCount < 1) {
      throw new Error(`The editor process tree disappeared after export ${ordinal}.`);
    }
    runtimeSamples.push(runtimeSample);
    exportRecords.push({
      ordinal,
      format,
      durationMs: Math.round(durationMs * 10) / 10,
      bytes: bytes.length,
      sha256: sha256(bytes),
      validation,
    });
  }

  const runtimeGrowth = summarizeRuntimeGrowth(runtimeBaseline, runtimeSamples);
  if (!runtimeGrowth.processCountStable) {
    throw new Error('The Electron process count grew beyond the stabilized export allowance.');
  }
  if (runtimeGrowth.workingSet.available && !runtimeGrowth.workingSet.withinBudget) {
    throw new Error('The Electron process-tree working set grew beyond the export smoke budget.');
  }
  if (!runtimeGrowth.workingSet.available) {
    process.stdout.write(
      'Memory-growth limitation: Windows working-set data was unavailable for every sample.\n',
    );
  }

  let visualEvidence = null;
  if (exportRun.mode === 'short') {
    const htmlPath = firstExportPathByFormat.get('html');
    const pdfPath = firstExportPathByFormat.get('pdf');
    if (htmlPath === undefined || pdfPath === undefined) {
      throw new Error('The short export run did not produce both visual source formats.');
    }
    const browserExecutable = await findBrowserExecutable();
    await mkdir(evidenceDirectory, { recursive: true });
    const htmlRelativePath = `artifacts/evidence/v1-standalone-html-${requestedPagePreset}.png`;
    const pdfRelativePath = `artifacts/evidence/v1-pdf-${requestedPagePreset}.png`;
    const htmlVisual = await captureLocalVisual({
      browserExecutable,
      sourcePath: htmlPath,
      screenshotPath: path.join(repositoryRoot, htmlRelativePath),
      profilePath: path.join(temporaryRoot, 'Profil visuel HTML'),
    });
    const pdfVisual = await captureLocalVisual({
      browserExecutable,
      sourcePath: pdfPath,
      screenshotPath: path.join(repositoryRoot, pdfRelativePath),
      profilePath: path.join(temporaryRoot, 'Profil visuel PDF'),
      fragment: '#page=1&zoom=page-fit',
    });
    visualEvidence = {
      browser: path.basename(browserExecutable),
      standaloneHtml: { path: htmlRelativePath, ...htmlVisual },
      pdfFirstPage: { path: pdfRelativePath, ...pdfVisual },
    };
  }

  const firstApplicationPid = activeApplicationPid;
  await editor.close();
  editor = undefined;
  const firstRuntimeCleanup = await waitForRuntimeExit(
    firstApplicationPid,
    'Primary editor process and window cleanup',
  );

  const savedBytes = await readFile(savedPath);
  const parsed = parseHdeckArchive(savedBytes);
  if (
    parsed.document.name !== document.name ||
    parsed.document.slides.length !== document.slides.length
  ) {
    throw new Error('The saved .hdeck did not round-trip the source document.');
  }
  if (sha256(await readFile(sourcePath)) !== sha256(sourceBytes)) {
    throw new Error('Save As unexpectedly modified the original presentation.');
  }

  editor = await launchEditor({ deckPath: savedPath, userData: reopenUserData });
  activeApplicationPid = editor.application.pid;
  if (activeApplicationPid === undefined) throw new Error('Electron process ID is unavailable.');
  const reopened = await editor.evaluate(`(() => ({
    name: document.querySelector('.document-title span')?.textContent?.trim() ?? '',
    slideCount: document.querySelectorAll('.canonical-thumbnail').length,
    elementCount: document.querySelectorAll('[data-canvas-element-id]').length,
  }))()`);
  if (
    reopened.name !== document.name ||
    reopened.slideCount !== document.slides.length ||
    reopened.elementCount < 1
  ) {
    throw new Error('The Save As result did not reopen completely in the real editor.');
  }
  const reopenRuntime = await waitForStableRuntime(
    activeApplicationPid,
    'Observable reopened editor runtime',
  );
  if (
    !reopenRuntime.processTreeComplete ||
    reopenRuntime.processCount < 1 ||
    reopenRuntime.topLevelWindowCount < 1
  ) {
    throw new Error('The reopened editor runtime was not completely observable.');
  }
  const reopenApplicationPid = activeApplicationPid;
  await editor.close();
  editor = undefined;
  const reopenRuntimeCleanup = await waitForRuntimeExit(
    reopenApplicationPid,
    'Reopened editor process and window cleanup',
  );

  const htmlExports = exportRecords.filter((record) => record.format === 'html');
  const pdfExports = exportRecords.filter((record) => record.format === 'pdf');
  await removeTemporaryRoot();

  const report = {
    schemaVersion: 2,
    passed: true,
    testedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    launchMode:
      process.env.HTMLLELUJAH_EXECUTABLE === undefined ? 'source-build' : 'packaged-executable',
    fixture: {
      unicodeAndSpaces: true,
      pagePreset: requestedPagePreset,
      slideCount: document.slides.length,
      page: document.page,
    },
    run: {
      mode: exportRun.mode,
      exportCount: exportRecords.length,
      htmlExportCount: htmlExports.length,
      pdfExportCount: pdfExports.length,
      alternatingFormats: exportRecords.every(
        (record, index) => record.format === (index % 2 === 0 ? 'html' : 'pdf'),
      ),
      uniqueDestinations: exportTargets.size === exportRecords.length,
    },
    checks: {
      realEditorOpenedSourceDeck: true,
      nativeSaveAsDialogAutomated: true,
      nativeHtmlExportDialogsAutomated: htmlExports.length,
      nativePdfExportDialogsAutomated: pdfExports.length,
      everyHtmlValidatedOfflineWithCspAndNoUrl: htmlExports.every(
        (record) =>
          record.validation.offline &&
          record.validation.cspHashesValid &&
          record.validation.externalResourceReferences === 0,
      ),
      everyPdfValidated: pdfExports.every(
        (record) =>
          record.validation.signatureAndEofValid &&
          record.validation.pageCount === document.slides.length,
      ),
      sourceDeckUnchanged: true,
      hdeckParsedAndValidated: true,
      savedHdeckReopenedInRealEditor: true,
      nativeDialogsClosedAfterEveryExport: true,
      standaloneHtmlAndPdfVisualsCaptured: exportRun.mode === 'stress' || visualEvidence !== null,
      exactWindowHandlesAndVisibilityRestoredAfterEveryExport: true,
      processCountStable: runtimeGrowth.processCountStable,
      processTreesAndWindowsClosedAfterEditorsExit:
        firstRuntimeCleanup.processCount === 0 &&
        firstRuntimeCleanup.topLevelWindowCount === 0 &&
        firstRuntimeCleanup.visibleWindowCount === 0 &&
        reopenRuntimeCleanup.processCount === 0 &&
        reopenRuntimeCleanup.topLevelWindowCount === 0 &&
        reopenRuntimeCleanup.visibleWindowCount === 0,
      temporaryWorkspaceRemoved: temporaryRootRemoved,
    },
    artifacts: {
      hdeck: { bytes: savedBytes.length, sha256: sha256(savedBytes) },
      exports: exportRecords,
      visuals: visualEvidence,
    },
    performance: {
      allExports: summarizeDurations(exportRecords.map((record) => record.durationMs)),
      htmlExports: summarizeDurations(htmlExports.map((record) => record.durationMs)),
      pdfExports: summarizeDurations(pdfExports.map((record) => record.durationMs)),
    },
    runtime: {
      measurement: {
        memoryMetric: 'sum of Windows WorkingSet64 across the Electron process tree',
        limitation:
          'Working set is an RSS-equivalent signal; a bounded run cannot prove that no slower leak exists.',
      },
      baseline: runtimeBaseline,
      samples: runtimeSamples.map((sample, index) => ({ ordinal: index + 1, ...sample })),
      growth: runtimeGrowth,
      cleanup: {
        primaryEditor: firstRuntimeCleanup,
        reopenedEditor: reopenRuntimeCleanup,
      },
    },
    security: {
      cspSha256DirectivesVerifiedForEveryHtml: true,
      externalResourceReferences: 0,
      publicReportContainsLocalPaths: false,
    },
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `Windows system export smoke passed: ${exportRecords.length} mixed exports, parsing, runtime cleanup, and real reopen verified.\n`,
  );
} catch (error) {
  if (editor !== undefined && editor.applicationError() !== '') {
    process.stderr.write(`[desktop stderr]\n${editor.applicationError()}\n`);
  }
  executionError = error;
} finally {
  const cleanupErrors = [];
  if (editor !== undefined) {
    const rootProcessId = editor.application.pid;
    try {
      await editor.close();
      if (rootProcessId !== undefined) {
        await waitForRuntimeExit(rootProcessId, 'Failed-run editor process and window cleanup');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!temporaryRootRemoved) {
    try {
      await removeTemporaryRoot();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    executionError = new AggregateError(
      executionError === undefined ? cleanupErrors : [executionError, ...cleanupErrors],
      'The system export smoke or its cleanup failed.',
    );
  }
}

if (executionError !== undefined) throw executionError;
