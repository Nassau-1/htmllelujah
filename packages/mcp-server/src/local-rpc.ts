import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Readable, type Writable } from 'node:stream';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import type {
  CommitProposalInput,
  DesignContextInput,
  ExportDocumentInput,
  ImportAssetInput,
  ProposeCommandsInput,
  ProposeDesignOperationsInput,
  TransactionTargetInput,
} from './contracts.js';
import {
  approvalIdSchema,
  commitProposalSchema,
  designContextSchema,
  documentTargetSchema,
  exportDocumentSchema,
  importAssetSchema,
  proposeCommandsSchema,
  proposeDesignOperationsSchema,
  slideTargetSchema,
  transactionTargetSchema,
} from './contracts.js';
import {
  createHtmllelujahMcpServer,
  McpSafeError,
  type HtmllelujahMcpService,
  type McpPermissionGate,
  type SafeRecord,
} from './service.js';
import {
  signTrustedClientChallenge,
  trustedClientContext,
  trustedClientCredentialSchema,
  verifyTrustedClientChallenge,
  type TrustedClientContext,
  type TrustedClientCredential,
  type TrustedClientProfile,
} from './trusted-client.js';

const PROTOCOL_VERSION = 2;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUESTS_PER_MINUTE = 120;
const DEFAULT_DESCRIPTOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ROTATION_LEAD_MS = 5 * 60 * 1000;
// A descriptor must remain discoverable long enough for an in-flight client to
// finish the bounded authentication handshake. Keeping two authentication
// windows before expiry also leaves one full window for atomic publication.
const MIN_ROTATION_LEAD_MS = AUTH_TIMEOUT_MS * 2;
const MIN_ROTATION_INTERVAL_MS = AUTH_TIMEOUT_MS;
const MIN_DESCRIPTOR_LIFETIME_MS = MIN_ROTATION_LEAD_MS + MIN_ROTATION_INTERVAL_MS;

export interface LocalRpcEndpointDescriptor {
  readonly protocolVersion: 2;
  readonly pipeName: string;
  readonly secret: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface LocalRpcServerHandle {
  readonly descriptor: LocalRpcEndpointDescriptor;
  readonly connectionCount: number;
  readonly connectedClientIds: readonly string[];
  rotateCredentials(): Promise<LocalRpcEndpointDescriptor>;
  disconnectClient(clientId: string): void;
  close(): Promise<void>;
}

type RpcMethod =
  | 'appStatus'
  | 'listOpenDocuments'
  | 'getDocumentOutline'
  | 'getSlide'
  | 'getStyleCatalog'
  | 'getDesignContext'
  | 'validateDocument'
  | 'proposeCommands'
  | 'proposeDesignOperations'
  | 'commitProposal'
  | 'undoAgentTransaction'
  | 'importAsset'
  | 'exportDocument'
  | 'collaborationStatus'
  | 'canRead'
  | 'canEdit'
  | 'consumeApproval';

interface RpcRequest {
  readonly type: 'request';
  readonly id: string;
  readonly method: RpcMethod;
  readonly params: unknown;
}

interface RpcResponse {
  readonly type: 'response';
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

const allowedMethods = new Set<RpcMethod>([
  'appStatus',
  'listOpenDocuments',
  'getDocumentOutline',
  'getSlide',
  'getStyleCatalog',
  'getDesignContext',
  'validateDocument',
  'proposeCommands',
  'proposeDesignOperations',
  'commitProposal',
  'undoAgentTransaction',
  'importAsset',
  'exportDocument',
  'collaborationStatus',
  'canRead',
  'canEdit',
  'consumeApproval',
]);

const emptyParamsSchema = z.object({}).strict();
const permissionActionSchema = z.enum([
  'commit-destructive',
  'undo',
  'import',
  'export-html',
  'export-pdf',
]);
const consumeApprovalSchema = z
  .object({
    approvalId: approvalIdSchema,
    documentId: documentTargetSchema.shape.documentId,
    action: permissionActionSchema,
  })
  .strict();

const FAIL_CLOSED_PERMISSION_GATE: McpPermissionGate = Object.freeze({
  canRead: () => false,
  canEdit: () => false,
  consumeApproval: () => false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hmac = (secret: string, value: string): string =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(value).digest('hex');

const constantEqualHex = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};

const transcript = (
  instanceId: string,
  clientId: string,
  clientNonce: string,
  serverNonce: string,
): string => `htmllelujah-rpc-v2|${instanceId}|${clientId}|${clientNonce}|${serverNonce}`;

const writeFrame = (socket: Socket, value: unknown): void => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) {
    throw new McpSafeError('INVALID_REQUEST', 'Local RPC response exceeds limits.');
  }
  socket.write(frame, 'utf8');
};

const createLineReader = (
  socket: Socket,
  onLine: (value: unknown) => Promise<void> | void,
): (() => void) => {
  let buffered = '';
  let closed = false;
  const onData = (chunk: Buffer): void => {
    if (closed) return;
    buffered += chunk.toString('utf8');
    if (Buffer.byteLength(buffered, 'utf8') > MAX_FRAME_BYTES) {
      closed = true;
      socket.destroy(new Error('Local RPC frame exceeds limits.'));
      return;
    }
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        socket.destroy(new Error('Local RPC JSON is invalid.'));
        return;
      }
      void Promise.resolve(onLine(value)).catch(() => {
        socket.destroy(new Error('Local RPC handler failed.'));
      });
    }
  };
  socket.on('data', onData);
  return () => {
    closed = true;
    socket.off('data', onData);
  };
};

