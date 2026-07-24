import type { Stats } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  parsePresentationImportPreview,
  PRESENTATION_IMPORT_LIMITS,
  type PresentationImportPreview,
} from '@htmllelujah/pptx-importer';

export type PresentationDesignPreviewSourceErrorCode =
  | 'INVALID_EXTENSION'
  | 'INVALID_SOURCE'
  | 'SOURCE_LIMIT_EXCEEDED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_READ_FAILED';

export class PresentationDesignPreviewSourceError extends Error {
  public constructor(
    public readonly code: PresentationDesignPreviewSourceErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'PresentationDesignPreviewSourceError';
  }
}

export interface PresentationDesignPreviewFileResult {
  readonly displayName: string;
  readonly preview: PresentationImportPreview;
}

export const isPresentationDesignFileName = (value: string): boolean => {
  const extension = path.extname(value).toLocaleLowerCase('en-US');
  return extension === '.pptx' || extension === '.potx';
};

const sourceError = (
  error: unknown,
  fallbackCode: PresentationDesignPreviewSourceErrorCode,
  fallbackMessage: string,
): PresentationDesignPreviewSourceError =>
  error instanceof PresentationDesignPreviewSourceError
    ? error
    : new PresentationDesignPreviewSourceError(fallbackCode, fallbackMessage, { cause: error });

/**
 * Reads from an already selected local file with a fixed allocation ceiling. The file is opened
 * and re-statted before allocation, then probed for growth after the exact bounded read.
 */
export const readPresentationDesignArchive = async (targetPath: string): Promise<Uint8Array> => {
  if (!isPresentationDesignFileName(targetPath)) {
    throw new PresentationDesignPreviewSourceError(
      'INVALID_EXTENSION',
      'Choose a .pptx or .potx presentation file.',
    );
  }

  let selectedMetadata: Stats;
  try {
    selectedMetadata = await lstat(targetPath);
  } catch (error) {
    throw sourceError(error, 'SOURCE_READ_FAILED', 'The selected presentation could not be read.');
  }
  if (!selectedMetadata.isFile() || selectedMetadata.isSymbolicLink()) {
    throw new PresentationDesignPreviewSourceError(
      'INVALID_SOURCE',
      'The selected presentation must be a regular file.',
    );
  }
  if (
    !Number.isSafeInteger(selectedMetadata.size) ||
    selectedMetadata.size <= 0 ||
    selectedMetadata.size > PRESENTATION_IMPORT_LIMITS.maxArchiveBytes
  ) {
    throw new PresentationDesignPreviewSourceError(
      'SOURCE_LIMIT_EXCEEDED',
      'Choose a non-empty presentation smaller than 64 MB.',
    );
  }

  let handle: FileHandle;
  try {
    handle = await open(targetPath, 'r');
  } catch (error) {
    throw sourceError(error, 'SOURCE_READ_FAILED', 'The selected presentation could not be read.');
  }
  try {
    const openedMetadata = await handle.stat();
    if (
      !openedMetadata.isFile() ||
      !Number.isSafeInteger(openedMetadata.size) ||
      openedMetadata.size <= 0 ||
      openedMetadata.size > PRESENTATION_IMPORT_LIMITS.maxArchiveBytes
    ) {
      throw new PresentationDesignPreviewSourceError(
        'SOURCE_LIMIT_EXCEEDED',
        'Choose a non-empty presentation smaller than 64 MB.',
      );
    }
    if (
      openedMetadata.dev !== selectedMetadata.dev ||
      openedMetadata.ino !== selectedMetadata.ino ||
      openedMetadata.size !== selectedMetadata.size
    ) {
      throw new PresentationDesignPreviewSourceError(
        'SOURCE_CHANGED',
        'The selected presentation changed before it could be previewed.',
      );
    }

    const bytes = Buffer.allocUnsafe(openedMetadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new PresentationDesignPreviewSourceError(
          'SOURCE_CHANGED',
          'The selected presentation changed while it was being read.',
        );
      }
      offset += result.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    if ((await handle.read(overflowProbe, 0, 1, bytes.byteLength)).bytesRead !== 0) {
      throw new PresentationDesignPreviewSourceError(
        'SOURCE_CHANGED',
        'The selected presentation changed while it was being read.',
      );
    }
    const completedMetadata = await handle.stat();
    if (
      completedMetadata.size !== openedMetadata.size ||
      completedMetadata.mtimeMs !== openedMetadata.mtimeMs ||
      completedMetadata.ctimeMs !== openedMetadata.ctimeMs
    ) {
      throw new PresentationDesignPreviewSourceError(
        'SOURCE_CHANGED',
        'The selected presentation changed while it was being read.',
      );
    }
    return bytes;
  } catch (error) {
    throw sourceError(error, 'SOURCE_READ_FAILED', 'The selected presentation could not be read.');
  } finally {
    await handle.close().catch(() => undefined);
  }
};

/**
 * Local design-only preview. It performs no Office automation, network access, or document edit.
 * The selected path is consumed inside main and reduced to a basename before crossing IPC.
 */
export const previewPresentationDesignFile = async (
  targetPath: string,
): Promise<PresentationDesignPreviewFileResult> => {
  const bytes = await readPresentationDesignArchive(targetPath);
  return {
    displayName: path.basename(targetPath),
    preview: parsePresentationImportPreview(bytes, { mode: 'design-only' }),
  };
};
