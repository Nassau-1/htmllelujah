import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createNeutralDemoDeck } from '@htmllelujah/document-core';
import { createHdeckArchive } from '@htmllelujah/hdeck';
import electronPath from 'electron';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const evidenceDirectory = path.join(repositoryRoot, 'artifacts', 'evidence');
const reportPath = path.join(evidenceDirectory, 'text-lock-ui-system-v1.json');
const screenshotPaths = {
  hostOwned: path.join(evidenceDirectory, 'text-lock-host-owned-v1.png'),
  guestBlocked: path.join(evidenceDirectory, 'text-lock-guest-blocked-v1.png'),
  guestOwned: path.join(evidenceDirectory, 'text-lock-guest-owned-v1.png'),
};
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

const launchEditor = async ({ deckPath, profilePath, role }) => {
  const executable = process.env.HTMLLELUJAH_EXECUTABLE;
  const launchCommand = executable === undefined ? electronPath : path.resolve(executable);
  const launchArguments = [
    ...(executable === undefined ? ['.'] : []),
    deckPath,
    `--user-data-dir=${profilePath}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--force-device-scale-factor=1',
  ];
  const application = spawn(launchCommand, launchArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  application.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4_000);
  });

  let cdp;
  try {
    const debuggingPort = await waitFor(
      async () => {
        if (application.exitCode !== null || application.signalCode !== null) {
          throw new Error(`${role} Electron instance exited before opening its UI.`);
        }
        try {
          const value = await readFile(path.join(profilePath, 'DevToolsActivePort'), 'utf8');
          const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
          if (Number.isInteger(port) && port > 0) return port;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const match = stderr.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
        return match === null ? undefined : Number.parseInt(match[1], 10);
      },
      20_000,
      `${role} Electron debugging endpoint`,
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
      `${role} editor target`,
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
        throw new Error(`${role} renderer evaluation failed: ${detail}`);
      }
      return response.result?.value;
    };
    const waitForRenderer = (expression, label, timeoutMs = 15_000) =>
      waitFor(async () => ((await evaluate(expression)) ? true : undefined), timeoutMs, label);

    await waitForRenderer(
      `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
      `${role} editor shell`,
      20_000,
    );
    await evaluate(`document.fonts.ready.then(() => true)`);

    return {
      application,
      cdp,
      evaluate,
      waitForRenderer,
      role,
      stderr: () => stderr,
      async close() {
        cdp?.close();
        await terminateTree(application);
      },
    };
  } catch (error) {
    cdp?.close();
    await terminateTree(application);
    throw new Error(
      `${role} instance could not be driven.${stderr === '' ? '' : ' Electron emitted diagnostics.'}`,
      { cause: error },
    );
  }
};

