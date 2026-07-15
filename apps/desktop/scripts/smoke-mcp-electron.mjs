import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import electronPath from 'electron';

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
      lastError = error;
    }
    await sleep(50);
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
application.stderr.on('data', (chunk) => {
  applicationError += chunk.toString('utf8');
});

let mcp;
try {
  await waitFor(
    async () => {
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
  let buffered = '';
  const responses = new Map();
  const waiters = new Map();
  mcp.stderr.on('data', (chunk) => {
    mcpError += chunk.toString('utf8');
  });
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error('MCP stdout contained non-JSON data.');
      }
      if (message.id === undefined) continue;
      const waiter = waiters.get(message.id);
      if (waiter === undefined) responses.set(message.id, message);
      else {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });

  const send = async (message, timeoutMs = 10_000) => {
    mcp.stdin.write(`${JSON.stringify(message)}\n`);
    if (message.id === undefined) return undefined;
    const ready = responses.get(message.id);
    if (ready !== undefined) {
      responses.delete(message.id);
      return ready;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(message.id);
        reject(new Error(`MCP response ${message.id} timed out.`));
      }, timeoutMs);
      waiters.set(message.id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
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

  mcp.stdin.end();
  await waitFor(() => mcp.exitCode !== null, 5_000, 'MCP stdio shutdown');
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
  if (mcp !== undefined) await terminate(mcp);
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
    'Electron smoke cleanup',
  );
}
