import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

import { createMcpResponseRouter } from './mcp-json-line-router.mjs';

const desktopRoot = path.resolve(import.meta.dirname, '..');
const packagedExecutable = process.env.HTMLLELUJAH_EXECUTABLE;
const packagedLauncher = process.env.HTMLLELUJAH_MCP_LAUNCHER;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitFor = async (operation, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      if (error instanceof Error && error.code === 'MCP_STDIO_FAILURE') throw error;
      lastError = error;
    }
    await sleep(50);
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
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('error', finish);
      killer.once('exit', finish);
    });
    if (await waitForExit(child, 2_000)) return;
  }

  try {
    child.kill();
  } catch {
    // Continue to the forceful, bounded termination attempt.
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

const userData = await mkdtemp(path.join(tmpdir(), 'htmllelujah-electron-smoke-'));
const descriptorPath = path.join(userData, 'mcp', 'endpoint-v1.json');
const application = spawn(
  packagedExecutable === undefined ? electronPath : path.resolve(packagedExecutable),
  [...(packagedExecutable === undefined ? ['.'] : []), `--user-data-dir=${userData}`],
  {
    cwd: desktopRoot,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  },
);
let applicationError = '';
let mcpError = '';
let applicationSpawnError;
application.once('error', (error) => {
  applicationSpawnError = error;
});
application.stderr.on('data', (chunk) => {
  applicationError += chunk.toString('utf8');
});

let mcp;
let mcpRouter;
let mcpExitExpected = false;
try {
  await waitFor(
    async () => {
      if (applicationSpawnError !== undefined) throw applicationSpawnError;
      if (hasExited(application)) {
        throw new Error(`Desktop process exited before MCP startup (${application.exitCode}).`);
      }
      await access(descriptorPath);
      return true;
    },
    15_000,
    'Desktop MCP descriptor',
  );

  const mcpCommand =
    packagedLauncher === undefined ? electronPath : (process.env.ComSpec ?? 'cmd.exe');
  const mcpArguments =
    packagedLauncher === undefined
      ? [path.join(desktopRoot, 'dist-electron', 'mcp-cli.js')]
      : ['/d', '/q', '/c', `call "${path.resolve(packagedLauncher)}"`];
  mcp = spawn(mcpCommand, mcpArguments, {
    cwd: desktopRoot,
    windowsHide: true,
    windowsVerbatimArguments: packagedLauncher !== undefined && process.platform === 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HTMLLELUJAH_USER_DATA_DIR: userData,
    },
  });
  mcpRouter = createMcpResponseRouter();
  mcp.stderr.on('data', (chunk) => {
    mcpError += chunk.toString('utf8');
  });
  mcp.stdout.on('data', (chunk) => {
    mcpRouter.push(chunk);
  });
  mcp.stdout.once('end', () => {
    mcpRouter.finish();
  });
  mcp.stdin.on('error', (error) => {
    mcpRouter.fail(new Error('MCP stdin failed.', { cause: error }));
  });
  mcp.once('error', (error) => {
    mcpRouter.fail(new Error('MCP process failed to spawn or communicate.', { cause: error }));
  });
  mcp.once('exit', (code, signal) => {
    if (!mcpExitExpected) {
      mcpRouter.fail(
        new Error(`MCP process exited unexpectedly (${String(code ?? signal ?? 'unknown')}).`),
      );
    }
  });

  const writeMcpLine = (line, timeoutMs = 5_000) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined || error === null) resolve();
        else {
          const failure = mcpRouter.fail(error);
          reject(failure);
        }
      };
      const timer = setTimeout(() => finish(new Error('MCP stdin write timed out.')), timeoutMs);
      try {
        mcp.stdin.write(line, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('MCP stdin write failed.'));
      }
    });

  const send = async (message, timeoutMs = 10_000) => {
    if (mcpRouter.failure !== undefined) throw mcpRouter.failure;
    await writeMcpLine(`${JSON.stringify(message)}\n`);
    if (message.id === undefined) return undefined;
    return mcpRouter.waitForResponse(message.id, timeoutMs);
  };

  const initialize = await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'htmllelujah-electron-smoke', version: '1.0.0' },
    },
  });
  if (initialize?.result?.serverInfo?.name !== 'htmllelujah') {
    throw new Error('MCP initialize did not return the HTMLlelujah server.');
  }
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  if (!tools?.result?.tools?.some((tool) => tool.name === 'documents_propose_commands')) {
    throw new Error('MCP tool catalog is incomplete.');
  }

  let nextId = 3;
  const callTool = async (name, args = {}) => {
    const response = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (response?.error !== undefined || response?.result?.isError === true) {
      throw new Error(`MCP tool ${name} failed.${mcpError === '' ? '' : ' See stderr.'}`);
    }
    const text = response?.result?.content?.find((item) => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error(`MCP tool ${name} returned no text result.`);
    return JSON.parse(text);
  };

  const documents = await waitFor(
    async () => {
      const value = await callTool('documents_list');
      return Array.isArray(value) && value.length > 0 ? value : undefined;
    },
    10_000,
    'Visible desktop document',
  );
  const document = documents[0];
  const proposal = await callTool('documents_propose_commands', {
    documentId: document.documentId,
    expectedRevision: document.revision,
    label: 'Electron MCP smoke rename',
    commands: [{ type: 'deck.rename', name: 'MCP smoke verified' }],
  });
  const committed = await callTool('documents_commit_proposal', {
    proposalId: proposal.proposalId,
  });
  if (committed.revision === document.revision) {
    throw new Error('MCP commit did not advance the document revision.');
  }
  const outline = await callTool('documents_get_outline', {
    documentId: document.documentId,
  });
  if (outline.name !== 'MCP smoke verified' || outline.revision !== committed.revision) {
    throw new Error('Desktop and MCP revisions did not converge.');
  }
  if (mcpRouter.failure !== undefined) throw mcpRouter.failure;

  mcpExitExpected = true;
  mcp.stdin.end();
  await waitFor(
    () => mcp.exitCode !== null && mcp.stdout.readableEnded && mcp.stderr.readableEnded,
    5_000,
    'MCP stdio shutdown',
  );
  mcpRouter.finish();
  if (mcpRouter.failure !== undefined) throw mcpRouter.failure;
  if (mcp.exitCode !== 0) throw new Error(`MCP process exited with ${mcp.exitCode}.`);
  process.stdout.write(
    `Electron MCP smoke passed (${packagedLauncher === undefined ? 'source' : 'packaged launcher'}): opened app, listed tools, committed edit, converged.\n`,
  );
} catch (error) {
  if (applicationError !== '') {
    process.stderr.write(`[desktop stderr]\n${applicationError.slice(0, 4_000)}\n`);
  }
  if (mcpError !== '') process.stderr.write(`[mcp stderr]\n${mcpError.slice(0, 4_000)}\n`);
  if (mcp !== undefined) {
    process.stderr.write(`[mcp exit] code=${mcp.exitCode} signal=${mcp.signalCode}\n`);
  }
  throw error;
} finally {
  try {
    if (mcp !== undefined) await terminate(mcp, 'MCP process');
  } finally {
    try {
      await terminate(application, 'Desktop process');
    } finally {
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
        'Electron smoke cleanup',
      );
    }
  }
}
