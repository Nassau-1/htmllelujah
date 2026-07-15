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
        confirmAddedExtensionOverwrite: confirm,
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
        confirmAddedExtensionOverwrite: confirm,
      }),
    ).resolves.toEqual({
      path: 'C:\\Decks\\quarterly.hdeck',
      state: { exists: true, fingerprint: 'approved-fingerprint' },
    });
  });

  it('relies on the native dialog consent when the selected path is already final', async () => {
    const confirm = vi.fn(async () => true);

    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\quarterly.HDECK',
        extension: '.hdeck',
        inspect: async () => ({ exists: true, fingerprint: 'native-dialog-approved' }),
        confirmAddedExtensionOverwrite: confirm,
      }),
    ).resolves.toMatchObject({ path: 'C:\\Decks\\quarterly.HDECK' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not prompt when the extension-created target does not exist', async () => {
    const confirm = vi.fn(async () => true);

    await expect(
      resolveSaveTarget({
        selectedPath: 'C:\\Decks\\new-deck',
        extension: '.hdeck',
        inspect: async () => ({ exists: false }),
        confirmAddedExtensionOverwrite: confirm,
      }),
    ).resolves.toEqual({ path: 'C:\\Decks\\new-deck.hdeck', state: { exists: false } });
    expect(confirm).not.toHaveBeenCalled();
  });
});