const safeRpcError = (error: unknown): { readonly code: string; readonly message: string } => {
  if (error instanceof McpSafeError) return { code: error.code, message: error.message };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    const allowed = new Set(['REVISION_CONFLICT', 'NOT_FOUND', 'LOCKED', 'READ_ONLY']);
    if (allowed.has(error.code)) {
      return { code: error.code, message: 'The local document operation failed safely.' };
    }
  }
  return { code: 'SERVICE_UNAVAILABLE', message: 'The local document service is unavailable.' };
};

const parseParams = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new McpSafeError('INVALID_REQUEST', 'RPC parameters are invalid.');
  }
  return result.data;
};

const requirePermissionDecision = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'The permission service returned invalid data.');
  }
  return value;
};

const requireClientCapability = (
  client: TrustedClientContext,
  capability: 'documents.read.visible' | 'documents.edit.ordinary',
): void => {
  if (!client.capabilities.includes(capability)) {
    throw new McpSafeError('MCP_UNAUTHORIZED', 'The trusted client capability is not granted.');
  }
};

const dispatch = async (
  service: HtmllelujahMcpService,
  permissions: McpPermissionGate,
  client: TrustedClientContext,
  method: RpcMethod,
  params: unknown,
): Promise<unknown> => {
  switch (method) {
    case 'appStatus': {
      parseParams(emptyParamsSchema, params);
      return service.appStatus();
    }
    case 'listOpenDocuments': {
      parseParams(emptyParamsSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.listOpenDocuments();
    }
    case 'getDocumentOutline': {
      const input = parseParams(documentTargetSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.getDocumentOutline(input.documentId);
    }
    case 'getSlide': {
      const input = parseParams(slideTargetSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.getSlide(input.documentId, input.slideId);
    }
    case 'getStyleCatalog': {
      const input = parseParams(documentTargetSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.getStyleCatalog(input.documentId);
    }
    case 'getDesignContext': {
      const input = parseParams(designContextSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.getDesignContext(input);
    }
    case 'validateDocument': {
      const input = parseParams(documentTargetSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.validateDocument(input.documentId);
    }
    case 'proposeCommands': {
      requireClientCapability(client, 'documents.edit.ordinary');
      return service.proposeCommands(parseParams(proposeCommandsSchema, params), client);
    }
    case 'proposeDesignOperations': {
      requireClientCapability(client, 'documents.edit.ordinary');
      return service.proposeDesignOperations(
        parseParams(proposeDesignOperationsSchema, params),
        client,
      );
    }
    case 'commitProposal': {
      requireClientCapability(client, 'documents.edit.ordinary');
      return service.commitProposal(parseParams(commitProposalSchema, params), client);
    }
    case 'undoAgentTransaction': {
      requireClientCapability(client, 'documents.edit.ordinary');
      return service.undoAgentTransaction(parseParams(transactionTargetSchema, params), client);
    }
    case 'importAsset': {
      requireClientCapability(client, 'documents.edit.ordinary');
      return service.importAsset(parseParams(importAssetSchema, params), client);
    }
    case 'exportDocument': {
      requireClientCapability(client, 'documents.read.visible');
      return service.exportDocument(parseParams(exportDocumentSchema, params), client);
    }
    case 'collaborationStatus': {
      const input = parseParams(documentTargetSchema, params);
      requireClientCapability(client, 'documents.read.visible');
      return service.collaborationStatus(input.documentId);
    }
    case 'canRead': {
      const input = parseParams(documentTargetSchema, params);
      if (!client.capabilities.includes('documents.read.visible')) return false;
      return requirePermissionDecision(await permissions.canRead(input.documentId, client));
    }
    case 'canEdit': {
      const input = parseParams(documentTargetSchema, params);
      if (!client.capabilities.includes('documents.edit.ordinary')) return false;
      return requirePermissionDecision(await permissions.canEdit(input.documentId, client));
    }
    case 'consumeApproval': {
      const input = parseParams(consumeApprovalSchema, params);
      requireClientCapability(client, 'documents.edit.ordinary');
      return requirePermissionDecision(await permissions.consumeApproval(input, client));
    }
  }
};

const parseRpcRequest = (value: unknown): RpcRequest => {
  if (!isRecord(value)) throw new McpSafeError('INVALID_REQUEST', 'RPC request is invalid.');
  const keys = Object.keys(value);
  if (
    keys.length !== 4 ||
    keys.some((key) => !['type', 'id', 'method', 'params'].includes(key)) ||
    value.type !== 'request' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 80 ||
    typeof value.method !== 'string' ||
    !allowedMethods.has(value.method as RpcMethod)
  ) {
    throw new McpSafeError('INVALID_REQUEST', 'RPC request fields are invalid.');
  }
  return value as unknown as RpcRequest;
};

const handleServerSocket = (
  socket: Socket,
  service: HtmllelujahMcpService,
  permissions: McpPermissionGate,
  resolveSecret: (instanceId: string) => string | undefined,
  resolveTrustedClient: (clientId: string) => TrustedClientProfile | undefined,
  usedNonces: Set<string>,
  onAuthenticated: (clientId: string) => void,
): void => {
  socket.setNoDelay(true);
  socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy());
  let state: 'hello' | 'authenticate' | 'ready' = 'hello';
  let clientNonce = '';
  let serverNonce = '';
  let instanceId = '';
  let clientId = '';
  let connectionSecret: string | undefined;
  let clientProfile: TrustedClientProfile | undefined;
  let client: TrustedClientContext | undefined;
  let requestWindowStarted = Date.now();
  let requestCount = 0;

  createLineReader(socket, async (value) => {
    if (state === 'hello') {
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 4 ||
        Object.keys(value).some(
          (key) => !['type', 'clientNonce', 'instanceId', 'clientId'].includes(key),
        ) ||
        value.type !== 'hello' ||
        typeof value.clientNonce !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.clientNonce) ||
        typeof value.instanceId !== 'string' ||
        typeof value.clientId !== 'string' ||
        usedNonces.has(value.clientNonce)
      ) {
        socket.destroy();
        return;
      }
      connectionSecret = resolveSecret(value.instanceId);
      clientProfile = resolveTrustedClient(value.clientId);
      if (connectionSecret === undefined || clientProfile === undefined) {
        socket.destroy();
        return;
      }
      instanceId = value.instanceId;
      clientId = value.clientId;
      clientNonce = value.clientNonce;
      usedNonces.add(clientNonce);
      if (usedNonces.size > 4096) usedNonces.delete(usedNonces.values().next().value ?? '');
      serverNonce = randomBytes(32).toString('hex');
      const proof = hmac(
        connectionSecret,
        `server|${transcript(instanceId, clientId, clientNonce, serverNonce)}`,
      );
      writeFrame(socket, { type: 'challenge', serverNonce, proof });
      state = 'authenticate';
      return;
    }
    if (state === 'authenticate') {
      if (connectionSecret === undefined || clientProfile === undefined) {
        socket.destroy();
        return;
      }
      const challenge = transcript(instanceId, clientId, clientNonce, serverNonce);
      if (
        !isRecord(value) ||
        Object.keys(value).length !== 2 ||
        Object.keys(value).some((key) => !['type', 'signature'].includes(key)) ||
        value.type !== 'authenticate' ||
        typeof value.signature !== 'string' ||
        !verifyTrustedClientChallenge(clientProfile, challenge, value.signature)
      ) {
        socket.destroy();
        return;
      }
      const currentProfile = resolveTrustedClient(clientId);
      if (
        currentProfile === undefined ||
        currentProfile.publicKeySpki !== clientProfile.publicKeySpki
      ) {
        socket.destroy();
        return;
      }
      client = trustedClientContext(currentProfile);
      state = 'ready';
      socket.setTimeout(0);
      writeFrame(socket, { type: 'ready', protocolVersion: PROTOCOL_VERSION });
      onAuthenticated(clientId);
      return;
    }

    const now = Date.now();
    if (now - requestWindowStarted >= 60_000) {
      requestWindowStarted = now;
      requestCount = 0;
    }
    requestCount += 1;
    if (requestCount > MAX_REQUESTS_PER_MINUTE) {
      socket.destroy();
      return;
    }

    let request: RpcRequest;
    try {
      request = parseRpcRequest(value);
    } catch (error) {
      const response: RpcResponse = {
        type: 'response',
        id: isRecord(value) && typeof value.id === 'string' ? value.id.slice(0, 80) : 'invalid',
        ok: false,
        error: safeRpcError(error),
      };
      writeFrame(socket, response);
      return;
    }
    const currentProfile = resolveTrustedClient(clientId);
    if (
      client === undefined ||
      currentProfile === undefined ||
      currentProfile.publicKeySpki !== clientProfile?.publicKeySpki
    ) {
      socket.destroy();
      return;
    }
    client = trustedClientContext(currentProfile);
    try {
      const result = await dispatch(service, permissions, client, request.method, request.params);
      writeFrame(socket, {
        type: 'response',
        id: request.id,
        ok: true,
        result,
      } satisfies RpcResponse);
    } catch (error) {
      writeFrame(socket, {
        type: 'response',
        id: request.id,
        ok: false,
        error: safeRpcError(error),
      } satisfies RpcResponse);
    }
  });
};

const endpointPath = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\htmllelujah-${randomUUID()}`
    : path.join(tmpdir(), `htmllelujah-${randomUUID()}.sock`);

const writeDescriptorAtomic = async (
  descriptorPath: string,
  descriptor: LocalRpcEndpointDescriptor,
): Promise<void> => {
  await mkdir(path.dirname(descriptorPath), { recursive: true });
  const temporary = `${descriptorPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(descriptor)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, descriptorPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
};

const removeDescriptorIfOwned = async (
  descriptorPath: string,
  descriptor: LocalRpcEndpointDescriptor,
): Promise<void> => {
  try {
    const bytes = await readFile(descriptorPath);
    if (bytes.byteLength > 16 * 1024) return;
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      isRecord(value) &&
      value.instanceId === descriptor.instanceId &&
      value.secret === descriptor.secret
    ) {
      await rm(descriptorPath, { force: true });
    }
  } catch {
    // A missing, replaced, or malformed descriptor is not owned by this server anymore.
  }
};

const listen = async (server: Server, pipeName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });

export const startLocalRpcServer = async (input: {
  readonly service: HtmllelujahMcpService;
  readonly permissions?: McpPermissionGate | undefined;
  readonly resolveTrustedClient: (clientId: string) => TrustedClientProfile | undefined;
  readonly descriptorPath: string;
  readonly lifetimeMs?: number | undefined;
  readonly rotationLeadMs?: number | undefined;
}): Promise<LocalRpcServerHandle> => {
  if (!path.isAbsolute(input.descriptorPath)) {
    throw new McpSafeError('INVALID_REQUEST', 'Endpoint descriptor path must be absolute.');
  }
  const lifetimeMs = input.lifetimeMs ?? DEFAULT_DESCRIPTOR_LIFETIME_MS;
  const rotationLeadMs =
    input.rotationLeadMs ?? Math.min(DEFAULT_ROTATION_LEAD_MS, Math.floor(lifetimeMs / 2));
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < MIN_DESCRIPTOR_LIFETIME_MS ||
    !Number.isSafeInteger(rotationLeadMs) ||
    rotationLeadMs < MIN_ROTATION_LEAD_MS ||
    lifetimeMs - rotationLeadMs < MIN_ROTATION_INTERVAL_MS
  ) {
    throw new McpSafeError('INVALID_REQUEST', 'Endpoint rotation timing is invalid.');
  }
  const pipeName = endpointPath();
  const createDescriptor = (): LocalRpcEndpointDescriptor => {
    const createdAtMs = Date.now();
    return {
      protocolVersion: 2,
      pipeName,
      secret: randomBytes(32).toString('hex'),
      instanceId: randomUUID(),
      pid: process.pid,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + lifetimeMs).toISOString(),
    };
  };
  let descriptor = createDescriptor();
  const credentials = new Map<string, { readonly secret: string; readonly expiresAtMs: number }>([
    [
      descriptor.instanceId,
      { secret: descriptor.secret, expiresAtMs: Date.parse(descriptor.expiresAt) },
    ],
  ]);
  const resolveSecret = (instanceId: string): string | undefined => {
    const now = Date.now();
    for (const [candidateId, credential] of credentials) {
      if (credential.expiresAtMs <= now) credentials.delete(candidateId);
    }
    return credentials.get(instanceId)?.secret;
  };
  const usedNonces = new Set<string>();
  const sockets = new Set<Socket>();
  const socketClients = new Map<Socket, string>();
  const permissions = input.permissions ?? FAIL_CLOSED_PERMISSION_GATE;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
      socketClients.delete(socket);
    });
    handleServerSocket(
      socket,
      input.service,
      permissions,
      resolveSecret,
      input.resolveTrustedClient,
      usedNonces,
      (clientId) => socketClients.set(socket, clientId),
    );
  });
  await listen(server, pipeName);
  try {
    await writeDescriptorAtomic(input.descriptorPath, descriptor);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== 'win32') await rm(pipeName, { force: true }).catch(() => undefined);
    throw error;
  }
  let closed = false;
  let rotationTimer: ReturnType<typeof setTimeout> | undefined;
  let rotationTask: Promise<LocalRpcEndpointDescriptor> | undefined;
  const rotationDelayMs = lifetimeMs - rotationLeadMs;
  const beginRotation = (): Promise<LocalRpcEndpointDescriptor> => {
    if (closed) {
      return Promise.reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC server is closed.'));
    }
    if (rotationTask !== undefined) return rotationTask;
    const task = (async () => {
      const now = Date.now();
      for (const [candidateId, credential] of credentials) {
        if (credential.expiresAtMs <= now) credentials.delete(candidateId);
      }
      const replacement = createDescriptor();
      credentials.set(replacement.instanceId, {
        secret: replacement.secret,
        expiresAtMs: Date.parse(replacement.expiresAt),
      });
      try {
        await writeDescriptorAtomic(input.descriptorPath, replacement);
      } catch (error) {
        credentials.delete(replacement.instanceId);
        throw error;
      }
      descriptor = replacement;
      return replacement;
    })();
    rotationTask = task;
    void task.then(
      () => {
        if (rotationTask === task) rotationTask = undefined;
      },
      () => {
        if (rotationTask === task) rotationTask = undefined;
      },
    );
    return task;
  };
  const scheduleRotation = (delayMs: number): void => {
    if (closed) return;
    if (rotationTimer !== undefined) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotationTimer = undefined;
      void beginRotation()
        .then(() => scheduleRotation(rotationDelayMs))
        .catch(() => {
          const remainingMs = Date.parse(descriptor.expiresAt) - Date.now();
          const retryMs = Math.max(50, Math.min(1_000, Math.floor(remainingMs / 2)));
          scheduleRotation(retryMs);
        });
    }, delayMs);
    rotationTimer.unref?.();
  };
  scheduleRotation(rotationDelayMs);
  return {
    get descriptor() {
      return descriptor;
    },
    get connectionCount() {
      return sockets.size;
    },
    get connectedClientIds() {
      return [...new Set(socketClients.values())];
    },
    async rotateCredentials() {
      if (rotationTimer !== undefined) {
        clearTimeout(rotationTimer);
        rotationTimer = undefined;
      }
      try {
        const replacement = await beginRotation();
        scheduleRotation(rotationDelayMs);
        return replacement;
      } catch (error) {
        if (!closed) {
          const remainingMs = Date.parse(descriptor.expiresAt) - Date.now();
          const retryMs = Math.max(50, Math.min(1_000, Math.floor(remainingMs / 2)));
          scheduleRotation(retryMs);
        }
        throw error;
      }
    },
    disconnectClient(clientId) {
      for (const [socket, candidateId] of socketClients) {
        if (candidateId === clientId) socket.destroy();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (rotationTimer !== undefined) clearTimeout(rotationTimer);
      await rotationTask?.catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeDescriptorIfOwned(input.descriptorPath, descriptor);
      if (process.platform !== 'win32') await rm(pipeName, { force: true }).catch(() => undefined);
    },
  };
};

