import { elementSchema, type ImageElement } from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  beginImageCropDrag,
  imageCropFromDrag,
  imageCropFromHandleDrag,
  MINIMUM_IMAGE_VISIBLE_FRACTION,
  normalizeImageCrop,
} from '../src/renderer/editor/image-crop-tools.js';

const image = (overrides: Partial<ImageElement> = {}): ImageElement => ({
  id: 'c0000000-0000-4000-8000-000000000001',
  name: 'Image',
  type: 'image',
  frame: { xPt: 100, yPt: 80, widthPt: 200, heightPt: 100, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  assetId: 'c0000000-0000-4000-8000-000000000002',
  altText: '',
  fit: 'cover',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
  ...overrides,
});

describe('direct image crop geometry', () => {
  it('maps every edge and corner drag to the matching crop sides', () => {
    const start = { xPx: 500, yPx: 400 };
    const source = image();

    expect(imageCropFromHandleDrag(source, 'left', start, { xPx: 550, yPx: 400 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0.25,
    });
    expect(imageCropFromHandleDrag(source, 'right', start, { xPx: 450, yPx: 400 })).toEqual({
      top: 0,
      right: 0.25,
      bottom: 0,
      left: 0,
    });
    expect(imageCropFromHandleDrag(source, 'top', start, { xPx: 500, yPx: 425 })).toEqual({
      top: 0.25,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(imageCropFromHandleDrag(source, 'bottom', start, { xPx: 500, yPx: 375 })).toEqual({
      top: 0,
      right: 0,
      bottom: 0.25,
      left: 0,
    });
    expect(imageCropFromHandleDrag(source, 'top-left', start, { xPx: 550, yPx: 425 })).toEqual({
      top: 0.25,
      right: 0,
      bottom: 0,
      left: 0.25,
    });
  });

  it('applies screen scale and rotation before choosing the local frame axis', () => {
    const source = image({
      frame: { xPt: 100, yPt: 80, widthPt: 100, heightPt: 100, rotationDeg: 90 },
    });
    const start = { xPx: 0, yPx: 0 };

    // At 200% zoom, 20 screen pixels become 10 canonical points. A downward
    // screen drag on a 90-degree frame is a rightward local drag.
    const left = imageCropFromHandleDrag(
      source,
      'left',
      start,
      { xPx: 0, yPx: 20 },
      { canvasScale: 2 },
    );
    expect(left.left).toBeCloseTo(0.1, 12);
    expect(left.top).toBe(0);

    // A leftward screen drag becomes a downward local drag.
    const top = imageCropFromHandleDrag(
      source,
      'top',
      start,
      { xPx: -20, yPx: 0 },
      { canvasScale: 2 },
    );
    expect(top.top).toBeCloseTo(0.1, 12);
    expect(top.left).toBe(0);
  });

  it('adjusts the crop against the source fraction still visible at gesture start', () => {
    const source = image({
      crop: { top: 0.1, right: 0.1, bottom: 0.2, left: 0.2 },
    });
    const drag = beginImageCropDrag(source, 'left', { xPx: 10, yPx: 10 });
    const crop = imageCropFromDrag(drag, { xPx: 110, yPx: 999 });

    // 70% of the source was visible horizontally; a half-frame drag removes
    // half of that visible source (35%), while the irrelevant Y delta is ignored.
    expect(crop).toEqual({
      top: 0.1,
      right: 0.1,
      bottom: 0.2,
      left: 0.55,
    });
    expect(source.crop.left).toBe(0.2);
  });

  it('keeps a schema-valid visible area and clamps outward drags at zero', () => {
    const source = image({
      crop: { top: 0, right: 0.3, bottom: 0, left: 0.2 },
    });
    const capped = imageCropFromHandleDrag(
      source,
      'left',
      { xPx: 0, yPx: 0 },
      { xPx: 100_000, yPx: 0 },
    );
    const restored = imageCropFromHandleDrag(
      source,
      'left',
      { xPx: 0, yPx: 0 },
      { xPx: -100_000, yPx: 0 },
    );

    expect(capped.left).toBeCloseTo(0.69, 12);
    expect(capped.left + capped.right).toBeCloseTo(1 - MINIMUM_IMAGE_VISIBLE_FRACTION, 12);
    expect(restored.left).toBe(0);
    expect(elementSchema.safeParse({ ...source, crop: capped }).success).toBe(true);
  });

  it('supports a larger requested visible area and normalizes malformed inputs deterministically', () => {
    expect(normalizeImageCrop({ top: Number.NaN, right: 0.8, bottom: -2, left: 0.8 }, 0.2)).toEqual(
      {
        top: 0,
        right: 0.4,
        bottom: 0,
        left: 0.4,
      },
    );

    const crop = imageCropFromHandleDrag(
      image(),
      'bottom-right',
      { xPx: Number.NaN, yPx: Number.POSITIVE_INFINITY },
      { xPx: Number.NaN, yPx: Number.NEGATIVE_INFINITY },
      { canvasScale: 0, minimumVisibleFraction: 0 },
    );
    expect(crop).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('uses the gesture snapshot instead of accumulating pointermove rounding', () => {
    const source = image();
    const drag = beginImageCropDrag(source, 'bottom-right', { xPx: 10, yPx: 20 });
    const intermediate = imageCropFromDrag(drag, { xPx: -10, yPx: 10 });
    const final = imageCropFromDrag(drag, { xPx: -30, yPx: -20 });

    expect(intermediate.right).toBeCloseTo(0.1, 12);
    expect(intermediate.bottom).toBeCloseTo(0.1, 12);
    expect(final.right).toBeCloseTo(0.2, 12);
    expect(final.bottom).toBeCloseTo(0.4, 12);
  });
});
