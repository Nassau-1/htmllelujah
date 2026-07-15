import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  CommitProposalInput,
  ExportDocumentInput,
  ImportAssetInput,
  ProposeCommandsInput,
  TransactionTargetInput,
} from './contracts.js';
import { McpSafeError, type HtmllelujahMcpService, type SafeRecord } from './service.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REQUESTS_PER_MINUTE = 120;

export interface LocalRpcEndpointDescriptor {
  readonly protocolVersion: 1;
  readonly pipeName: string;
  readonly secret: string;
  readonly instanceId: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface LocalRpcServerHandle {
  readonly descriptor: LocalRpcEndpointDescriptor;
  close(): Promise<void>;
}

type RpcMethod =
  | 'appStatus'
  | 'listOpenDocuments'
  | 'getDocumentOutline'
  | 'getSlide'
  | 'getStyleCatalog'
  | 'validateDocument'
  | 'proposeCommands'
  | 'commitProposal'
  | 'undoAgentTransaction'
  | 'importAsset'
  | 'exportDocument'
  | 'collaborationStatus';

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
  'validateDocument',
  'proposeCommands',
  'commitProposal',
  'undoAgentTransaction',
  'importAsset',
  'exportDocument',
  'collaborationStatus',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hmac = (secret: string, value: string): string =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(value).digest('hex');

const constantEqualHex = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/u.test(left) || !/^[0-9a-f]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};

const transcript = (clientNonce: string, serverNonce: string): string =>
  `htmllelujah-rpc-v1|${clientNonce}|${serverNonce}`;

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

const requireObject = (params: unknown): Record<string, unknown> => {
  if (!isRecord(params)) throw new McpSafeError('INVALID_REQUEST', 'RPC parameters are invalid.');
  return params;
};

const requireString = (params: Record<string, unknown>, key: string): string => {
  const value = params[key];
  if (typeof value !== 'string')
    throw new McpSafeError('INVALID_REQUEST', 'RPC parameter is invalid.');
  return value;
};

const dispatch = async (
  service: HtmllelujahMcpService,
  method: RpcMethod,
  params: unknown,
): Promise<unknown> => {
  switch (method) {
    case 'appStatus':
      return service.appStatus();
    case 'listOpenDocuments':
      return service.listOpenDocuments();
    case 'getDocumentOutline': {
      const record = requireObject(params);
      return service.getDocumentOutline(requireString(record, 'documentId'));
    }
    case 'getSlide': {
      const record = requireObject(params);
      return service.getSlide(
        requireString(record, 'documentId'),
        requireString(record, 'slideId'),
      );
    }
    case 'getStyleCatalog': {
      const record = requireObject(params);
      return service.getStyleCatalog(requireString(record, 'documentId'));
    }
    case 'validateDocument': {
      const record = requireObject(params);
      return service.validateDocument(requireString(record, 'documentId'));
    }
    case 'proposeCommands':
      return service.proposeCommands(requireObject(params) as unknown as ProposeCommandsInput);
    case 'commitProposal':
      return service.commitProposal(requireObject(params) as unknown as CommitProposalInput);
    case 'undoAgentTransaction':
      return service.undoAgentTransaction(
        requireObject(params) as unknown as TransactionTargetInput,
      );
    case 'importAsset':
      return service.importAsset(requireObject(params) as unknown as ImportAssetInput);
    case 'exportDocument':
      return service.exportDocument(requireObject(params) as unknown as ExportDocumentInput);
    case 'collaborationStatus': {
      const record = requireObject(params);
      return service.collaborationStatus(requireString(record, 'documentId'));
    }
  }
};

