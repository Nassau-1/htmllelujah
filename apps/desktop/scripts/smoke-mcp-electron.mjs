import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpResponseRouter } from './mcp-json-line-router.mjs';
import {
  assertDocumentUnchanged,
  assertExactToolCatalog,
  assertProtocolStdout,
  assertRevisionAdvanced,
  assertSafeDiagnostic,
  assertSafeProjection,
  assertToolError,
  comparableDocumentState,
  createCaseRecorder,
  createMcpEvidence,
  createMcpFailureEvidence,
  decodeToolResponse,
} from './mcp-smoke-support.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const defaultEvidencePath = path.join(repositoryRoot, 'artifacts', 'evidence', 'mcp-v1.json');
const evidencePath = path.resolve(process.env.HTMLLELUJAH_MCP_EVIDENCE ?? defaultEvidencePath);
const packagedExecutable = process.env.HTMLLELUJAH_EXECUTABLE;
const packagedLauncher = process.env.HTMLLELUJAH_MCP_LAUNCHER;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const waitFor = async (operation, timeoutMs, label, intervalMs = 50) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
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

const terminate = async (child, label) => {
  if (hasExited(child) || child.pid === undefined) return;
  try {
    child.kill();
  } catch {
    // Continue to the bounded handle-based forceful attempt.
  }
  if (await waitForExit(child, 2_000)) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The verified exit check below remains authoritative.
  }
  if (await waitForExit(child, 3_000)) return;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  throw new Error(`${label} did not exit within the termination deadline.`);
};

const sha256 = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });

const fileIdentity = async (filePath) => {
  const linkMetadata = await lstat(filePath);
  const before = await stat(filePath);
  if (linkMetadata.isSymbolicLink() || !before.isFile() || before.size === 0) {
    throw new Error('MCP target is not a stable regular file.');
  }
  const digest = await sha256(filePath);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('MCP target changed while it was being identified.');
  }
  return { size: after.size, sha256: digest };
};

