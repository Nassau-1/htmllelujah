import {
  DOCUMENT_LIMITS,
  type PathElement,
  type ShapeElement,
  type ShapeKind,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  performShapeBooleanOperation,
  type ShapeBooleanOperation,
} from '../src/renderer/editor/shape-boolean-geometry.js';

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;

const shape = (
  id: number,
  xPt: number,
  yPt: number,
  widthPt: number,
  heightPt: number,
  shapeKind: ShapeKind = 'rectangle',
  rotationDeg = 0,
): ShapeElement => ({
  id: uuid(id),
  name: `Shape ${id}`,
  type: 'shape',
  frame: { xPt, yPt, widthPt, heightPt, rotationDeg },
  opacity: 0.8,
  visible: true,
  locked: false,
  shape: shapeKind,
  fill: '#123456',
  stroke: { color: '#abcdef', widthPt: 2, dash: 'dash' },
  cornerRadiusPt: 12,
  shadow: {
    color: '#000000',
    blurPt: 3,
    offsetXPt: 1,
    offsetYPt: 2,
    opacity: 0.25,
  },
});

const pathArea = (element: PathElement): number => {
  const points = element.commands.flatMap((command) =>
    command.type === 'move' || command.type === 'line'
      ? [
          {
            xPt: element.frame.xPt + command.xPt,
            yPt: element.frame.yPt + command.yPt,
          },
        ]
      : [],
  );
  return Math.abs(
    points.reduce((area, point, index) => {
      const next = points[(index + 1) % points.length];
      return next === undefined ? area : area + point.xPt * next.yPt - next.xPt * point.yPt;
    }, 0) / 2,
  );
};

const run = (operation: ShapeBooleanOperation, inputs: readonly (ShapeElement | PathElement)[]) => {
  let nextId = 100;
  return performShapeBooleanOperation(inputs, operation, {
    idFactory: () => uuid(nextId++),
  });
};

