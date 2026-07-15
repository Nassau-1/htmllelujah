import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { describe, expect, it, vi } from 'vitest';

import { initializeWindowSafely, retainWindowOnFailure } from '../src/main/window-lifecycle.js';

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
        initializeWindowSafely(
          window,
          async () => runtime.openMainOnly({ targetPath }),
          cleanup,
        ),
      ).rejects.toMatchObject({ code: 'SAVE_FAILED' });
      expect(cleanup).toHaveBeenCalledOnce();
      expect(window.destroy).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
});
