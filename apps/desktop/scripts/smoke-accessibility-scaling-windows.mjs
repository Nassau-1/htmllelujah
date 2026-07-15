import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

/**
 * Windows accessibility and display-scaling smoke for the real Electron app.
 *
 * This deliberately uses only Electron/Chromium's CDP surface and DOM semantics.
 * It is a release gate for regressions, not a substitute for a manual pass with
 * Narrator, NVDA, a keyboard-only user, or multiple physical displays.
 */

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidenceDirectory = path.join(repositoryRoot, 'artifacts', 'evidence');
const reportRelativePath = 'artifacts/evidence/v1-accessibility-scaling.json';
const reportPath = path.join(repositoryRoot, reportRelativePath);
const defaultScaleFactors = [1, 1.25, 1.5, 2];
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fail = (message) => {
  throw new Error(message);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

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
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }),
  ]);
};

const removeWithRetry = async (targetPath) => {
  await waitFor(
    async () => {
      try {
        await rm(targetPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        return true;
      } catch (error) {
        if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
        throw error;
      }
    },
    10_000,
    'Temporary Electron profile cleanup',
  );
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

const parseScaleFactors = () => {
  const configured = process.env.HTMLLELUJAH_SCALE_FACTORS;
  if (configured === undefined || configured.trim() === '') return defaultScaleFactors;
  const factors = configured
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry >= 0.5 && entry <= 4);
  if (factors.length === 0) {
    fail('HTMLLELUJAH_SCALE_FACTORS must contain comma-separated values between 0.5 and 4.');
  }
  return [...new Set(factors)];
};

const scaleLabel = (factor) => String(Math.round(factor * 100)).padStart(3, '0');

const cleanLaunchEnvironment = () => {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.VITE_DEV_SERVER_URL;
  return environment;
};

const sanitizeMessage = (value, temporaryPaths = []) => {
  let result = String(value);
  for (const localPath of [repositoryRoot, desktopRoot, ...temporaryPaths]) {
    result = result.replaceAll(localPath, '<local-path>');
    result = result.replaceAll(localPath.replaceAll('\\', '/'), '<local-path>');
  }
  return result
    .replace(/file:\/\/\/[^\s"']+/giu, '<local-url>')
    .replace(/\b[a-z]:[\\/](?![\\/])[^\r\n"'`]*/giu, '<local-path>')
    .slice(0, 800);
};

const assertPublicSafeReport = (serialized) => {
  const forbidden = [/[a-z]:\\/iu, /file:\/\/\//iu, /\\users\\/iu, /\/users\//iu, /appdata/iu];
  for (const pattern of forbidden) {
    assert(
      !pattern.test(serialized),
      `The evidence report contains a private local path (${pattern}).`,
    );
  }
};

const pngDimensions = (data) => {
  const bytes = Buffer.from(data, 'base64');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(signature), 'Invalid PNG screenshot.');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes };
};

const axValue = (entry) => (entry === undefined ? undefined : entry.value);

const auditAccessibilityTree = (nodes) => {
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);
  const exposed = nodes.filter((node) => !node.ignored);
  const interactive = exposed.filter((node) => interactiveRoles.has(axValue(node.role)));
  const unnamed = interactive
    .filter((node) => String(axValue(node.name) ?? '').trim() === '')
    .map((node) => ({ role: axValue(node.role), backendDOMNodeId: node.backendDOMNodeId ?? null }));
  const roles = {};
  const states = {};
  for (const node of exposed) {
    const role = axValue(node.role) ?? 'unknown';
    roles[role] = (roles[role] ?? 0) + 1;
    for (const property of node.properties ?? []) {
      if (
        ['checked', 'disabled', 'expanded', 'focusable', 'focused', 'pressed', 'selected'].includes(
          property.name,
        )
      ) {
        states[property.name] = (states[property.name] ?? 0) + 1;
      }
    }
  }
  assert(exposed.length >= 30, 'The exposed accessibility tree is unexpectedly small.');
  assert(interactive.length >= 15, 'The accessibility tree exposes too few interactive controls.');
  assert(unnamed.length === 0, 'The accessibility tree contains unnamed interactive controls.');
  for (const requiredRole of ['RootWebArea', 'main', 'navigation', 'toolbar', 'tab', 'slider']) {
    assert((roles[requiredRole] ?? 0) > 0, `The accessibility tree is missing ${requiredRole}.`);
  }
  assert(
    (states.focusable ?? 0) >= 10,
    'The accessibility tree exposes too few focusable controls.',
  );
  assert((states.selected ?? 0) >= 1, 'The accessibility tree exposes no selected state.');
  assert((states.pressed ?? 0) >= 1, 'The accessibility tree exposes no pressed state.');
  return {
    exposedNodes: exposed.length,
    interactiveNodes: interactive.length,
    unnamedInteractiveNodes: unnamed,
    roles,
    states,
  };
};

const sendKey = async (cdp, key, code, windowsVirtualKeyCode, modifiers = 0) => {
  const common = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...common });
  const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
  if (text !== undefined) {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'char',
      modifiers,
      key,
      code,
      text,
      unmodifiedText: text,
    });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...common });
};

