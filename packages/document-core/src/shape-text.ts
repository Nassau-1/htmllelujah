import type { ShapeKind, ShapeTextMargins } from './model.js';

const SHAPES_WITHOUT_TEXT = new Set<ShapeKind>(['line', 'arrow', 'arc']);

/** Default inset used when an author explicitly adds text to a native shape. */
export const DEFAULT_SHAPE_TEXT_MARGINS: ShapeTextMargins = Object.freeze({
  topPt: 6,
  rightPt: 6,
  bottomPt: 6,
  leftPt: 6,
});

/**
 * Whether a shape can host editable text.
 *
 * Kept as a public model helper so every editor surface applies the same rule.
 * Unsupported kinds remain valid geometry, but canonical documents reject a
 * nested text payload on them.
 */
export const shapeSupportsText = (shape: ShapeKind): boolean => !SHAPES_WITHOUT_TEXT.has(shape);