const writeJsonAtomic = async (target, value) => {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

class CdpSession {
  #nextId = 1;
  #pending = new Map();
  #socket;

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out.')), 5_000);
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
          reject(new Error('CDP connection failed.'));
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
        pending.reject(new Error(`CDP ${pending.method} failed.`));
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

const waitForDebuggingPort = (application, userData, getError, getSpawnError) =>
  waitFor(
    async () => {
      if (getSpawnError() !== undefined) throw getSpawnError();
      if (hasExited(application)) throw new Error('Desktop exited before CDP was ready.');
      try {
        const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8');
        const port = Number.parseInt(value.split(/\r?\n/u)[0] ?? '', 10);
        if (Number.isInteger(port) && port > 0) return port;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const match = getError().match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//u);
      return match === null ? undefined : Number.parseInt(match[1], 10);
    },
    20_000,
    'Desktop remote debugging endpoint',
  );

const waitForRendererTarget = (debuggingPort) =>
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
    'Desktop renderer target',
  );

const evaluateCdp = async (session, expression) => {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error('Renderer evaluation failed.');
  }
  return response.result?.value;
};

const createLaunchConfiguration = async () => {
  if ((packagedExecutable === undefined) !== (packagedLauncher === undefined)) {
    throw new Error('Packaged MCP smoke requires both executable and launcher.');
  }
  if (packagedExecutable !== undefined && packagedLauncher !== undefined) {
    const executable = path.resolve(packagedExecutable);
    const launcher = path.resolve(packagedLauncher);
    await Promise.all([access(executable), access(launcher)]);
    if (path.dirname(executable).toLowerCase() !== path.dirname(launcher).toLowerCase()) {
      throw new Error('Packaged executable and MCP launcher must be companions.');
    }
    if (path.basename(executable).toLowerCase() !== 'htmllelujah.exe') {
      throw new Error('Packaged executable name is invalid.');
    }
    if (path.basename(launcher).toLowerCase() !== 'htmllelujah-mcp.cmd') {
      throw new Error('Packaged MCP launcher name is invalid.');
    }
    const artifact = {
      executable: await fileIdentity(executable),
      launcher: await fileIdentity(launcher),
    };
    return {
      mode: 'packaged-launcher',
      applicationCommand: executable,
      applicationArguments: [],
      mcpCommand: process.env.ComSpec ?? 'cmd.exe',
      mcpArguments: ['/d', '/q', '/c', `call "${launcher}"`],
      mcpVerbatim: process.platform === 'win32',
      artifact,
      async verifyArtifact() {
        const finalArtifact = {
          executable: await fileIdentity(executable),
          launcher: await fileIdentity(launcher),
        };
        if (JSON.stringify(finalArtifact) !== JSON.stringify(artifact)) {
          throw new Error('Packaged MCP companions changed during the smoke.');
        }
      },
    };
  }
  const electronPath = (await import('electron')).default;
  await access(path.join(desktopRoot, 'dist-electron', 'mcp-cli.js'));
  return {
    mode: 'source-build',
    applicationCommand: electronPath,
    applicationArguments: ['.'],
    mcpCommand: electronPath,
    mcpArguments: [path.join(desktopRoot, 'dist-electron', 'mcp-cli.js')],
    mcpVerbatim: false,
    artifact: { sourceBuild: true },
    verifyArtifact: async () => undefined,
  };
};

const createMcpClient = ({ configuration, userData, label, metrics, forbiddenDiagnostics }) => {
  const child = spawn(configuration.mcpCommand, configuration.mcpArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    windowsVerbatimArguments: configuration.mcpVerbatim,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HTMLLELUJAH_USER_DATA_DIR: userData,
    },
  });
  metrics.processCount += 1;
  const router = createMcpResponseRouter({ maxBufferedBytes: 2 * 1024 * 1024 });
  const stdoutChunks = [];
  let stdoutBytes = 0;
  let stderr = '';
  let nextId = 1;
  let exitExpected = false;

  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes <= 8 * 1024 * 1024) stdoutChunks.push(Buffer.from(chunk));
    else router.fail(new Error('MCP stdout exceeded the smoke capture limit.'));
    router.push(chunk);
  });
  child.stdout.once('end', () => router.finish());
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-32_768);
  });
  child.stdin.on('error', (error) => router.fail(new Error('MCP stdin failed.', { cause: error })));
  child.once('error', (error) =>
    router.fail(new Error('MCP process failed to spawn or communicate.', { cause: error })),
  );
  child.once('exit', (code, signal) => {
    if (!exitExpected) {
      router.fail(
        new Error(`${label} exited unexpectedly (${String(code ?? signal ?? 'unknown')}).`),
      );
    }
  });

  const writeLine = (line, timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined || error === null) resolve();
        else reject(router.fail(error));
      };
      const timer = setTimeout(() => finish(new Error('MCP stdin write timed out.')), timeoutMs);
      try {
        child.stdin.write(line, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('MCP stdin write failed.'));
      }
    });

  const send = async (method, params, timeoutMs = 15_000) => {
    if (router.failure !== undefined) throw router.failure;
    const id = nextId++;
    await writeLine(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return router.waitForResponse(id, timeoutMs);
  };

  const notify = (method, params) =>
    writeLine(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  return {
    child,
    async initialize() {
      const initialized = await send('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'htmllelujah-v1-packaged-smoke', version: '1.0.0' },
      });
      if (
        initialized?.result?.serverInfo?.name !== 'htmllelujah' ||
        initialized?.result?.serverInfo?.version !== '1.0.0'
      ) {
        throw new Error('MCP initialize returned an unexpected server identity.');
      }
      await notify('notifications/initialized');
      const catalog = await send('tools/list');
      return assertExactToolCatalog(catalog?.result?.tools);
    },
    send,
    async callTool(name, args = {}) {
      return decodeToolResponse(await send('tools/call', { name, arguments: args }));
    },
    async close() {
      if (hasExited(child)) throw new Error(`${label} exited before graceful shutdown.`);
      exitExpected = true;
      child.stdin.end();
      await waitFor(
        () =>
          hasExited(child) && child.stdout.readableEnded && child.stderr.readableEnded
            ? true
            : undefined,
        10_000,
        `${label} stdio shutdown`,
      );
      router.finish();
      if (router.failure !== undefined) throw router.failure;
      if (child.exitCode !== 0) throw new Error(`${label} exited with a non-zero status.`);
      const frameCount = assertProtocolStdout(Buffer.concat(stdoutChunks));
      assertSafeDiagnostic(stderr, forbiddenDiagnostics);
      metrics.protocolFrameCount += frameCount;
      return { frameCount, stderrBytes: Buffer.byteLength(stderr, 'utf8') };
    },
    async dispose() {
      await terminate(child, label);
    },
  };
};

const requireToolValue = (outcome, label) => {
  if (outcome?.ok !== true) throw new Error(`${label} returned an MCP error.`);
  return outcome.value;
};

const readRendererSession = async (cdp) => {
  const result = await evaluateCdp(
    cdp,
    `(async () => {
      const initialized = await window.htmllelujah.initialize();
      if (!initialized.ok) return { ok: false, code: initialized.error.code };
      const snapshot = initialized.value.session.snapshot;
      return {
        ok: true,
        sessionId: snapshot.sessionId,
        documentId: snapshot.documentId,
        revision: snapshot.revision,
        name: snapshot.document.name,
        page: snapshot.document.page,
      };
    })()`,
  );
  if (
    !isRecord(result) ||
    result.ok !== true ||
    typeof result.sessionId !== 'string' ||
    typeof result.documentId !== 'string' ||
    typeof result.revision !== 'string' ||
    typeof result.name !== 'string' ||
    !isRecord(result.page)
  ) {
    throw new Error('Renderer did not expose a valid current session projection.');
  }
  return result;
};

const issueApproval = async (cdp, action) => {
  const result = await evaluateCdp(
    cdp,
    `(async () => {
      const initialized = await window.htmllelujah.initialize();
      if (!initialized.ok) return { ok: false, code: initialized.error.code };
      const approval = await window.htmllelujah.mcpCreateApproval({
        sessionId: initialized.value.session.snapshot.sessionId,
        action: ${JSON.stringify(action)},
      });
      if (!approval.ok) return { ok: false, code: approval.error.code };
      return { ok: true, value: approval.value };
    })()`,
  );
  if (!isRecord(result) || typeof result.ok !== 'boolean') {
    throw new Error('Desktop approval response was invalid.');
  }
  if (!result.ok) {
    return { ok: false, code: typeof result.code === 'string' ? result.code : 'UNKNOWN' };
  }
  const value = result.value;
  if (
    !isRecord(value) ||
    typeof value.approvalId !== 'string' ||
    value.approvalId.length < 16 ||
    value.action !== action ||
    typeof value.expiresAt !== 'string' ||
    Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new Error('Desktop approval capability was invalid.');
  }
  return { ok: true, value };
};

