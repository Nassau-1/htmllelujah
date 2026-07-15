import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmllelujahMcpServer,
  LocalRpcClient,
  runHtmllelujahMcpStdioFromDescriptor,
  startLocalRpcServer,
  type CommitProposalInput,
  type ExportDocumentInput,
  type HtmllelujahMcpService,
  type ImportAssetInput,
  type McpPermissionGate,
  type ProposeCommandsInput,
  type TransactionTargetInput,
} from '../src/index.js';

const documentId = '10000000-0000-4000-8000-000000000001';
const slideId = '10000000-0000-4000-8000-000000000002';
const proposalId = '10000000-0000-4000-8000-000000000003';
const transactionId = '10000000-0000-4000-8000-000000000004';
const approvalId = 'approval-00000000000000000001';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-mcp-'));
  directories.push(directory);
  return directory;
};

const createService = (): HtmllelujahMcpService => ({
  appStatus: vi.fn(async () => ({ running: true, version: '1.0.0' })),
  listOpenDocuments: vi.fn(async () => [{ documentId, revision: 'rev-1', name: 'Demo' }]),
  getDocumentOutline: vi.fn(async () => ({ documentId, revision: 'rev-1', slides: [{ slideId }] })),
  getSlide: vi.fn(async () => ({ documentId, slideId, revision: 'rev-1', elements: [] })),
  getStyleCatalog: vi.fn(async () => ({ documentId, themes: [], layouts: [] })),
  validateDocument: vi.fn(async () => ({ documentId, valid: true, issueCount: 0 })),
  proposeCommands: vi.fn(async (input: ProposeCommandsInput) => ({
    proposalId,
    documentId: input.documentId,
    baseRevision: input.expectedRevision,
    expiresAt: '2026-07-15T13:00:00.000Z',
    requiresApproval: input.commands.some((command) => command.type === 'slide.delete'),
    commandCount: input.commands.length,
    affectedSlideIds: input.commands.flatMap((command) =>
      'slideId' in command ? [command.slideId] : [],
    ),
    warnings: [],
    summary: 'One typed command',
  })),
  commitProposal: vi.fn(async (_input: CommitProposalInput) => ({
    documentId,
    transactionId,
    previousRevision: 'rev-1',
    revision: 'rev-2',
    acceptedCommandCount: 1,
  })),
  undoAgentTransaction: vi.fn(async (_input: TransactionTargetInput) => ({
    documentId,
    transactionId: '10000000-0000-4000-8000-000000000005',
    previousRevision: 'rev-2',
    revision: 'rev-3',
    acceptedCommandCount: 1,
  })),
  importAsset: vi.fn(async (_input: ImportAssetInput) => ({
    assetId: slideId,
    mediaType: 'image/png',
  })),
  exportDocument: vi.fn(async (input: ExportDocumentInput) => ({
    documentId: input.documentId,
    format: input.format,
    status: 'exported',
  })),
  collaborationStatus: vi.fn(async () => ({ documentId, state: 'off', participantCount: 1 })),
});

const createPermissions = (): McpPermissionGate & { approvals: Set<string> } => {
  const approvals = new Set<string>();
  return {
    approvals,
    canRead: () => true,
    canEdit: () => true,
    consumeApproval: ({ approvalId: candidate }) => approvals.delete(candidate),
  };
};

const connectMcp = async (service: HtmllelujahMcpService, permissions: McpPermissionGate) => {
  const server = createHtmllelujahMcpServer(service, permissions);
  const client = new Client({ name: 'htmllelujah-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
};

const textResult = (result: unknown): Record<string, unknown> => {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('Expected MCP content result.');
  }
  const content = result.content;
  if (!Array.isArray(content)) throw new Error('Expected MCP content array.');
  const first = content[0] as { readonly type?: unknown; readonly text?: unknown } | undefined;
  expect(first?.type).toBe('text');
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected text result.');
  }
  return JSON.parse(first.text) as Record<string, unknown>;
};

