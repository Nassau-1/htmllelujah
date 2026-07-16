import { describe, expect, it } from 'vitest';

import {
  calculateFitScale,
  effectiveZoomPercent,
  resolveCanvasScale,
  stepCanvasZoom,
} from '../src/renderer/editor/editor-viewport.js';

describe('whole-page editor zoom', () => {
  it('fits both page axes exactly without deriving any object geometry', () => {
    expect(
      calculateFitScale({ widthPx: 800, heightPx: 420 }, { widthPt: 960, heightPt: 540 }),
    ).toBeCloseTo(420 / 540);
    expect(
      calculateFitScale({ widthPx: 600, heightPx: 1_000 }, { widthPt: 960, heightPt: 540 }),
    ).toBeCloseTo(600 / 960);
  });

  it('supports manual 25 through 200 percent independently from Fit', () => {
    expect(resolveCanvasScale({ mode: 'manual', percent: 25 }, 0.7)).toBe(0.25);
    expect(resolveCanvasScale({ mode: 'manual', percent: 200 }, 0.7)).toBe(2);
    expect(resolveCanvasScale({ mode: 'fit' }, 0.7)).toBe(0.7);
    expect(effectiveZoomPercent({ mode: 'fit' }, 0.734)).toBe(73);
  });

  it('steps from the current fitted percentage then clamps at supported edges', () => {
    expect(stepCanvasZoom({ mode: 'fit' }, 0.72, 1)).toEqual({ mode: 'manual', percent: 82 });
    expect(stepCanvasZoom({ mode: 'manual', percent: 195 }, 1, 1)).toEqual({
      mode: 'manual',
      percent: 200,
    });
    expect(stepCanvasZoom({ mode: 'fit' }, 0.1, -1)).toEqual({
      mode: 'manual',
      percent: 25,
    });
  });

  it('fails safe for unusable measurements and never exceeds 200 percent', () => {
    expect(calculateFitScale({ widthPx: 0, heightPx: 500 }, { widthPt: 960, heightPt: 540 })).toBe(
      1,
    );
    expect(
      calculateFitScale({ widthPx: 10_000, heightPx: 10_000 }, { widthPt: 960, heightPt: 540 }),
    ).toBe(2);
  });
});