const parseDescriptor = (value: unknown): LocalRpcEndpointDescriptor => {
  if (!isRecord(value))
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is invalid.');
  const allowed = new Set([
    'protocolVersion',
    'pipeName',
    'secret',
    'instanceId',
    'pid',
    'createdAt',
    'expiresAt',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.protocolVersion !== 2 ||
    typeof value.pipeName !== 'string' ||
    typeof value.secret !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.secret) ||
    typeof value.instanceId !== 'string' ||
    typeof value.pid !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= Date.now()
  ) {
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is stale or invalid.');
  }
  return value as unknown as LocalRpcEndpointDescriptor;
};

const readDescriptor = async (descriptorPath: string): Promise<LocalRpcEndpointDescriptor> => {
  let descriptorBytes: Buffer;
  try {
    descriptorBytes = await readFile(descriptorPath);
  } catch {
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is unavailable.');
  }
  if (descriptorBytes.byteLength > 16 * 1024) {
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is too large.');
  }
  let descriptorValue: unknown;
  try {
    descriptorValue = JSON.parse(descriptorBytes.toString('utf8')) as unknown;
  } catch {
    throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is invalid.');
  }
  return parseDescriptor(descriptorValue);
};

const connectSocket = async (pipeName: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local application connection timed out.'));
    }, AUTH_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.off('error', onError);
      resolve(socket);
    });
    const onError = (): void => {
      clearTimeout(timer);
      reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local application connection failed.'));
    };
    socket.once('error', onError);
  });

