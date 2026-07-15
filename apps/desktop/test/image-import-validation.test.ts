import { describe, expect, it } from 'vitest';

import {
  assertDecodedDimensions,
  ImageImportValidationError,
  imageFrameForPage,
  inspectImageBeforeDecode,
} from '../src/main/image-import-validation.js';

const onePixelPng = (): Buffer =>
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

describe('desktop image import validation', () => {
  it('uses the byte header rather than a potentially mislabeled filename', () => {
    expect(inspectImageBeforeDecode(onePixelPng())).toEqual({
      mediaType: 'image/png',
      widthPx: 1,
      heightPx: 1,
    });
  });

  it('rejects an oversized header before any pixel decode', () => {
    const oversized = onePixelPng();
    oversized.writeUInt32BE(16_385, 16);
    expect(() => inspectImageBeforeDecode(oversized)).toThrowError(
      expect.objectContaining<ImageImportValidationError>({ code: 'IMAGE_LIMIT_EXCEEDED' }),
    );
  });

  it('rejects a decoder result that disagrees with the inspected header', () => {
    const header = inspectImageBeforeDecode(onePixelPng());
    expect(() =>
      assertDecodedDimensions(header, { empty: false, widthPx: 2, heightPx: 1 }),
    ).toThrowError(
      expect.objectContaining<ImageImportValidationError>({ code: 'DECODE_MISMATCH' }),
    );
  });

  it('fits new images inside narrow and minimal custom pages', () => {
    for (const page of [
      { widthPt: 120, heightPt: 900 },
      { widthPt: Number.MIN_VALUE, heightPt: Number.MIN_VALUE },
    ]) {
      const frame = imageFrameForPage(4_000, 1_000, page);
      expect(Number.isFinite(frame.xPt)).toBe(true);
      expect(Number.isFinite(frame.yPt)).toBe(true);
      expect(frame.widthPt).toBeGreaterThan(0);
      expect(frame.heightPt).toBeGreaterThan(0);
      expect(frame.xPt + frame.widthPt).toBeLessThanOrEqual(page.widthPt);
      expect(frame.yPt + frame.heightPt).toBeLessThanOrEqual(page.heightPt);
    }
  });
});
