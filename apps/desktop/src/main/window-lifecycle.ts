import { randomUUID } from 'node:crypto';

import {
  isWindowCloseRelease,
  isWindowCloseRequest,
  isWindowCloseResponse,
  type WindowCloseDecision,
  type WindowCloseRelease,
  type WindowCloseRequest,
} from '../shared/desktop-api.js';

export interface DestroyableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

/** Prevents a failed open/load from leaving an invisible native window behind. */
export const initializeWindowSafely = async <T>(
  window: DestroyableWindow,
  initialize: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> => {
  try {
    return await initialize();
  } catch (error) {
    await cleanup().catch(() => undefined);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
};

/**
 * Runs a user-visible window operation without letting a rejected promise escape. The native
 * window is deliberately retained so its session and recovery journal remain actionable.
 */
export const retainWindowOnFailure = async (
  window: DestroyableWindow,
  operation: () => Promise<void>,
  report: () => Promise<void>,
): Promise<boolean> => {
  try {
    await operation();
    return true;
  } catch {
    if (!window.isDestroyed()) await report().catch(() => undefined);
    return false;
  }
};

/** Releases a renderer close seal only while the prepared window is still retained. */
export const releaseRendererCloseSealIfRetained = (
  window: DestroyableWindow,
  requestId: string,
  release: (value: WindowCloseRelease) => void,
): boolean => {
  const value = { requestId };
  if (window.isDestroyed() || !isWindowCloseRelease(value)) return false;
  try {
    release(Object.freeze(value));
    return true;
  } catch {
    // The renderer watchdog remains the bounded fallback if WebContents disappears mid-send.
    return false;
  }
};

/**
 * Completes a close attempt that already consumed a renderer `ready` response. Cancelled dialogs,
 * failed saves, and collaboration errors all retain the window and therefore release that exact
 * renderer generation. A successfully destroyed window never receives a release.
 */
export const retainWindowAfterRendererClosePreparation = async (
  window: DestroyableWindow,
  requestId: string,
  operation: () => Promise<void>,
  report: () => Promise<void>,
  release: (value: WindowCloseRelease) => void,
): Promise<boolean> => {
  const completed = await retainWindowOnFailure(window, operation, report);
  releaseRendererCloseSealIfRetained(window, requestId, release);
  return completed;
};

/**
 * Cleans a replacement session only while it remains detached from every native window.
 * Ownership is checked both before asynchronous preparation and immediately before close so a
 * stale operation cannot tear down a session that another assignment made visible meanwhile.
 */
export const cleanupSessionIfUnowned = async (
  hasWindowOwner: () => boolean,
  prepare: () => Promise<void>,
  close: () => Promise<void>,
): Promise<boolean> => {
  if (hasWindowOwner()) return false;
  await prepare();
  if (hasWindowOwner()) return false;
  await close();
  return true;
};

/**
 * Exposes a close authorization only for the synchronous native close dispatch. The close event
 * may consume it during dispatch; every throw or no-event return revokes it before a later retry.
 */
export const runAuthorizedWindowClose = (
  preparedCloses: Map<number, string>,
  webContentsId: number,
  requestId: string,
  close: () => void,
): boolean => {
  preparedCloses.set(webContentsId, requestId);
  try {
    close();
    return !preparedCloses.has(webContentsId);
  } finally {
    if (preparedCloses.get(webContentsId) === requestId) {
      preparedCloses.delete(webContentsId);
    }
  }
};

const DEFAULT_CLOSE_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_CLOSE_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_CLOSE_HANDSHAKES = 64;
const MAX_PENDING_CLOSE_HANDSHAKES = 1_024;

export type RendererCloseHandshakeReason =
  | 'renderer-ready'
  | 'renderer-blocked'
  | 'timeout'
  | 'send-failed'
  | 'cancelled'
  | 'capacity'
  | 'invalid-target'
  | 'invalid-request-id';

export interface RendererCloseHandshakeResult {
  readonly decision: WindowCloseDecision;
  readonly reason: RendererCloseHandshakeReason;
  readonly requestId?: string | undefined;
}

export interface RendererCloseHandshakeBrokerOptions {
  readonly timeoutMs?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly createRequestId?: (() => string) | undefined;
}

type PendingCloseHandshake = {
  readonly request: WindowCloseRequest;
  readonly promise: Promise<RendererCloseHandshakeResult>;
  readonly resolve: (result: RendererCloseHandshakeResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const boundedInteger = (value: number, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
};

const blockedResult = (
  reason: Exclude<RendererCloseHandshakeReason, 'renderer-ready'>,
  requestId?: string,
): RendererCloseHandshakeResult => ({
  decision: 'blocked',
  reason,
  ...(requestId === undefined ? {} : { requestId }),
});

/**
 * Coordinates one renderer flush request per native window. Only a schema-valid response from
 * the exact WebContents and unguessable request nonce can release the close. Every other path is
 * fail-closed and bounded by a timer so an unresponsive renderer cannot strand broker state.
 */
export class RendererCloseHandshakeBroker {
  readonly #timeoutMs: number;
  readonly #maxPending: number;
  readonly #now: () => number;
  readonly #createRequestId: () => string;
  readonly #pending = new Map<number, PendingCloseHandshake>();

  public constructor(options: RendererCloseHandshakeBrokerOptions = {}) {
    this.#timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_CLOSE_HANDSHAKE_TIMEOUT_MS,
      1,
      MAX_CLOSE_HANDSHAKE_TIMEOUT_MS,
      'Close handshake timeout',
    );
    this.#maxPending = boundedInteger(
      options.maxPending ?? DEFAULT_MAX_PENDING_CLOSE_HANDSHAKES,
      1,
      MAX_PENDING_CLOSE_HANDSHAKES,
      'Pending close handshake limit',
    );
    this.#now = options.now ?? Date.now;
    this.#createRequestId = options.createRequestId ?? randomUUID;
  }

  public get pendingCount(): number {
    return this.#pending.size;
  }

  public request(
    webContentsId: number,
    send: (request: WindowCloseRequest) => void,
  ): Promise<RendererCloseHandshakeResult> {
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
      return Promise.resolve(blockedResult('invalid-target'));
    }
    const existing = this.#pending.get(webContentsId);
    if (existing !== undefined) return existing.promise;
    if (this.#pending.size >= this.#maxPending) {
      return Promise.resolve(blockedResult('capacity'));
    }

    const request = {
      requestId: this.#createRequestId(),
      deadlineAtMs: this.#now() + this.#timeoutMs,
    };
    if (!isWindowCloseRequest(request)) {
      return Promise.resolve(blockedResult('invalid-request-id'));
    }

    let resolve!: (result: RendererCloseHandshakeResult) => void;
    const promise = new Promise<RendererCloseHandshakeResult>((done) => {
      resolve = done;
    });
    const pending: PendingCloseHandshake = {
      request: Object.freeze(request),
      promise,
      resolve,
      timer: undefined,
    };
    this.#pending.set(webContentsId, pending);
    pending.timer = setTimeout(() => {
      this.#settle(webContentsId, request.requestId, blockedResult('timeout', request.requestId));
    }, this.#timeoutMs);

    try {
      send(pending.request);
    } catch {
      this.#settle(
        webContentsId,
        request.requestId,
        blockedResult('send-failed', request.requestId),
      );
    }
    return promise;
  }

  public receive(webContentsId: number, value: unknown): boolean {
    if (!isWindowCloseResponse(value)) return false;
    const pending = this.#pending.get(webContentsId);
    if (pending === undefined || pending.request.requestId !== value.requestId) return false;
    if (this.#now() >= pending.request.deadlineAtMs) {
      this.#settle(
        webContentsId,
        pending.request.requestId,
        blockedResult('timeout', pending.request.requestId),
      );
      return false;
    }
    return this.#settle(
      webContentsId,
      pending.request.requestId,
      value.decision === 'ready'
        ? {
            decision: 'ready',
            reason: 'renderer-ready',
            requestId: pending.request.requestId,
          }
        : blockedResult('renderer-blocked', pending.request.requestId),
    );
  }

  public cancel(webContentsId: number): boolean {
    const pending = this.#pending.get(webContentsId);
    return pending === undefined
      ? false
      : this.#settle(
          webContentsId,
          pending.request.requestId,
          blockedResult('cancelled', pending.request.requestId),
        );
  }

  public dispose(): void {
    for (const webContentsId of [...this.#pending.keys()]) this.cancel(webContentsId);
  }

  #settle(webContentsId: number, requestId: string, result: RendererCloseHandshakeResult): boolean {
    const pending = this.#pending.get(webContentsId);
    if (pending === undefined || pending.request.requestId !== requestId) return false;
    this.#pending.delete(webContentsId);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }
}