export class LocalRpcClient implements HtmllelujahMcpService, McpPermissionGate {
  private readonly pending = new Map<
    string,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  private socket: Socket | undefined;
  private descriptor: LocalRpcEndpointDescriptor | undefined;
  private readyPromise: Promise<void> | undefined;
  private removeReader: (() => void) | undefined;
  private closed = false;

  private readonly credential: TrustedClientCredential;

  public constructor(
    private readonly descriptorPath: string,
    credential: TrustedClientCredential,
  ) {
    this.credential = trustedClientCredentialSchema.parse(credential);
  }

  public async connect(): Promise<void> {
    if (this.closed) {
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC client is closed.');
    }
    if (this.readyPromise !== undefined) return this.readyPromise;
    if (this.socket !== undefined && !this.socket.destroyed) return;
    this.readyPromise = this.connectInternal();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = undefined;
    }
  }

  private async connectInternal(): Promise<void> {
    const descriptor = await readDescriptor(this.descriptorPath);
    try {
      await this.connectWithDescriptor(descriptor);
      return;
    } catch (error) {
      if (this.closed) throw error;
      // Atomic replacement can happen after a client reads the file but before
      // it finishes authentication. Retry exactly once only when the endpoint
      // identity actually changed; unchanged or tampered descriptors still
      // fail closed without a timing-based retry loop.
      let replacement: LocalRpcEndpointDescriptor;
      try {
        replacement = await readDescriptor(this.descriptorPath);
      } catch {
        throw error;
      }
      if (
        replacement.instanceId === descriptor.instanceId &&
        replacement.secret === descriptor.secret
      ) {
        throw error;
      }
      await this.connectWithDescriptor(replacement);
    }
  }

  private async connectWithDescriptor(descriptor: LocalRpcEndpointDescriptor): Promise<void> {
    if (this.closed) {
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC client is closed.');
    }
    const socket = await connectSocket(descriptor.pipeName);
    if (this.closed) {
      socket.destroy();
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC client is closed.');
    }
    socket.setNoDelay(true);
    this.socket = socket;
    this.descriptor = descriptor;

    const clientNonce = randomBytes(32).toString('hex');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.off('close', fail);
        socket.off('error', fail);
        this.removeReader?.();
        this.removeReader = undefined;
        if (this.socket === socket) this.socket = undefined;
        this.descriptor = undefined;
        reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local authentication failed.'));
      };
      const timeout = setTimeout(() => {
        fail();
        socket.destroy();
      }, AUTH_TIMEOUT_MS);
      socket.once('close', fail);
      socket.once('error', fail);
      let state: 'challenge' | 'ready' = 'challenge';
      this.removeReader = createLineReader(socket, (value) => {
        try {
          if (state === 'challenge') {
            if (
              !isRecord(value) ||
              Object.keys(value).length !== 3 ||
              Object.keys(value).some((key) => !['type', 'serverNonce', 'proof'].includes(key)) ||
              value.type !== 'challenge' ||
              typeof value.serverNonce !== 'string' ||
              !/^[0-9a-f]{64}$/u.test(value.serverNonce) ||
              typeof value.proof !== 'string'
            ) {
              throw new Error('Invalid challenge.');
            }
            const expected = hmac(
              descriptor.secret,
              `server|${transcript(
                descriptor.instanceId,
                this.credential.clientId,
                clientNonce,
                value.serverNonce,
              )}`,
            );
            if (!constantEqualHex(value.proof, expected)) {
              throw new Error('Invalid endpoint proof.');
            }
            const signature = signTrustedClientChallenge(
              this.credential,
              transcript(
                descriptor.instanceId,
                this.credential.clientId,
                clientNonce,
                value.serverNonce,
              ),
            );
            writeFrame(socket, { type: 'authenticate', signature });
            state = 'ready';
            return;
          }
          if (
            !isRecord(value) ||
            Object.keys(value).length !== 2 ||
            Object.keys(value).some((key) => !['type', 'protocolVersion'].includes(key)) ||
            value.type !== 'ready' ||
            value.protocolVersion !== 2
          ) {
            throw new Error('Invalid readiness frame.');
          }
          settled = true;
          clearTimeout(timeout);
          socket.off('close', fail);
          socket.off('error', fail);
          this.removeReader?.();
          this.removeReader = createLineReader(socket, (message) => this.handleResponse(message));
          resolve();
        } catch {
          fail();
          socket.destroy();
        }
      });
      writeFrame(socket, {
        type: 'hello',
        clientNonce,
        instanceId: descriptor.instanceId,
        clientId: this.credential.clientId,
      });
    });
    socket.once('close', () => this.rejectAll());
    socket.once('error', () => this.rejectAll());
  }

  private handleResponse(value: unknown): void {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => !['type', 'id', 'ok', 'result', 'error'].includes(key)) ||
      value.type !== 'response' ||
      typeof value.id !== 'string' ||
      typeof value.ok !== 'boolean'
    ) {
      this.socket?.destroy();
      return;
    }
    const pending = this.pending.get(value.id);
    if (pending === undefined) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.ok) {
      if ('error' in value) {
        this.socket?.destroy();
        pending.reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC response is invalid.'));
        return;
      }
      pending.resolve(value.result);
    } else {
      if ('result' in value) {
        this.socket?.destroy();
        pending.reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC response is invalid.'));
        return;
      }
      const error = isRecord(value.error) ? value.error : {};
      if (
        Object.keys(error).length !== 2 ||
        Object.keys(error).some((key) => !['code', 'message'].includes(key)) ||
        typeof error.code !== 'string' ||
        typeof error.message !== 'string'
      ) {
        this.socket?.destroy();
        pending.reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local RPC response is invalid.'));
        return;
      }
      const code = [
        'MCP_UNAUTHORIZED',
        'APPROVAL_REQUIRED',
        'APPROVAL_EXPIRED',
        'REVISION_CONFLICT',
        'NOT_FOUND',
        'INVALID_REQUEST',
        'SERVICE_UNAVAILABLE',
      ].includes(error.code)
        ? (error.code as ConstructorParameters<typeof McpSafeError>[0])
        : 'SERVICE_UNAVAILABLE';
      pending.reject(new McpSafeError(code, error.message));
    }
  }

  private rejectAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local application disconnected.'));
    }
    this.pending.clear();
    this.removeReader?.();
    this.removeReader = undefined;
    this.socket = undefined;
    this.descriptor = undefined;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.rejectAll();
  }

  private async call(method: RpcMethod, params: unknown = {}): Promise<unknown> {
    await this.connect();
    const socket = this.socket;
    if (socket === undefined)
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Local app is unavailable.');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpSafeError('SERVICE_UNAVAILABLE', 'Local operation timed out.'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        writeFrame(socket, { type: 'request', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Local operation failed.'));
      }
    });
  }

  public async appStatus(): Promise<SafeRecord> {
    return (await this.call('appStatus')) as SafeRecord;
  }
  public async listOpenDocuments(): Promise<readonly SafeRecord[]> {
    return (await this.call('listOpenDocuments')) as readonly SafeRecord[];
  }
  public async getDocumentOutline(documentId: string): Promise<SafeRecord> {
    return (await this.call('getDocumentOutline', { documentId })) as SafeRecord;
  }
  public async getSlide(documentId: string, slideId: string): Promise<SafeRecord> {
    return (await this.call('getSlide', { documentId, slideId })) as SafeRecord;
  }
  public async getStyleCatalog(documentId: string): Promise<SafeRecord> {
    return (await this.call('getStyleCatalog', { documentId })) as SafeRecord;
  }
  public async getDesignContext(input: DesignContextInput): Promise<SafeRecord> {
    return (await this.call('getDesignContext', input)) as SafeRecord;
  }
  public async validateDocument(documentId: string): Promise<SafeRecord> {
    return (await this.call('validateDocument', { documentId })) as SafeRecord;
  }
  public async proposeCommands(input: ProposeCommandsInput) {
    return (await this.call('proposeCommands', input)) as Awaited<
      ReturnType<HtmllelujahMcpService['proposeCommands']>
    >;
  }
  public async proposeDesignOperations(input: ProposeDesignOperationsInput) {
    return (await this.call('proposeDesignOperations', input)) as Awaited<
      ReturnType<HtmllelujahMcpService['proposeDesignOperations']>
    >;
  }
  public async commitProposal(input: CommitProposalInput) {
    return (await this.call('commitProposal', input)) as Awaited<
      ReturnType<HtmllelujahMcpService['commitProposal']>
    >;
  }
  public async undoAgentTransaction(input: TransactionTargetInput) {
    return (await this.call('undoAgentTransaction', input)) as Awaited<
      ReturnType<HtmllelujahMcpService['undoAgentTransaction']>
    >;
  }
  public async importAsset(input: ImportAssetInput): Promise<SafeRecord> {
    return (await this.call('importAsset', input)) as SafeRecord;
  }
  public async exportDocument(input: ExportDocumentInput): Promise<SafeRecord> {
    return (await this.call('exportDocument', input)) as SafeRecord;
  }
  public async collaborationStatus(documentId: string): Promise<SafeRecord> {
    return (await this.call('collaborationStatus', { documentId })) as SafeRecord;
  }

  public async canRead(documentId: string): Promise<boolean> {
    return this.callPermission('canRead', { documentId });
  }

  public async canEdit(documentId: string): Promise<boolean> {
    return this.callPermission('canEdit', { documentId });
  }

  public async consumeApproval(
    input: Parameters<McpPermissionGate['consumeApproval']>[0],
  ): Promise<boolean> {
    return this.callPermission('consumeApproval', input);
  }

  private async callPermission(method: 'canRead' | 'canEdit' | 'consumeApproval', params: unknown) {
    const result = await this.call(method, params);
    if (typeof result !== 'boolean') {
      this.socket?.destroy();
      throw new McpSafeError(
        'SERVICE_UNAVAILABLE',
        'The local permission service returned invalid data.',
      );
    }
    return result;
  }
}

