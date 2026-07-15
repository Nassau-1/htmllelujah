import { describe, expect, it } from 'vitest';

import {
  GeometryError,
  alignItems,
  assertValidFrame,
  boundsForFrame,
  boundsForFrames,
  clampFrameToBounds,
  constrainMoveDelta,
  createGroupGeometry,
  distributeItems,
  frameCenter,
  moveItems,
  moveItemsWithSnapping,
  normalizeRotation,
  projectGroupChildren,
  resizeFrame,
  rotateFrameBy,
  rotatePointAround,
  rotateVector,
  rotatedCorners,
  rotationFromPointer,
  snapScalarToGrid,
  transformItemsWithGroup,
  translateFrame,
  type Bounds,
  type Frame,
  type GeometryItem,
  type ResizeHandle,
} from '../src/index.js';

const frame = (xPt = 10, yPt = 20, widthPt = 100, heightPt = 60, rotationDeg = 0): Frame => ({
  xPt,
  yPt,
  widthPt,
  heightPt,
  rotationDeg,
});

const item = (id: string, value: Frame): GeometryItem => ({ id, frame: value });

const expectFrameClose = (actual: Frame, expected: Frame, precision = 9): void => {
  expect(actual.xPt).toBeCloseTo(expected.xPt, precision);
  expect(actual.yPt).toBeCloseTo(expected.yPt, precision);
  expect(actual.widthPt).toBeCloseTo(expected.widthPt, precision);
  expect(actual.heightPt).toBeCloseTo(expected.heightPt, precision);
  expect(actual.rotationDeg).toBeCloseTo(expected.rotationDeg, precision);
};

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

const seededValues = (count: number): readonly number[] => {
  let state = 0x5eed_1234;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    values.push(state / 0x1_0000_0000);
  }
  return values;
};

describe('validation and canonical rotation', () => {
  it.each([
    [0, 0],
    [180, -180],
    [-180, -180],
    [360, 0],
    [-360, 0],
    [540, -180],
    [725, 5],
    [-725, -5],
  ])('normalizes %s degrees to %s', (input, expected) => {
    expect(normalizeRotation(input)).toBe(expected);
  });

  it('rejects non-finite values, invalid sizes, identifiers, and snap settings', () => {
    expect(() => assertValidFrame(frame(0, 0, 0, 1))).toThrowError(GeometryError);
    expect(() => assertValidFrame(frame(0, 0, 1, -1))).toThrowError(GeometryError);
    expect(() => normalizeRotation(Number.NaN)).toThrowError(GeometryError);
    expect(() => translateFrame(frame(), { dxPt: Number.POSITIVE_INFINITY, dyPt: 0 })).toThrowError(
      GeometryError,
    );
    expect(() =>
      moveItems([item('same', frame()), item('same', frame(20))], { dxPt: 1, dyPt: 1 }),
    ).toThrowError(GeometryError);
    expect(() => snapScalarToGrid(1, 0)).toThrowError(GeometryError);
    expect(() => snapScalarToGrid(1, 10, 0, -1)).toThrowError(GeometryError);
  });
});

