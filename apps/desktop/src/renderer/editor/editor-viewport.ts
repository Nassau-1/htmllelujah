import type { PageSize } from '@htmllelujah/document-core';

export const MANUAL_ZOOM_MIN_PERCENT = 25;
export const MANUAL_ZOOM_MAX_PERCENT = 200;
export const MANUAL_ZOOM_STEP_PERCENT = 10;

export type CanvasZoom = Readonly<{ mode: 'fit' }> | Readonly<{ mode: 'manual'; percent: number }>;

export type FitViewport = Readonly<{
  widthPx: number;
  heightPx: number;
}>;

const finitePositive = (value: number): boolean => Number.isFinite(value) && value > 0;

export const clampManualZoomPercent = (percent: number): number => {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MANUAL_ZOOM_MAX_PERCENT, Math.max(MANUAL_ZOOM_MIN_PERCENT, percent));
};

/**
 * Returns one whole-page scale. Object geometry remains point-based and is never
 * recomputed for a viewport. Fit is capped by the same supported 200% ceiling as
 * manual zoom while still permitting a fit below the manual 25% floor.
 */
export const calculateFitScale = (viewport: FitViewport, page: PageSize): number => {
  if (
    !finitePositive(viewport.widthPx) ||
    !finitePositive(viewport.heightPx) ||
    !finitePositive(page.widthPt) ||
    !finitePositive(page.heightPt)
  ) {
    return 1;
  }
  return Math.min(
    MANUAL_ZOOM_MAX_PERCENT / 100,
    viewport.widthPx / page.widthPt,
    viewport.heightPx / page.heightPt,
  );
};

export const resolveCanvasScale = (zoom: CanvasZoom, fitScale: number): number =>
  zoom.mode === 'fit'
    ? finitePositive(fitScale)
      ? fitScale
      : 1
    : clampManualZoomPercent(zoom.percent) / 100;

export const effectiveZoomPercent = (zoom: CanvasZoom, fitScale: number): number =>
  zoom.mode === 'fit'
    ? Math.round((finitePositive(fitScale) ? fitScale : 1) * 100)
    : Math.round(clampManualZoomPercent(zoom.percent));

export const stepCanvasZoom = (
  zoom: CanvasZoom,
  fitScale: number,
  direction: -1 | 1,
): CanvasZoom => ({
  mode: 'manual',
  percent: clampManualZoomPercent(
    effectiveZoomPercent(zoom, fitScale) + direction * MANUAL_ZOOM_STEP_PERCENT,
  ),
});
