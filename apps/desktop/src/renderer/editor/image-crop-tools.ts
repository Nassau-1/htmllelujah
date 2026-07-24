import type { Frame, ImageCrop, ImageElement } from '@htmllelujah/document-core';

export const MINIMUM_IMAGE_VISIBLE_FRACTION = 0.01;

export const IMAGE_CROP_HANDLES = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left',
] as const;

export type ImageCropHandle = (typeof IMAGE_CROP_HANDLES)[number];

/**
 * Pointer coordinates are expressed in CSS pixels. Only their delta is used, so
 * viewport-relative coordinates such as PointerEvent.clientX/clientY can be
 * passed directly.
 */
export type ImageCropPointer = Readonly<{
  xPx: number;
  yPx: number;
}>;

export type ImageCropDragOptions = Readonly<{
  /** Rendered canvas pixels per canonical point. Invalid values fall back to 1. */
  canvasScale?: number | undefined;
  /**
   * Minimum fraction of the original image that must remain visible on each
   * axis. Values outside ]0, 1] fall back to 1%.
   */
  minimumVisibleFraction?: number | undefined;
}>;

/**
 * Immutable gesture snapshot. Keeping the crop at pointer-down time avoids
 * accumulating rounding errors across pointermove events.
 */
export type ImageCropDrag = Readonly<{
  handle: ImageCropHandle;
  frame: Frame;
  initialCrop: ImageCrop;
  startPointer: ImageCropPointer;
  canvasScale: number;
  minimumVisibleFraction: number;
}>;

type LocalDelta = Readonly<{ dxPt: number; dyPt: number }>;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const finiteOr = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

const normalizedScale = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;

const normalizedMinimumVisibleFraction = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : MINIMUM_IMAGE_VISIBLE_FRACTION;

const normalizeCropAxis = (
  startInput: number,
  endInput: number,
  minimumVisibleFraction: number,
): readonly [start: number, end: number] => {
  let start = clamp(startInput, 0, 1);
  let end = clamp(endInput, 0, 1);
  const maximumCrop = 1 - minimumVisibleFraction;
  const total = start + end;
  if (total > maximumCrop && total > 0) {
    const ratio = maximumCrop / total;
    start *= ratio;
    end *= ratio;
  }
  return [start, end];
};

export const normalizeImageCrop = (
  crop: ImageCrop,
  minimumVisibleFraction = MINIMUM_IMAGE_VISIBLE_FRACTION,
): ImageCrop => {
  const minimum = normalizedMinimumVisibleFraction(minimumVisibleFraction);
  const [left, right] = normalizeCropAxis(crop.left, crop.right, minimum);
  const [top, bottom] = normalizeCropAxis(crop.top, crop.bottom, minimum);
  return { top, right, bottom, left };
};

const pointerDeltaInFrame = (drag: ImageCropDrag, currentPointer: ImageCropPointer): LocalDelta => {
  const screenDxPt =
    (finiteOr(currentPointer.xPx, drag.startPointer.xPx) - drag.startPointer.xPx) /
    drag.canvasScale;
  const screenDyPt =
    (finiteOr(currentPointer.yPx, drag.startPointer.yPx) - drag.startPointer.yPx) /
    drag.canvasScale;
  const rotationDeg = finiteOr(drag.frame.rotationDeg, 0);
  if (rotationDeg === 0) return { dxPt: screenDxPt, dyPt: screenDyPt };

  const radians = (-rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    dxPt: screenDxPt * cosine - screenDyPt * sine,
    dyPt: screenDxPt * sine + screenDyPt * cosine,
  };
};

const includesHorizontalStart = (handle: ImageCropHandle): boolean =>
  handle === 'left' || handle === 'top-left' || handle === 'bottom-left';

const includesHorizontalEnd = (handle: ImageCropHandle): boolean =>
  handle === 'right' || handle === 'top-right' || handle === 'bottom-right';

const includesVerticalStart = (handle: ImageCropHandle): boolean =>
  handle === 'top' || handle === 'top-left' || handle === 'top-right';

const includesVerticalEnd = (handle: ImageCropHandle): boolean =>
  handle === 'bottom' || handle === 'bottom-left' || handle === 'bottom-right';

const cropAxisFromDrag = (
  start: number,
  end: number,
  localDeltaPt: number,
  frameSizePt: number,
  moveStart: boolean,
  moveEnd: boolean,
  minimumVisibleFraction: number,
): readonly [start: number, end: number] => {
  if ((!moveStart && !moveEnd) || !Number.isFinite(frameSizePt) || frameSizePt <= 0) {
    return [start, end];
  }
  const visibleFraction = Math.max(minimumVisibleFraction, 1 - start - end);
  const cropDelta = (finiteOr(localDeltaPt, 0) / frameSizePt) * visibleFraction;
  if (moveStart) {
    return [clamp(start + cropDelta, 0, Math.max(0, 1 - minimumVisibleFraction - end)), end];
  }
  return [start, clamp(end - cropDelta, 0, Math.max(0, 1 - minimumVisibleFraction - start))];
};

export const beginImageCropDrag = (
  image: ImageElement,
  handle: ImageCropHandle,
  startPointer: ImageCropPointer,
  options: ImageCropDragOptions = {},
): ImageCropDrag => {
  const minimumVisibleFraction = normalizedMinimumVisibleFraction(options.minimumVisibleFraction);
  return {
    handle,
    frame: { ...image.frame },
    initialCrop: normalizeImageCrop(image.crop, minimumVisibleFraction),
    startPointer: {
      xPx: finiteOr(startPointer.xPx, 0),
      yPx: finiteOr(startPointer.yPx, 0),
    },
    canvasScale: normalizedScale(options.canvasScale),
    minimumVisibleFraction,
  };
};

/**
 * Calculates the canonical crop for the current pointer without mutating the
 * image or gesture. The frame stays unchanged; a caller can use the returned
 * value in one transactional element patch when the gesture completes.
 */
export const imageCropFromDrag = (
  drag: ImageCropDrag,
  currentPointer: ImageCropPointer,
): ImageCrop => {
  const delta = pointerDeltaInFrame(drag, currentPointer);
  const [left, right] = cropAxisFromDrag(
    drag.initialCrop.left,
    drag.initialCrop.right,
    delta.dxPt,
    drag.frame.widthPt,
    includesHorizontalStart(drag.handle),
    includesHorizontalEnd(drag.handle),
    drag.minimumVisibleFraction,
  );
  const [top, bottom] = cropAxisFromDrag(
    drag.initialCrop.top,
    drag.initialCrop.bottom,
    delta.dyPt,
    drag.frame.heightPt,
    includesVerticalStart(drag.handle),
    includesVerticalEnd(drag.handle),
    drag.minimumVisibleFraction,
  );
  return { top, right, bottom, left };
};

/** One-shot convenience API for integrations that do not retain gesture state. */
export const imageCropFromHandleDrag = (
  image: ImageElement,
  handle: ImageCropHandle,
  startPointer: ImageCropPointer,
  currentPointer: ImageCropPointer,
  options: ImageCropDragOptions = {},
): ImageCrop =>
  imageCropFromDrag(beginImageCropDrag(image, handle, startPointer, options), currentPointer);