describe('performShapeBooleanOperation', () => {
  it('unions overlapping rectangles into one styled native path', () => {
    const result = run('union', [shape(1, 0, 0, 100, 100), shape(2, 50, 0, 100, 100)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      id: uuid(100),
      name: 'Union',
      type: 'path',
      frame: { xPt: 0, yPt: 0, widthPt: 150, heightPt: 100, rotationDeg: 0 },
      opacity: 0.8,
      fill: '#123456',
      stroke: { color: '#abcdef', widthPt: 2, dash: 'dash' },
      fillRule: 'nonzero',
      shadow: { color: '#000000' },
    });
    expect(pathArea(result.elements[0]!)).toBeCloseTo(15_000, 6);
  });

  it.each([
    ['intersect', 5_000, 50, 50, 1],
    ['subtract', 5_000, 0, 50, 1],
    ['combine', 10_000, undefined, undefined, 2],
  ] as const)(
    '%s preserves the expected overlapping-rectangle area',
    (operation, area, xPt, widthPt, count) => {
      const result = run(operation, [shape(1, 0, 0, 100, 100), shape(2, 50, 0, 100, 100)]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.elements).toHaveLength(count);
      expect(result.elements.reduce((total, element) => total + pathArea(element), 0)).toBeCloseTo(
        area,
        6,
      );
      if (xPt !== undefined && widthPt !== undefined) {
        expect(result.elements[0]?.frame).toMatchObject({ xPt, widthPt });
      }
    },
  );

  it('keeps disjoint union components as separate canonical paths', () => {
    const result = run('union', [shape(1, 0, 0, 40, 40), shape(2, 100, 0, 40, 40)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements.map((element) => element.frame.xPt)).toEqual([0, 100]);
    expect(result.elements.map(pathArea)).toEqual([1_600, 1_600]);
  });

  it('merges shared edges but keeps point-touching components independent', () => {
    const edgeTouch = run('union', [shape(1, 0, 0, 50, 50), shape(2, 50, 0, 50, 50)]);
    expect(edgeTouch.ok).toBe(true);
    if (edgeTouch.ok) {
      expect(edgeTouch.elements).toHaveLength(1);
      expect(edgeTouch.elements[0]?.frame).toMatchObject({
        xPt: 0,
        widthPt: 100,
        heightPt: 50,
      });
      expect(pathArea(edgeTouch.elements[0]!)).toBeCloseTo(5_000, 6);
    }

    const pointTouch = run('union', [shape(1, 0, 0, 50, 50), shape(2, 50, 50, 50, 50)]);
    expect(pointTouch.ok).toBe(true);
    if (!pointTouch.ok) return;
    expect(pointTouch.elements).toHaveLength(2);
    expect(pointTouch.elements.map(pathArea)).toEqual([2_500, 2_500]);
  });

  it('fragments two overlapping rectangles into three bounded regions', () => {
    const result = run('fragment', [shape(1, 0, 0, 100, 100), shape(2, 50, 0, 100, 100)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(3);
    expect(result.elements.map(pathArea).toSorted((left, right) => left - right)).toEqual([
      5_000, 5_000, 5_000,
    ]);
    expect(result.elements.map((element) => element.name)).toEqual([
      'Fragment 1',
      'Fragment 2',
      'Fragment 3',
    ]);
  });

  it('supports rotated inputs and emits unrotated bounded result frames', () => {
    const result = run('intersect', [
      shape(1, 0, 0, 100, 100, 'rectangle', 45),
      shape(2, 25, 25, 50, 50),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.frame.rotationDeg).toBe(0);
    expect(pathArea(result.elements[0]!)).toBeCloseTo(2_500, 5);
    for (const command of result.elements[0]!.commands) {
      if (command.type === 'move' || command.type === 'line') {
        expect(command.xPt).toBeGreaterThanOrEqual(0);
        expect(command.xPt).toBeLessThanOrEqual(result.elements[0]!.frame.widthPt);
        expect(command.yPt).toBeGreaterThanOrEqual(0);
        expect(command.yPt).toBeLessThanOrEqual(result.elements[0]!.frame.heightPt);
      }
    }
  });

  it.each([
    'rectangle',
    'rounded-rectangle',
    'ellipse',
    'triangle',
    'right-triangle',
    'diamond',
    'parallelogram',
    'trapezoid',
    'pentagon',
    'hexagon',
    'octagon',
    'chevron',
    'cross',
  ] satisfies readonly ShapeKind[])('polygonizes supported %s shapes deterministically', (kind) => {
    const result = run('union', [shape(1, 10, 10, 80, 60, kind), shape(2, 0, 0, 100, 80)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.elements).toHaveLength(1);
    expect(pathArea(result.elements[0]!)).toBeCloseTo(8_000, 3);
  });

  it('accepts a closed straight native path', () => {
    const nativePath: PathElement = {
      id: uuid(1),
      name: 'Freeform',
      type: 'path',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      commands: [
        { type: 'move', xPt: 0, yPt: 0 },
        { type: 'line', xPt: 100, yPt: 0 },
        { type: 'line', xPt: 50, yPt: 100 },
        { type: 'close' },
      ],
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      fillRule: 'nonzero',
    };
    const result = run('intersect', [nativePath, shape(2, 0, 0, 100, 100)]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pathArea(result.elements[0]!)).toBeCloseTo(5_000, 6);
  });

  it.each(['line', 'arrow', 'arc', 'left-bracket', 'right-bracket', 'donut'] as const)(
    'refuses unsupported %s geometry without throwing',
    (kind) => {
      const result = run('union', [shape(1, 0, 0, 100, 100, kind), shape(2, 50, 0, 100, 100)]);

      expect(result).toMatchObject({
        ok: false,
        code: 'UNSUPPORTED_GEOMETRY',
        elementId: uuid(1),
      });
    },
  );

  it('refuses cubic or open paths and locked inputs', () => {
    const cubic: PathElement = {
      id: uuid(1),
      name: 'Cubic',
      type: 'path',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      commands: [
        { type: 'move', xPt: 0, yPt: 0 },
        {
          type: 'cubic',
          control1XPt: 25,
          control1YPt: 0,
          control2XPt: 75,
          control2YPt: 100,
          xPt: 100,
          yPt: 100,
        },
        { type: 'line', xPt: 0, yPt: 100 },
        { type: 'close' },
      ],
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      fillRule: 'nonzero',
    };
    expect(run('union', [cubic, shape(2, 0, 0, 100, 100)])).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_GEOMETRY',
    });
    expect(
      run('union', [{ ...shape(1, 0, 0, 100, 100), locked: true }, shape(2, 50, 0, 100, 100)]),
    ).toMatchObject({ ok: false, code: 'LOCKED_ELEMENT' });
  });

  it('refuses shape text and placeholder bindings instead of discarding content', () => {
    const textBearing: ShapeElement = {
      ...shape(1, 0, 0, 100, 100),
      text: {
        content: {
          blocks: [
            {
              id: uuid(50),
              type: 'paragraph',
              alignment: 'left',
              runs: [
                {
                  text: 'Keep me',
                  marks: {
                    bold: false,
                    italic: false,
                    underline: false,
                    strikethrough: false,
                  },
                },
              ],
            },
          ],
        },
        styleRole: 'body',
        verticalAlignment: 'middle',
        margins: { topPt: 4, rightPt: 4, bottomPt: 4, leftPt: 4 },
      },
    };
    expect(run('union', [textBearing, shape(2, 50, 0, 100, 100)])).toMatchObject({
      ok: false,
      code: 'CONTENT_WOULD_BE_LOST',
      elementId: uuid(1),
    });

    const bound: ShapeElement = {
      ...shape(1, 0, 0, 100, 100),
      placeholderBinding: { placeholderId: uuid(80), overrides: [] },
    };
    expect(run('union', [bound, shape(2, 50, 0, 100, 100)])).toMatchObject({
      ok: false,
      code: 'CONTENT_WOULD_BE_LOST',
    });
  });

  it('rejects holes instead of silently corrupting them', () => {
    const result = run('subtract', [shape(1, 0, 0, 100, 100), shape(2, 25, 25, 50, 50)]);

    expect(result).toMatchObject({ ok: false, code: 'RESULT_HAS_HOLES' });
  });

  it('returns stable failures for empty results, invalid IDs, and command limits', () => {
    expect(run('intersect', [shape(1, 0, 0, 20, 20), shape(2, 100, 100, 20, 20)])).toMatchObject({
      ok: false,
      code: 'RESULT_EMPTY',
    });

    expect(
      performShapeBooleanOperation([shape(1, 0, 0, 100, 100), shape(2, 50, 0, 100, 100)], 'union', {
        idFactory: () => 'not-a-uuid',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_RESULT_ID' });

    const points = Array.from(
      { length: Math.min(510, DOCUMENT_LIMITS.maxPathCommands - 2) },
      (_, index) => {
        const angle = (index / 510) * Math.PI * 2;
        return { xPt: 50 + Math.cos(angle) * 50, yPt: 50 + Math.sin(angle) * 50 };
      },
    );
    const complex: PathElement = {
      id: uuid(1),
      name: 'Complex',
      type: 'path',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      commands: [
        { type: 'move', xPt: points[0]!.xPt, yPt: points[0]!.yPt },
        ...points.slice(1).map((point) => ({ type: 'line' as const, ...point })),
        { type: 'close' },
      ],
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      fillRule: 'nonzero',
    };
    expect(run('union', [complex, shape(2, 0, 0, 100, 100)])).toMatchObject({
      ok: false,
      code: 'RESULT_TOO_COMPLEX',
    });
  });
});
