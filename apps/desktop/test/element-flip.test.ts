import type {
  ConnectorElement,
  Element,
  Frame,
  PathElement,
  ShapeElement,
  ShapeKind,
  ShapeText,
  TextElement,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  flipElementsAroundSelectionBounds,
  inspectElementFlip,
  type ElementFlipAxis,
} from '../src/renderer/editor/element-flip.js';

const frame = (xPt = 100, yPt = 100, widthPt = 120, heightPt = 80, rotationDeg = 0): Frame => ({
  xPt,
  yPt,
  widthPt,
  heightPt,
  rotationDeg,
});

const shape = (
  id: string,
  shapeKind: ShapeKind = 'rectangle',
  elementFrame: Frame = frame(),
): ShapeElement => ({
  id,
  name: `${shapeKind} ${id}`,
  type: 'shape',
  frame: elementFrame,
  opacity: 0.8,
  visible: true,
  locked: false,
  shape: shapeKind,
  fill: '#ddeeff',
  stroke: { color: '#123456', widthPt: 2, dash: 'dash' },
  cornerRadiusPt: 7,
  shadow: {
    color: '#000000',
    blurPt: 4,
    offsetXPt: 2,
    offsetYPt: 3,
    opacity: 0.25,
  },
});

const path = (id: string, elementFrame = frame(100, 200, 100, 80, 30)): PathElement => ({
  id,
  name: `Path ${id}`,
  type: 'path',
  frame: elementFrame,
  opacity: 0.7,
  visible: true,
  locked: false,
  commands: [
    { type: 'move', xPt: 10, yPt: 20 },
    {
      type: 'cubic',
      control1XPt: 20,
      control1YPt: 30,
      control2XPt: 70,
      control2YPt: 60,
      xPt: 90,
      yPt: 70,
    },
    { type: 'close' },
  ],
  fill: '#aabbcc',
  stroke: { color: '#102030', widthPt: 3, dash: 'dot' },
  fillRule: 'evenodd',
  shadow: {
    color: '#000000',
    blurPt: 5,
    offsetXPt: 1,
    offsetYPt: 2,
    opacity: 0.3,
  },
});

const connector = (
  id: string,
  start: ConnectorElement['start'] = { xPt: 10, yPt: 20, binding: {} },
  end: ConnectorElement['end'] = { xPt: 110, yPt: 80, binding: {} },
): ConnectorElement => ({
  id,
  name: `Connector ${id}`,
  type: 'connector',
  frame: frame(10, 20, 100, 60, 17),
  opacity: 0.9,
  visible: true,
  locked: false,
  geometryVersion: 2,
  start,
  end,
  routing: 'elbow',
  stroke: { color: '#556677', widthPt: 2.5, dash: 'solid' },
  startCap: 'none',
  endCap: 'arrow',
});