const parseRpcRequest = (value: unknown): RpcRequest => {
  if (!isRecord(value)) throw new McpSafeError('INVALID_REQUEST', 'RPC request is invalid.');
  const keys = Object.keys(value);
  if (
    keys.some((key) => !['type', 'id', 'method', 'params'].includes(key)) ||
    value.type !== 'request' ||
    typeof value.id !== 'string' ||
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
  secret: string,
  usedNonces: Set<string>,
): void => {
  socket.setNoDelay(true);
  socket.setTimeout(AUTH_TIMEOUT_MS, () => socket.destroy());
  let state: 'hello' | 'authenticate' | 'ready' = 'hello';
  let clientNonce = '';
  let serverNonce = '';
  let requestWindowStarted = Date.now();
  let requestCount = 0;

  createLineReader(socket, async (value) => {
    if (state === 'hello') {
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !['type', 'clientNonce'].includes(key)) ||
        value.type !== 'hello' ||
        typeof value.clientNonce !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(value.clientNonce) ||
        usedNonces.has(value.clientNonce)
      ) {
        socket.destroy();
        return;
      }
      clientNonce = value.clientNonce;
      usedNonces.add(clientNonce);
      if (usedNonces.size > 4096) usedNonces.delete(usedNonces.values().next().value ?? '');
      serverNonce = randomBytes(32).toString('hex');
      const proof = hmac(secret, `server|${transcript(clientNonce, serverNonce)}`);
      writeFrame(socket, { type: 'challenge', serverNonce, proof });
      state = 'authenticate';
      return;
    }
    if (state === 'authenticate') {
      const expected = hmac(secret, `client|${transcript(clientNonce, serverNonce)}`);
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !['type', 'proof'].includes(key)) ||
        value.type !== 'authenticate' ||
        typeof value.proof !== 'string' ||
        !constantEqualHex(value.proof, expected)
      ) {
        socket.destroy();
        return;
      }
      state = 'ready';
      socket.setTimeout(0);
      writeFrame(socket, { type: 'ready', protocolVersion: PROTOCOL_VERSION });
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
    try {
      const result = await dispatch(service, request.method, request.params);
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
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(descriptor)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, descriptorPath);
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
  readonly descriptorPath: string;
  readonly lifetimeMs?: number | undefined;
}): Promise<LocalRpcServerHandle> => {
  if (!path.isAbsolute(input.descriptorPath)) {
    throw new McpSafeError('INVALID_REQUEST', 'Endpoint descriptor path must be absolute.');
  }
  const secret = randomBytes(32).toString('hex');
  const pipeName = endpointPath();
  const createdAt = new Date();
  const descriptor: LocalRpcEndpointDescriptor = {
    protocolVersion: 1,
    pipeName,
    secret,
    instanceId: randomUUID(),
    pid: process.pid,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(
      createdAt.getTime() + (input.lifetimeMs ?? 24 * 60 * 60 * 1000),
    ).toISOString(),
  };
  const usedNonces = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    handleServerSocket(socket, input.service, secret, usedNonces);
  });
  await listen(server, pipeName);
  try {
    await writeDescriptorAtomic(input.descriptorPath, descriptor);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  let closed = false;
  return {
    descriptor,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(input.descriptorPath, { force: true }).catch(() => undefined);
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
    value.protocolVersion !== 1 ||
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

export class LocalRpcClient implements HtmllelujahMcpService {
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

  public constructor(private readonly descriptorPath: string) {}

  public async connect(): Promise<void> {
    if (this.socket !== undefined) return;
    if (this.readyPromise !== undefined) return this.readyPromise;
    this.readyPromise = this.connectInternal();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = undefined;
    }
  }

  private async connectInternal(): Promise<void> {
    const descriptorBytes = await readFile(this.descriptorPath);
    if (descriptorBytes.byteLength > 16 * 1024) {
      throw new McpSafeError('SERVICE_UNAVAILABLE', 'Endpoint descriptor is too large.');
    }
    const descriptor = parseDescriptor(JSON.parse(descriptorBytes.toString('utf8')) as unknown);
    const socket = await connectSocket(descriptor.pipeName);
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
              value.type !== 'challenge' ||
              typeof value.serverNonce !== 'string' ||
              typeof value.proof !== 'string'
            ) {
              throw new Error('Invalid challenge.');
            }
            const expected = hmac(
              descriptor.secret,
              `server|${transcript(clientNonce, value.serverNonce)}`,
            );
            if (!constantEqualHex(value.proof, expected)) {
              throw new Error('Invalid endpoint proof.');
            }
            const proof = hmac(
              descriptor.secret,
              `client|${transcript(clientNonce, value.serverNonce)}`,
            );
            writeFrame(socket, { type: 'authenticate', proof });
            state = 'ready';
            return;
          }
          if (!isRecord(value) || value.type !== 'ready' || value.protocolVersion !== 1) {
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
      writeFrame(socket, { type: 'hello', clientNonce });
    });
    socket.once('close', () => this.rejectAll());
    socket.once('error', () => this.rejectAll());
  }

  private handleResponse(value: unknown): void {
    if (
      !isRecord(value) ||
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
    if (value.ok) pending.resolve(value.result);
    else {
      const error = isRecord(value.error) ? value.error : {};
      pending.reject(
        new McpSafeError(
          typeof error.code === 'string' && error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'SERVICE_UNAVAILABLE',
          typeof error.message === 'string' ? error.message : 'Local operation failed.',
        ),
      );
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
  public async validateDocument(documentId: string): Promise<SafeRecord> {
    return (await this.call('validateDocument', { documentId })) as SafeRecord;
  }
  public async proposeCommands(input: ProposeCommandsInput) {
    return (await this.call('proposeCommands', input)) as Awaited<
      ReturnType<HtmllelujahMcpService['proposeCommands']>
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
}