const requireApproval = async (cdp, action) => {
  const outcome = await issueApproval(cdp, action);
  if (!outcome.ok) throw new Error(`Desktop refused the ${action} smoke approval.`);
  return outcome.value;
};

const readMcpStatus = async (cdp) => {
  const result = await evaluateCdp(
    cdp,
    `(async () => {
      const status = await window.htmllelujah.mcpStatus();
      return status.ok ? { ok: true, value: status.value } : { ok: false, code: status.error.code };
    })()`,
  );
  if (
    !isRecord(result) ||
    result.ok !== true ||
    !isRecord(result.value) ||
    typeof result.value.pendingApprovals !== 'number'
  ) {
    throw new Error('Desktop MCP status was invalid.');
  }
  return result.value;
};

const executeHumanRename = async (cdp, expectedRevision, name) => {
  const result = await evaluateCdp(
    cdp,
    `(async () => {
      const initialized = await window.htmllelujah.initialize();
      if (!initialized.ok) return { ok: false, code: initialized.error.code };
      const executed = await window.htmllelujah.execute({
        sessionId: initialized.value.session.snapshot.sessionId,
        expectedRevision: ${JSON.stringify(expectedRevision)},
        label: 'Human parity smoke edit',
        commands: [{ type: 'deck.rename', name: ${JSON.stringify(name)} }],
      });
      if (!executed.ok) return { ok: false, code: executed.error.code };
      return {
        ok: true,
        revision: executed.value.snapshot.revision,
        name: executed.value.snapshot.document.name,
      };
    })()`,
  );
  if (
    !isRecord(result) ||
    result.ok !== true ||
    typeof result.revision !== 'string' ||
    result.name !== name
  ) {
    throw new Error('Human parity edit failed in the packaged renderer session.');
  }
  assertRevisionAdvanced(expectedRevision, result.revision);
  return result;
};

const writeBytesAtomic = async (target, bytes) => {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const runRejectedLauncherProbe = async ({
  configuration,
  userData,
  label,
  metrics,
  forbiddenDiagnostics,
}) => {
  const child = spawn(configuration.mcpCommand, configuration.mcpArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    windowsVerbatimArguments: configuration.mcpVerbatim,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HTMLLELUJAH_USER_DATA_DIR: userData,
    },
  });
  metrics.processCount += 1;
  const stdout = [];
  let stdoutBytes = 0;
  let stderr = '';
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes <= 1_048_576) stdout.push(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-32_768);
  });
  try {
    await waitFor(
      () => {
        if (spawnError !== undefined) throw spawnError;
        return hasExited(child) && child.stdout.readableEnded && child.stderr.readableEnded
          ? true
          : undefined;
      },
      12_000,
      `${label} rejection`,
    );
    if (child.exitCode === 0) throw new Error(`${label} unexpectedly authenticated.`);
    if (stdoutBytes !== 0 || Buffer.concat(stdout).byteLength !== 0) {
      throw new Error(`${label} wrote non-protocol data to stdout.`);
    }
    if (stderr.length === 0) throw new Error(`${label} returned no safe diagnostic.`);
    assertSafeDiagnostic(stderr, forbiddenDiagnostics);
    return true;
  } finally {
    await terminate(child, label);
  }
};

