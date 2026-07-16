import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDefaultDeck, type DocumentCommand } from '@htmllelujah/document-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmllelujahMcpServer,
  commandsRequireApproval,
  LocalRpcClient,
  MCP_LIMITS,
  runHtmllelujahMcpStdioFromDescriptor,
  startLocalRpcServer,
  type CommitProposalInput,
  type ExportDocumentInput,
  type HtmllelujahMcpService,
  type ImportAssetInput,
  type McpPermissionGate,
  type ProposalResult,
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

describe('MCP destructive command classification', () => {
  it('requires approval for every destructive or content-remapping command', () => {
    const destructiveCommands: readonly DocumentCommand[] = [
      { type: 'slide.delete', slideId },
      { type: 'element.delete', slideId, elementIds: [proposalId] },
      { type: 'theme.delete', themeId: proposalId },
      { type: 'master.delete', masterId: proposalId },
      { type: 'layout.delete', layoutId: proposalId },
      { type: 'asset.remove', assetId: proposalId },
      { type: 'table.delete-row', slideId, tableId: proposalId, index: 0 },
      { type: 'table.delete-column', slideId, tableId: proposalId, index: 0 },
      { type: 'slide.set-layout', slideId, layoutId: proposalId },
      { type: 'slide.reset-placeholder', slideId, placeholderId: proposalId },
      {
        type: 'deck.set-page',
        page: { widthPt: 960, heightPt: 540 },
      },
    ];

    for (const command of destructiveCommands) {
      expect(commandsRequireApproval([command]), command.type).toBe(true);
    }
    expect(commandsRequireApproval([{ type: 'deck.rename', name: 'Safe rename' }])).toBe(false);
  });

  it('fails closed for complete replacements that can silently remove nested content', () => {
    const deck = createDefaultDeck();
    const theme = deck.themes[0];
    const master = deck.masters[0];
    const layout = deck.layouts[0];
    if (theme === undefined || master === undefined || layout === undefined) {
      throw new Error('Missing default styles.');
    }

    const replacementCommands: readonly DocumentCommand[] = [
      {
        type: 'theme.update',
        themeId: theme.id,
        replacement: { ...theme, name: 'Replacement theme' },
      },
      {
        type: 'master.update',
        masterId: master.id,
        replacement: { ...master, elements: [] },
      },
      {
        type: 'layout.update',
        layoutId: layout.id,
        replacement: { ...layout, elements: [] },
      },
      {
        type: 'element.update',
        slideId,
        elementId: proposalId,
        replacement: {
          type: 'group',
          id: proposalId,
          name: 'Replacement group',
          frame: { xPt: 0, yPt: 0, widthPt: 200, heightPt: 100, rotationDeg: 0 },
          opacity: 1,
          visible: true,
          locked: false,
          coordinateSpace: { widthPt: 200, heightPt: 100 },
          children: [],
        },
      },
    ];

    for (const command of replacementCommands) {
      expect(commandsRequireApproval([command]), command.type).toBe(true);
    }
    expect(
      commandsRequireApproval([
        {
          type: 'element.update-style',
          slideId,
          elementId: proposalId,
          patch: { kind: 'text', opacity: 0.8 },
        },
      ]),
    ).toBe(false);
  });
});

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
    expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs).toISOString(),
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

  it('purges expired proposal metadata before commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const service = createService();
    const { server, client } = await connectMcp(service, createPermissions());
    try {
      const proposed = await client.callTool({
        name: 'documents_propose_commands',
        arguments: {
          documentId,
          expectedRevision: 'rev-1',
          label: 'Short-lived proposal',
          commands: [{ type: 'deck.rename', name: 'Still bounded' }],
        },
      });
      expect(textResult(proposed)).toMatchObject({ proposalId });

      vi.advanceTimersByTime(MCP_LIMITS.proposalTtlMs + 1);
      const expired = await client.callTool({
        name: 'documents_commit_proposal',
        arguments: { proposalId },
      });
      expect(expired.isError).toBe(true);
      expect(textResult(expired)).toMatchObject({ error: { code: 'NOT_FOUND' } });
      expect(service.commitProposal).not.toHaveBeenCalled();
    } finally {
      await Promise.all([client.close(), server.close()]);
      vi.useRealTimers();
    }
  });

  it('rejects invalid expirations and duplicate proposal identities without leaking reservations', async () => {
    const service = createService();
    service.proposeCommands = vi
      .fn<HtmllelujahMcpService['proposeCommands']>()
      .mockImplementationOnce(async (input) => ({
        proposalId,
        documentId: input.documentId,
        baseRevision: input.expectedRevision,
        expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs + 60_000).toISOString(),
        requiresApproval: false,
        commandCount: input.commands.length,
        affectedSlideIds: [],
        warnings: [],
        summary: 'Invalid long-lived proposal',
      }))
      .mockImplementation(async (input) => ({
        proposalId,
        documentId: input.documentId,
        baseRevision: input.expectedRevision,
        expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs).toISOString(),
        requiresApproval: false,
        commandCount: input.commands.length,
        affectedSlideIds: [],
        warnings: [],
        summary: 'Valid proposal',
      }));
    const { server, client } = await connectMcp(service, createPermissions());
    const request = {
      name: 'documents_propose_commands',
      arguments: {
        documentId,
        expectedRevision: 'rev-1',
        label: 'Validate proposal identity and TTL',
        commands: [{ type: 'deck.rename', name: 'Bounded' }],
      },
    } as const;
    try {
      const invalidExpiry = await client.callTool(request);
      expect(invalidExpiry.isError).toBe(true);
      expect(textResult(invalidExpiry)).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });

      const valid = await client.callTool(request);
      expect(valid.isError).not.toBe(true);
      expect(textResult(valid)).toMatchObject({ proposalId });

      const duplicate = await client.callTool(request);
      expect(duplicate.isError).toBe(true);
      expect(textResult(duplicate)).toMatchObject({
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(service.proposeCommands).toHaveBeenCalledTimes(3);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it('bounds pending and in-flight proposals and recovers capacity after commit', async () => {
    const release: Array<
      (value: Awaited<ReturnType<HtmllelujahMcpService['proposeCommands']>>) => void
    > = [];
    const service = createService();
    service.proposeCommands = vi.fn(
      (_input: ProposeCommandsInput) =>
        new Promise<ProposalResult>((resolve) => {
          release.push((value) => resolve(value));
        }),
    );
    const { server, client } = await connectMcp(service, createPermissions());
    const calls = Array.from({ length: MCP_LIMITS.maxPendingProposals }, (_, index) =>
      client.callTool({
        name: 'documents_propose_commands',
        arguments: {
          documentId,
          expectedRevision: 'rev-1',
          label: `Concurrent proposal ${index}`,
          commands: [{ type: 'deck.rename', name: `Bounded ${index}` }],
        },
      }),
    );
    try {
      await vi.waitFor(() => expect(release).toHaveLength(MCP_LIMITS.maxPendingProposals));
      const saturated = await client.callTool({
        name: 'documents_propose_commands',
        arguments: {
          documentId,
          expectedRevision: 'rev-1',
          label: 'One too many',
          commands: [{ type: 'deck.rename', name: 'Rejected' }],
        },
      });
      expect(saturated.isError).toBe(true);
      expect(textResult(saturated)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(service.proposeCommands).toHaveBeenCalledTimes(MCP_LIMITS.maxPendingProposals);

      for (let index = 0; index < release.length; index += 1) {
        release[index]?.({
          proposalId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          documentId,
          baseRevision: 'rev-1',
          expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs).toISOString(),
          requiresApproval: false,
          commandCount: 1,
          affectedSlideIds: [],
          warnings: [],
          summary: 'One typed command',
        });
      }
      await Promise.all(calls);

      const firstProposalId = '10000000-0000-4000-8000-000000000000';
      const committed = await client.callTool({
        name: 'documents_commit_proposal',
        arguments: { proposalId: firstProposalId },
      });
      expect(textResult(committed)).toMatchObject({ revision: 'rev-2' });

      const admitted = client.callTool({
        name: 'documents_propose_commands',
        arguments: {
          documentId,
          expectedRevision: 'rev-2',
          label: 'Capacity restored',
          commands: [{ type: 'deck.rename', name: 'Accepted' }],
        },
      });
      await vi.waitFor(() => expect(release).toHaveLength(MCP_LIMITS.maxPendingProposals + 1));
      release.at(-1)?.({
        proposalId: '10000000-0000-4000-8000-999999999999',
        documentId,
        baseRevision: 'rev-2',
        expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs).toISOString(),
        requiresApproval: false,
        commandCount: 1,
        affectedSlideIds: [],
        warnings: [],
        summary: 'One typed command',
      });
      const admittedResult = await admitted;
      expect(admittedResult.isError).not.toBe(true);
      expect(textResult(admittedResult)).toMatchObject({
        proposalId: '10000000-0000-4000-8000-999999999999',
      });
    } finally {
      for (const complete of release) {
        complete({
          proposalId,
          documentId,
          baseRevision: 'rev-1',
          expiresAt: new Date(Date.now() + MCP_LIMITS.proposalTtlMs).toISOString(),
          requiresApproval: false,
          commandCount: 1,
          affectedSlideIds: [],
          warnings: [],
          summary: 'One typed command',
        });
      }
      await Promise.allSettled(calls);
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

  it('rotates credentials behind an explicit barrier while preserving established clients', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const initialTime = Date.parse('2026-07-16T12:00:00.000Z');
    vi.setSystemTime(initialTime);
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    const staleDescriptorPath = path.join(directory, 'expired-endpoint-v1.json');
    const server = await startLocalRpcServer({
      service: createService(),
      descriptorPath,
      lifetimeMs: 60_000,
      rotationLeadMs: 20_000,
    });
    const firstDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
      readonly instanceId: string;
      readonly secret: string;
      readonly pipeName: string;
      readonly createdAt: string;
      readonly expiresAt: string;
    };
    await writeFile(staleDescriptorPath, JSON.stringify(firstDescriptor), 'utf8');
    const establishedClient = new LocalRpcClient(descriptorPath);
    let overlapClient: LocalRpcClient | undefined;
    const freshClients: LocalRpcClient[] = [];
    try {
      await expect(establishedClient.appStatus()).resolves.toMatchObject({ running: true });
      vi.setSystemTime(initialTime + 30_000);
      const rotations = await Promise.all(
        Array.from({ length: 8 }, () => server.rotateCredentials()),
      );

      const currentDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
        readonly instanceId: string;
        readonly secret: string;
        readonly pipeName: string;
        readonly createdAt: string;
        readonly expiresAt: string;
      };
      expect(currentDescriptor).toMatchObject({ pipeName: firstDescriptor.pipeName });
      expect(currentDescriptor.instanceId).not.toBe(firstDescriptor.instanceId);
      expect(currentDescriptor.secret).not.toBe(firstDescriptor.secret);
      expect(Date.parse(currentDescriptor.createdAt)).toBeGreaterThan(
        Date.parse(firstDescriptor.createdAt),
      );
      expect(Date.parse(currentDescriptor.expiresAt)).toBeGreaterThan(Date.now());
      expect(new Set(rotations.map((candidate) => candidate.instanceId))).toEqual(
        new Set([currentDescriptor.instanceId]),
      );
      expect(server.descriptor).toMatchObject({
        instanceId: currentDescriptor.instanceId,
        secret: currentDescriptor.secret,
      });

      overlapClient = new LocalRpcClient(staleDescriptorPath);
      await expect(overlapClient.appStatus()).resolves.toMatchObject({ running: true });

      vi.setSystemTime(Date.parse(firstDescriptor.expiresAt) + 1);
      await expect(establishedClient.appStatus()).resolves.toMatchObject({ running: true });
      await expect(overlapClient.appStatus()).resolves.toMatchObject({ running: true });

      freshClients.push(...Array.from({ length: 12 }, () => new LocalRpcClient(descriptorPath)));
      await expect(
        Promise.all(freshClients.map(async (client) => client.appStatus())),
      ).resolves.toEqual(
        Array.from({ length: freshClients.length }, () =>
          expect.objectContaining({ running: true }),
        ),
      );
      await expect(new LocalRpcClient(staleDescriptorPath).appStatus()).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
      });
    } finally {
      await Promise.all([
        establishedClient.close(),
        overlapClient?.close(),
        ...freshClients.map(async (client) => client.close()),
      ]);
      await server.close();
      vi.useRealTimers();
    }
  });

  it('rejects descriptor timing that cannot cover an authentication window', async () => {
    const directory = await createTemporaryDirectory();
    const descriptorPath = path.join(directory, 'endpoint-v1.json');
    await expect(
      startLocalRpcServer({
        service: createService(),
        descriptorPath,
        lifetimeMs: 300,
        rotationLeadMs: 150,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      startLocalRpcServer({
        service: createService(),
        descriptorPath,
        lifetimeMs: 20_000,
        rotationLeadMs: 9_999,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('retries authentication once when the atomically published endpoint changes', async () => {
    const directory = await createTemporaryDirectory();
    const primaryDescriptorPath = path.join(directory, 'primary-endpoint-v1.json');
    const clientDescriptorPath = path.join(directory, 'client-endpoint-v1.json');
    const pipeName =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\htmllelujah-stalled-${randomUUID()}`
        : path.join(directory, 'stalled.sock');
    const sockets = new Set<Socket>();
    let acceptConnection: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      acceptConnection = resolve;
    });
    const stalledServer = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      acceptConnection?.();
    });
    await new Promise<void>((resolve, reject) => {
      stalledServer.once('error', reject);
      stalledServer.listen(pipeName, () => {
        stalledServer.off('error', reject);
        resolve();
      });
    });
    const primaryServer = await startLocalRpcServer({
      service: createService(),
      descriptorPath: primaryDescriptorPath,
    });
    const now = Date.now();
    await writeFile(
      clientDescriptorPath,
      JSON.stringify({
        protocolVersion: 1,
        pipeName,
        secret: 'a'.repeat(64),
        instanceId: randomUUID(),
        pid: process.pid,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      }),
      'utf8',
    );
    const client = new LocalRpcClient(clientDescriptorPath);
    try {
      const status = client.appStatus();
      await accepted;
      const replacementPath = path.join(directory, 'replacement-endpoint-v1.json');
      await writeFile(replacementPath, JSON.stringify(primaryServer.descriptor), 'utf8');
      await rename(replacementPath, clientDescriptorPath);
      for (const socket of sockets) socket.destroy();
      await expect(status).resolves.toMatchObject({ running: true, version: '1.0.0' });
      expect(primaryServer.connectionCount).toBe(1);
    } finally {
      await client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      await primaryServer.close();
    }
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
