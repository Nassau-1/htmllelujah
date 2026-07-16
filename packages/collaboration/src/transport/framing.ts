import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import WebSocket from 'ws';

import { COLLABORATION_PROTOCOL_VERSION } from '../contracts.js';
import { transportChunkSchema, type TransportChunk } from './protocol.js';

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
// A supported .hdeck may contain 32 MiB of document JSON. Reserve one MiB for
// the resync protocol envelope so every valid V1 document can cross the wire.
export const DEFAULT_MAX_LOGICAL_PAYLOAD_BYTES = 33 * 1024 * 1024;
export const DEFAULT_MAX_REASSEMBLY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4;
export const DEFAULT_CHUNK_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
// Base64url framing expands a full logical payload by roughly one third.
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SEND_TIMEOUT_MS = 5_000;
export const MAX_CHUNKS_PER_TRANSFER = 65_536;
const MAX_COMPLETED_TRANSFER_IDS = 4_096;

export type TransportStream = 'client' | 'server';

export type TransportFramingErrorCode =
  | 'BACKPRESSURE_LIMIT'
  | 'CHUNK_TIMEOUT'
  | 'DUPLICATE_CHUNK'
  | 'FRAME_TOO_SMALL'
  | 'HASH_MISMATCH'
  | 'LOGICAL_PAYLOAD_TOO_LARGE'
  | 'MALFORMED_CHUNK'
  | 'REASSEMBLY_LIMIT'
  | 'SEND_TIMEOUT'
  | 'SOCKET_CLOSED';

export class TransportFramingError extends Error {
  public constructor(
    public readonly code: TransportFramingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TransportFramingError';
  }
}

export interface FramingLimits {
  readonly maxFrameBytes: number;
  readonly maxLogicalPayloadBytes: number;
  readonly maxReassemblyBytes: number;
  readonly maxConcurrentTransfers: number;
  readonly chunkTimeoutMs: number;
}

export interface SenderLimits {
  readonly maxFrameBytes: number;
  readonly maxLogicalPayloadBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxQueuedBytes: number;
  readonly sendTimeoutMs: number;
}

const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('base64url');

const chunkMac = (secret: Uint8Array, chunk: Omit<TransportChunk, 'mac'>): string =>
  createHmac('sha256', secret)
    .update('htmllelujah-collaboration-chunk-v1\0')
    .update(chunk.stream)
    .update('\0')
    .update(chunk.transferId)
    .update('\0')
    .update(String(chunk.index))
    .update('\0')
    .update(String(chunk.totalChunks))
    .update('\0')
    .update(String(chunk.totalBytes))
    .update('\0')
    .update(chunk.sha256)
    .update('\0')
    .update(chunk.data)
    .digest('base64url');

const equalMac = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const encodedChunkCapacity = (maxFrameBytes: number, stream: TransportStream): number => {
  const envelope = {
    type: 'transport.chunk',
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    stream,
    transferId: '00000000-0000-4000-8000-000000000000',
    index: MAX_CHUNKS_PER_TRANSFER - 1,
    totalChunks: MAX_CHUNKS_PER_TRANSFER,
    totalBytes: Number.MAX_SAFE_INTEGER,
    sha256: 'A'.repeat(43),
    data: '',
    mac: 'A'.repeat(43),
  } as const;
  const overhead = Buffer.byteLength(JSON.stringify(envelope));
  const available = maxFrameBytes - overhead;
  // Base64url uses at most ceil(4n/3) bytes. Keep a small rounding margin.
  return Math.floor((available - 4) * 0.75);
};

export const encodeLogicalMessage = (
  value: unknown,
  options: {
    readonly stream: TransportStream;
    readonly secret: Uint8Array;
    readonly transferId: string;
    readonly maxFrameBytes: number;
    readonly maxLogicalPayloadBytes: number;
  },
): readonly string[] => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') {
    throw new TransportFramingError('MALFORMED_CHUNK', 'Logical payload is not JSON serializable.');
  }
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.byteLength > options.maxLogicalPayloadBytes) {
    throw new TransportFramingError(
      'LOGICAL_PAYLOAD_TOO_LARGE',
      `Logical payload is ${bytes.byteLength} bytes; limit is ${options.maxLogicalPayloadBytes}.`,
    );
  }
  const capacity = encodedChunkCapacity(options.maxFrameBytes, options.stream);
  if (capacity < 1) {
    throw new TransportFramingError(
      'FRAME_TOO_SMALL',
      'The frame limit is too small for the authenticated chunk envelope.',
    );
  }
  const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / capacity));
  if (totalChunks > MAX_CHUNKS_PER_TRANSFER) {
    throw new TransportFramingError(
      'LOGICAL_PAYLOAD_TOO_LARGE',
      'Logical payload requires too many transport chunks.',
    );
  }
  const sha256 = digest(bytes);
  const frames: string[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const data = bytes
      .subarray(index * capacity, Math.min((index + 1) * capacity, bytes.byteLength))
      .toString('base64url');
    const unsigned = {
      type: 'transport.chunk',
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      stream: options.stream,
      transferId: options.transferId,
      index,
      totalChunks,
      totalBytes: bytes.byteLength,
      sha256,
      data,
    } as const;
    const frame = JSON.stringify({ ...unsigned, mac: chunkMac(options.secret, unsigned) });
    if (Buffer.byteLength(frame) > options.maxFrameBytes) {
      throw new TransportFramingError('FRAME_TOO_SMALL', 'Encoded chunk exceeds frame limit.');
    }
    frames.push(frame);
  }
  return frames;
};