const clickButton = async (editor, text, label = text) => {
  const clicked = await editor.evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)},
    );
    if (!(element instanceof HTMLButtonElement)) return false;
    if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
    element.focus();
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${editor.role} ${label} button was not found.`);
};

const clickButtonWithMouse = async (editor, text, label = text) => {
  await editor.cdp.send('Page.bringToFront');
  const point = await editor.evaluate(`(() => {
    const element = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)},
    );
    if (!(element instanceof HTMLButtonElement)) return null;
    if (element.disabled) throw new Error(${JSON.stringify(`${label} is disabled.`)});
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rectangle = element.getBoundingClientRect();
    return { x: rectangle.left + rectangle.width / 2, y: rectangle.top + rectangle.height / 2 };
  })()`);
  if (
    point === null ||
    typeof point?.x !== 'number' ||
    !Number.isFinite(point.x) ||
    typeof point?.y !== 'number' ||
    !Number.isFinite(point.y)
  ) {
    throw new Error(`${editor.role} ${label} button was not available for mouse input.`);
  }
  await editor.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await editor.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
};

const setLabeledInput = async (editor, label, value) => {
  const updated = await editor.evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="share-title"]');
    const field = [...(dialog?.querySelectorAll('label') ?? [])].find(
      (candidate) => candidate.querySelector(':scope > span')?.textContent?.trim() === ${JSON.stringify(label)},
    );
    const input = field?.querySelector('input');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!updated) throw new Error(`${editor.role} ${label} input was not found.`);
};

const openShareDialog = async (editor, physicalMouse = false) => {
  if (physicalMouse) await clickButtonWithMouse(editor, 'Share');
  else await clickButton(editor, 'Share');
  await editor.waitForRenderer(
    `document.querySelector('[aria-labelledby="share-title"]') !== null`,
    `${editor.role} Share dialog`,
  );
};

const closeShareDialog = async (editor) => {
  const closed = await editor.evaluate(`(() => {
    const button = document.querySelector('[aria-labelledby="share-title"] button[aria-label="Close"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.focus();
    button.click();
    return true;
  })()`);
  if (!closed) throw new Error(`${editor.role} Share dialog close button was not found.`);
  await editor.waitForRenderer(
    `document.querySelector('[aria-labelledby="share-title"]') === null`,
    `${editor.role} Share dialog close`,
  );
};

const selectFirstText = async (editor) => {
  const elementId = await editor.evaluate(`(() => {
    const element = [...document.querySelectorAll('.canonical-hitbox')].find(
      (candidate) => candidate.getAttribute('aria-label')?.includes(', text'),
    );
    if (!(element instanceof HTMLElement)) return '';
    element.focus();
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return element.dataset.canvasElementId ?? '';
  })()`);
  if (typeof elementId !== 'string' || elementId === '') {
    throw new Error(`${editor.role} could not select the first text element.`);
  }
  await editor.waitForRenderer(
    `document.querySelector('.text-editor-section') !== null`,
    `${editor.role} text inspector`,
  );
  return elementId;
};

const textLeaseView = (editor) =>
  editor.evaluate(`(() => {
    const status = document.querySelector('.text-editor-section .section-status');
    const fieldset = document.querySelector('.text-editor-controls');
    const gate = document.querySelector('.text-lease-gate');
    return {
      status: status?.textContent?.trim() ?? '',
      controlsDisabled: fieldset instanceof HTMLFieldSetElement ? fieldset.disabled : null,
      gateText: gate?.textContent?.trim() ?? '',
      gateBusy: gate?.getAttribute('aria-busy') === 'true',
    };
  })()`);

const focusTextEditor = async (editor) => {
  await editor.cdp.send('Page.bringToFront');
  const focused = await editor.evaluate(`(() => {
    const editor = document.querySelector('.text-content-editor');
    if (!(editor instanceof HTMLTextAreaElement) || editor.disabled) return false;
    editor.focus();
    return document.activeElement === editor;
  })()`);
  if (!focused) throw new Error(`${editor.role} text editor could not receive focus.`);
};

const reserveSelectedText = async (editor, expectedState) => {
  await editor.waitForRenderer(
    `document.querySelector('.text-lease-gate') instanceof HTMLButtonElement`,
    `${editor.role} text reservation gate`,
  );
  const clicked = await editor.evaluate(`(() => {
    const gate = document.querySelector('.text-lease-gate');
    if (!(gate instanceof HTMLButtonElement) || gate.disabled) return false;
    gate.focus();
    gate.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${editor.role} text reservation gate could not be activated.`);
  try {
    await editor.waitForRenderer(
      expectedState === 'owned'
        ? `document.querySelector('.text-editor-section .section-status')?.textContent?.includes('Reserved for you') === true && document.querySelector('.text-editor-controls')?.disabled === false`
        : `document.querySelector('.text-editor-section .section-status')?.textContent?.includes('Editing by participant') === true && document.querySelector('.text-editor-controls')?.disabled === true`,
      `${editor.role} ${expectedState} reservation state`,
    );
  } catch (error) {
    const diagnostic = await editor.evaluate(`(() => ({
      status: document.querySelector('.text-editor-section .section-status')?.textContent?.trim() ?? '',
      controlsDisabled: document.querySelector('.text-editor-controls')?.disabled ?? null,
      gate: document.querySelector('.text-lease-gate')?.textContent?.trim() ?? '',
      toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.textContent?.trim() ?? ''),
    }))()`);
    throw new Error(
      `${editor.role} did not reach the ${expectedState} reservation state: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
  return textLeaseView(editor);
};

const retryUntilOwned = async (editor) => {
  await waitFor(
    async () => {
      const view = await textLeaseView(editor);
      if (view.status.includes('Reserved for you') && view.controlsDisabled === false) return true;
      if (!view.gateBusy) {
        await editor.evaluate(`(() => {
          const gate = document.querySelector('.text-lease-gate');
          if (!(gate instanceof HTMLButtonElement) || gate.disabled) return false;
          gate.focus();
          gate.click();
          return true;
        })()`);
      }
      return undefined;
    },
    15_000,
    `${editor.role} reservation transfer`,
  );
  return textLeaseView(editor);
};

const captureScreenshot = async (editor) => {
  const screenshot = await editor.cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof screenshot.data !== 'string' || screenshot.data.length < 1_000) {
    throw new Error(`${editor.role} returned an invalid screenshot.`);
  }
  return Buffer.from(screenshot.data, 'base64');
};

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'htmllelujah-text-lock-system-'));
const hostProfile = path.join(temporaryRoot, 'Profil hôte');
const guestProfile = path.join(temporaryRoot, 'Profil invité');
const deckPath = path.join(temporaryRoot, 'Réservation texte – système.hdeck');
const startedAt = Date.now();
const editors = [];