describe('rotated bounds and transformations', () => {
  it('returns exact axis-aligned and quarter-turn bounds', () => {
    expect(boundsForFrame(frame(10, 20, 100, 60, 0))).toEqual({
      leftPt: 10,
      topPt: 20,
      rightPt: 110,
      bottomPt: 80,
      widthPt: 100,
      heightPt: 60,
      centerXPt: 60,
      centerYPt: 50,
    });
    const quarterTurn = boundsForFrame(frame(10, 20, 100, 60, 90));
    expect(quarterTurn.leftPt).toBeCloseTo(30);
    expect(quarterTurn.topPt).toBeCloseTo(0);
    expect(quarterTurn.rightPt).toBeCloseTo(90);
    expect(quarterTurn.bottomPt).toBeCloseTo(100);
    expect(quarterTurn.widthPt).toBeCloseTo(60);
    expect(quarterTurn.heightPt).toBeCloseTo(100);
  });

  it('computes the expected square bounds at 45 degrees', () => {
    const bounds = boundsForFrame(frame(0, 0, 100, 100, 45));
    const expectedSize = Math.sqrt(2) * 100;
    expect(bounds.widthPt).toBeCloseTo(expectedSize);
    expect(bounds.heightPt).toBeCloseTo(expectedSize);
    expect(bounds.centerXPt).toBeCloseTo(50);
    expect(bounds.centerYPt).toBeCloseTo(50);
  });

  it('keeps every rotated corner inside its bounds across many deterministic samples', () => {
    const values = seededValues(240);
    for (let index = 0; index < values.length; index += 6) {
      const candidate = frame(
        values[index]! * 400 - 200,
        values[index + 1]! * 300 - 150,
        values[index + 2]! * 500 + 0.1,
        values[index + 3]! * 300 + 0.1,
        values[index + 4]! * 2_000 - 1_000,
      );
      const bounds = boundsForFrame(candidate);
      for (const corner of rotatedCorners(candidate)) {
        expect(corner.xPt).toBeGreaterThanOrEqual(bounds.leftPt - 1e-9);
        expect(corner.xPt).toBeLessThanOrEqual(bounds.rightPt + 1e-9);
        expect(corner.yPt).toBeGreaterThanOrEqual(bounds.topPt - 1e-9);
        expect(corner.yPt).toBeLessThanOrEqual(bounds.bottomPt + 1e-9);
      }
      expect(bounds.centerXPt).toBeCloseTo(frameCenter(candidate).xPt, 9);
      expect(bounds.centerYPt).toBeCloseTo(frameCenter(candidate).yPt, 9);
    }
  });

  it('round-trips vectors and points through inverse rotations', () => {
    for (const angle of [-179, -90, -17.5, 0, 33, 90, 179]) {
      const vector = { dxPt: 27.25, dyPt: -91.5 };
      const roundTrip = rotateVector(rotateVector(vector, angle), -angle);
      expect(roundTrip.dxPt).toBeCloseTo(vector.dxPt, 10);
      expect(roundTrip.dyPt).toBeCloseTo(vector.dyPt, 10);
      const point = { xPt: 14, yPt: -30 };
      const center = { xPt: 3, yPt: 8 };
      const pointRoundTrip = rotatePointAround(
        rotatePointAround(point, center, angle),
        center,
        -angle,
      );
      expect(pointRoundTrip.xPt).toBeCloseTo(point.xPt, 10);
      expect(pointRoundTrip.yPt).toBeCloseTo(point.yPt, 10);
    }
  });

  it('unions rotated frame bounds without mutating inputs', () => {
    const frames = deepFreeze([frame(0, 0, 10, 10, 45), frame(100, 50, 20, 30, -30)]);
    const before = JSON.stringify(frames);
    const union = boundsForFrames(frames);
    expect(union).not.toBeNull();
    expect(union!.leftPt).toBeLessThan(0);
    expect(union!.rightPt).toBeGreaterThan(120);
    expect(JSON.stringify(frames)).toBe(before);
  });
});

describe('movement and containment', () => {
  it('applies explicit and Shift-like dominant-axis constraints', () => {
    expect(constrainMoveDelta({ dxPt: 10, dyPt: 4 }, 'dominant-axis')).toEqual({
      dxPt: 10,
      dyPt: 0,
    });
    expect(constrainMoveDelta({ dxPt: 4, dyPt: -10 }, 'dominant-axis')).toEqual({
      dxPt: 0,
      dyPt: -10,
    });
    expect(constrainMoveDelta({ dxPt: 5, dyPt: 5 }, 'dominant-axis')).toEqual({
      dxPt: 5,
      dyPt: 0,
    });
    expect(constrainMoveDelta({ dxPt: 5, dyPt: 5 }, 'x')).toEqual({ dxPt: 5, dyPt: 0 });
    expect(constrainMoveDelta({ dxPt: 5, dyPt: 5 }, 'y')).toEqual({ dxPt: 0, dyPt: 5 });
  });

  it('moves a selection as an immutable rigid set', () => {
    const input = deepFreeze([
      item('a', frame(0, 0, 10, 10)),
      item('b', frame(30, 40, 20, 20, 30)),
    ]);
    const output = moveItems(input, { dxPt: 7, dyPt: -4 });
    expectFrameClose(output[0]!.frame, frame(7, -4, 10, 10));
    expectFrameClose(output[1]!.frame, frame(37, 36, 20, 20, 30));
    expect(output).not.toBe(input);
    expect(output[0]).not.toBe(input[0]);
  });

  it('clamps rotated frames and centers frames larger than the container', () => {
    const container: Bounds = {
      leftPt: 0,
      topPt: 0,
      rightPt: 100,
      bottomPt: 100,
      widthPt: 100,
      heightPt: 100,
      centerXPt: 50,
      centerYPt: 50,
    };
    const clamped = clampFrameToBounds(frame(-40, 80, 30, 20, 45), container);
    const clampedBounds = boundsForFrame(clamped);
    expect(clampedBounds.leftPt).toBeGreaterThanOrEqual(-1e-9);
    expect(clampedBounds.bottomPt).toBeLessThanOrEqual(100 + 1e-9);
    const oversized = clampFrameToBounds(frame(-100, -100, 200, 150, 0), container);
    expect(frameCenter(oversized)).toEqual({ xPt: 50, yPt: 50 });
  });
});