interface PartialTransfer {
  readonly totalChunks: number;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly chunks: Buffer[];
  readonly timer: ReturnType<typeof setTimeout>;
  nextIndex: number;
  receivedBytes: number;
}

export class ChunkReassembler {
  private readonly transfers = new Map<string, PartialTransfer>();
  private readonly completedTransfers = new Map<string, number>();
  private reservedBytes = 0;
  private disposed = false;

  public constructor(
    private readonly options: FramingLimits & {
      readonly stream: TransportStream;
      readonly secret: Uint8Array;
      readonly clock?: () => number;
      readonly onTimeout: (error: TransportFramingError) => void;
    },
  ) {}

  public accept(raw: unknown): string | undefined {
    if (this.disposed) {
      throw new TransportFramingError('SOCKET_CLOSED', 'Chunk reassembler is closed.');
    }
    this.purgeCompleted();
    const parsed = transportChunkSchema.safeParse(raw);
    if (!parsed.success || parsed.data.stream !== this.options.stream) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Malformed transport chunk.');
    }
    const chunk = parsed.data;
    const { mac: suppliedMac, ...unsigned } = chunk;
    if (!equalMac(suppliedMac, chunkMac(this.options.secret, unsigned))) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Chunk authentication failed.');
    }
    if (chunk.totalBytes > this.options.maxLogicalPayloadBytes) {
      throw new TransportFramingError(
        'LOGICAL_PAYLOAD_TOO_LARGE',
        'Advertised logical payload exceeds the configured limit.',
      );
    }
    if (this.completedTransfers.has(chunk.transferId)) {
      throw new TransportFramingError('DUPLICATE_CHUNK', 'Transfer ID was already completed.');
    }

    let transfer = this.transfers.get(chunk.transferId);
    if (transfer === undefined) {
      if (chunk.index !== 0) {
        throw new TransportFramingError('MALFORMED_CHUNK', 'Transfer must begin at chunk zero.');
      }
      if (this.transfers.size >= this.options.maxConcurrentTransfers) {
        throw new TransportFramingError(
          'REASSEMBLY_LIMIT',
          'Too many concurrent logical payloads.',
        );
      }
      if (this.reservedBytes + chunk.totalBytes > this.options.maxReassemblyBytes) {
        throw new TransportFramingError('REASSEMBLY_LIMIT', 'Reassembly byte budget exceeded.');
      }
      const timer = setTimeout(() => {
        this.drop(chunk.transferId);
        this.options.onTimeout(
          new TransportFramingError('CHUNK_TIMEOUT', 'Chunked payload reassembly timed out.'),
        );
      }, this.options.chunkTimeoutMs);
      timer.unref?.();
      transfer = {
        totalChunks: chunk.totalChunks,
        totalBytes: chunk.totalBytes,
        sha256: chunk.sha256,
        chunks: [],
        timer,
        nextIndex: 0,
        receivedBytes: 0,
      };
      this.transfers.set(chunk.transferId, transfer);
      this.reservedBytes += transfer.totalBytes;
    }
    if (
      transfer.totalChunks !== chunk.totalChunks ||
      transfer.totalBytes !== chunk.totalBytes ||
      transfer.sha256 !== chunk.sha256
    ) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Chunk metadata changed mid-transfer.');
    }
    if (chunk.index !== transfer.nextIndex) {
      throw new TransportFramingError(
        chunk.index < transfer.nextIndex ? 'DUPLICATE_CHUNK' : 'MALFORMED_CHUNK',
        'Chunk order is invalid.',
      );
    }
    const decoded = Buffer.from(chunk.data, 'base64url');
    if (decoded.byteLength === 0 || decoded.toString('base64url') !== chunk.data) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Chunk data is not canonical base64url.');
    }
    transfer.receivedBytes += decoded.byteLength;
    if (transfer.receivedBytes > transfer.totalBytes) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Chunk data exceeds declared size.');
    }
    transfer.chunks.push(decoded);
    transfer.nextIndex += 1;
    if (transfer.nextIndex < transfer.totalChunks) return undefined;

    this.drop(chunk.transferId);
    if (transfer.receivedBytes !== transfer.totalBytes) {
      throw new TransportFramingError('MALFORMED_CHUNK', 'Chunk data is shorter than declared.');
    }
    const complete = Buffer.concat(transfer.chunks, transfer.totalBytes);
    if (digest(complete) !== transfer.sha256) {
      throw new TransportFramingError('HASH_MISMATCH', 'Logical payload hash mismatch.');
    }
    if (this.completedTransfers.size >= MAX_COMPLETED_TRANSFER_IDS) {
      throw new TransportFramingError(
        'REASSEMBLY_LIMIT',
        'Completed transfer replay cache capacity exceeded.',
      );
    }
    this.completedTransfers.set(
      chunk.transferId,
      (this.options.clock ?? Date.now)() + this.options.chunkTimeoutMs,
    );
    return complete.toString('utf8');
  }

  public dispose(): void {
    this.disposed = true;
    this.transfers.forEach((transfer) => clearTimeout(transfer.timer));
    this.transfers.clear();
    this.completedTransfers.clear();
    this.reservedBytes = 0;
  }

  private drop(transferId: string): void {
    const transfer = this.transfers.get(transferId);
    if (transfer === undefined) return;
    clearTimeout(transfer.timer);
    this.transfers.delete(transferId);
    this.reservedBytes -= transfer.totalBytes;
  }

  private purgeCompleted(): void {
    const now = (this.options.clock ?? Date.now)();
    this.completedTransfers.forEach((expiresAtMs, transferId) => {
      if (expiresAtMs <= now) this.completedTransfers.delete(transferId);
    });
  }
}