const simpleShapeText = (): ShapeText => ({
  content: {
    blocks: [
      {
        id: 'paragraph-1',
        type: 'paragraph',
        alignment: 'left',
        runs: [
          {
            text: 'Readable',
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
  margins: { topPt: 6, rightPt: 6, bottomPt: 6, leftPt: 6 },
});

const resultElements = (
  elements: readonly Element[],
  axis: ElementFlipAxis,
): readonly Element[] => {
  const result = flipElementsAroundSelectionBounds(elements, axis);
  if (!result.ok) throw new Error(result.message);
  return result.elements;
};

describe('element flip support inspection', () => {
  it('returns structured, atomic failures for empty, locked, and unsupported selections', () => {
    expect(flipElementsAroundSelectionBounds([], 'horizontal')).toMatchObject({
      ok: false,
      code: 'EMPTY_SELECTION',
    });

    const locked = { ...shape('locked'), locked: true };
    const text: TextElement = {
      id: 'text',
      name: 'Text',
      type: 'text',
      frame: frame(),
      opacity: 1,
      visible: true,
      locked: false,
      styleRole: 'body',
      verticalAlignment: 'top',
      content: { blocks: [] },
    };
    const issues = inspectElementFlip([locked, text], 'vertical');

    expect(issues.map((current) => current.code)).toEqual([
      'LOCKED_ELEMENT',
      'UNSUPPORTED_ELEMENT_TYPE',
    ]);
    expect(issues[1]).toMatchObject({ elementId: 'text', elementType: 'text' });
    expect(flipElementsAroundSelectionBounds([locked, text], 'vertical')).toMatchObject({
      ok: false,
      code: 'LOCKED_ELEMENT',
    });
  });

  it('reports duplicate ids, invalid geometry, and non-representable native shapes explicitly', () => {
    const duplicateA = shape('duplicate');
    const duplicateB = shape('duplicate', 'ellipse');
    const invalidPath = {
      ...path('invalid-path'),
      commands: [
        { type: 'move' as const, xPt: 10, yPt: 20 },
        { type: 'line' as const, xPt: 101, yPt: 20 },
      ],
    };
    const issues = inspectElementFlip(
      [
        duplicateA,
        duplicateB,
        shape('right-triangle', 'right-triangle'),
        shape('parallelogram', 'parallelogram'),
        invalidPath,
      ],
      'horizontal',
    );

    expect(issues.map((current) => current.code)).toEqual([
      'DUPLICATE_ELEMENT_ID',
      'UNSUPPORTED_SHAPE_GEOMETRY',
      'UNSUPPORTED_SHAPE_GEOMETRY',
      'INVALID_PATH_GEOMETRY',
    ]);
  });

  it('rejects a mathematically overflowing collective axis', () => {
    const farLeft = shape('far-left', 'rectangle', frame(-1e308, 0, 1e292, 50));
    const farRight = shape('far-right', 'rectangle', frame(1e308, 100, 1e292, 50));

    expect(flipElementsAroundSelectionBounds([farLeft, farRight], 'horizontal')).toMatchObject({
      ok: false,
      code: 'INVALID_SELECTION_BOUNDS',
    });
  });
});

describe('frame and native shape flips', () => {
  it('mirrors element centers around collective rotated bounds and negates rotation', () => {
    const first = shape('first', 'rectangle', frame(20, 40, 120, 80, 25));
    const second = shape('second', 'ellipse', frame(360, 180, 90, 60, -35));
    const original = structuredClone([first, second]);
    const result = flipElementsAroundSelectionBounds([first, second], 'horizontal');
    if (!result.ok) throw new Error(result.message);

    for (const [index, input] of [first, second].entries()) {
      const output = result.elements[index];
      if (output === undefined) throw new Error('Missing flipped element.');
      const inputCenterX = input.frame.xPt + input.frame.widthPt / 2;
      const outputCenterX = output.frame.xPt + output.frame.widthPt / 2;
      expect(inputCenterX + outputCenterX).toBeCloseTo(2 * result.bounds.centerXPt, 10);
      expect(output.frame.yPt).toBeCloseTo(input.frame.yPt, 10);
      expect(output.frame.widthPt).toBe(input.frame.widthPt);
      expect(output.frame.heightPt).toBe(input.frame.heightPt);
      expect(output.frame.rotationDeg).toBeCloseTo(-input.frame.rotationDeg, 10);
      expect(output.id).toBe(input.id);
    }
    expect([first, second]).toEqual(original);
  });

  it('uses exact current-model mappings for directional shapes', () => {
    const cases = [
      {
        input: shape('triangle', 'triangle'),
        axis: 'vertical' as const,
        shape: 'triangle',
        rotation: -180,
      },
      {
        input: shape('chevron', 'chevron'),
        axis: 'horizontal' as const,
        shape: 'chevron',
        rotation: -180,
      },
      {
        input: shape('bracket', 'left-bracket'),
        axis: 'horizontal' as const,
        shape: 'right-bracket',
        rotation: 0,
      },
      {
        input: shape('arrow', 'arrow'),
        axis: 'horizontal' as const,
        shape: 'arrow',
        rotation: -180,
      },
      {
        input: shape('arc', 'arc'),
        axis: 'horizontal' as const,
        shape: 'arc',
        rotation: 0,
      },
    ] satisfies readonly {
      input: ShapeElement;
      axis: ElementFlipAxis;
      shape: ShapeKind;
      rotation: number;
    }[];

    for (const testCase of cases) {
      const [output] = resultElements([testCase.input], testCase.axis);
      expect(output).toMatchObject({
        id: testCase.input.id,
        type: 'shape',
        shape: testCase.shape,
        frame: { rotationDeg: testCase.rotation },
      });
      if (output?.type !== 'shape') throw new Error('Expected a shape.');
      expect(output.stroke).toBe(testCase.input.stroke);
      expect(output.shadow).toBe(testCase.input.shadow);
    }
  });

  it('does not rotate hosted text when the model cannot mirror shape and text independently', () => {
    const triangleWithText = { ...shape('text-triangle', 'triangle'), text: simpleShapeText() };
    const vertical = flipElementsAroundSelectionBounds([triangleWithText], 'vertical');
    const horizontal = flipElementsAroundSelectionBounds([triangleWithText], 'horizontal');

    expect(vertical).toMatchObject({
      ok: false,
      code: 'CONTENT_TRANSFORM_UNREPRESENTABLE',
    });
    expect(horizontal.ok).toBe(true);
    if (horizontal.ok && horizontal.elements[0]?.type === 'shape') {
      expect(horizontal.elements[0].text).toBe(triangleWithText.text);
    }
  });
});

describe('path and connector flips', () => {
  it('mirrors every path anchor and cubic control while preserving identity and styles', () => {
    const input = path('path');
    const [output] = resultElements([input], 'horizontal');
    if (output?.type !== 'path') throw new Error('Expected a path.');

    expect(output.frame).toEqual(frame(100, 200, 100, 80, -30));
    expect(output.commands).toEqual([
      { type: 'move', xPt: 90, yPt: 20 },
      {
        type: 'cubic',
        control1XPt: 80,
        control1YPt: 30,
        control2XPt: 30,
        control2YPt: 60,
        xPt: 10,
        yPt: 70,
      },
      { type: 'close' },
    ]);
    expect(output.id).toBe(input.id);
    expect(output.name).toBe(input.name);
    expect(output.stroke).toBe(input.stroke);
    expect(output.shadow).toBe(input.shadow);
    expect(input.commands[0]).toEqual({ type: 'move', xPt: 10, yPt: 20 });
  });

  it('uses connector endpoints, not the advisory frame, as connector selection bounds', () => {
    const input = {
      ...connector('connector'),
      frame: frame(-500, -400, 1_000, 900, 17),
    };
    const result = flipElementsAroundSelectionBounds([input], 'horizontal');
    if (!result.ok) throw new Error(result.message);
    const output = result.elements[0];
    if (output?.type !== 'connector') throw new Error('Expected a connector.');

    expect(result.bounds).toMatchObject({
      leftPt: 10,
      topPt: 20,
      rightPt: 110,
      bottomPt: 80,
      centerXPt: 60,
      centerYPt: 50,
    });
    expect(output.start).toEqual({ xPt: 110, yPt: 20, binding: {} });
    expect(output.end).toEqual({ xPt: 10, yPt: 80, binding: {} });
    expect(output.frame.rotationDeg).toBe(-17);
    expect(output.stroke).toBe(input.stroke);
    expect(output.startCap).toBe(input.startCap);
    expect(output.endCap).toBe(input.endCap);
  });

  it('maps selected target anchors and writes a correct mirrored fallback endpoint', () => {
    const target = shape('target', 'rectangle', frame(100, 100, 100, 60));
    const linked = connector(
      'linked',
      {
        xPt: -999,
        yPt: -999,
        binding: { elementId: target.id, anchor: 'left' },
      },
      { xPt: 300, yPt: 130, binding: {} },
    );
    const result = flipElementsAroundSelectionBounds([target, linked], 'horizontal');
    if (!result.ok) throw new Error(result.message);
    const outputTarget = result.elements[0];
    const outputConnector = result.elements[1];
    if (outputTarget?.type !== 'shape' || outputConnector?.type !== 'connector') {
      throw new Error('Expected a shape and connector.');
    }

    expect(outputTarget.frame.xPt).toBe(200);
    expect(outputConnector.start).toEqual({
      xPt: 300,
      yPt: 130,
      binding: { elementId: target.id, anchor: 'right' },
    });
    expect(outputConnector.end).toEqual({ xPt: 100, yPt: 130, binding: {} });
  });

  it('rejects connector bindings outside the atomic selection', () => {
    const linked = connector('linked', {
      xPt: 10,
      yPt: 20,
      binding: { elementId: 'outside', anchor: 'top' },
    });
    const result = flipElementsAroundSelectionBounds([linked], 'vertical');

    expect(result).toMatchObject({
      ok: false,
      code: 'EXTERNAL_CONNECTOR_BINDING',
      issues: [{ elementId: 'linked' }],
    });
  });

  it('round-trips supported path and connector geometry on both axes', () => {
    const assertRoundTrip = (axis: ElementFlipAxis): void => {
      const inputs: readonly Element[] = [
        shape('shape', 'rectangle', frame(20, 30, 100, 70, 27)),
        path('path', frame(250, 160, 100, 80, -15)),
        connector(
          'connector',
          { xPt: 80, yPt: 300, binding: {} },
          { xPt: 410, yPt: 360, binding: {} },
        ),
      ];
      const first = flipElementsAroundSelectionBounds(inputs, axis);
      if (!first.ok) throw new Error(first.message);
      const second = flipElementsAroundSelectionBounds(first.elements, axis);
      if (!second.ok) throw new Error(second.message);

      expect(second.elements).toHaveLength(inputs.length);
      for (const [index, input] of inputs.entries()) {
        const output = second.elements[index];
        if (output === undefined) throw new Error('Missing round-trip output.');
        expect(output.id).toBe(input.id);
        expect(output.type).toBe(input.type);
        expect(output.frame.xPt).toBeCloseTo(input.frame.xPt, 9);
        expect(output.frame.yPt).toBeCloseTo(input.frame.yPt, 9);
        expect(output.frame.rotationDeg).toBeCloseTo(input.frame.rotationDeg, 9);
      }
      expect(second.elements[1]).toMatchObject({ commands: (inputs[1] as PathElement).commands });
      expect(second.elements[2]).toMatchObject({
        start: (inputs[2] as ConnectorElement).start,
        end: (inputs[2] as ConnectorElement).end,
      });
    };

    assertRoundTrip('horizontal');
    assertRoundTrip('vertical');
  });
});