try {
  await Promise.all([
    mkdir(hostProfile, { recursive: true }),
    mkdir(guestProfile, { recursive: true }),
  ]);
  const baseDocument = createNeutralDemoDeck();
  const document = { ...baseDocument, name: 'Text lock UI system smoke' };
  await writeFile(deckPath, createHdeckArchive({ document }));

  const host = await launchEditor({ deckPath, profilePath: hostProfile, role: 'host' });
  editors.push(host);
  await openShareDialog(host, true);
  await setLabeledInput(host, 'Your name', 'Host smoke');
  const discoveryDisabled = await host.evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="share-title"]');
    const toggle = dialog?.querySelector('.toggle-row input[type="checkbox"]');
    return toggle instanceof HTMLInputElement && toggle.checked === false;
  })()`);
  if (!discoveryDisabled) throw new Error('LAN discovery was not opt-in and disabled by default.');
  await clickButton(host, 'Start LAN session');
  await host.waitForRenderer(
    `document.querySelector('.collaboration-status strong')?.textContent?.trim() === 'Hosting' && document.querySelectorAll('.session-secret code').length === 3`,
    'host LAN session startup',
    20_000,
  );
  const invitation = await host.evaluate(`(() => {
    const values = [...document.querySelectorAll('.session-secret code')].map(
      (element) => element.textContent?.trim() ?? '',
    );
    return { endpoint: values[0] ?? '', sessionCode: values[1] ?? '', fingerprint: values[2] ?? '' };
  })()`);
  if (
    typeof invitation?.endpoint !== 'string' ||
    !invitation.endpoint.startsWith('wss://') ||
    typeof invitation.sessionCode !== 'string' ||
    invitation.sessionCode.length < 20 ||
    typeof invitation.fingerprint !== 'string' ||
    invitation.fingerprint.length < 20
  ) {
    throw new Error('The host UI did not expose a complete manual LAN invitation.');
  }
  await closeShareDialog(host);
  const hostElementId = await selectFirstText(host);
  const hostOwned = await reserveSelectedText(host, 'owned');
  const hostOwnedScreenshot = await captureScreenshot(host);

  const guest = await launchEditor({ deckPath, profilePath: guestProfile, role: 'guest' });
  editors.push(guest);
  await openShareDialog(guest, true);
  await setLabeledInput(guest, 'Your name', 'Guest smoke');
  await setLabeledInput(guest, 'Host address', invitation.endpoint);
  await setLabeledInput(guest, 'Session code', invitation.sessionCode);
  await setLabeledInput(guest, 'Fingerprint', invitation.fingerprint);
  await clickButton(guest, 'Join session');
  await guest.waitForRenderer(
    `document.querySelector('.collaboration-status strong')?.textContent?.trim() === 'Joined'`,
    'guest LAN session join',
    20_000,
  );
  await closeShareDialog(guest);
  const guestElementId = await selectFirstText(guest);
  if (guestElementId !== hostElementId) {
    throw new Error('The two product instances did not select the same text element.');
  }
  const guestBlocked = await reserveSelectedText(guest, 'held');
  const guestBlockedScreenshot = await captureScreenshot(guest);
  if (!guestBlocked.status.startsWith('Editing by participant ')) {
    throw new Error('The guest did not receive the peer-owner reservation message.');
  }

  await focusTextEditor(host);
  await openShareDialog(host, true);
  try {
    await host.waitForRenderer(
      `document.querySelector('.text-editor-section .section-status')?.textContent?.includes('Reserve this text to edit') === true`,
      'host reservation release on inspector blur',
    );
  } catch (error) {
    const diagnostic = await host.evaluate(`(() => ({
      activeElement: document.activeElement?.tagName ?? '',
      activeText: document.activeElement?.textContent?.trim().slice(0, 80) ?? '',
      status: document.querySelector('.text-editor-section .section-status')?.textContent?.trim() ?? '',
      controlsDisabled: document.querySelector('.text-editor-controls')?.disabled ?? null,
      shareOpen: document.querySelector('[aria-labelledby="share-title"]') !== null,
    }))()`);
    throw new Error(
      `Host reservation did not release after a product UI blur: ${JSON.stringify(diagnostic)}`,
      {
        cause: error,
      },
    );
  }
  const guestOwned = await retryUntilOwned(guest);
  const guestOwnedScreenshot = await captureScreenshot(guest);

  await focusTextEditor(guest);
  await openShareDialog(guest, true);
  await clickButton(guest, 'End LAN session on this device');
  await guest.waitForRenderer(
    `document.querySelector('.collaboration-status strong')?.textContent?.trim() === 'Offline'`,
    'guest LAN session leave',
    20_000,
  );
  await clickButton(host, 'End LAN session on this device');
  await host.waitForRenderer(
    `document.querySelector('.collaboration-status strong')?.textContent?.trim() === 'Offline'`,
    'host LAN session shutdown',
    20_000,
  );

  const report = {
    passed: true,
    testedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    launchMode:
      process.env.HTMLLELUJAH_EXECUTABLE === undefined ? 'source-build' : 'packaged-executable',
    checks: {
      syntheticDeckOpenedByTwoIsolatedProfiles: true,
      manualLanSessionWithoutDiscovery: discoveryDisabled,
      invitationReadFromProductUi: true,
      sameTextElementSelectedInBothInstances: guestElementId === hostElementId,
      hostReservationVisible: hostOwned.status.includes('Reserved for you'),
      guestSawParticipantOwnerMessage: guestBlocked.status.startsWith('Editing by participant '),
      guestTextFieldsetDisabledWhileHeld: guestBlocked.controlsDisabled === true,
      reservationTransferredAfterHostBlur: guestOwned.status.includes('Reserved for you'),
      guestTextFieldsetEnabledAfterTransfer: guestOwned.controlsDisabled === false,
      bothSessionsEndedThroughProductUi: true,
      screenshotsCapturedAfterSecretDialogClosed: 3,
      rendererProductBridgeCalledDirectlyByTest: false,
    },
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await Promise.all([
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(screenshotPaths.hostOwned, hostOwnedScreenshot),
    writeFile(screenshotPaths.guestBlocked, guestBlockedScreenshot),
    writeFile(screenshotPaths.guestOwned, guestOwnedScreenshot),
  ]);
  process.stdout.write(
    'Text-lock UI system smoke passed: peer blocking and reservation transfer verified.\n' +
      'Evidence: artifacts/evidence/text-lock-ui-system-v1.json and three redacted-state screenshots.\n',
  );
} finally {
  for (const editor of editors.reverse()) {
    await editor.close().catch(() => undefined);
  }
  await waitFor(
    async () => {
      try {
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        return true;
      } catch (error) {
        if (error?.code === 'EBUSY' || error?.code === 'EPERM') return false;
        throw error;
      }
    },
    15_000,
    'text-lock UI system smoke cleanup',
  );
}