const runScale = async ({ factor, executable }) => {
  const userData = await mkdtemp(path.join(tmpdir(), `htmllelujah-a11y-${scaleLabel(factor)}-`));
  const launchCommand = executable === undefined ? electronPath : path.resolve(executable);
  const launchArguments = [
    ...(executable === undefined ? ['.'] : []),
    `--user-data-dir=${userData}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--force-device-scale-factor=${factor}`,
  ];
  const application = spawn(launchCommand, launchArguments, {
    cwd: desktopRoot,
    env: cleanLaunchEnvironment(),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  application.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000);
  });
  let cdp;
  try {
    const debuggingPort = await waitFor(
      async () => {
        if (application.exitCode !== null) {
          throw new Error(
            `Electron exited before opening its renderer (code ${application.exitCode}).`,
          );
        }
        try {
          const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
          const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
          if (Number.isInteger(port) && port > 0) return port;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const match = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
        return match === null ? undefined : Number.parseInt(match[1], 10);
      },
      20_000,
      `Electron remote debugging endpoint at ${factor}x`,
    );

    const target = await waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`);
        if (!response.ok) return undefined;
        const targets = await response.json();
        return targets.find(
          (candidate) =>
            candidate.type === 'page' &&
            typeof candidate.webSocketDebuggerUrl === 'string' &&
            typeof candidate.url === 'string' &&
            !candidate.url.startsWith('devtools://'),
        );
      },
      20_000,
      `HTMLlelujah renderer target at ${factor}x`,
    );

    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Accessibility.enable'),
    ]);
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
    const waitForRenderer = (expression, label, timeoutMs = 10_000) =>
      waitFor(async () => ((await evaluate(expression)) ? true : undefined), timeoutMs, label);

    await waitForRenderer(
      `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
      `Editor shell at ${factor}x`,
      20_000,
    );
    await evaluate(`document.fonts.ready.then(() => true)`);

    const layoutAudit = async (label) => {
      const result = await evaluate(`(() => {
        const round = (value) => Math.round(value * 10) / 10;
        const visible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        };
        const descriptor = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, missing: true };
          const rect = element.getBoundingClientRect();
          const intersectionWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
          const intersectionHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
          const area = rect.width * rect.height;
          return {
            selector,
            missing: false,
            visible: visible(element),
            rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
            visibleRatio: area === 0 ? 0 : round((intersectionWidth * intersectionHeight) / area),
          };
        };
        const critical = [
          '.app-header',
          '.editor-layout',
          'aside[aria-label="Slides"]',
          'section[aria-label="Slide workspace"]',
          'aside[aria-label="Inspector"]',
          '.status-bar',
          '.application-menu button',
          '[aria-label="Add text"]',
          '[aria-label="Add image"]',
          '[aria-label="Add shape"]',
          '[aria-label="Add table"]',
          '.new-slide-button',
          '.canonical-thumbnail',
          '[data-testid="editor-canvas-root"]',
          '[role="tab"]',
          '[aria-label="Zoom percentage"]',
        ].map(descriptor);
        const localScrollContainers = ['.slide-list', '.inspector-scroll'].map((selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) return { selector, missing: true };
          const style = getComputedStyle(element);
          return {
            selector,
            missing: false,
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            clientHeight: element.clientHeight,
            scrollHeight: element.scrollHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          };
        });
        return {
          label: ${JSON.stringify(label)},
          viewport: {
            width: innerWidth,
            height: innerHeight,
            devicePixelRatio,
            visualScale: visualViewport?.scale ?? 1,
          },
          documentExtent: {
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            rootOverflowX: getComputedStyle(document.documentElement).overflowX,
            rootOverflowY: getComputedStyle(document.documentElement).overflowY,
            bodyOverflowX: getComputedStyle(document.body).overflowX,
            bodyOverflowY: getComputedStyle(document.body).overflowY,
          },
          critical,
          localScrollContainers,
        };
      })()`);
      const broken = result.critical.filter(
        (entry) => entry.missing || !entry.visible || entry.visibleRatio < 0.74,
      );
      assert(
        broken.length === 0,
        `${label} has missing, hidden, or critically clipped UI surfaces.`,
      );
      const horizontalOverflowContained = [
        result.documentExtent.rootOverflowX,
        result.documentExtent.bodyOverflowX,
      ].every((value) => value === 'hidden' || value === 'clip');
      const verticalOverflowContained = [
        result.documentExtent.rootOverflowY,
        result.documentExtent.bodyOverflowY,
      ].every((value) => value === 'hidden' || value === 'clip');
      assert(
        result.documentExtent.scrollWidth <= result.documentExtent.clientWidth + 2 ||
          horizontalOverflowContained,
        `${label} has uncontained document-level horizontal overflow.`,
      );
      assert(
        result.documentExtent.scrollHeight <= result.documentExtent.clientHeight + 2 ||
          verticalOverflowContained,
        `${label} has uncontained document-level vertical overflow.`,
      );
      const horizontalPanelOverflow = result.localScrollContainers.filter(
        (entry) => !entry.missing && entry.scrollWidth > entry.clientWidth + 2,
      );
      assert(
        horizontalPanelOverflow.length === 0,
        `${label} has unintended horizontal overflow in a side panel: ${JSON.stringify(horizontalPanelOverflow)}`,
      );
      return result;
    };

    const nativeLayout = await layoutAudit('native-window');
    assert(
      Math.abs(nativeLayout.viewport.devicePixelRatio - factor) <= 0.06,
      `Chromium did not apply the requested ${factor}x device scale factor.`,
    );

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1120,
      height: 720,
      deviceScaleFactor: factor,
      mobile: false,
      screenWidth: 1120,
      screenHeight: 720,
    });
    await sleep(250);
    const compactLayout = await layoutAudit('compact-1120x720');
    assert(
      compactLayout.viewport.width === 1120 && compactLayout.viewport.height === 720,
      'The compact viewport override was not applied.',
    );
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(250);

    const keyboardOrder = [];
    await evaluate(`(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute('tabindex');
      return true;
    })()`);
    for (let index = 0; index < 14; index += 1) {
      await sendKey(cdp, 'Tab', 'Tab', 9);
      const focused = await evaluate(`(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLElement)) return null;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') ?? '',
          name: (element.getAttribute('aria-label') ?? element.textContent ?? element.title ?? '')
            .replace(/\\s+/g, ' ').trim().slice(0, 80),
          visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
            style.display !== 'none' && rect.bottom > 0 && rect.right > 0 && rect.left < innerWidth &&
            rect.top < innerHeight,
          focusVisible: element.matches(':focus-visible'),
          focusIndicator: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
        };
      })()`);
      assert(focused !== null && focused.visible, 'Tab moved focus to an invisible control.');
      keyboardOrder.push(focused);
    }
    assert(
      new Set(keyboardOrder.map((entry) => `${entry.tag}:${entry.role}:${entry.name}`)).size >= 10,
      'Keyboard Tab traversal appears trapped in a short focus cycle.',
    );
    assert(
      keyboardOrder.some((entry) => entry.name === 'File'),
      'Tab order did not reach File.',
    );
    assert(
      keyboardOrder.some((entry) => entry.name === 'Add text'),
      'Tab order did not reach the primary editing toolbar.',
    );
    assert(
      keyboardOrder.some((entry) => entry.focusVisible && entry.focusIndicator),
      'Keyboard focus did not expose a visible focus indicator.',
    );

    const focusSelector = async (selector, label) => {
      const focused = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!(element instanceof HTMLElement)) return false;
        element.focus();
        return document.activeElement === element;
      })()`);
      assert(focused, `${label} could not receive keyboard focus.`);
    };

    await focusSelector('.application-menu button', 'File menu button');
    await sendKey(cdp, 'Enter', 'Enter', 13);
    await waitForRenderer(
      `document.querySelector('[role="menu"][aria-label="File menu"]') !== null`,
      'Keyboard-opened File menu',
    );
    await focusSelector('[role="menuitem"]', 'File menu item');
    const menuFocus = await evaluate(`(() => ({
      role: document.activeElement?.getAttribute('role') ?? '',
      name: document.activeElement?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80) ?? '',
      focusVisible: document.activeElement?.matches(':focus-visible') ?? false,
    }))()`);
    assert(
      menuFocus.role === 'menuitem' && menuFocus.name !== '',
      'File menu item focus is invalid.',
    );
    await sendKey(cdp, 'Escape', 'Escape', 27);
    await waitForRenderer(
      `document.querySelector('[role="menu"][aria-label="File menu"]') === null`,
      'Escape-closing File menu',
    );

    await focusSelector('.canonical-thumbnail', 'Slide thumbnail');
    await sendKey(cdp, 'Enter', 'Enter', 13);
    assert(
      await evaluate(`document.activeElement?.getAttribute('aria-current') === 'page'`),
      'Keyboard slide selection did not expose aria-current.',
    );

    await focusSelector('.canonical-hitbox', 'Canvas object');
    await sendKey(cdp, ' ', 'Space', 32);
    await waitForRenderer(
      `document.activeElement?.getAttribute('aria-pressed') === 'true'`,
      'Keyboard canvas object selection',
    );

    await focusSelector('[role="tab"]:not([aria-selected="true"])', 'Design tab');
    await sendKey(cdp, 'Enter', 'Enter', 13);
    await waitForRenderer(
      `document.activeElement?.getAttribute('aria-selected') === 'true'`,
      'Keyboard Design tab activation',
    );
    await focusSelector('[role="tab"]:not([aria-selected="true"])', 'Properties tab');
    await sendKey(cdp, 'Enter', 'Enter', 13);
    await waitForRenderer(
      `document.activeElement?.getAttribute('aria-selected') === 'true'`,
      'Keyboard Properties tab activation',
    );

    await focusSelector('[aria-label="Zoom percentage"]', 'Canvas zoom slider');
    const zoomBefore = await evaluate(`Number(document.activeElement?.value ?? 0)`);
    await sendKey(cdp, 'Home', 'Home', 36);
    await sendKey(cdp, 'ArrowRight', 'ArrowRight', 39);
    const zoomKeyboardValue = await evaluate(`Number(document.activeElement?.value ?? 0)`);
    assert(
      zoomKeyboardValue > 25 && zoomKeyboardValue !== zoomBefore,
      'Canvas zoom ignored keyboard input.',
    );
    await focusSelector('[aria-label="Fit slide"]', 'Fit slide button');
    await sendKey(cdp, 'Enter', 'Enter', 13);
    await waitForRenderer(
      `Number(document.querySelector('[aria-label="Zoom percentage"]')?.value ?? 0) === 100`,
      'Keyboard canvas zoom reset',
    );
    const postZoomLayout = await layoutAudit('post-keyboard-zoom');

    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    const reducedMotion = await evaluate(`(() => {
      const toMilliseconds = (value) => value.split(',').map((part) => {
        const entry = part.trim();
        if (entry.endsWith('ms')) return Number.parseFloat(entry);
        if (entry.endsWith('s')) return Number.parseFloat(entry) * 1000;
        return 0;
      }).filter(Number.isFinite);
      const offenders = [];
      for (const element of document.querySelectorAll('*')) {
        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(element);
        const maximum = Math.max(
          0,
          ...toMilliseconds(style.transitionDuration),
          ...toMilliseconds(style.animationDuration),
        );
        if (maximum > 0.1) {
          offenders.push({
            tag: element.tagName.toLowerCase(),
            className: [...element.classList].slice(0, 3).join('.'),
            maximumDurationMs: maximum,
          });
        }
      }
      return {
        mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        offenders: offenders.slice(0, 20),
      };
    })()`);
    assert(reducedMotion.mediaMatches, 'Reduced-motion emulation was not applied.');
    assert(
      reducedMotion.offenders.length === 0,
      'Visible motion was not reduced to a negligible duration.',
    );
    await cdp.send('Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });

    const domAudit = await evaluate(`(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.closest('[aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const normal = (value) => value?.replace(/\\s+/g, ' ').trim() ?? '';
      const nameOf = (element) => {
        const labelledBy = normal(element.getAttribute('aria-labelledby'));
        const labelled = labelledBy === '' ? '' : labelledBy.split(/\\s+/).map((id) =>
          normal(document.getElementById(id)?.textContent)).filter(Boolean).join(' ');
        const labels = 'labels' in element && element.labels
          ? [...element.labels].map((label) => normal(label.textContent)).filter(Boolean).join(' ')
          : '';
        return normal(
          element.getAttribute('aria-label') || labelled || labels ||
          (element instanceof HTMLButtonElement ? element.textContent : '') ||
          element.getAttribute('title'),
        );
      };
      const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') ?? '',
        classes: [...element.classList].slice(0, 3),
      });
      const controls = [...document.querySelectorAll(
        'button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="slider"], [contenteditable="true"]',
      )].filter(isVisible);
      const unnamedControls = controls.filter((element) => nameOf(element) === '').map(describe);
      const duplicateIds = [...document.querySelectorAll('[id]')]
        .map((element) => element.id).filter((id, index, ids) => id !== '' && ids.indexOf(id) !== index);
      const brokenLabelTargets = [...document.querySelectorAll('label[for]')]
        .map((label) => label.getAttribute('for')).filter((id) => id && document.getElementById(id) === null);
      const imagesWithoutAlt = [...document.querySelectorAll('img:not([alt])')]
        .filter(isVisible).map(describe);
      const positiveTabIndex = controls.filter((element) => element.tabIndex > 0).map(describe);
      return {
        visibleControls: controls.length,
        namedControls: controls.length - unnamedControls.length,
        unnamedControls,
        duplicateIds: [...new Set(duplicateIds)],
        brokenLabelTargets: [...new Set(brokenLabelTargets)],
        imagesWithoutAlt,
        positiveTabIndex,
      };
    })()`);
    assert(domAudit.visibleControls >= 15, 'The DOM exposes too few visible controls.');
    assert(
      domAudit.unnamedControls.length === 0,
      `Visible DOM controls without accessible names were found: ${JSON.stringify(domAudit.unnamedControls.slice(0, 8))}`,
    );
    assert(domAudit.duplicateIds.length === 0, 'Duplicate DOM ids were found.');
    assert(
      domAudit.brokenLabelTargets.length === 0,
      'Labels with missing control targets were found.',
    );
    assert(
      domAudit.imagesWithoutAlt.length === 0,
      'Visible images without alt attributes were found.',
    );
    assert(
      domAudit.positiveTabIndex.length === 0,
      'Positive tabindex values disturb natural keyboard order.',
    );

    const tree = await cdp.send('Accessibility.getFullAXTree', { depth: -1 });
    const accessibility = auditAccessibilityTree(tree.nodes ?? []);

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    assert(
      typeof screenshot.data === 'string' && screenshot.data.length > 1_000,
      'Empty screenshot.',
    );
    const dimensions = pngDimensions(screenshot.data);
    const screenshotRelativePath = `artifacts/evidence/v1-accessibility-scale-${scaleLabel(factor)}.png`;
    await writeFile(path.join(repositoryRoot, screenshotRelativePath), dimensions.bytes);

    return {
      factorRequested: factor,
      factorObserved: nativeLayout.viewport.devicePixelRatio,
      nativeLayout,
      compactLayout,
      postZoomLayout,
      keyboard: {
        sampledTabStops: keyboardOrder,
        fileMenuItem: menuFocus,
        canvasZoomBefore: zoomBefore,
        canvasZoomFromKeyboard: zoomKeyboardValue,
      },
      reducedMotion,
      dom: domAudit,
      accessibility,
      screenshot: {
        path: screenshotRelativePath,
        widthPx: dimensions.width,
        heightPx: dimensions.height,
      },
    };
  } catch (error) {
    const diagnostic = {
      message: sanitizeMessage(error instanceof Error ? error.message : error, [userData]),
      processExitCode: application.exitCode,
      rendererStderrObserved: stderr.trim() !== '',
    };
    if (stderr.trim() !== '') {
      process.stderr.write(`[desktop ${factor}x stderr]\n${sanitizeMessage(stderr, [userData])}\n`);
    }
    throw Object.assign(new Error(diagnostic.message), { publicDiagnostic: diagnostic });
  } finally {
    cdp?.close();
    await terminate(application);
    await removeWithRetry(userData);
  }
};

const main = async () => {
  if (process.platform !== 'win32') {
    fail('This smoke is intentionally Windows-only. Run it on the supported Windows V1 platform.');
  }
  const executable = process.env.HTMLLELUJAH_EXECUTABLE;
  if (executable === undefined) {
    await Promise.all([
      access(path.join(desktopRoot, 'dist', 'index.html')),
      access(path.join(desktopRoot, 'dist-electron', 'main.js')),
    ]).catch(() => {
      fail('The source build is missing. Build @htmllelujah/desktop before running this smoke.');
    });
  } else {
    await access(path.resolve(executable)).catch(() => {
      fail('HTMLLELUJAH_EXECUTABLE does not identify an accessible executable.');
    });
  }

  await mkdir(evidenceDirectory, { recursive: true });
  const scaleFactors = parseScaleFactors();
  const results = [];
  let failure;
  for (const factor of scaleFactors) {
    process.stdout.write(`Auditing HTMLlelujah at ${factor}x display scaling...\n`);
    try {
      results.push(await runScale({ factor, executable }));
    } catch (error) {
      failure = error;
      break;
    }
  }

  const report = {
    schemaVersion: 1,
    passed: failure === undefined && results.length === scaleFactors.length,
    testedAt: new Date().toISOString(),
    platform: 'Windows',
    launchMode: executable === undefined ? 'source-build' : 'packaged-executable',
    requestedScaleFactors: scaleFactors,
    completedScaleFactors: results.map((result) => result.factorRequested),
    results,
    failure:
      failure === undefined
        ? null
        : (failure.publicDiagnostic ?? { message: sanitizeMessage(failure.message ?? failure) }),
    limitations: [
      'CDP and DOM semantics do not simulate a real screen reader.',
      'A manual Narrator or NVDA pass remains required for release-level assistive-technology confidence.',
      'Forced device scale factors exercise Chromium rendering but cannot reproduce every physical monitor or GPU combination.',
    ],
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  assertPublicSafeReport(serialized);
  await writeFile(reportPath, serialized, 'utf8');

  if (failure !== undefined) {
    process.stderr.write(
      `Accessibility/scaling smoke failed: ${sanitizeMessage(failure.message ?? failure)}\n` +
        `Public-safe report: ${reportRelativePath}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Accessibility/scaling smoke passed at ${scaleFactors.join('x, ')}x.\n` +
      `Public-safe report: ${reportRelativePath}\n` +
      `Reminder: this automated smoke does not replace Narrator or NVDA.\n`,
  );
};

await main().catch(async (error) => {
  const message = sanitizeMessage(error instanceof Error ? error.message : error);
  const fallback = {
    schemaVersion: 1,
    passed: false,
    testedAt: new Date().toISOString(),
    platform: process.platform === 'win32' ? 'Windows' : process.platform,
    launchMode:
      process.env.HTMLLELUJAH_EXECUTABLE === undefined ? 'source-build' : 'packaged-executable',
    requestedScaleFactors: [],
    completedScaleFactors: [],
    results: [],
    failure: { message },
    limitations: ['This automated smoke does not simulate a real screen reader.'],
  };
  try {
    await mkdir(evidenceDirectory, { recursive: true });
    const serialized = `${JSON.stringify(fallback, null, 2)}\n`;
    assertPublicSafeReport(serialized);
    await writeFile(reportPath, serialized, 'utf8');
  } catch {
    // The original failure remains the useful result if evidence cannot be written.
  }
  process.stderr.write(`Accessibility/scaling smoke failed: ${message}\n`);
  process.exitCode = 1;
});
