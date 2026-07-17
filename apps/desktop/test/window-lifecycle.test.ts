import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { describe, expect, it, vi } from 'vitest';

import {
  cleanupSessionIfUnowned,
  RendererCloseHandshakeBroker,
  initializeWindowSafely,
  retainWindowOnFailure,
  runAuthorizedWindowClose,
} from '../src/main/window-lifecycle.js';
import { settleWindowCloseListeners, type WindowCloseRequest } from '../src/shared/desktop-api.js';

const FIRST_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_REQUEST_ID = '22222222-2222-4222-8222-222222222222';

const fakeWindow = () => {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  };
};

describe('native window lifecycle guards', () => {
  it('destroys a hidden window and runs cleanup when corrupt input aborts initialization', async () => {
    const window = fakeWindow();
    const cleanup = vi.fn(async () => undefined);
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-window-lifecycle-'));
    try {
      const targetPath = path.join(directory, 'corrupt.hdeck');
      await writeFile(targetPath, Buffer.from('not an hdeck archive', 'utf8'));
      const runtime = new DocumentSessionManager({
        recoveryDirectory: path.join(directory, 'recovery'),
        autosaveDelayMs: 0,
      });
      await expect(
        initializeWindowSafely(window, async () => runtime.openMainOnly({ targetPath }), cleanup),
      ).rejects.toMatchObject({ code: 'SAVE_FAILED' });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(window.destroy).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('revokes presentation registration before destroying a window whose navigation fails', async () => {
    const window = fakeWindow();
    const modes = new Map<number, 'presentation'>();
    const sessions = new Map<number, string>();
    const tokens = new Set<number>();
    const webContentsId = 41;
    modes.set(webContentsId, 'presentation');
    sessions.set(webContentsId, 'presentation-session');
    tokens.add(webContentsId);

    await expect(
      initializeWindowSafely(
        window,
        async () => Promise.reject(new Error('loadURL failed')),
        async () => {
          tokens.delete(webContentsId);
          modes.delete(webContentsId);
          sessions.delete(webContentsId);
        },
      ),
    ).rejects.toThrow('loadURL failed');

    expect(tokens.has(webContentsId)).toBe(false);
    expect(modes.has(webContentsId)).toBe(false);
    expect(sessions.has(webContentsId)).toBe(false);
    expect(window.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the window alive and reports a failed disk save without an unhandled rejection', async () => {
    const window = fakeWindow();
    const report = vi.fn(async () => undefined);
    await expect(
      retainWindowOnFailure(
        window,
        async () => {
          const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          throw error;
        },
        report,
      ),
    ).resolves.toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(window.destroy).not.toHaveBeenCalled();
  });

  it('still contains reporter failures and retains the session window', async () => {
    const window = fakeWindow();
    await expect(
      retainWindowOnFailure(
        window,
        async () => Promise.reject(new Error('save failed')),
        async () => Promise.reject(new Error('dialog failed')),
      ),
    ).resolves.toBe(false);
    expect(window.destroy).not.toHaveBeenCalled();
  });

  it('never closes a cleanup candidate that already has or gains a window owner', async () => {
    let owned = true;
    const prepare = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);

    await expect(cleanupSessionIfUnowned(() => owned, prepare, close)).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    owned = false;
    prepare.mockImplementationOnce(async () => {
      owned = true;
    });
    await expect(cleanupSessionIfUnowned(() => owned, prepare, close)).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    owned = false;
    await expect(cleanupSessionIfUnowned(() => owned, prepare, close)).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it('revokes a one-shot native close authorization after success, no event, or failure', () => {
    const prepared = new Set<number>();
    const webContentsId = 41;

    runAuthorizedWindowClose(prepared, webContentsId, () => {
      expect(prepared.delete(webContentsId)).toBe(true);
    });
    expect(prepared.has(webContentsId)).toBe(false);

    runAuthorizedWindowClose(prepared, webContentsId, () => undefined);
    expect(prepared.has(webContentsId)).toBe(false);

    expect(() =>
      runAuthorizedWindowClose(prepared, webContentsId, () => {
        throw new Error('native close failed');
      }),
    ).toThrow('native close failed');
    expect(prepared.has(webContentsId)).toBe(false);
  });

  it('deduplicates concurrent close attempts for the same renderer', async () => {
    const broker = new RendererCloseHandshakeBroker({
      timeoutMs: 1_000,
      now: () => 10_000,
      createRequestId: () => FIRST_REQUEST_ID,
    });
    const send = vi.fn<(request: WindowCloseRequest) => void>();
    const duplicateSend = vi.fn<(request: WindowCloseRequest) => void>();

    const first = broker.request(41, send);
    const duplicate = broker.request(41, duplicateSend);

    expect(duplicate).toBe(first);
    expect(send).toHaveBeenCalledOnce();
    expect(duplicateSend).not.toHaveBeenCalled();
    expect(broker.pendingCount).toBe(1);
    expect(broker.receive(41, { requestId: FIRST_REQUEST_ID, decision: 'ready' })).toBe(true);
    await expect(first).resolves.toEqual({
      decision: 'ready',
      reason: 'renderer-ready',
      requestId: FIRST_REQUEST_ID,
    });
    expect(broker.pendingCount).toBe(0);
  });

  it('rejects wrong senders, wrong nonces, and non-strict responses without settling', async () => {
    const broker = new RendererCloseHandshakeBroker({
      timeoutMs: 1_000,
      now: () => 20_000,
      createRequestId: () => FIRST_REQUEST_ID,
    });
    const pending = broker.request(41, () => undefined);

    expect(broker.receive(42, { requestId: FIRST_REQUEST_ID, decision: 'ready' })).toBe(false);
    expect(broker.receive(41, { requestId: SECOND_REQUEST_ID, decision: 'ready' })).toBe(false);
    expect(
      broker.receive(41, {
        requestId: FIRST_REQUEST_ID,
        decision: 'ready',
        spoofed: true,
      }),
    ).toBe(false);
    expect(broker.pendingCount).toBe(1);

    expect(broker.receive(41, { requestId: FIRST_REQUEST_ID, decision: 'blocked' })).toBe(true);
    await expect(pending).resolves.toEqual({
      decision: 'blocked',
      reason: 'renderer-blocked',
      requestId: FIRST_REQUEST_ID,
    });
  });

  it('fails closed and releases broker state when the renderer misses its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(30_000);
    try {
      const broker = new RendererCloseHandshakeBroker({
        timeoutMs: 250,
        createRequestId: () => FIRST_REQUEST_ID,
      });
      const pending = broker.request(41, () => undefined);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toEqual({
        decision: 'blocked',
        reason: 'timeout',
        requestId: FIRST_REQUEST_ID,
      });
      expect(broker.pendingCount).toBe(0);
      expect(broker.receive(41, { requestId: FIRST_REQUEST_ID, decision: 'ready' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed immediately when the close request cannot be sent', async () => {
    const broker = new RendererCloseHandshakeBroker({
      createRequestId: () => FIRST_REQUEST_ID,
    });
    await expect(
      broker.request(41, () => {
        throw new Error('renderer was destroyed');
      }),
    ).resolves.toEqual({
      decision: 'blocked',
      reason: 'send-failed',
      requestId: FIRST_REQUEST_ID,
    });
    expect(broker.pendingCount).toBe(0);
  });

  it('maps absent, rejected, or invalid renderer listeners to blocked', async () => {
    const request: WindowCloseRequest = {
      requestId: FIRST_REQUEST_ID,
      deadlineAtMs: Date.now() + 1_000,
    };
    await expect(settleWindowCloseListeners([], request)).resolves.toBe('blocked');
    await expect(
      settleWindowCloseListeners(
        [
          async () => {
            throw new Error('draft flush failed');
          },
        ],
        request,
      ),
    ).resolves.toBe('blocked');
    await expect(
      settleWindowCloseListeners([(() => 'unexpected') as unknown as () => 'ready'], request),
    ).resolves.toBe('blocked');
    await expect(
      settleWindowCloseListeners([() => 'ready', async () => 'ready'], request),
    ).resolves.toBe('ready');
    await expect(
      settleWindowCloseListeners([() => new Promise<never>(() => undefined)], {
        ...request,
        deadlineAtMs: Date.now() + 15,
      }),
    ).resolves.toBe('blocked');
  });
});
