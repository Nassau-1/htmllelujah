import type { ImageImportTarget, ImportClipboardImageInput } from '../shared/desktop-api.js';

const copyTarget = (target: ImageImportTarget): ImageImportTarget => {
  switch (target.surface) {
    case 'slide':
      return { surface: 'slide', slideId: target.slideId };
    case 'layout':
      return { surface: 'layout', layoutId: target.layoutId };
    case 'master':
      return { surface: 'master', masterId: target.masterId };
  }
};

/**
 * Produces a fresh, closed IPC envelope. Extra renderer object properties, buffers, paths and
 * URLs are not forwarded through the context-isolated bridge.
 */
export const clipboardImageInputForIpc = (
  input: ImportClipboardImageInput,
): ImportClipboardImageInput => ({
  sessionId: input.sessionId,
  expectedRevision: input.expectedRevision,
  target: copyTarget(input.target),
  bytes: Uint8Array.from(input.bytes),
  mediaType: input.mediaType,
  fileName: input.fileName,
});