const runAuthenticationProbes = async ({ configuration, descriptorPath, userData, metrics }) => {
  const originalBytes = await readFile(descriptorPath);
  if (originalBytes.byteLength === 0 || originalBytes.byteLength > 16 * 1024) {
    throw new Error('Desktop MCP descriptor size was invalid.');
  }
  let descriptor;
  try {
    descriptor = JSON.parse(originalBytes.toString('utf8'));
  } catch {
    throw new Error('Desktop MCP descriptor was not valid JSON.');
  }
  if (
    !isRecord(descriptor) ||
    typeof descriptor.secret !== 'string' ||
    typeof descriptor.pipeName !== 'string' ||
    typeof descriptor.instanceId !== 'string'
  ) {
    throw new Error('Desktop MCP descriptor fields were invalid.');
  }
  const forbidden = [
    descriptor.secret,
    descriptor.pipeName,
    descriptor.instanceId,
    descriptorPath,
    userData,
  ];
  const wrongUserData = await mkdtemp(path.join(tmpdir(), 'htmllelujah-mcp-wrong-profile-'));
  try {
    await runRejectedLauncherProbe({
      configuration,
      userData: wrongUserData,
      label: 'Missing current-profile descriptor probe',
      metrics,
      forbiddenDiagnostics: forbidden,
    });
  } finally {
    await rm(wrongUserData, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  }

  const runTampered = async (replacement, label) => {
    try {
      await writeJsonAtomic(descriptorPath, replacement);
      await runRejectedLauncherProbe({
        configuration,
        userData,
        label,
        metrics,
        forbiddenDiagnostics: forbidden,
      });
    } finally {
      await writeBytesAtomic(descriptorPath, originalBytes);
    }
    const restored = await readFile(descriptorPath);
    if (!restored.equals(originalBytes)) throw new Error('MCP descriptor restoration failed.');
  };

  const replacementSecret = `${descriptor.secret.startsWith('0') ? '1' : '0'}${descriptor.secret.slice(1)}`;
  await runTampered(
    { ...descriptor, secret: replacementSecret },
    'Wrong authenticated descriptor probe',
  );
  await runTampered(
    { ...descriptor, expiresAt: '1970-01-01T00:00:00.000Z' },
    'Expired authenticated descriptor probe',
  );
  return forbidden;
};

const runDocumentScenario = async ({ client, cdp, setStage }) => {
  setStage('MCP-001');
  await client.initialize();
  const applicationStatus = requireToolValue(await client.callTool('app_status'), 'app_status');
  if (
    !isRecord(applicationStatus) ||
    applicationStatus.running !== true ||
    applicationStatus.transport !== 'authenticated-local-rpc' ||
    typeof applicationStatus.version !== 'string'
  ) {
    throw new Error('MCP application status was invalid.');
  }
  assertSafeProjection(applicationStatus, 'MCP application status');

  setStage('MCP-004');
  const documents = await waitFor(
    async () => {
      const value = requireToolValue(await client.callTool('documents_list'), 'documents_list');
      return Array.isArray(value) && value.length > 0 ? value : undefined;
    },
    10_000,
    'Visible MCP document',
  );
  assertSafeProjection(documents, 'MCP document list');
  const document = documents[0];
  if (
    !isRecord(document) ||
    typeof document.documentId !== 'string' ||
    typeof document.revision !== 'string'
  ) {
    throw new Error('MCP document list entry was invalid.');
  }
  const documentId = document.documentId;
  const initialRevision = document.revision;

  const readOutline = async () => {
    const outline = requireToolValue(
      await client.callTool('documents_get_outline', { documentId }),
      'documents_get_outline',
    );
    assertSafeProjection(outline, 'MCP document outline');
    if (
      !isRecord(outline) ||
      outline.documentId !== documentId ||
      typeof outline.revision !== 'string' ||
      typeof outline.name !== 'string' ||
      !isRecord(outline.page) ||
      !Array.isArray(outline.slides) ||
      outline.slides.length === 0
    ) {
      throw new Error('MCP document outline was invalid.');
    }
    return outline;
  };

  const initialOutline = await readOutline();
  if (initialOutline.revision !== initialRevision) {
    throw new Error('MCP list and outline revisions diverged.');
  }
  const styles = requireToolValue(
    await client.callTool('documents_get_styles', { documentId }),
    'documents_get_styles',
  );
  const validation = requireToolValue(
    await client.callTool('documents_validate', { documentId }),
    'documents_validate',
  );
  const slideId = initialOutline.slides[0]?.slideId;
  if (typeof slideId !== 'string') throw new Error('MCP outline omitted the first slide ID.');
  const slide = requireToolValue(
    await client.callTool('slides_get', { documentId, slideId }),
    'slides_get',
  );
  const collaboration = requireToolValue(
    await client.callTool('collaboration_status', { documentId }),
    'collaboration_status',
  );
  for (const [label, projection] of [
    ['MCP style catalog', styles],
    ['MCP validation', validation],
    ['MCP slide', slide],
    ['MCP collaboration status', collaboration],
  ]) {
    assertSafeProjection(projection, label);
  }
  if (
    !isRecord(validation) ||
    validation.valid !== true ||
    validation.revision !== initialRevision
  ) {
    throw new Error('MCP validation did not confirm the initial document.');
  }
  if (!isRecord(slide) || slide.revision !== initialRevision || !isRecord(slide.slide)) {
    throw new Error('MCP slide projection did not match the initial revision.');
  }
  if (!isRecord(collaboration) || collaboration.mode !== 'offline') {
    throw new Error('MCP smoke requires the isolated document to be offline.');
  }

  setStage('MCP-005');
  const renameProposal = requireToolValue(
    await client.callTool('documents_propose_commands', {
      documentId,
      expectedRevision: initialRevision,
      label: 'Packaged MCP non-mutating rename preview',
      commands: [{ type: 'deck.rename', name: 'MCP smoke verified' }],
    }),
    'documents_propose_commands',
  );
  if (
    !isRecord(renameProposal) ||
    typeof renameProposal.proposalId !== 'string' ||
    renameProposal.baseRevision !== initialRevision ||
    renameProposal.commandCount !== 1 ||
    renameProposal.requiresApproval !== false
  ) {
    throw new Error('MCP safe proposal metadata was invalid.');
  }
  assertDocumentUnchanged(initialOutline, await readOutline());
  const renamed = requireToolValue(
    await client.callTool('documents_commit_proposal', {
      proposalId: renameProposal.proposalId,
    }),
    'documents_commit_proposal',
  );
  if (!isRecord(renamed) || typeof renamed.revision !== 'string') {
    throw new Error('MCP safe commit acknowledgement was invalid.');
  }
  assertRevisionAdvanced(initialRevision, renamed.revision);
  const renamedOutline = await readOutline();
  if (
    renamedOutline.name !== 'MCP smoke verified' ||
    renamedOutline.revision !== renamed.revision
  ) {
    throw new Error('MCP safe commit did not converge with the document outline.');
  }

  const staleProposal = await client.callTool('documents_propose_commands', {
    documentId,
    expectedRevision: initialRevision,
    label: 'Rejected stale packaged MCP proposal',
    commands: [{ type: 'deck.rename', name: 'Stale rename must not apply' }],
  });
  assertToolError(staleProposal, 'REVISION_CONFLICT');
  assertDocumentUnchanged(renamedOutline, await readOutline());

  const invalidMiddle = await client.callTool('documents_propose_commands', {
    documentId,
    expectedRevision: renamed.revision,
    label: 'Rejected atomic mixed packaged MCP batch',
    commands: [
      { type: 'deck.rename', name: 'Atomic rejection must preserve the old name' },
      { type: 'slide.delete', slideId: '00000000-0000-4000-8000-000000000099' },
    ],
  });
  assertToolError(invalidMiddle, ['INVALID_REQUEST', 'NOT_FOUND']);
  assertDocumentUnchanged(renamedOutline, await readOutline());

  const originalPage = structuredClone(renamedOutline.page);
  const changedPage =
    originalPage.widthPt === originalPage.heightPt
      ? { widthPt: originalPage.widthPt + 1, heightPt: originalPage.heightPt }
      : { widthPt: originalPage.heightPt, heightPt: originalPage.widthPt };
  setStage('MCP-006');
  const destructiveProposal = requireToolValue(
    await client.callTool('documents_propose_commands', {
      documentId,
      expectedRevision: renamed.revision,
      label: 'Packaged MCP approved page change',
      commands: [{ type: 'deck.set-page', page: changedPage }],
    }),
    'documents_propose_commands',
  );
  if (
    !isRecord(destructiveProposal) ||
    typeof destructiveProposal.proposalId !== 'string' ||
    destructiveProposal.requiresApproval !== true
  ) {
    throw new Error('MCP destructive proposal was not classified for approval.');
  }

  assertToolError(
    await client.callTool('documents_commit_proposal', {
      proposalId: destructiveProposal.proposalId,
    }),
    'APPROVAL_REQUIRED',
  );
  assertDocumentUnchanged(renamedOutline, await readOutline());

  const mismatchedApproval = await requireApproval(cdp, 'export-html');
  assertToolError(
    await client.callTool('documents_commit_proposal', {
      proposalId: destructiveProposal.proposalId,
      approvalId: mismatchedApproval.approvalId,
    }),
    'APPROVAL_EXPIRED',
  );
  assertDocumentUnchanged(renamedOutline, await readOutline());

  const commitApproval = await requireApproval(cdp, 'commit-destructive');
  const changed = requireToolValue(
    await client.callTool('documents_commit_proposal', {
      proposalId: destructiveProposal.proposalId,
      approvalId: commitApproval.approvalId,
    }),
    'documents_commit_proposal',
  );
  if (
    !isRecord(changed) ||
    typeof changed.revision !== 'string' ||
    typeof changed.transactionId !== 'string'
  ) {
    throw new Error('MCP approved commit acknowledgement was invalid.');
  }
  assertRevisionAdvanced(renamed.revision, changed.revision);
  const changedOutline = await readOutline();
  if (
    changedOutline.revision !== changed.revision ||
    JSON.stringify(changedOutline.page) !== JSON.stringify(changedPage)
  ) {
    throw new Error('MCP approved page change did not converge.');
  }

  const reuseProposal = requireToolValue(
    await client.callTool('documents_propose_commands', {
      documentId,
      expectedRevision: changed.revision,
      label: 'Rejected reused packaged MCP approval',
      commands: [{ type: 'deck.set-page', page: originalPage }],
    }),
    'documents_propose_commands',
  );
  assertToolError(
    await client.callTool('documents_commit_proposal', {
      proposalId: reuseProposal.proposalId,
      approvalId: commitApproval.approvalId,
    }),
    'APPROVAL_EXPIRED',
  );
  assertDocumentUnchanged(changedOutline, await readOutline());

  setStage('MCP-008');
  const undoApproval = await requireApproval(cdp, 'undo');
  const undone = requireToolValue(
    await client.callTool('documents_undo_agent_transaction', {
      documentId,
      transactionId: changed.transactionId,
      expectedRevision: changed.revision,
      approvalId: undoApproval.approvalId,
    }),
    'documents_undo_agent_transaction',
  );
  if (!isRecord(undone) || typeof undone.revision !== 'string') {
    throw new Error('MCP undo acknowledgement was invalid.');
  }
  assertRevisionAdvanced(changed.revision, undone.revision);
  const undoneOutline = await readOutline();
  if (
    undoneOutline.revision !== undone.revision ||
    JSON.stringify(undoneOutline.page) !== JSON.stringify(originalPage) ||
    undoneOutline.name !== 'MCP smoke verified'
  ) {
    throw new Error('MCP undo did not restore the exact prior document state.');
  }
  assertToolError(
    await client.callTool('documents_undo_agent_transaction', {
      documentId,
      transactionId: changed.transactionId,
      expectedRevision: undone.revision,
      approvalId: undoApproval.approvalId,
    }),
    'APPROVAL_EXPIRED',
  );
  assertDocumentUnchanged(undoneOutline, await readOutline());

  const agentBeforeHumanProposal = requireToolValue(
    await client.callTool('documents_propose_commands', {
      documentId,
      expectedRevision: undone.revision,
      label: 'Agent transaction before human parity edit',
      commands: [{ type: 'deck.rename', name: 'Agent before human parity edit' }],
    }),
    'documents_propose_commands',
  );
  const agentBeforeHuman = requireToolValue(
    await client.callTool('documents_commit_proposal', {
      proposalId: agentBeforeHumanProposal.proposalId,
    }),
    'documents_commit_proposal',
  );
  if (
    !isRecord(agentBeforeHuman) ||
    typeof agentBeforeHuman.revision !== 'string' ||
    typeof agentBeforeHuman.transactionId !== 'string'
  ) {
    throw new Error('MCP pre-human transaction acknowledgement was invalid.');
  }
  const beforeHumanOutline = await readOutline();
  const commitAfterHumanProposal = requireToolValue(
    await client.callTool('documents_propose_commands', {
      documentId,
      expectedRevision: agentBeforeHuman.revision,
      label: 'Proposal made stale by a human edit',
      commands: [{ type: 'deck.rename', name: 'Stale post-human proposal' }],
    }),
    'documents_propose_commands',
  );
  const human = await executeHumanRename(
    cdp,
    agentBeforeHuman.revision,
    'Human and MCP convergence verified',
  );
  assertToolError(
    await client.callTool('documents_commit_proposal', {
      proposalId: commitAfterHumanProposal.proposalId,
    }),
    'REVISION_CONFLICT',
  );
  const afterHumanOutline = await readOutline();
  if (
    afterHumanOutline.revision !== human.revision ||
    afterHumanOutline.name !== 'Human and MCP convergence verified'
  ) {
    throw new Error('Human and MCP document sessions did not converge.');
  }
  if (comparableDocumentState(beforeHumanOutline) === comparableDocumentState(afterHumanOutline)) {
    throw new Error('Human parity edit did not change the canonical document.');
  }
  const rendererAfterHuman = await readRendererSession(cdp);
  if (
    rendererAfterHuman.documentId !== documentId ||
    rendererAfterHuman.revision !== afterHumanOutline.revision ||
    rendererAfterHuman.name !== afterHumanOutline.name
  ) {
    throw new Error('Renderer and MCP projections did not converge after the human edit.');
  }

  const staleUndoApproval = await requireApproval(cdp, 'undo');
  assertToolError(
    await client.callTool('documents_undo_agent_transaction', {
      documentId,
      transactionId: agentBeforeHuman.transactionId,
      expectedRevision: human.revision,
      approvalId: staleUndoApproval.approvalId,
    }),
    'REVISION_CONFLICT',
  );
  assertDocumentUnchanged(afterHumanOutline, await readOutline());

  setStage('MCP-007');
  const forbiddenTool = await client.callTool('shell_exec', { command: 'whoami' });
  assertToolError(forbiddenTool, 'JSON_RPC_ERROR');
  const rawHtmlCommand = await client.callTool('documents_propose_commands', {
    documentId,
    expectedRevision: human.revision,
    label: 'Rejected raw HTML capability',
    commands: [{ type: 'element.set-html', html: '<script>unsafe()</script>' }],
  });
  assertToolError(rawHtmlCommand, 'JSON_RPC_ERROR');
  assertDocumentUnchanged(afterHumanOutline, await readOutline());
  const resources = await client.send('resources/list');
  if (!(
    (Array.isArray(resources?.result?.resources) && resources.result.resources.length === 0) ||
    typeof resources?.error?.code === 'number'
  )) {
    throw new Error('MCP exposed an unexpected raw resource capability.');
  }

  const fakeApproval = 'approval-invalid-0000000000000000';
  assertToolError(
    await client.callTool('assets_request_import', {
      documentId,
      approvalId: fakeApproval,
    }),
    'APPROVAL_EXPIRED',
  );
  assertToolError(
    await client.callTool('documents_request_export', {
      documentId,
      expectedRevision: human.revision,
      format: 'html',
      includeHidden: false,
      approvalId: fakeApproval,
    }),
    'APPROVAL_EXPIRED',
  );
  assertDocumentUnchanged(afterHumanOutline, await readOutline());

  return {
    documentId,
    revision: human.revision,
    version: applicationStatus.version,
    pendingProposalCount: 2,
  };
};

const runProposalQuota = async ({
  configuration,
  userData,
  metrics,
  activeClients,
  documentId,
  revision,
  pendingProposalCount,
}) => {
  const maximum = 64;
  if (!Number.isInteger(pendingProposalCount) || pendingProposalCount < 0) {
    throw new Error('Tracked MCP proposal count was invalid.');
  }
  let remaining = maximum - pendingProposalCount;
  let accepted = 0;
  let clientIndex = 0;
  while (remaining > 0) {
    const count = Math.min(32, remaining);
    clientIndex += 1;
    const client = createMcpClient({
      configuration,
      userData,
      label: `MCP proposal quota client ${clientIndex}`,
      metrics,
      forbiddenDiagnostics: [],
    });
    activeClients.add(client);
    try {
      await client.initialize();
      for (let index = 0; index < count; index += 1) {
        const proposal = requireToolValue(
          await client.callTool('documents_propose_commands', {
            documentId,
            expectedRevision: revision,
            label: `Bounded packaged proposal ${accepted + 1}`,
            commands: [{ type: 'deck.rename', name: `Pending packaged proposal ${accepted + 1}` }],
          }),
          'documents_propose_commands quota admission',
        );
        if (!isRecord(proposal) || typeof proposal.proposalId !== 'string') {
          throw new Error('MCP quota proposal acknowledgement was invalid.');
        }
        accepted += 1;
      }
      remaining -= count;
      if (remaining === 0) {
        assertToolError(
          await client.callTool('documents_propose_commands', {
            documentId,
            expectedRevision: revision,
            label: 'Rejected sixty-fifth pending proposal',
            commands: [{ type: 'deck.rename', name: 'Proposal quota must reject this preview' }],
          }),
          'INVALID_REQUEST',
        );
      }
      await client.close();
      activeClients.delete(client);
    } finally {
      if (activeClients.delete(client)) await client.dispose();
    }
  }
  if (accepted + pendingProposalCount !== maximum) {
    throw new Error('MCP proposal quota was not reached exactly.');
  }
  return { maximum, newlyAccepted: accepted };
};

const runApprovalQuota = async (cdp) => {
  let status = await readMcpStatus(cdp);
  if (status.pendingApprovals < 0 || status.pendingApprovals > 32) {
    throw new Error('Desktop pending approval count was outside limits.');
  }
  const initial = status.pendingApprovals;
  while (status.pendingApprovals < 32) {
    const approval = await issueApproval(cdp, 'export-pdf');
    if (!approval.ok) throw new Error('Desktop approval quota rejected capacity too early.');
    status = await readMcpStatus(cdp);
  }
  const overflow = await issueApproval(cdp, 'export-pdf');
  if (overflow.ok || overflow.code !== 'INVALID_REQUEST') {
    throw new Error('Desktop approval quota did not reject the thirty-third capability.');
  }
  status = await readMcpStatus(cdp);
  if (status.pendingApprovals !== 32) {
    throw new Error('Desktop approval quota changed after overflow rejection.');
  }
  return { maximum: 32, newlyAccepted: 32 - initial };
};

let failureStage = 'startup';
let evidenceMode =
  packagedExecutable !== undefined || packagedLauncher !== undefined
    ? 'packaged-launcher'
    : 'source-build';

const runSmoke = async () => {
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await rm(evidencePath, { force: true });
  const configuration = await createLaunchConfiguration();
  evidenceMode = configuration.mode;
  const metrics = { processCount: 0, protocolFrameCount: 0 };
  const activeClients = new Set();
  const userData = await mkdtemp(path.join(tmpdir(), 'htmllelujah-mcp-v1-'));
  const descriptorPath = path.join(userData, 'mcp', 'endpoint-v1.json');
  let application;
  let applicationSpawnError;
  let applicationError = '';
  let cdp;

  try {
    application = spawn(
      configuration.applicationCommand,
      [
        ...configuration.applicationArguments,
        '--remote-debugging-port=0',
        `--user-data-dir=${userData}`,
      ],
      {
        cwd: desktopRoot,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    application.once('error', (error) => {
      applicationSpawnError = error;
    });
    application.stderr.on('data', (chunk) => {
      applicationError = (applicationError + chunk.toString('utf8')).slice(-65_536);
    });

    const debuggingPort = await waitForDebuggingPort(
      application,
      userData,
      () => applicationError,
      () => applicationSpawnError,
    );
    const target = await waitForRendererTarget(debuggingPort);
    cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitFor(
      async () =>
        (await evaluateCdp(
          cdp,
          `document.readyState === 'complete' && document.querySelector('.app-shell') !== null`,
        )) || undefined,
      20_000,
      'Desktop application shell',
    );
    await readRendererSession(cdp);
    await waitFor(
      async () => {
        await access(descriptorPath);
        return true;
      },
      15_000,
      'Desktop MCP descriptor',
    );

    const primary = createMcpClient({
      configuration,
      userData,
      label: 'Primary packaged MCP client',
      metrics,
      forbiddenDiagnostics: [],
    });
    activeClients.add(primary);
    let scenario;
    try {
      scenario = await runDocumentScenario({
        client: primary,
        cdp,
        setStage: (stage) => {
          failureStage = stage;
        },
      });
      await primary.close();
      activeClients.delete(primary);
    } finally {
      if (activeClients.delete(primary)) await primary.dispose();
    }

    failureStage = 'MCP-009';
    const proposalQuota = await runProposalQuota({
      configuration,
      userData,
      metrics,
      activeClients,
      documentId: scenario.documentId,
      revision: scenario.revision,
      pendingProposalCount: scenario.pendingProposalCount,
    });
    const approvalQuota = await runApprovalQuota(cdp);

    failureStage = 'MCP-003';
    const forbiddenDiagnostics = await runAuthenticationProbes({
      configuration,
      descriptorPath,
      userData,
      metrics,
    });

    failureStage = 'MCP-001';
    const restarted = createMcpClient({
      configuration,
      userData,
      label: 'Restarted packaged MCP client',
      metrics,
      forbiddenDiagnostics,
    });
    activeClients.add(restarted);
    try {
      await restarted.initialize();
      const restartedDocuments = requireToolValue(
        await restarted.callTool('documents_list'),
        'restarted documents_list',
      );
      if (!Array.isArray(restartedDocuments) || restartedDocuments.length !== 1) {
        throw new Error('Restarted MCP client did not see the current isolated document.');
      }
      assertSafeProjection(restartedDocuments, 'Restarted MCP document list');
      await restarted.close();
      activeClients.delete(restarted);
    } finally {
      if (activeClients.delete(restarted)) await restarted.dispose();
    }

    failureStage = 'MCP-002';
    await waitFor(
      async () => {
        const status = await readMcpStatus(cdp);
        return status.connected === false ? true : undefined;
      },
      10_000,
      'MCP connection cleanup',
    );
    if (metrics.protocolFrameCount < 100 || metrics.processCount < 7) {
      throw new Error(
        'MCP packaged smoke did not exercise the expected process and frame breadth.',
      );
    }

    await cdp.send('Browser.close').catch(() => undefined);
    await waitForExit(application, 15_000);
    if (!hasExited(application) || application.exitCode !== 0) {
      throw new Error('Desktop did not shut down cleanly after the MCP lifecycle smoke.');
    }
    await waitFor(
      async () => {
        try {
          await access(descriptorPath);
          return false;
        } catch (error) {
          if (error?.code === 'ENOENT') return true;
          throw error;
        }
      },
      10_000,
      'Owned MCP descriptor cleanup',
    );
    await configuration.verifyArtifact();

    const recorder = createCaseRecorder();
    recorder.pass('MCP-001', [
      'initialize, exact catalogue, graceful stdio shutdown and valid launcher restart succeeded',
      'desktop shutdown revoked and removed the owned local endpoint descriptor',
    ]);
    recorder.pass('MCP-002', [
      'every successful client emitted complete JSON-RPC response lines only',
      'rejected launchers emitted no stdout and diagnostics passed capability redaction',
    ]);
    recorder.pass('MCP-003', [
      'missing current-profile descriptor, wrong endpoint secret and expired descriptor were rejected',
      'the restored current descriptor authenticated a fresh launcher exactly once per connection',
    ]);
    recorder.pass('MCP-004', [
      'status, document list, outline, slide, styles, validation and collaboration projections were bounded',
      'all read projections agreed on the current canonical document revision',
    ]);
    recorder.pass('MCP-005', [
      'proposal preview did not mutate, one-batch commit converged and stale revisions failed atomically',
      'an invalid mixed batch preserved the complete prior document state',
    ]);
    recorder.pass('MCP-006', [
      'destructive commit required a document-scoped purpose-bound approval',
      'missing, mismatched, fake and reused approvals failed without mutation',
    ]);
    recorder.pass('MCP-007', [
      'tool catalogue matched the closed V1 allowlist with no shell or raw resource capability',
      'unknown tool, raw HTML command, unauthorised import and unauthorised export failed safely',
    ]);
    recorder.pass('MCP-008', [
      'approved agent transaction undid as one exact revision-advancing action',
      'approval reuse and undo after a later human edit failed while renderer and MCP stayed converged',
    ]);
    recorder.pass(
      'MCP-009',
      [
        `${proposalQuota.maximum} pending proposals were admitted and the next was rejected`,
        `${approvalQuota.maximum} pending approvals were admitted and the next was rejected`,
      ],
      'packaged-capacity-boundaries',
    );

    return createMcpEvidence({
      generatedAt: new Date().toISOString(),
      mode: configuration.mode,
      platform: process.platform,
      architecture: process.arch,
      version: scenario.version,
      artifact: configuration.artifact,
      cases: recorder.evidence(),
      protocolFrameCount: metrics.protocolFrameCount,
      processCount: metrics.processCount,
      limitations: [
        'Execution from a different Windows account requires the dedicated current-user system gate.',
        'Long wall-clock proposal and approval expiry is covered by deterministic clock tests; this packaged smoke verifies expired and invalid capabilities without a multi-minute wait.',
        'Successful native file chooser import and export are covered by their system smokes; this MCP smoke verifies safe refusal before any chooser opens.',
      ],
    });
  } finally {
    await Promise.allSettled([...activeClients].map((client) => client.dispose()));
    activeClients.clear();
    cdp?.close();
    if (application !== undefined) await terminate(application, 'Desktop process');
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
      15_000,
      'MCP smoke temporary state cleanup',
      100,
    );
  }
};

try {
  const evidence = await runSmoke();
  await writeJsonAtomic(evidencePath, evidence);
  process.stdout.write(
    `Packaged MCP V1 smoke passed: ${evidence.protocol.frameCount} protocol responses across ${evidence.protocol.processCount} MCP processes.\n`,
  );
} catch {
  const failure = createMcpFailureEvidence({
    generatedAt: new Date().toISOString(),
    mode: evidenceMode,
    platform: process.platform,
    architecture: process.arch,
    stage: failureStage,
  });
  try {
    await writeJsonAtomic(evidencePath, failure);
  } catch {
    // The non-zero exit remains authoritative if even redacted failure evidence cannot be written.
  }
  process.stderr.write(`Packaged MCP V1 smoke failed during ${failureStage}.\n`);
  process.exitCode = 1;
}
