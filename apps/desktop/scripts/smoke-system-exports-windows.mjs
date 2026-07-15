import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNeutralDemoDeck } from '@htmllelujah/document-core';
import { createHdeckArchive, parseHdeckArchive } from '@htmllelujah/hdeck';
import electronPath from 'electron';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidencePath = path.join(repositoryRoot, 'artifacts', 'evidence', 'system-exports-v1.json');
const dialogAutomationPath = path.join(import.meta.dirname, 'automate-save-dialog.ps1');
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
      } else pending.resolve(message.result ?? {});
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
      'HTMLlelujah renderer target',
    );
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
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

const workingDirectory = path.join(temporaryRoot, 'Vérification système 你好');
const sourcePath = path.join(workingDirectory, 'Présentation source – été.hdeck');
const savedPath = path.join(workingDirectory, 'Copie enregistrée – 你好.hdeck');
const htmlPath = path.join(workingDirectory, 'Présentation autonome – 你好.html');
const pdfPath = path.join(workingDirectory, 'Présentation imprimable – 你好.pdf');
const firstUserData = path.join(temporaryRoot, 'Profil source');
const reopenUserData = path.join(temporaryRoot, 'Profil réouverture');
let editor;

try {
  await mkdir(workingDirectory, { recursive: true });
  const baseDocument = createNeutralDemoDeck();
  const document = { ...baseDocument, name: 'Vérification système V1' };
  await writeFile(sourcePath, createHdeckArchive({ document }));
  const sourceBytes = await readFile(sourcePath);

  editor = await launchEditor({ deckPath: sourcePath, userData: firstUserData });
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
  await runSaveOperation({
    editor,
    menuPrefix: 'Export standalone HTML',
    dialogTitle: 'Export standalone HTML',
    targetPath: htmlPath,
    successText: 'HTML exported:',
  });
  await runSaveOperation({
    editor,
    menuPrefix: 'Export PDF',
    dialogTitle: 'Export PDF',
    targetPath: pdfPath,
    successText: 'PDF exported:',
  });

  await editor.close();
  editor = undefined;

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

  const htmlBytes = await readFile(htmlPath);
  const htmlValidation = validateStandaloneHtml(htmlBytes, document.name);
  const pdfBytes = await readFile(pdfPath);
  const pdfValidation = validatePdf(pdfBytes, document.slides.length, document.page);

  editor = await launchEditor({ deckPath: savedPath, userData: reopenUserData });
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
  await editor.close();
  editor = undefined;

  const report = {
    schemaVersion: 1,
    passed: true,
    testedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    launchMode:
      process.env.HTMLLELUJAH_EXECUTABLE === undefined ? 'source-build' : 'packaged-executable',
    fixture: {
      unicodeAndSpaces: true,
      slideCount: document.slides.length,
      page: document.page,
    },
    checks: {
      realEditorOpenedSourceDeck: true,
      nativeSaveAsDialogAutomated: true,
      nativeHtmlExportDialogAutomated: true,
      nativePdfExportDialogAutomated: true,
      sourceDeckUnchanged: true,
      hdeckParsedAndValidated: true,
      savedHdeckReopenedInRealEditor: true,
      standaloneHtmlOffline: true,
      standaloneHtmlCspHashesValid: true,
      pdfSignatureAndEofValid: true,
      pdfPageCount: pdfValidation.pageCount,
      pdfMediaBoxPt: [pdfValidation.widthPt, pdfValidation.heightPt],
    },
    artifacts: {
      hdeck: { bytes: savedBytes.length, sha256: sha256(savedBytes) },
      html: { bytes: htmlBytes.length, sha256: sha256(htmlBytes) },
      pdf: { bytes: pdfBytes.length, sha256: sha256(pdfBytes) },
    },
    security: {
      cspSha256DirectivesVerified: Boolean(htmlValidation.scriptHash && htmlValidation.styleHash),
      externalResourceReferences: 0,
      publicReportContainsLocalPaths: false,
    },
  };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    'Windows system export smoke passed: Save As, HTML, PDF, parsing, and real reopen verified.\n',
  );
} catch (error) {
  if (editor !== undefined && editor.applicationError() !== '') {
    process.stderr.write(`[desktop stderr]\n${editor.applicationError()}\n`);
  }
  throw error;
} finally {
  if (editor !== undefined) await editor.close();
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
}
