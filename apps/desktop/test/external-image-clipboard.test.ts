import { describe, expect, it, vi } from 'vitest';

import {
  ExternalClipboardImageError,
  extractExternalClipboardImage,
  extractExternalImageFromClipboardEvent,
  MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES,
  normalizeExternalClipboardImageFileName,
} from '../src/renderer/editor/external-image-clipboard.js';

const item = (file: File | null, type = file?.type ?? ''): DataTransferItem =>
  ({
    kind: 'file',
    type,
    getAsFile: () => file,
  }) as DataTransferItem;

const clipboard = (
  items: readonly DataTransferItem[],
  files: readonly File[] = [],
): Pick<DataTransfer, 'items' | 'files'> =>
  ({
    items,
    files,
  }) as unknown as Pick<DataTransfer, 'items' | 'files'>;

describe('external image clipboard extraction', () => {
  it('chooses the lossless image representation deterministically and copies its bytes', async () => {
    const jpeg = new File([Uint8Array.of(9, 8, 7)], 'preview.jpeg', { type: 'image/jpeg' });
    const png = new File([Uint8Array.of(1, 2, 3)], 'Excel chart.tmp', { type: 'image/png' });

    const result = await extractExternalClipboardImage(
      clipboard([item(jpeg), item(png), { kind: 'string', type: 'text/html' } as DataTransferItem]),
    );

    expect(result).toEqual({
      bytes: Uint8Array.of(1, 2, 3),
      mediaType: 'image/png',
      fileName: 'Excel chart.png',
    });
    expect(result?.bytes.buffer).not.toBe(await png.arrayBuffer());
  });

  it('uses the bounded files fallback and ignores text, HTML, paths and URLs', async () => {
    const png = new File([Uint8Array.of(4)], 'https://example.invalid/private.png', {
      type: 'image/png',
    });
    const result = await extractExternalClipboardImage(
      clipboard([{ kind: 'string', type: 'text/html' } as DataTransferItem], [png]),
    );

    expect(result).toMatchObject({
      bytes: Uint8Array.of(4),
      mediaType: 'image/png',
      fileName: 'Clipboard image.png',
    });
    expect(await extractExternalClipboardImage(clipboard([], []))).toBeNull();
    await expect(
      extractExternalImageFromClipboardEvent({ clipboardData: null }),
    ).resolves.toBeNull();
  });

  it('rejects oversized or unreadable candidates before any unbounded transfer', async () => {
    const arrayBuffer = vi.fn(async () => Uint8Array.of(1).buffer);
    const oversized = {
      name: 'large.png',
      type: 'image/png',
      size: MAX_EXTERNAL_CLIPBOARD_IMAGE_BYTES + 1,
      arrayBuffer,
    } as unknown as File;

    const boundedJpeg = new File([Uint8Array.of(2)], 'fallback.jpg', {
      type: 'image/jpeg',
    });
    await expect(
      extractExternalClipboardImage(clipboard([item(oversized), item(boundedJpeg)])),
    ).resolves.toMatchObject({ bytes: Uint8Array.of(2), mediaType: 'image/jpeg' });
    expect(arrayBuffer).not.toHaveBeenCalled();

    await expect(extractExternalClipboardImage(clipboard([item(oversized)]))).rejects.toEqual(
      expect.objectContaining<ExternalClipboardImageError>({ code: 'IMAGE_TOO_LARGE' }),
    );
    expect(arrayBuffer).not.toHaveBeenCalled();

    const unreadable = {
      name: 'broken.webp',
      type: 'image/webp',
      size: 10,
      arrayBuffer: vi.fn(async () => {
        throw new Error('provider failure');
      }),
    } as unknown as File;
    await expect(extractExternalClipboardImage(clipboard([item(unreadable)]))).rejects.toEqual(
      expect.objectContaining<ExternalClipboardImageError>({ code: 'IMAGE_READ_FAILED' }),
    );
  });

  it('normalizes safe names to the inspected representation without forwarding path metadata', () => {
    expect(normalizeExternalClipboardImageFileName('Chart.JPEG', 'image/png')).toBe('Chart.png');
    expect(normalizeExternalClipboardImageFileName('C:\\private\\chart.png', 'image/png')).toBe(
      'Clipboard image.png',
    );
    expect(normalizeExternalClipboardImageFileName('../chart.png', 'image/png')).toBe(
      'Clipboard image.png',
    );
    expect(normalizeExternalClipboardImageFileName('quarterly chart', 'image/webp')).toBe(
      'quarterly chart.webp',
    );
  });
});