describe('eight-handle resizing and modifier constraints', () => {
  const cases: readonly [ResizeHandle, { dxPt: number; dyPt: number }, Frame][] = [
    ['north-west', { dxPt: -10, dyPt: -5 }, frame(0, 15, 110, 65)],
    ['north', { dxPt: 0, dyPt: -5 }, frame(10, 15, 100, 65)],
    ['north-east', { dxPt: 10, dyPt: -5 }, frame(10, 15, 110, 65)],
    ['east', { dxPt: 10, dyPt: 0 }, frame(10, 20, 110, 60)],
    ['south-east', { dxPt: 10, dyPt: 5 }, frame(10, 20, 110, 65)],
    ['south', { dxPt: 0, dyPt: 5 }, frame(10, 20, 100, 65)],
    ['south-west', { dxPt: -10, dyPt: 5 }, frame(0, 20, 110, 65)],
    ['west', { dxPt: -10, dyPt: 0 }, frame(0, 20, 110, 60)],
  ];

  it.each(cases)('resizes the %s handle in frame-local geometry', (handle, delta, expected) => {
    expectFrameClose(resizeFrame(frame(), handle, delta), expected);
  });

  it('enforces minimum sizes without flipping handles', () => {
    expectFrameClose(
      resizeFrame(frame(), 'east', { dxPt: -1_000, dyPt: 0 }, { minimumWidthPt: 10 }),
      frame(10, 20, 10, 60),
    );
    expectFrameClose(
      resizeFrame(frame(), 'west', { dxPt: 1_000, dyPt: 0 }, { minimumWidthPt: 10 }),
      frame(100, 20, 10, 60),
    );
    expectFrameClose(
      resizeFrame(frame(), 'north', { dxPt: 0, dyPt: 1_000 }, { minimumHeightPt: 12 }),
      frame(10, 68, 100, 12),
    );
  });

  it('uses Alt-like center resizing', () => {
    const resized = resizeFrame(frame(), 'east', { dxPt: 10, dyPt: 0 }, { fromCenter: true });
    expectFrameClose(resized, frame(0, 20, 120, 60));
    expect(frameCenter(resized)).toEqual(frameCenter(frame()));
  });

  it('uses Shift-like aspect locking for edges and corners', () => {
    expectFrameClose(
      resizeFrame(frame(), 'east', { dxPt: 20, dyPt: 0 }, { preserveAspectRatio: true }),
      frame(10, 14, 120, 72),
    );
    expectFrameClose(
      resizeFrame(frame(), 'south-east', { dxPt: 20, dyPt: 1 }, { preserveAspectRatio: true }),
      frame(10, 20, 120, 72),
    );
    expectFrameClose(
      resizeFrame(frame(), 'south', { dxPt: 0, dyPt: 12 }, { preserveAspectRatio: true }),
      frame(0, 20, 120, 72),
    );
  });

  it('combines Shift and Alt while preserving center and aspect ratio', () => {
    const resized = resizeFrame(
      frame(),
      'south-east',
      { dxPt: 10, dyPt: 6 },
      { preserveAspectRatio: true, fromCenter: true },
    );
    expectFrameClose(resized, frame(0, 14, 120, 72));
    expect(frameCenter(resized)).toEqual(frameCenter(frame()));
  });

  it('converts world deltas into local axes for rotated frames', () => {
    const resized = resizeFrame(frame(10, 20, 100, 60, 90), 'east', { dxPt: 0, dyPt: 10 });
    expectFrameClose(resized, frame(5, 25, 110, 60, 90));
  });

  it('preserves invariants for every handle, angle, and deterministic input sample', () => {
    const handles: readonly ResizeHandle[] = [
      'north-west',
      'north',
      'north-east',
      'east',
      'south-east',
      'south',
      'south-west',
      'west',
    ];
    const values = seededValues(160);
    for (let index = 0; index < values.length; index += 4) {
      const source = deepFreeze(
        frame(
          values[index]! * 100,
          values[index + 1]! * 100,
          values[index + 2]! * 200 + 20,
          values[index + 3]! * 120 + 20,
          index * 17 - 400,
        ),
      );
      for (const handle of handles) {
        const delta = { dxPt: values[index + 1]! * 80 - 40, dyPt: values[index + 2]! * 80 - 40 };
        const resized = resizeFrame(source, handle, delta, {
          minimumWidthPt: 4,
          minimumHeightPt: 3,
          preserveAspectRatio: true,
          fromCenter: true,
        });
        expect(resized.widthPt).toBeGreaterThanOrEqual(4 - 1e-9);
        expect(resized.heightPt).toBeGreaterThanOrEqual(3 - 1e-9);
        expect(resized.widthPt / resized.heightPt).toBeCloseTo(source.widthPt / source.heightPt, 8);
        expect(frameCenter(resized).xPt).toBeCloseTo(frameCenter(source).xPt, 8);
        expect(frameCenter(resized).yPt).toBeCloseTo(frameCenter(source).yPt, 8);
        expect(resized.rotationDeg).toBeGreaterThanOrEqual(-180);
        expect(resized.rotationDeg).toBeLessThan(180);
        expectFrameClose(
          resizeFrame(source, handle, delta, {
            minimumWidthPt: 4,
            minimumHeightPt: 3,
            preserveAspectRatio: true,
            fromCenter: true,
          }),
          resized,
        );
      }
    }
  });
});

