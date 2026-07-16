export class HarnessTimeoutError extends Error {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = 'HarnessTimeoutError';
  }
}

export class CdpCommandTimeoutError extends HarnessTimeoutError {
  constructor(message, options = undefined) {
    super(message, options);
    this.name = 'CdpCommandTimeoutError';
    this.fatal = true;
  }
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const withTimeout = (operation, timeoutMs, label, onTimeout = undefined) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new HarnessTimeoutError(`${label} timed out.`));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      let cleanupError;
      try {
        onTimeout?.();
      } catch (error) {
        cleanupError = error;
      }
      reject(
        new HarnessTimeoutError(
          `${label} timed out.`,
          cleanupError === undefined ? undefined : { cause: cleanupError },
        ),
      );
    }, timeoutMs);
    Promise.resolve(operation).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
};

export const waitFor = async (operation, timeoutMs, label, pollIntervalMs = 100) => {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
    try {
      const result = await withTimeout(
        Promise.resolve().then(() => operation(remainingMs)),
        remainingMs,
        `${label} attempt`,
      );
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      if (error?.fatal === true) throw error;
      lastError = error;
    }
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - performance.now()));
    if (sleepMs > 0) await sleep(sleepMs);
  }
  throw new HarnessTimeoutError(
    `${label} timed out.${lastError instanceof Error ? ` ${lastError.message}` : ''}`,
    lastError === undefined ? undefined : { cause: lastError },
  );
};

export const fetchJsonWithTimeout = async (
  url,
  timeoutMs,
  label,
  fetchImplementation = globalThis.fetch,
) => {
  const controller = new AbortController();
  const request = Promise.resolve().then(async () => {
    const response = await fetchImplementation(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return response.json();
  });
  return withTimeout(request, timeoutMs, label, () => controller.abort());
};

const closeSocketQuietly = (socket) => {
  try {
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
  } catch {
    // The owning Electron process is terminated by the caller's finally path.
  }
};

export class CdpSession {
  #closed = false;
  #commandTimeoutMs;
  #nextId = 1;
  #pending = new Map();
  #socket;

  static async connect(
    url,
    { timeoutMs = 5_000, commandTimeoutMs = 5_000, WebSocketImplementation } = {},
  ) {
    const Socket = WebSocketImplementation ?? globalThis.WebSocket;
    if (typeof Socket !== 'function') throw new Error('WebSocket is unavailable.');
    const socket = new Socket(url);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        closeSocketQuietly(socket);
        reject(error);
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new CdpSession(socket, { commandTimeoutMs }));
      };
      const onError = () => fail(new Error('CDP WebSocket connection failed.'));
      const onClose = () => fail(new Error('CDP WebSocket closed before connecting.'));
      const timer = setTimeout(
        () => fail(new CdpCommandTimeoutError('CDP WebSocket connection timed out.')),
        timeoutMs,
      );
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });
  }

  constructor(socket, { commandTimeoutMs = 5_000 } = {}) {
    this.#socket = socket;
    this.#commandTimeoutMs = commandTimeoutMs;
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        this.#failPending(new Error('CDP returned an invalid JSON message.'));
        this.close();
        return;
      }
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(`CDP ${pending.method} failed: ${message.error.message}`));
      } else pending.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => {
      this.#closed = true;
      this.#failPending(new Error('CDP WebSocket closed.'));
    });
    socket.addEventListener('error', () => {
      const error = new Error('CDP WebSocket failed.');
      this.#closed = true;
      this.#failPending(error);
      closeSocketQuietly(socket);
    });
  }

  #failPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`${error.message} Waiting for ${pending.method}.`, { cause: error }),
      );
    }
    this.#pending.clear();
  }

  send(method, params = {}, timeoutMs = this.#commandTimeoutMs) {
    if (this.#closed || this.#socket.readyState !== 1) {
      return Promise.reject(new Error(`CDP is not open for ${method}.`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        const error = new CdpCommandTimeoutError(`CDP ${method} timed out after ${timeoutMs} ms.`);
        reject(error);
        this.#closed = true;
        this.#failPending(error);
        closeSocketQuietly(this.#socket);
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(new Error('CDP session closed by the harness.'));
    closeSocketQuietly(this.#socket);
  }
}

export const runtimeWindowFingerprint = (sample) =>
  sample.topLevelWindows
    .map((window) => `${window.handle}:${window.processId}:${window.visible ? '1' : '0'}`)
    .sort()
    .join('|');

export const sameRuntimeWindows = (baseline, sample) =>
  baseline.topLevelWindowCount === sample.topLevelWindowCount &&
  baseline.visibleWindowCount === sample.visibleWindowCount &&
  runtimeWindowFingerprint(baseline) === runtimeWindowFingerprint(sample);
