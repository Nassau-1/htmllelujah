import { describe, expect, it } from 'vitest';

import {
  CdpCommandTimeoutError,
  CdpSession,
  HarnessTimeoutError,
  fetchJsonWithTimeout,
  runtimeWindowFingerprint,
  sameRuntimeWindows,
  waitFor,
} from '../scripts/system-export-harness.mjs';

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  send(value) {
    this.sent.push(value);
  }
}

class NeverConnectingSocket extends EventTarget {
  static lastInstance;
  readyState = 0;

  constructor() {
    super();
    NeverConnectingSocket.lastInstance = this;
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

describe('system export harness deadlines', () => {
  it('bounds an operation that never resolves by the overall wait budget', async () => {
    const startedAt = performance.now();
    await expect(waitFor(() => new Promise(() => undefined), 30, 'hung operation')).rejects.toThrow(
      HarnessTimeoutError,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('aborts a fetch whose response never arrives', async () => {
    let aborted = false;
    const hangingFetch = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    await expect(
      fetchJsonWithTimeout('http://127.0.0.1:1/json/list', 30, 'hung fetch', hangingFetch),
    ).rejects.toThrow(HarnessTimeoutError);
    expect(aborted).toBe(true);
  });

  it('times out a CDP command, clears the session, and closes its socket', async () => {
    const socket = new FakeSocket();
    const session = new CdpSession(socket, { commandTimeoutMs: 30 });
    await expect(session.send('Runtime.evaluate')).rejects.toThrow(CdpCommandTimeoutError);
    expect(socket.readyState).toBe(3);
    await expect(session.send('Page.enable')).rejects.toThrow('CDP is not open');
  });

  it('bounds and closes a CDP connection that never opens', async () => {
    await expect(
      CdpSession.connect('ws://127.0.0.1:1', {
        timeoutMs: 30,
        WebSocketImplementation: NeverConnectingSocket,
      }),
    ).rejects.toThrow(CdpCommandTimeoutError);
    expect(NeverConnectingSocket.lastInstance?.readyState).toBe(3);
  });
});

describe('system export harness window identity', () => {
  const baseline = {
    topLevelWindowCount: 2,
    visibleWindowCount: 1,
    topLevelWindows: [
      { handle: '0000000000000002', processId: 20, visible: false },
      { handle: '0000000000000001', processId: 10, visible: true },
    ],
  };

  it('is stable across enumeration order only', () => {
    const reordered = { ...baseline, topLevelWindows: [...baseline.topLevelWindows].reverse() };
    expect(runtimeWindowFingerprint(reordered)).toBe(runtimeWindowFingerprint(baseline));
    expect(sameRuntimeWindows(baseline, reordered)).toBe(true);
  });

  it('rejects a replacement handle even when aggregate counts are unchanged', () => {
    const replacement = {
      ...baseline,
      topLevelWindows: [
        baseline.topLevelWindows[0],
        { handle: '0000000000000003', processId: 10, visible: true },
      ],
    };
    expect(sameRuntimeWindows(baseline, replacement)).toBe(false);
  });

  it('rejects a visibility change even when handles and counts otherwise match', () => {
    const visibilityChanged = {
      ...baseline,
      visibleWindowCount: 0,
      topLevelWindows: baseline.topLevelWindows.map((window) => ({ ...window, visible: false })),
    };
    expect(sameRuntimeWindows(baseline, visibilityChanged)).toBe(false);
  });
});