describe('rotation interactions', () => {
  it('normalizes free rotation and snaps Shift-like increments', () => {
    expect(rotateFrameBy(frame(0, 0, 10, 10, 170), 20).rotationDeg).toBe(-170);
    expect(rotateFrameBy(frame(0, 0, 10, 10, 7), 12, { snapIncrementDeg: 15 }).rotationDeg).toBe(
      15,
    );
  });

  it('derives rotation from pointer movement around the frame center', () => {
    const source = frame(0, 0, 100, 100);
    expect(rotationFromPointer(source, { xPt: 100, yPt: 50 }, { xPt: 50, yPt: 100 })).toBeCloseTo(
      90,
    );
    expect(
      rotationFromPointer(source, { xPt: 100, yPt: 50 }, { xPt: 95, yPt: 75 }, 0, {
        snapIncrementDeg: 15,
      }),
    ).toBe(30);
  });
});

describe('alignment and distribution', () => {
  it.each(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const)(
    'aligns rotated item bounds in %s mode',
    (mode) => {
      const input = deepFreeze([
        item('a', frame(0, 0, 40, 20, 30)),
        item('b', frame(100, 60, 20, 50, -20)),
        item('c', frame(200, 20, 70, 30, 0)),
      ]);
      const output = alignItems(input, mode);
      const bounds = output.map((entry) => boundsForFrame(entry.frame));
      const anchors = bounds.map((entry) => {
        if (mode === 'left') return entry.leftPt;
        if (mode === 'center') return entry.centerXPt;
        if (mode === 'right') return entry.rightPt;
        if (mode === 'top') return entry.topPt;
        if (mode === 'middle') return entry.centerYPt;
        return entry.bottomPt;
      });
      expect(Math.max(...anchors) - Math.min(...anchors)).toBeLessThan(1e-9);
      expect(input[1]!.frame.xPt).toBe(100);
    },
  );

  it('aligns against an external reference bound', () => {
    const reference: Bounds = {
      leftPt: 10,
      topPt: 20,
      rightPt: 210,
      bottomPt: 120,
      widthPt: 200,
      heightPt: 100,
      centerXPt: 110,
      centerYPt: 70,
    };
    const output = alignItems([item('a', frame(0, 0, 20, 20))], 'right', reference);
    expect(boundsForFrame(output[0]!.frame).rightPt).toBe(210);
  });

  it('distributes mixed rotated widths with equal gaps and preserves caller order', () => {
    const input = [
      item('middle', frame(100, 10, 40, 20, 15)),
      item('last', frame(260, 10, 30, 20, -25)),
      item('first', frame(0, 10, 20, 20, 0)),
    ];
    const output = distributeItems(input, 'horizontal');
    expect(output.map((entry) => entry.id)).toEqual(['middle', 'last', 'first']);
    const sorted = [...output].sort(
      (left, right) => boundsForFrame(left.frame).leftPt - boundsForFrame(right.frame).leftPt,
    );
    const firstGap =
      boundsForFrame(sorted[1]!.frame).leftPt - boundsForFrame(sorted[0]!.frame).rightPt;
    const secondGap =
      boundsForFrame(sorted[2]!.frame).leftPt - boundsForFrame(sorted[1]!.frame).rightPt;
    expect(firstGap).toBeCloseTo(secondGap, 9);
    expectFrameClose(output[1]!.frame, input[1]!.frame);
    expectFrameClose(output[2]!.frame, input[2]!.frame);
  });

  it('uses a supplied distribution span and handles small selections deterministically', () => {
    const reference: Bounds = {
      leftPt: 0,
      topPt: 0,
      rightPt: 300,
      bottomPt: 100,
      widthPt: 300,
      heightPt: 100,
      centerXPt: 150,
      centerYPt: 50,
    };
    const pair = [item('a', frame(30, 20, 20, 20)), item('b', frame(80, 20, 20, 20))];
    const distributed = distributeItems(pair, 'horizontal', reference);
    expect(boundsForFrame(distributed[0]!.frame).leftPt).toBe(0);
    expect(boundsForFrame(distributed[1]!.frame).rightPt).toBe(300);
    const noReference = distributeItems(pair, 'horizontal');
    expectFrameClose(noReference[0]!.frame, pair[0]!.frame);
    expectFrameClose(noReference[1]!.frame, pair[1]!.frame);
  });
});

