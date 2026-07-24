import { describe, expect, it } from 'vitest';

import { clipboardImageImportSourceSchema } from '../src/main/clipboard-image-import.js';
import { MAX_DESKTOP_IMAGE_BYTES } from '../src/main/image-import-validation.js';
import { clipboardImageInputForIpc } from '../src/preload/clipboard-image-bridge.js';
import { DESKTOP_IPC } from '../src/shared/desktop-api.js';

describe('clipboard image IPC envelope', () => {
  it('uses a dedicated versioned channel and accepts only owned bytes plus bounded metadata', () => {
    expect(DESKTOP_IPC.importClipboardImage).toBe('htmllelujah:v1:asset-import-clipboard-image');
    expect(
      clipboardImageImportSourceSchema.parse({
        bytes: Uint8Array.of(1, 2, 3),
        mediaType: 'image/png',
        fileName: 'Chart.png',
      }),
    ).toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      fileName: 'Chart.png',
    });
  });

  it('rejects paths, URLs, unsupported media, unknown fields and non-typed byte payloads', () => {
    const source = {
      bytes: Uint8Array.of(1),
      mediaType: 'image/png',
      fileName: 'Chart.png',
    };
    for (const candidate of [
      { ...source, fileName: 'C:\\private\\Chart.png' },
      { ...source, fileName: 'https://example.invalid/Chart.png' },
      { ...source, mediaType: 'image/svg+xml' },
      { ...source, sourceUrl: 'https://example.invalid/Chart.png' },
      { ...source, bytes: source.bytes.buffer },
      { ...source, bytes: new Uint8Array() },
    ]) {
      expect(clipboardImageImportSourceSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('rejects the payload at the IPC boundary when it exceeds the desktop image budget', () => {
    expect(
      clipboardImageImportSourceSchema.safeParse({
        bytes: new Uint8Array(MAX_DESKTOP_IMAGE_BYTES + 1),
        mediaType: 'image/png',
        fileName: 'Large.png',
      }).success,
    ).toBe(false);
  });

  it('copies bytes and strips non-contract properties in the context-isolated preload bridge', () => {
    const bytes = Uint8Array.of(7, 8, 9);
    const bridged = clipboardImageInputForIpc({
      sessionId: '11000000-0000-4000-8000-000000000001',
      expectedRevision: 'revision-1',
      target: { surface: 'slide', slideId: '11000000-0000-4000-8000-000000000002' },
      bytes,
      mediaType: 'image/png',
      fileName: 'Chart.png',
      sourceUrl: 'https://example.invalid/private.png',
      path: 'C:\\private\\Chart.png',
    } as Parameters<typeof clipboardImageInputForIpc>[0] & {
      readonly sourceUrl: string;
      readonly path: string;
    });

    expect(bridged).toEqual({
      sessionId: '11000000-0000-4000-8000-000000000001',
      expectedRevision: 'revision-1',
      target: { surface: 'slide', slideId: '11000000-0000-4000-8000-000000000002' },
      bytes: Uint8Array.of(7, 8, 9),
      mediaType: 'image/png',
      fileName: 'Chart.png',
    });
    expect(bridged.bytes).not.toBe(bytes);
    bytes[0] = 255;
    expect(bridged.bytes[0]).toBe(7);
  });
});
