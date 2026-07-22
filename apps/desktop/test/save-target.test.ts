import { describe, expect, it, vi } from 'vitest';

import { resolveSaveTarget } from '../src/main/save-target.js';

describe('save target approval', () => {
  it('requires explicit consent before replacing an existing final path created by extension', async () => {
    const inspect = vi.fn(async () => ({ exists: true, fingerprint: 'approved-fingerprint' }));
    const confirm = vi.fn(async () => false);

    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\quarterly',
        extension: '.hdeck',
        inspect,
        confirmOverwrite: confirm,
      }),
    ).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledWith('C:\\Decks\\quarterly.hdeck');
    expect(confirm).toHaveBeenCalledWith('C:\\Decks\\quarterly.hdeck');

    confirm.mockResolvedValueOnce(true);
    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\quarterly',
        extension: '.hdeck',
        inspect,
        confirmOverwrite: confirm,
      }),
    ).resolves.toEqual({
      path: 'C:\\Decks\\quarterly.hdeck',
      state: { exists: true, fingerprint: 'approved-fingerprint' },
    });
  });

  it('requires explicit post-dialog consent when the selected path is already final', async () => {
    const approvedState = { exists: true, fingerprint: 'post-dialog-fingerprint' };
    const inspect = vi.fn(async () => approvedState);
    const confirm = vi.fn(async () => false);

    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\quarterly.HDECK',
        extension: '.hdeck',
        inspect,
        confirmOverwrite: confirm,
      }),
    ).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith('C:\\Decks\\quarterly.HDECK');

    confirm.mockResolvedValueOnce(true);
    const approved = await resolveSaveTarget({
      selectedPath: 'C:\\Decks\\quarterly.HDECK',
      extension: '.hdeck',
      inspect,
      confirmOverwrite: confirm,
    });
    expect(approved).toEqual({
      path: 'C:\\Decks\\quarterly.HDECK',
      state: approvedState,
    });
    expect(approved?.state).toBe(approvedState);
  });

  it('does not prompt when the extension-created target does not exist', async () => {
    const confirm = vi.fn(async () => true);

    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\new-deck',
        extension: '.hdeck',
        inspect: async () => ({ exists: false }),
        confirmOverwrite: confirm,
      }),
    ).resolves.toEqual({ path: 'C:\\Decks\\new-deck.hdeck', state: { exists: false } });
    expect(confirm).not.toHaveBeenCalled();
  });
});