describe('MCP tools', () => {
  it('lists and invokes bounded read tools', async () => {
    const service = createService();
    const { server, client } = await connectMcp(service, createPermissions());
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('documents_get_outline');
      const result = await client.callTool({
        name: 'documents_get_outline',
        arguments: { documentId },
      });
      expect(textResult(result)).toMatchObject({ documentId, revision: 'rev-1' });
      expect(service.getDocumentOutline).toHaveBeenCalledWith(documentId);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('fails closed when document read access is not granted', async () => {
    const service = createService();
    const permissions = createPermissions();
    permissions.canRead = () => false;
    const { server, client } = await connectMcp(service, permissions);
    try {
      const result = await client.callTool({
        name: 'documents_get_outline',
        arguments: { documentId },
      });
      expect(result.isError).toBe(true);
      expect(textResult(result)).toMatchObject({
        error: { code: 'MCP_UNAUTHORIZED' },
      });
      expect(service.getDocumentOutline).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('rejects unknown input fields at the MCP schema boundary', async () => {
    const { server, client } = await connectMcp(createService(), createPermissions());
    try {
      const result = await client.callTool({
        name: 'documents_get_outline',
        arguments: { documentId, path: 'C:\\secret.txt' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('requires and consumes one-time desktop approval for a destructive proposal', async () => {
    const service = createService();
    const permissions = createPermissions();
    const { server, client } = await connectMcp(service, permissions);
    try {
      const proposal = await client.callTool({
        name: 'documents_propose_commands',
        arguments: {
          documentId,
          expectedRevision: 'rev-1',
          label: 'Remove unused slide',
          commands: [{ type: 'slide.delete', slideId }],
        },
      });
      expect(textResult(proposal)).toMatchObject({ proposalId, requiresApproval: true });

      const denied = await client.callTool({
        name: 'documents_commit_proposal',
        arguments: { proposalId },
      });
      expect(denied.isError).toBe(true);
      expect(textResult(denied)).toMatchObject({ error: { code: 'APPROVAL_REQUIRED' } });

      permissions.approvals.add(approvalId);
      const committed = await client.callTool({
        name: 'documents_commit_proposal',
        arguments: { proposalId, approvalId },
      });
      expect(textResult(committed)).toMatchObject({ revision: 'rev-2', transactionId });
      expect(permissions.approvals.has(approvalId)).toBe(false);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

describe('authenticated local RPC', () => {
  it('connects over an authenticated endpoint and dispatches typed methods', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const service = createService();
    const server = await startLocalRpcServer({ service, descriptorPath });
    const client = new LocalRpcClient(descriptorPath);
    try {
      await expect(client.appStatus()).resolves.toMatchObject({ running: true, version: '1.0.0' });
      await expect(client.getSlide(documentId, slideId)).resolves.toMatchObject({
        documentId,
        slideId,
      });
      expect(service.getSlide).toHaveBeenCalledWith(documentId, slideId);
    } finally {
      await client.close();
      await server.close();
      await server.close();
    }
    await expect(readFile(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a client when the descriptor secret is tampered', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const server = await startLocalRpcServer({ service: createService(), descriptorPath });
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<
      string,
      unknown
    >;
    descriptor.secret = '0'.repeat(64);
    await writeFile(descriptorPath, JSON.stringify(descriptor), 'utf8');
    const client = new LocalRpcClient(descriptorPath);
    try {
      await expect(client.appStatus()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects stale descriptors before opening a socket', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    await writeFile(
      descriptorPath,
      JSON.stringify({
        protocolVersion: 1,
        pipeName: '\\\\.\\pipe\\missing',
        secret: '1'.repeat(64),
        instanceId: 'instance',
        pid: 1,
        createdAt: '2026-07-15T12:00:00.000Z',
        expiresAt: '2026-07-15T12:00:01.000Z',
      }),
      'utf8',
    );
    await expect(new LocalRpcClient(descriptorPath).appStatus()).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('routes permission decisions and consumes approvals exactly once', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const permissions = createPermissions();
    permissions.approvals.add(approvalId);
    permissions.canRead = vi.fn((candidate) => candidate === documentId);
    permissions.canEdit = vi.fn(() => false);
    const server = await startLocalRpcServer({
      service: createService(),
      permissions,
      descriptorPath,
    });
    const client = new LocalRpcClient(descriptorPath);
    try {
      await expect(client.canRead(documentId)).resolves.toBe(true);
      await expect(client.canEdit(documentId)).resolves.toBe(false);
      await expect(
        client.consumeApproval({ approvalId, documentId, action: 'import' }),
      ).resolves.toBe(true);
      await expect(
        client.consumeApproval({ approvalId, documentId, action: 'import' }),
      ).resolves.toBe(false);
      expect(permissions.canRead).toHaveBeenCalledWith(documentId);
      expect(permissions.canEdit).toHaveBeenCalledWith(documentId);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails closed when no permission gate is supplied', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const server = await startLocalRpcServer({ service: createService(), descriptorPath });
    const client = new LocalRpcClient(descriptorPath);
    try {
      await expect(client.canRead(documentId)).resolves.toBe(false);
      await expect(client.canEdit(documentId)).resolves.toBe(false);
      await expect(
        client.consumeApproval({ approvalId, documentId, action: 'export-pdf' }),
      ).resolves.toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('strictly rejects malformed permission RPC parameters before invoking the gate', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const permissions = createPermissions();
    permissions.canRead = vi.fn(() => true);
    const server = await startLocalRpcServer({
      service: createService(),
      permissions,
      descriptorPath,
    });
    const client = new LocalRpcClient(descriptorPath);
    const rawCall = (
      client as unknown as {
        call(method: string, params: unknown): Promise<unknown>;
      }
    ).call.bind(client);
    try {
      await expect(
        rawCall('canRead', { documentId, unexpectedPath: 'C:\\private.txt' }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(
        rawCall('consumeApproval', {
          approvalId,
          documentId,
          action: 'export-anywhere',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(permissions.canRead).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('fails safely when a permission gate throws or returns invalid data', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const permissions = createPermissions();
    permissions.canRead = () => {
      throw new Error('sensitive permission backend details');
    };
    permissions.canEdit = (() => 'yes') as unknown as McpPermissionGate['canEdit'];
    const server = await startLocalRpcServer({
      service: createService(),
      permissions,
      descriptorPath,
    });
    const client = new LocalRpcClient(descriptorPath);
    try {
      await expect(client.canRead(documentId)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: 'The local document service is unavailable.',
      });
      await expect(client.canEdit(documentId)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses the RPC client as both MCP service and permission gate', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const service = createService();
    const permissions = createPermissions();
    permissions.approvals.add(approvalId);
    const rpcServer = await startLocalRpcServer({
      service,
      permissions,
      descriptorPath,
    });
    const rpcClient = new LocalRpcClient(descriptorPath);
    const { server, client } = await connectMcp(rpcClient, rpcClient);
    try {
      const first = await client.callTool({
        name: 'assets_request_import',
        arguments: { documentId, approvalId },
      });
      expect(first.isError).not.toBe(true);
      expect(textResult(first)).toMatchObject({ assetId: slideId });

      const replay = await client.callTool({
        name: 'assets_request_import',
        arguments: { documentId, approvalId },
      });
      expect(replay.isError).toBe(true);
      expect(textResult(replay)).toMatchObject({ error: { code: 'APPROVAL_EXPIRED' } });
      expect(service.importAsset).toHaveBeenCalledTimes(1);
    } finally {
      await Promise.all([client.close(), server.close()]);
      await rpcClient.close();
      await rpcServer.close();
    }
  });

  it('closes clients, pending connections, descriptors, and stdio bridge cleanly', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const service = createService();
    let releaseStatus: ((value: Readonly<Record<string, unknown>>) => void) | undefined;
    service.appStatus = vi.fn(
      () =>
        new Promise<Readonly<Record<string, unknown>>>((resolve) => {
          releaseStatus = resolve;
        }),
    );
    const rpcServer = await startLocalRpcServer({
      service,
      permissions: createPermissions(),
      descriptorPath,
    });
    const client = new LocalRpcClient(descriptorPath);
    await client.connect();
    await client.close();
    await client.close();
    await expect(client.appStatus()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stdoutText = '';
    stdout.on('data', (chunk: Buffer) => {
      stdoutText += chunk.toString('utf8');
    });
    const bridge = runHtmllelujahMcpStdioFromDescriptor(descriptorPath, { stdin, stdout });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-test', version: '1.0.0' },
        },
      })}\n`,
    );
    await vi.waitFor(
      () => {
        const messages = stdoutText
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: '2.0', id: 1 }));
      },
      { timeout: 5_000 },
    );
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    await vi.waitFor(
      () => {
        const messages = stdoutText
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(messages).toContainEqual(expect.objectContaining({ jsonrpc: '2.0', id: 2 }));
      },
      { timeout: 5_000 },
    );
    stdin.end();
    await bridge;
    const stdoutMessages = stdoutText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(stdoutMessages).toHaveLength(2);
    expect(stdoutMessages.every((message) => message.jsonrpc === '2.0')).toBe(true);

    const pendingClient = new LocalRpcClient(descriptorPath);
    const pendingStatus = pendingClient.appStatus();
    const pendingRejection = expect(pendingStatus).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await vi.waitFor(() => expect(service.appStatus).toHaveBeenCalledTimes(1));
    await rpcServer.close();
    await pendingRejection;
    releaseStatus?.({ running: true });
    await pendingClient.close();
    await rpcServer.close();
    await expect(readFile(descriptorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
