import type { Element, Frame, PageSize } from '@htmllelujah/document-core';

export type ElementFrameUpdate = Readonly<{
  elementId: string;
  frame: Frame;
}>;

const clampedPosition = (
  position: Readonly<{ xPt: number; yPt: number }>,
  frame: Frame,
  page: PageSize,
): Readonly<{ xPt: number; yPt: number }> => ({
  xPt: Math.max(0, Math.min(position.xPt, Math.max(0, page.widthPt - frame.widthPt))),
  yPt: Math.max(0, Math.min(position.yPt, Math.max(0, page.heightPt - frame.heightPt))),
});

/**
 * Swaps the top-left positions of exactly two objects while preserving each object's
 * size, rotation, identity, content, and styling. Positions are clamped only when a
 * differently sized peer would otherwise push an object outside the page.
 */
export const swapElementPositions = (
  elements: readonly Element[],
  page: PageSize,
): readonly ElementFrameUpdate[] => {
  if (elements.length !== 2) return [];
  const [first, second] = elements;
  if (first === undefined || second === undefined || first.locked || second.locked) return [];
  const firstPosition = clampedPosition(second.frame, first.frame, page);
  const secondPosition = clampedPosition(first.frame, second.frame, page);
  return [
    {
      elementId: first.id,
      frame: { ...first.frame, xPt: firstPosition.xPt, yPt: firstPosition.yPt },
    },
    {
      elementId: second.id,
      frame: { ...second.frame, xPt: secondPosition.xPt, yPt: secondPosition.yPt },
    },
  ];
};

/**
 * Matches every preceding object's width and height to the last-selected reference.
 * Positions and rotation stay local to each object; edge objects are shifted only enough
 * to remain on the page.
 */
export const matchElementSizes = (
  elements: readonly Element[],
  page: PageSize,
): readonly ElementFrameUpdate[] => {
  if (elements.length < 2 || elements.some((element) => element.locked)) return [];
  const reference = elements.at(-1);
  if (reference === undefined) return [];
  return elements.slice(0, -1).map((element) => {
    const nextFrame = {
      ...element.frame,
      widthPt: reference.frame.widthPt,
      heightPt: reference.frame.heightPt,
    };
    const position = clampedPosition(nextFrame, nextFrame, page);
    return {
      elementId: element.id,
      frame: { ...nextFrame, xPt: position.xPt, yPt: position.yPt },
    };
  });
};