const closeSlowPeer = (socket: WebSocket, reason: string): void => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try {
      socket.close(1013, reason.slice(0, 123));
    } catch {
      socket.terminate();
      return;
    }
    const timer = setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, 100);
    timer.unref?.();
  }
};

export const sendBounded = async (
  socket: WebSocket,
  frame: string,
  limits: Pick<SenderLimits, 'maxFrameBytes' | 'maxBufferedBytes' | 'sendTimeoutMs'>,
): Promise<void> => {
  const byteLength = Buffer.byteLength(frame);
  if (byteLength > limits.maxFrameBytes) {
    throw new TransportFramingError('FRAME_TOO_SMALL', 'Outbound frame exceeds frame limit.');
  }
  if (socket.readyState !== WebSocket.OPEN) {
    throw new TransportFramingError('SOCKET_CLOSED', 'WebSocket is not open.');
  }
  if (socket.bufferedAmount + byteLength > limits.maxBufferedBytes) {
    closeSlowPeer(socket, 'Backpressure limit');
    throw new TransportFramingError('BACKPRESSURE_LIMIT', 'Peer exceeded buffer high-water mark.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      closeSlowPeer(socket, 'Send timeout');
      reject(new TransportFramingError('SEND_TIMEOUT', 'Peer did not accept data in time.'));
    }, limits.sendTimeoutMs);
    timer.unref?.();
    try {
      socket.send(frame, (error) => {
        clearTimeout(timer);
        if (error == null) resolve();
        else reject(error);
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
};

export class BoundedSender {
  private tail: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private closed = false;

  public constructor(
    private readonly socket: WebSocket,
    private readonly options: SenderLimits & {
      readonly stream: TransportStream;
      readonly secret: Uint8Array;
      readonly idFactory: () => string;
    },
  ) {}

  public get pendingByteCount(): number {
    return this.queuedBytes;
  }

  public sendRaw(frame: string): Promise<void> {
    return this.enqueue([frame]);
  }

  public sendLogical(value: unknown): Promise<void> {
    if (this.closed) {
      return Promise.reject(new TransportFramingError('SOCKET_CLOSED', 'Sender is closed.'));
    }
    const frames = encodeLogicalMessage(value, {
      stream: this.options.stream,
      secret: this.options.secret,
      transferId: this.options.idFactory(),
      maxFrameBytes: this.options.maxFrameBytes,
      maxLogicalPayloadBytes: this.options.maxLogicalPayloadBytes,
    });
    return this.enqueue(frames);
  }

  public dispose(): void {
    this.closed = true;
  }

  private enqueue(frames: readonly string[]): Promise<void> {
    if (this.closed) {
      return Promise.reject(new TransportFramingError('SOCKET_CLOSED', 'Sender is closed.'));
    }
    const wireBytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0);
    if (this.queuedBytes + wireBytes > this.options.maxQueuedBytes) {
      this.closed = true;
      closeSlowPeer(this.socket, 'Outbound queue limit');
      return Promise.reject(
        new TransportFramingError('BACKPRESSURE_LIMIT', 'Outbound queue byte budget exceeded.'),
      );
    }
    this.queuedBytes += wireBytes;
    const operation = this.tail.then(async () => {
      for (const frame of frames) {
        await sendBounded(this.socket, frame, this.options);
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation.finally(() => {
      this.queuedBytes -= wireBytes;
    });
  }
}
