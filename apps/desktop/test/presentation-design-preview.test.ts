import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PRESENTATION_IMPORT_LIMITS, PresentationImportError } from '@htmllelujah/pptx-importer';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isPresentationDesignFileName,
  previewPresentationDesignFile,
  readPresentationDesignArchive,
  PresentationDesignPreviewSourceError,
} from '../src/main/presentation-design-preview.js';
import { DESKTOP_IPC } from '../src/shared/desktop-api.js';
import { createPresentationFixture } from '../../../packages/pptx-importer/test/fixture-builder.js';

const directories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-design-preview-'));
  directories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bounded presentation design preview bridge', () => {
  it('parses a design-only preview and returns only the selected basename', async () => {
    const directory = await temporaryDirectory();
    const targetPath = path.join(directory, 'Board template.potx');
    const source = createPresentationFixture({ method: 8 });
    await writeFile(targetPath, source);

    const result = await previewPresentationDesignFile(targetPath);

    expect(result.displayName).toBe('Board template.potx');
    expect(result.preview).toMatchObject({
      schemaVersion: 1,
      mode: 'design-only',
      source: { archiveBytes: source.byteLength, masterPartCount: 1, layoutPartCount: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(await readFile(targetPath)).toEqual(Buffer.from(source));
  });

  it('accepts only pptx/potx regular files and rejects empty or absent sources safely', async () => {
    const directory = await temporaryDirectory();
    const empty = path.join(directory, 'Empty.pptx');
    const missing = path.join(directory, 'Missing.potx');
    await writeFile(empty, new Uint8Array());

    expect(isPresentationDesignFileName('DECK.PPTX')).toBe(true);
    expect(isPresentationDesignFileName('Template.PoTx')).toBe(true);
    expect(isPresentationDesignFileName('Deck.pptm')).toBe(false);
    await expect(readPresentationDesignArchive(path.join(directory, 'Deck.pdf'))).rejects.toEqual(
      expect.objectContaining<PresentationDesignPreviewSourceError>({
        code: 'INVALID_EXTENSION',
      }),
    );
    await expect(readPresentationDesignArchive(empty)).rejects.toEqual(
      expect.objectContaining<PresentationDesignPreviewSourceError>({
        code: 'SOURCE_LIMIT_EXCEEDED',
      }),
    );
    await expect(readPresentationDesignArchive(missing)).rejects.toEqual(
      expect.objectContaining<PresentationDesignPreviewSourceError>({
        code: 'SOURCE_READ_FAILED',
      }),
    );
  });

  it('checks the importer archive ceiling before allocating or parsing source bytes', async () => {
    const directory = await temporaryDirectory();
    const oversized = path.join(directory, 'Oversized.pptx');
    await writeFile(oversized, Uint8Array.of(0));
    await truncate(oversized, PRESENTATION_IMPORT_LIMITS.maxArchiveBytes + 1);

    await expect(readPresentationDesignArchive(oversized)).rejects.toEqual(
      expect.objectContaining<PresentationDesignPreviewSourceError>({
        code: 'SOURCE_LIMIT_EXCEEDED',
      }),
    );
  });

  it('keeps parser failures typed and exposes a dedicated versioned IPC channel', async () => {
    const directory = await temporaryDirectory();
    const invalid = path.join(directory, 'Invalid.pptx');
    await writeFile(invalid, Uint8Array.of(1, 2, 3, 4));

    await expect(previewPresentationDesignFile(invalid)).rejects.toBeInstanceOf(
      PresentationImportError,
    );
    expect(DESKTOP_IPC.previewPresentationDesignImport).toBe(
      'htmllelujah:v1:presentation-design-import-preview',
    );
  });
});