describe('grid, guide, and object snapping', () => {
  it('snaps scalar values within tolerance and reports misses', () => {
    expect(snapScalarToGrid(19, 10, 0, 2)).toEqual({
      valuePt: 20,
      snapped: true,
      correctionPt: 1,
      gridLinePt: 20,
    });
    expect(snapScalarToGrid(16, 10, 0, 2)).toEqual({
      valuePt: 16,
      snapped: false,
      correctionPt: 0,
      gridLinePt: 20,
    });
    expect(snapScalarToGrid(-9, 10, 1, 0)).toEqual({
      valuePt: -9,
      snapped: true,
      correctionPt: 0,
      gridLinePt: -9,
    });
    expect(snapScalarToGrid(4, 10)).toEqual({
      valuePt: 0,
      snapped: true,
      correctionPt: -4,
      gridLinePt: 0,
    });
  });

  it('snaps a moving selection to the grid as one rigid group', () => {
    const input = [item('a', frame(1, 1, 8, 8)), item('b', frame(21, 21, 8, 8))];
    const result = moveItemsWithSnapping(
      input,
      { dxPt: 0, dyPt: 0 },
      {
        grid: { spacingPt: 10, tolerancePt: 2 },
      },
    );
    expect(result.appliedDelta).toEqual({ dxPt: -1, dyPt: -1 });
    expect(result.items[0]!.frame.xPt).toBe(0);
    expect(result.items[1]!.frame.xPt - result.items[0]!.frame.xPt).toBe(20);
    expect(result.guides.some((guide) => guide.targetKind === 'grid')).toBe(true);
  });

  it('snaps to explicit guides and emits stable smart-guide metadata', () => {
    const result = moveItemsWithSnapping(
      [item('a', frame(42, 10, 10, 10))],
      {
        dxPt: 0,
        dyPt: 0,
      },
      {
        tolerancePt: 3,
        verticalGuides: [{ id: 'page-center', positionPt: 50 }],
      },
    );
    expect(result.appliedDelta.dxPt).toBe(-2);
    expect(result.guides).toContainEqual({
      axis: 'x',
      positionPt: 50,
      movingAnchor: 'end',
      targetAnchor: 'center',
      targetKind: 'guide',
      correctionPt: -2,
      targetId: 'page-center',
    });
  });

  it('snaps rotated bounds to object starts while excluding selected objects', () => {
    const moving = item('moving', frame(80, 20, 10, 10));
    const target = item('target', frame(100, 20, 20, 20));
    const result = moveItemsWithSnapping(
      [moving],
      { dxPt: 7, dyPt: 0 },
      {
        tolerancePt: 4,
        objects: [moving, target],
      },
    );
    expect(result.appliedDelta.dxPt).toBe(10);
    expect(boundsForFrame(result.items[0]!.frame).rightPt).toBe(100);
    expect(result.guides.some((guide) => guide.targetId === 'target')).toBe(true);
    expect(result.guides.some((guide) => guide.targetId === 'moving')).toBe(false);
  });

  it('chooses the nearest candidate, then guide/object/grid priority deterministically', () => {
    const options = {
      tolerancePt: 3,
      verticalGuides: [{ id: 'guide', positionPt: 20 }],
      objects: [item('object', frame(20, 50, 10, 10))],
      grid: { spacingPt: 10, tolerancePt: 3 },
    } as const;
    const first = moveItemsWithSnapping(
      [item('moving', frame(0, 0, 10, 10))],
      {
        dxPt: 10,
        dyPt: 0,
      },
      options,
    );
    const second = moveItemsWithSnapping(
      [item('moving', frame(0, 0, 10, 10))],
      {
        dxPt: 10,
        dyPt: 0,
      },
      options,
    );
    expect(first).toEqual(second);
    expect(first.guides[0]!.targetKind).toBe('guide');
  });

  it('does not snap outside tolerance and never reintroduces a Shift-locked axis', () => {
    const miss = moveItemsWithSnapping(
      [item('a', frame(40, 40, 10, 10))],
      {
        dxPt: 1,
        dyPt: 1,
      },
      {
        tolerancePt: 1,
        verticalGuides: [100],
        horizontalGuides: [100],
      },
    );
    expect(miss.appliedDelta).toEqual({ dxPt: 1, dyPt: 1 });
    const constrained = moveItemsWithSnapping(
      [item('a', frame(0, 1, 10, 8))],
      {
        dxPt: 15,
        dyPt: 3,
      },
      {
        constraint: 'dominant-axis',
        grid: { spacingPt: 10, tolerancePt: 2 },
      },
    );
    expect(constrained.appliedDelta.dyPt).toBe(0);
  });
});