export interface DescriptorStdioStreams {
  readonly stdin?: Readable | undefined;
  readonly stdout?: Writable | undefined;
}

/**
 * Runs an MCP stdio bridge backed by the authenticated desktop RPC endpoint.
 *
 * The supplied stdout is owned exclusively by the MCP transport. This function
 * deliberately performs no logging so protocol frames are never mixed with
 * diagnostic text.
 */
export const runHtmllelujahMcpStdioFromDescriptor = async (
  descriptorPath: string,
  credential: TrustedClientCredential,
  streams: DescriptorStdioStreams = {},
): Promise<void> => {
  if (!path.isAbsolute(descriptorPath)) {
    throw new McpSafeError('INVALID_REQUEST', 'Endpoint descriptor path must be absolute.');
  }

  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  const rpc = new LocalRpcClient(descriptorPath, credential);
  const mcp = createHtmllelujahMcpServer(rpc, rpc);
  const transport = new StdioServerTransport(stdin, stdout);

  let resolveClosed: (() => void) | undefined;
  let terminalError: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const fail = (error: Error): void => {
    terminalError ??= error;
    resolveClosed?.();
  };
  const closeTransport = (): void => {
    void transport.close().catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error('The MCP stdio transport failed to close.'));
    });
  };
  const onInputError = (error: Error): void => fail(error);

  transport.onclose = () => resolveClosed?.();
  transport.onerror = (error) => fail(error);
  stdin.once('end', closeTransport);
  stdin.once('close', closeTransport);
  stdin.once('error', onInputError);

  try {
    await rpc.connect();
    if (terminalError !== undefined) throw terminalError;
    await mcp.connect(transport);
    if (stdin.readableEnded || stdin.destroyed) closeTransport();
    await closed;
    if (terminalError !== undefined) throw terminalError;
  } finally {
    stdin.off('end', closeTransport);
    stdin.off('close', closeTransport);
    stdin.off('error', onInputError);
    await Promise.allSettled([mcp.close(), rpc.close()]);
  }
};
