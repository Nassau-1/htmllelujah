import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidenceDirectory = path.join(repositoryRoot, 'artifacts', 'evidence');
const screenshotPath = path.join(evidenceDirectory, 'v1-editor-electron.png');
const reportPath = path.join(evidenceDirectory, 'v1-editor-electron.json');
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

const terminate = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await Promise.race([new Promise((resolve) => killer.once('exit', resolve)), sleep(5_000)]);
    if (child.exitCode !== null || child.signalCode !== null) return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => child.kill('SIGKILL')),
  ]);
};

const automateFileDialog = (rootProcessId, windowTitle, targetPath) =>
  new Promise((resolve, reject) => {
    const child = spawn(
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
        '-TimeoutSeconds',
        '30',
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Native file-dialog automation timed out.'));
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Native file-dialog automation exited ${code ?? signal}. ${stderr}`));
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

const userData = await mkdtemp(path.join(tmpdir(), 'htmllelujah-ui-smoke-'));
const imageFixturePath = path.join(userData, 'native-image-import.png');
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
const launchCommand = executable === undefined ? electronPath : path.resolve(executable);
const launchArguments = [
  ...(executable === undefined ? ['.'] : []),
  ...(openPath === undefined ? [] : [path.resolve(openPath)]),
  `--user-data-dir=${userData}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--force-device-scale-factor=1',
];
const launchStartedAt = performance.now();
const application = spawn(launchCommand, launchArguments, {
  cwd: desktopRoot,
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let applicationError = '';
application.stderr.on('data', (chunk) => {
  applicationError += chunk.toString('utf8');
});

let cdp;
let evaluateRenderer;
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
    15_000,
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
    15_000,
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

  const setInputValue = async (selector, value, label, blur = false) => {
    const updated = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
        return false;
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
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
  await evaluate(`document.fonts.ready.then(() => true)`);
  const interactiveReadyMs = Number((performance.now() - launchStartedAt).toFixed(3));

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

  await click('[aria-label="Add shape"]', 'Add shape');
  await waitForRenderer(
    `document.querySelectorAll('[data-canvas-element-id]').length === ${initial.elementCount + 1}`,
    'Shape insertion',
  );
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 1`,
    'Inserted shape selection',
  );

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
  const reselected = await evaluate(`(() => {
    const elements = [...document.querySelectorAll('[data-canvas-element-id]')];
    const element = elements.at(-1);
    if (!(element instanceof HTMLElement)) return false;
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    return true;
  })()`);
  if (!reselected) throw new Error('The redone shape could not be selected.');
  await waitForRenderer(
    `document.querySelectorAll('.canonical-hitbox.is-selected').length === 1`,
    'Redone shape keyboard selection',
  );

  if (application.pid === undefined) throw new Error('The Electron process ID is unavailable.');
  const imageDialog = automateFileDialog(application.pid, 'Insert image', imageFixturePath);
  await click('[aria-label="Add image"]', 'Add image');
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
  try {
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
  if (finalState.elementCount !== initial.elementCount + 2 || finalState.selectedCount !== 1) {
    throw new Error('The user edit was not preserved after undo and redo.');
  }
  if (finalState.openDialogs !== 0 || finalState.activeInspectorTab !== 'Properties') {
    throw new Error('The editor did not return to a stable post-interaction state.');
  }

  const screenshot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof screenshot.data !== 'string' || screenshot.data.length < 1_000) {
    throw new Error('Electron returned an invalid screenshot.');
  }

  const report = {
    passed: true,
    testedAt: new Date().toISOString(),
    launchMode: executable === undefined ? 'source-build' : 'packaged-executable',
    performance: {
      interactiveReadyMs,
      warmStartBudgetMs: 3_000,
      withinWarmStartBudget: interactiveReadyMs < 3_000,
    },
    rendererTitle: initial.title,
    initial,
    final: finalState,
    checks: [
      'real Electron renderer opened through the secure app protocol',
      'essential editor surfaces rendered',
      'shape insertion, undo, and redo converged',
      'native image chooser imported one decoded image with atomic undo and redo',
      'File menu opened and closed',
      'Codex MCP dialog opened and closed',
      'LAN collaboration dialog opened and closed',
      'page format changed through the Design inspector and undid cleanly',
      'Design and Properties inspector tabs switched',
      'stable PNG screenshot captured from the real window',
    ],
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await Promise.all([
    writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64')),
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
  ]);

  process.stdout.write(
    `Electron UI smoke passed: real window edited, undo/redo verified, dialogs exercised.\n` +
      `Screenshot: ${screenshotPath}\nReport: ${reportPath}\n`,
  );
} catch (error) {
  if (evaluateRenderer !== undefined) {
    try {
      const diagnostic = await evaluateRenderer(`(() => ({
        readyState: document.readyState,
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 1_000) ?? '',
        bodyHtml: document.body?.innerHTML?.slice(0, 1_000) ?? '',
      }))()`);
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
  cdp?.close();
  await terminate(application);
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
}