describe('group coordinate frames', () => {
  it('creates an enclosing axis-aligned group and local children without mutation', () => {
    const input = deepFreeze([
      item('a', frame(10, 20, 40, 20, 30)),
      item('b', frame(100, 70, 20, 30, -20)),
    ]);
    const group = createGroupGeometry(input);
    const expectedBounds = boundsForFrames(input.map((entry) => entry.frame));
    expect(expectedBounds).not.toBeNull();
    expectFrameClose(group.frame, {
      xPt: expectedBounds!.leftPt,
      yPt: expectedBounds!.topPt,
      widthPt: expectedBounds!.widthPt,
      heightPt: expectedBounds!.heightPt,
      rotationDeg: 0,
    });
    expect(group.children[0]!.frame.xPt).toBeCloseTo(input[0]!.frame.xPt - group.frame.xPt);
    expect(input[0]!.frame.xPt).toBe(10);
  });

  it('round-trips local children through the original group frame', () => {
    const input = [item('a', frame(10, 20, 40, 20, 30)), item('b', frame(100, 70, 20, 30, -20))];
    const group = createGroupGeometry(input);
    const projected = projectGroupChildren(group.frame, group.coordinateSpace, group.children);
    projected.forEach((entry, index) => expectFrameClose(entry.frame, input[index]!.frame));
  });

  it('scales, translates, and rotates children deterministically with a group', () => {
    const input = [item('a', frame(0, 0, 10, 10)), item('b', frame(20, 0, 10, 10))];
    const group = createGroupGeometry(input);
    const nextGroup = frame(100, 200, group.frame.widthPt * 2, group.frame.heightPt * 3, 90);
    const projected = projectGroupChildren(nextGroup, group.coordinateSpace, group.children);
    expect(projected[0]!.frame.widthPt).toBeCloseTo(20);
    expect(projected[0]!.frame.heightPt).toBeCloseTo(30);
    expect(projected[0]!.frame.rotationDeg).toBe(90);
    expect(projected[1]!.frame.rotationDeg).toBe(90);
    const centers = projected.map((entry) => frameCenter(entry.frame));
    expect(centers[0]!.xPt).toBeCloseTo(centers[1]!.xPt);
    expect(Math.abs(centers[0]!.yPt - centers[1]!.yPt)).toBeCloseTo(40);
    expect(projectGroupChildren(nextGroup, group.coordinateSpace, group.children)).toEqual(
      projected,
    );
  });

  it('provides a convenience transform and rejects empty groups', () => {
    const input = [item('a', frame(0, 0, 10, 10)), item('b', frame(20, 0, 10, 10))];
    const transformed = transformItemsWithGroup(input, frame(50, 50, 60, 20, 0));
    expect(transformed[0]!.frame.widthPt).toBe(20);
    expect(transformed[1]!.frame.xPt).toBe(90);
    expect(() => createGroupGeometry([])).toThrowError(GeometryError);
  });
});
