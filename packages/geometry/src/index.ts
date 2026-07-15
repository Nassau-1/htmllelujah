/**
 * Pure geometry primitives. All coordinates and distances are expressed in points.
 * Functions validate finite input, never mutate arguments, and use deterministic
 * tie-breaking where more than one snapping result is possible.
 */

export interface Point {
  readonly xPt: number;
  readonly yPt: number;
}

export interface Vector {
  readonly dxPt: number;
  readonly dyPt: number;
}

export interface Frame {
  readonly xPt: number;
  readonly yPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly rotationDeg: number;
}

export interface Bounds {
  readonly leftPt: number;
  readonly topPt: number;
  readonly rightPt: number;
  readonly bottomPt: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly centerXPt: number;
  readonly centerYPt: number;
}

export interface GeometryItem {
  readonly id: string;
  readonly frame: Frame;
}

export type Axis = 'x' | 'y';
export type Anchor = 'start' | 'center' | 'end';
export type AlignmentMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributionAxis = 'horizontal' | 'vertical';
export type MoveConstraint = 'none' | 'dominant-axis' | 'x' | 'y';

export type ResizeHandle =
  'north-west' | 'north' | 'north-east' | 'east' | 'south-east' | 'south' | 'south-west' | 'west';

export type GeometryErrorCode =
  'EMPTY_SELECTION' | 'INVALID_ARGUMENT' | 'INVALID_FRAME' | 'INVALID_ITEM';

export class GeometryError extends Error {
  public readonly code: GeometryErrorCode;

  public constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = 'GeometryError';
    this.code = code;
  }
}

const ZERO_EPSILON = 1e-12;
const cleanZero = (value: number): number => (Math.abs(value) < ZERO_EPSILON ? 0 : value);

const requireFinite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) {
    throw new GeometryError('INVALID_ARGUMENT', `${label} must be finite.`);
  }
  return value;
};

const requirePositive = (value: number, label: string): number => {
  requireFinite(value, label);
  if (value <= 0) {
    throw new GeometryError('INVALID_ARGUMENT', `${label} must be greater than zero.`);
  }
  return value;
};

const requireNonNegative = (value: number, label: string): number => {
  requireFinite(value, label);
  if (value < 0) {
    throw new GeometryError('INVALID_ARGUMENT', `${label} cannot be negative.`);
  }
  return value;
};

const requireTolerance = (value: number, label: string): number => {
  if (Number.isNaN(value) || value < 0) {
    throw new GeometryError('INVALID_ARGUMENT', `${label} cannot be negative or NaN.`);
  }
  return value;
};

export const assertValidFrame = (frame: Frame): void => {
  const values = [frame.xPt, frame.yPt, frame.widthPt, frame.heightPt, frame.rotationDeg];
  if (!values.every(Number.isFinite) || frame.widthPt <= 0 || frame.heightPt <= 0) {
    throw new GeometryError(
      'INVALID_FRAME',
      'A frame requires finite coordinates and rotation with positive width and height.',
    );
  }
};

const assertItems = (items: readonly GeometryItem[]): void => {
  const identifiers = new Set<string>();
  for (const item of items) {
    if (item.id.trim().length === 0 || identifiers.has(item.id)) {
      throw new GeometryError(
        'INVALID_ITEM',
        'Geometry item identifiers must be non-empty and unique.',
      );
    }
    identifiers.add(item.id);
    assertValidFrame(item.frame);
  }
};

/** Canonical rotation in the half-open range [-180, 180). */
export const normalizeRotation = (rotationDeg: number): number => {
  requireFinite(rotationDeg, 'rotationDeg');
  return cleanZero(((((rotationDeg + 180) % 360) + 360) % 360) - 180);
};

export const rotateVector = (vector: Vector, rotationDeg: number): Vector => {
  requireFinite(vector.dxPt, 'dxPt');
  requireFinite(vector.dyPt, 'dyPt');
  const radians = (requireFinite(rotationDeg, 'rotationDeg') * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    dxPt: cleanZero(vector.dxPt * cosine - vector.dyPt * sine),
    dyPt: cleanZero(vector.dxPt * sine + vector.dyPt * cosine),
  };
};

export const rotatePointAround = (point: Point, center: Point, rotationDeg: number): Point => {
  requireFinite(point.xPt, 'point.xPt');
  requireFinite(point.yPt, 'point.yPt');
  requireFinite(center.xPt, 'center.xPt');
  requireFinite(center.yPt, 'center.yPt');
  const rotated = rotateVector(
    { dxPt: point.xPt - center.xPt, dyPt: point.yPt - center.yPt },
    rotationDeg,
  );
  return { xPt: center.xPt + rotated.dxPt, yPt: center.yPt + rotated.dyPt };
};

export const frameCenter = (frame: Frame): Point => {
  assertValidFrame(frame);
  return {
    xPt: frame.xPt + frame.widthPt / 2,
    yPt: frame.yPt + frame.heightPt / 2,
  };
};

export const rotatedCorners = (frame: Frame): readonly [Point, Point, Point, Point] => {
  assertValidFrame(frame);
  const center = frameCenter(frame);
  const corners: readonly [Point, Point, Point, Point] = [
    { xPt: frame.xPt, yPt: frame.yPt },
    { xPt: frame.xPt + frame.widthPt, yPt: frame.yPt },
    { xPt: frame.xPt + frame.widthPt, yPt: frame.yPt + frame.heightPt },
    { xPt: frame.xPt, yPt: frame.yPt + frame.heightPt },
  ];
  return corners.map((corner) =>
    rotatePointAround(corner, center, frame.rotationDeg),
  ) as unknown as readonly [Point, Point, Point, Point];
};

export const boundsForPoints = (points: readonly Point[]): Bounds | null => {
  if (points.length === 0) return null;
  let leftPt = Number.POSITIVE_INFINITY;
  let topPt = Number.POSITIVE_INFINITY;
  let rightPt = Number.NEGATIVE_INFINITY;
  let bottomPt = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    requireFinite(point.xPt, 'point.xPt');
    requireFinite(point.yPt, 'point.yPt');
    leftPt = Math.min(leftPt, point.xPt);
    topPt = Math.min(topPt, point.yPt);
    rightPt = Math.max(rightPt, point.xPt);
    bottomPt = Math.max(bottomPt, point.yPt);
  }
  const widthPt = rightPt - leftPt;
  const heightPt = bottomPt - topPt;
  return {
    leftPt: cleanZero(leftPt),
    topPt: cleanZero(topPt),
    rightPt: cleanZero(rightPt),
    bottomPt: cleanZero(bottomPt),
    widthPt: cleanZero(widthPt),
    heightPt: cleanZero(heightPt),
    centerXPt: cleanZero(leftPt + widthPt / 2),
    centerYPt: cleanZero(topPt + heightPt / 2),
  };
};

export const boundsForFrame = (frame: Frame): Bounds => {
  const bounds = boundsForPoints(rotatedCorners(frame));
  if (bounds === null) {
    throw new GeometryError('INVALID_FRAME', 'A valid frame must have corners.');
  }
  return bounds;
};

export const boundsForFrames = (frames: readonly Frame[]): Bounds | null => {
  if (frames.length === 0) return null;
  const points = frames.flatMap((frame) => [...rotatedCorners(frame)]);
  return boundsForPoints(points);
};

export const frameFromBounds = (bounds: Bounds): Frame => {
  requirePositive(bounds.widthPt, 'bounds.widthPt');
  requirePositive(bounds.heightPt, 'bounds.heightPt');
  requireFinite(bounds.leftPt, 'bounds.leftPt');
  requireFinite(bounds.topPt, 'bounds.topPt');
  return {
    xPt: bounds.leftPt,
    yPt: bounds.topPt,
    widthPt: bounds.widthPt,
    heightPt: bounds.heightPt,
    rotationDeg: 0,
  };
};

export const translateFrame = (frame: Frame, delta: Vector): Frame => {
  assertValidFrame(frame);
  requireFinite(delta.dxPt, 'delta.dxPt');
  requireFinite(delta.dyPt, 'delta.dyPt');
  return {
    ...frame,
    xPt: cleanZero(frame.xPt + delta.dxPt),
    yPt: cleanZero(frame.yPt + delta.dyPt),
  };
};

export const constrainMoveDelta = (delta: Vector, constraint: MoveConstraint = 'none'): Vector => {
  requireFinite(delta.dxPt, 'delta.dxPt');
  requireFinite(delta.dyPt, 'delta.dyPt');
  if (constraint === 'x') return { dxPt: delta.dxPt, dyPt: 0 };
  if (constraint === 'y') return { dxPt: 0, dyPt: delta.dyPt };
  if (constraint === 'dominant-axis') {
    return Math.abs(delta.dxPt) >= Math.abs(delta.dyPt)
      ? { dxPt: delta.dxPt, dyPt: 0 }
      : { dxPt: 0, dyPt: delta.dyPt };
  }
  return { ...delta };
};

export const moveItems = <T extends GeometryItem>(
  items: readonly T[],
  delta: Vector,
  constraint: MoveConstraint = 'none',
): readonly T[] => {
  assertItems(items);
  const constrained = constrainMoveDelta(delta, constraint);
  return items.map((item) => ({ ...item, frame: translateFrame(item.frame, constrained) }));
};

export interface ResizeOptions {
  /** Shift behavior. */
  readonly preserveAspectRatio?: boolean;
  /** Alt behavior. */
  readonly fromCenter?: boolean;
  readonly minimumWidthPt?: number;
  readonly minimumHeightPt?: number;
}

const handleDirections: Readonly<
  Record<ResizeHandle, { readonly horizontal: -1 | 0 | 1; readonly vertical: -1 | 0 | 1 }>
> = {
  'north-west': { horizontal: -1, vertical: -1 },
  north: { horizontal: 0, vertical: -1 },
  'north-east': { horizontal: 1, vertical: -1 },
  east: { horizontal: 1, vertical: 0 },
  'south-east': { horizontal: 1, vertical: 1 },
  south: { horizontal: 0, vertical: 1 },
  'south-west': { horizontal: -1, vertical: 1 },
  west: { horizontal: -1, vertical: 0 },
};

const placeSizeOnEdges = (
  horizontal: -1 | 0 | 1,
  vertical: -1 | 0 | 1,
  widthPt: number,
  heightPt: number,
  fromCenter: boolean,
  current: { leftPt: number; rightPt: number; topPt: number; bottomPt: number },
): { leftPt: number; rightPt: number; topPt: number; bottomPt: number } => {
  let { leftPt, rightPt, topPt, bottomPt } = current;
  if (fromCenter || horizontal === 0) {
    leftPt = -widthPt / 2;
    rightPt = widthPt / 2;
  } else if (horizontal < 0) {
    leftPt = rightPt - widthPt;
  } else {
    rightPt = leftPt + widthPt;
  }

  if (fromCenter || vertical === 0) {
    topPt = -heightPt / 2;
    bottomPt = heightPt / 2;
  } else if (vertical < 0) {
    topPt = bottomPt - heightPt;
  } else {
    bottomPt = topPt + heightPt;
  }
  return { leftPt, rightPt, topPt, bottomPt };
};

/** Resize using a world-space pointer delta against any of the eight handles. */
export const resizeFrame = (
  frame: Frame,
  handle: ResizeHandle,
  worldDelta: Vector,
  options: ResizeOptions = {},
): Frame => {
  assertValidFrame(frame);
  requireFinite(worldDelta.dxPt, 'worldDelta.dxPt');
  requireFinite(worldDelta.dyPt, 'worldDelta.dyPt');
  const minimumWidthPt = requirePositive(options.minimumWidthPt ?? 1, 'minimumWidthPt');
  const minimumHeightPt = requirePositive(options.minimumHeightPt ?? 1, 'minimumHeightPt');
  const fromCenter = options.fromCenter ?? false;
  const direction = handleDirections[handle];
  const localDelta = rotateVector(worldDelta, -frame.rotationDeg);

  let leftPt = -frame.widthPt / 2;
  let rightPt = frame.widthPt / 2;
  let topPt = -frame.heightPt / 2;
  let bottomPt = frame.heightPt / 2;

  if (direction.horizontal < 0) {
    if (fromCenter) {
      const halfWidth = Math.max(minimumWidthPt / 2, frame.widthPt / 2 - localDelta.dxPt);
      leftPt = -halfWidth;
      rightPt = halfWidth;
    } else {
      leftPt = Math.min(leftPt + localDelta.dxPt, rightPt - minimumWidthPt);
    }
  } else if (direction.horizontal > 0) {
    if (fromCenter) {
      const halfWidth = Math.max(minimumWidthPt / 2, frame.widthPt / 2 + localDelta.dxPt);
      leftPt = -halfWidth;
      rightPt = halfWidth;
    } else {
      rightPt = Math.max(rightPt + localDelta.dxPt, leftPt + minimumWidthPt);
    }
  }

  if (direction.vertical < 0) {
    if (fromCenter) {
      const halfHeight = Math.max(minimumHeightPt / 2, frame.heightPt / 2 - localDelta.dyPt);
      topPt = -halfHeight;
      bottomPt = halfHeight;
    } else {
      topPt = Math.min(topPt + localDelta.dyPt, bottomPt - minimumHeightPt);
    }
  } else if (direction.vertical > 0) {
    if (fromCenter) {
      const halfHeight = Math.max(minimumHeightPt / 2, frame.heightPt / 2 + localDelta.dyPt);
      topPt = -halfHeight;
      bottomPt = halfHeight;
    } else {
      bottomPt = Math.max(bottomPt + localDelta.dyPt, topPt + minimumHeightPt);
    }
  }

  if (options.preserveAspectRatio ?? false) {
    const aspectRatio = frame.widthPt / frame.heightPt;
    let widthPt = rightPt - leftPt;
    let heightPt = bottomPt - topPt;
    if (direction.horizontal !== 0 && direction.vertical !== 0) {
      const horizontalChange = Math.abs(widthPt / frame.widthPt - 1);
      const verticalChange = Math.abs(heightPt / frame.heightPt - 1);
      if (horizontalChange >= verticalChange) heightPt = widthPt / aspectRatio;
      else widthPt = heightPt * aspectRatio;
    } else if (direction.horizontal !== 0) {
      heightPt = widthPt / aspectRatio;
    } else {
      widthPt = heightPt * aspectRatio;
    }
    const minimumScale = Math.max(minimumWidthPt / widthPt, minimumHeightPt / heightPt, 1);
    widthPt *= minimumScale;
    heightPt *= minimumScale;
    ({ leftPt, rightPt, topPt, bottomPt } = placeSizeOnEdges(
      direction.horizontal,
      direction.vertical,
      widthPt,
      heightPt,
      fromCenter,
      { leftPt, rightPt, topPt, bottomPt },
    ));
  }

  const widthPt = rightPt - leftPt;
  const heightPt = bottomPt - topPt;
  const localCenterOffset = { dxPt: (leftPt + rightPt) / 2, dyPt: (topPt + bottomPt) / 2 };
  const worldCenterOffset = rotateVector(localCenterOffset, frame.rotationDeg);
  const oldCenter = frameCenter(frame);
  const centerXPt = oldCenter.xPt + worldCenterOffset.dxPt;
  const centerYPt = oldCenter.yPt + worldCenterOffset.dyPt;
  return {
    xPt: cleanZero(centerXPt - widthPt / 2),
    yPt: cleanZero(centerYPt - heightPt / 2),
    widthPt: cleanZero(widthPt),
    heightPt: cleanZero(heightPt),
    rotationDeg: normalizeRotation(frame.rotationDeg),
  };
};

export interface RotationOptions {
  /** Shift behavior; typically 15 degrees. */
  readonly snapIncrementDeg?: number;
}

const snapRotation = (rotationDeg: number, incrementDeg: number | undefined): number => {
  if (incrementDeg === undefined) return normalizeRotation(rotationDeg);
  requirePositive(incrementDeg, 'snapIncrementDeg');
  return normalizeRotation(Math.round(rotationDeg / incrementDeg) * incrementDeg);
};

export const rotateFrameBy = (
  frame: Frame,
  deltaDeg: number,
  options: RotationOptions = {},
): Frame => {
  assertValidFrame(frame);
  requireFinite(deltaDeg, 'deltaDeg');
  return {
    ...frame,
    rotationDeg: snapRotation(frame.rotationDeg + deltaDeg, options.snapIncrementDeg),
  };
};

export const rotationFromPointer = (
  frame: Frame,
  startPointer: Point,
  currentPointer: Point,
  startRotationDeg = frame.rotationDeg,
  options: RotationOptions = {},
): number => {
  assertValidFrame(frame);
  requireFinite(startRotationDeg, 'startRotationDeg');
  const center = frameCenter(frame);
  const startAngle = Math.atan2(startPointer.yPt - center.yPt, startPointer.xPt - center.xPt);
  const currentAngle = Math.atan2(currentPointer.yPt - center.yPt, currentPointer.xPt - center.xPt);
  const deltaDeg = normalizeRotation(((currentAngle - startAngle) * 180) / Math.PI);
  return snapRotation(startRotationDeg + deltaDeg, options.snapIncrementDeg);
};

export const clampFrameToBounds = (frame: Frame, container: Bounds): Frame => {
  assertValidFrame(frame);
  requireFinite(container.leftPt, 'container.leftPt');
  requireFinite(container.topPt, 'container.topPt');
  requirePositive(container.widthPt, 'container.widthPt');
  requirePositive(container.heightPt, 'container.heightPt');
  const current = boundsForFrame(frame);
  let dxPt = 0;
  let dyPt = 0;
  if (current.widthPt > container.widthPt) dxPt = container.centerXPt - current.centerXPt;
  else if (current.leftPt < container.leftPt) dxPt = container.leftPt - current.leftPt;
  else if (current.rightPt > container.rightPt) dxPt = container.rightPt - current.rightPt;
  if (current.heightPt > container.heightPt) dyPt = container.centerYPt - current.centerYPt;
  else if (current.topPt < container.topPt) dyPt = container.topPt - current.topPt;
  else if (current.bottomPt > container.bottomPt) dyPt = container.bottomPt - current.bottomPt;
  return translateFrame(frame, { dxPt, dyPt });
};

const alignmentAxis = (mode: AlignmentMode): Axis =>
  mode === 'left' || mode === 'center' || mode === 'right' ? 'x' : 'y';

const alignmentTarget = (mode: AlignmentMode, bounds: Bounds): number => {
  if (mode === 'left') return bounds.leftPt;
  if (mode === 'center') return bounds.centerXPt;
  if (mode === 'right') return bounds.rightPt;
  if (mode === 'top') return bounds.topPt;
  if (mode === 'middle') return bounds.centerYPt;
  return bounds.bottomPt;
};

export const alignItems = <T extends GeometryItem>(
  items: readonly T[],
  mode: AlignmentMode,
  reference?: Bounds,
): readonly T[] => {
  assertItems(items);
  if (items.length === 0) return [];
  const selectionBounds = boundsForFrames(items.map((item) => item.frame));
  if (selectionBounds === null) return [];
  const target = alignmentTarget(mode, reference ?? selectionBounds);
  const axis = alignmentAxis(mode);
  return items.map((item) => {
    const bounds = boundsForFrame(item.frame);
    const itemAnchor = alignmentTarget(mode, bounds);
    const shift = target - itemAnchor;
    return {
      ...item,
      frame: translateFrame(item.frame, {
        dxPt: axis === 'x' ? shift : 0,
        dyPt: axis === 'y' ? shift : 0,
      }),
    };
  });
};

export const distributeItems = <T extends GeometryItem>(
  items: readonly T[],
  axis: DistributionAxis,
  reference?: Bounds,
): readonly T[] => {
  assertItems(items);
  if (items.length < 3 && reference === undefined)
    return items.map((item) => ({ ...item, frame: { ...item.frame } }));
  if (items.length === 0) return [];
  const measurements = items.map((item, originalIndex) => ({
    item,
    originalIndex,
    bounds: boundsForFrame(item.frame),
  }));
  measurements.sort((left, right) => {
    const leftStart = axis === 'horizontal' ? left.bounds.leftPt : left.bounds.topPt;
    const rightStart = axis === 'horizontal' ? right.bounds.leftPt : right.bounds.topPt;
    return leftStart - rightStart || left.item.id.localeCompare(right.item.id);
  });
  const first = measurements[0];
  const last = measurements.at(-1);
  if (first === undefined || last === undefined) return [];
  const startPt = reference
    ? axis === 'horizontal'
      ? reference.leftPt
      : reference.topPt
    : axis === 'horizontal'
      ? first.bounds.leftPt
      : first.bounds.topPt;
  const endPt = reference
    ? axis === 'horizontal'
      ? reference.rightPt
      : reference.bottomPt
    : axis === 'horizontal'
      ? last.bounds.rightPt
      : last.bounds.bottomPt;
  const totalSize = measurements.reduce(
    (sum, measurement) =>
      sum + (axis === 'horizontal' ? measurement.bounds.widthPt : measurement.bounds.heightPt),
    0,
  );
  const gapPt = items.length === 1 ? 0 : (endPt - startPt - totalSize) / (items.length - 1);
  let cursorPt = startPt;
  const positioned = new Map<number, T>();
  for (const measurement of measurements) {
    const currentStart =
      axis === 'horizontal' ? measurement.bounds.leftPt : measurement.bounds.topPt;
    const size = axis === 'horizontal' ? measurement.bounds.widthPt : measurement.bounds.heightPt;
    const shift = cursorPt - currentStart;
    positioned.set(measurement.originalIndex, {
      ...measurement.item,
      frame: translateFrame(measurement.item.frame, {
        dxPt: axis === 'horizontal' ? shift : 0,
        dyPt: axis === 'vertical' ? shift : 0,
      }),
    });
    cursorPt += size + gapPt;
  }
  return items.map((_, index) => positioned.get(index) as T);
};

export interface GridSnapOptions {
  readonly enabled?: boolean;
  readonly spacingPt: number;
  readonly originXPt?: number;
  readonly originYPt?: number;
  readonly tolerancePt?: number;
}

export interface GuidePosition {
  readonly id: string;
  readonly positionPt: number;
}

export interface MoveSnapOptions {
  readonly constraint?: MoveConstraint;
  readonly tolerancePt?: number;
  readonly grid?: GridSnapOptions;
  readonly verticalGuides?: readonly (number | GuidePosition)[];
  readonly horizontalGuides?: readonly (number | GuidePosition)[];
  readonly objects?: readonly GeometryItem[];
}

export interface SmartGuide {
  readonly axis: Axis;
  readonly positionPt: number;
  readonly movingAnchor: Anchor;
  readonly targetAnchor: Anchor;
  readonly targetKind: 'grid' | 'guide' | 'object';
  readonly correctionPt: number;
  readonly targetId?: string;
}

export interface SnapMoveResult<T extends GeometryItem = GeometryItem> {
  readonly items: readonly T[];
  readonly requestedDelta: Vector;
  readonly appliedDelta: Vector;
  readonly guides: readonly SmartGuide[];
}

export interface ScalarSnapResult {
  readonly valuePt: number;
  readonly snapped: boolean;
  readonly correctionPt: number;
  readonly gridLinePt: number;
}

export const snapScalarToGrid = (
  valuePt: number,
  spacingPt: number,
  originPt = 0,
  tolerancePt = Number.POSITIVE_INFINITY,
): ScalarSnapResult => {
  requireFinite(valuePt, 'valuePt');
  requirePositive(spacingPt, 'spacingPt');
  requireFinite(originPt, 'originPt');
  requireTolerance(tolerancePt, 'tolerancePt');
  const gridLinePt = originPt + Math.round((valuePt - originPt) / spacingPt) * spacingPt;
  const correctionPt = cleanZero(gridLinePt - valuePt);
  const snapped = Math.abs(correctionPt) <= tolerancePt;
  return {
    valuePt: snapped ? cleanZero(gridLinePt) : valuePt,
    snapped,
    correctionPt: snapped ? correctionPt : 0,
    gridLinePt: cleanZero(gridLinePt),
  };
};

interface TargetLine {
  readonly axis: Axis;
  readonly positionPt: number;
  readonly kind: SmartGuide['targetKind'];
  readonly targetAnchor: Anchor;
  readonly targetId?: string;
}

interface SnapCandidate {
  readonly distancePt: number;
  readonly correctionPt: number;
  readonly movingAnchor: Anchor;
  readonly line: TargetLine;
}

const anchorRank: Readonly<Record<Anchor, number>> = { start: 0, center: 1, end: 2 };
const kindRank: Readonly<Record<SmartGuide['targetKind'], number>> = {
  guide: 0,
  object: 1,
  grid: 2,
};

const axisAnchors = (bounds: Bounds, axis: Axis): Readonly<Record<Anchor, number>> =>
  axis === 'x'
    ? { start: bounds.leftPt, center: bounds.centerXPt, end: bounds.rightPt }
    : { start: bounds.topPt, center: bounds.centerYPt, end: bounds.bottomPt };

const normalizeGuides = (
  guides: readonly (number | GuidePosition)[],
  axis: Axis,
): readonly TargetLine[] =>
  guides.map((guide, index) => {
    const positionPt = typeof guide === 'number' ? guide : guide.positionPt;
    requireFinite(positionPt, `${axis} guide position`);
    const targetId = typeof guide === 'number' ? `guide-${axis}-${index}` : guide.id;
    return { axis, positionPt, kind: 'guide', targetAnchor: 'center', targetId };
  });

const objectLines = (objects: readonly GeometryItem[], axis: Axis): readonly TargetLine[] => {
  assertItems(objects);
  return objects.flatMap((object) => {
    const anchors = axisAnchors(boundsForFrame(object.frame), axis);
    return (['start', 'center', 'end'] as const).map((targetAnchor) => ({
      axis,
      positionPt: anchors[targetAnchor],
      kind: 'object' as const,
      targetAnchor,
      targetId: object.id,
    }));
  });
};

const compareCandidates = (left: SnapCandidate, right: SnapCandidate): number =>
  left.distancePt - right.distancePt ||
  kindRank[left.line.kind] - kindRank[right.line.kind] ||
  anchorRank[left.movingAnchor] - anchorRank[right.movingAnchor] ||
  anchorRank[left.line.targetAnchor] - anchorRank[right.line.targetAnchor] ||
  left.line.positionPt - right.line.positionPt ||
  (left.line.targetId ?? '').localeCompare(right.line.targetId ?? '');

const snapAxis = (
  bounds: Bounds,
  axis: Axis,
  options: MoveSnapOptions,
  excludedIds: ReadonlySet<string>,
): { readonly correctionPt: number; readonly guides: readonly SmartGuide[] } => {
  const tolerancePt = requireNonNegative(options.tolerancePt ?? 6, 'tolerancePt');
  const anchors = axisAnchors(bounds, axis);
  const objects = (options.objects ?? []).filter((object) => !excludedIds.has(object.id));
  const staticLines = [
    ...normalizeGuides(
      axis === 'x' ? (options.verticalGuides ?? []) : (options.horizontalGuides ?? []),
      axis,
    ),
    ...objectLines(objects, axis),
  ];
  const candidates: SnapCandidate[] = [];
  for (const movingAnchor of ['start', 'center', 'end'] as const) {
    const anchorPosition = anchors[movingAnchor];
    for (const line of staticLines) {
      const correctionPt = line.positionPt - anchorPosition;
      const distancePt = Math.abs(correctionPt);
      if (distancePt <= tolerancePt) {
        candidates.push({ distancePt, correctionPt, movingAnchor, line });
      }
    }
    if (options.grid && (options.grid.enabled ?? true)) {
      const originPt = axis === 'x' ? (options.grid.originXPt ?? 0) : (options.grid.originYPt ?? 0);
      const gridSnap = snapScalarToGrid(
        anchorPosition,
        options.grid.spacingPt,
        originPt,
        options.grid.tolerancePt ?? tolerancePt,
      );
      if (gridSnap.snapped) {
        candidates.push({
          distancePt: Math.abs(gridSnap.correctionPt),
          correctionPt: gridSnap.correctionPt,
          movingAnchor,
          line: {
            axis,
            positionPt: gridSnap.gridLinePt,
            kind: 'grid',
            targetAnchor: 'center',
          },
        });
      }
    }
  }
  candidates.sort(compareCandidates);
  const best = candidates[0];
  if (best === undefined) return { correctionPt: 0, guides: [] };
  const correctedAnchors = Object.fromEntries(
    (['start', 'center', 'end'] as const).map((anchor) => [
      anchor,
      anchors[anchor] + best.correctionPt,
    ]),
  ) as Readonly<Record<Anchor, number>>;
  const coincident = candidates.filter(
    (candidate) =>
      Math.abs(candidate.correctionPt - best.correctionPt) < ZERO_EPSILON &&
      Math.abs(correctedAnchors[candidate.movingAnchor] - candidate.line.positionPt) < ZERO_EPSILON,
  );
  const seen = new Set<string>();
  const guides: SmartGuide[] = [];
  for (const candidate of coincident) {
    const key = [
      axis,
      candidate.line.positionPt,
      candidate.movingAnchor,
      candidate.line.targetAnchor,
      candidate.line.kind,
      candidate.line.targetId ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    guides.push({
      axis,
      positionPt: candidate.line.positionPt,
      movingAnchor: candidate.movingAnchor,
      targetAnchor: candidate.line.targetAnchor,
      targetKind: candidate.line.kind,
      correctionPt: best.correctionPt,
      ...(candidate.line.targetId === undefined ? {} : { targetId: candidate.line.targetId }),
    });
  }
  return { correctionPt: best.correctionPt, guides };
};

export const moveItemsWithSnapping = <T extends GeometryItem>(
  items: readonly T[],
  requestedDelta: Vector,
  options: MoveSnapOptions = {},
): SnapMoveResult<T> => {
  assertItems(items);
  const constraint = options.constraint ?? 'none';
  const constrained = constrainMoveDelta(requestedDelta, constraint);
  if (items.length === 0) {
    return {
      items: [],
      requestedDelta: { ...requestedDelta },
      appliedDelta: constrained,
      guides: [],
    };
  }
  const movedFrames = items.map((item) => translateFrame(item.frame, constrained));
  const movedBounds = boundsForFrames(movedFrames);
  if (movedBounds === null) {
    return {
      items: [],
      requestedDelta: { ...requestedDelta },
      appliedDelta: constrained,
      guides: [],
    };
  }
  const excludedIds = new Set(items.map((item) => item.id));
  const constrainedAxis =
    constraint === 'dominant-axis'
      ? Math.abs(requestedDelta.dxPt) >= Math.abs(requestedDelta.dyPt)
        ? 'x'
        : 'y'
      : constraint;
  const xSnap =
    constrainedAxis === 'y'
      ? { correctionPt: 0, guides: [] }
      : snapAxis(movedBounds, 'x', options, excludedIds);
  const ySnap =
    constrainedAxis === 'x'
      ? { correctionPt: 0, guides: [] }
      : snapAxis(movedBounds, 'y', options, excludedIds);
  const appliedDelta = {
    dxPt: cleanZero(constrained.dxPt + xSnap.correctionPt),
    dyPt: cleanZero(constrained.dyPt + ySnap.correctionPt),
  };
  return {
    items: moveItems(items, appliedDelta),
    requestedDelta: { ...requestedDelta },
    appliedDelta,
    guides: [...xSnap.guides, ...ySnap.guides],
  };
};

export interface GroupCoordinateSpace {
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface GroupGeometry<T extends GeometryItem = GeometryItem> {
  readonly frame: Frame;
  readonly coordinateSpace: GroupCoordinateSpace;
  readonly children: readonly T[];
}

/** Creates an axis-aligned group frame and point-based local child frames. */
export const createGroupGeometry = <T extends GeometryItem>(
  items: readonly T[],
): GroupGeometry<T> => {
  assertItems(items);
  if (items.length === 0) {
    throw new GeometryError('EMPTY_SELECTION', 'A group requires at least one item.');
  }
  const bounds = boundsForFrames(items.map((item) => item.frame));
  if (bounds === null) {
    throw new GeometryError('EMPTY_SELECTION', 'A group requires at least one frame.');
  }
  const frame = frameFromBounds(bounds);
  return {
    frame,
    coordinateSpace: { widthPt: frame.widthPt, heightPt: frame.heightPt },
    children: items.map((item) => ({
      ...item,
      frame: {
        ...item.frame,
        xPt: item.frame.xPt - frame.xPt,
        yPt: item.frame.yPt - frame.yPt,
        rotationDeg: normalizeRotation(item.frame.rotationDeg),
      },
    })),
  };
};

/** Projects local group children into a resized and/or rotated group frame. */
export const projectGroupChildren = <T extends GeometryItem>(
  groupFrame: Frame,
  coordinateSpace: GroupCoordinateSpace,
  children: readonly T[],
): readonly T[] => {
  assertValidFrame(groupFrame);
  requirePositive(coordinateSpace.widthPt, 'coordinateSpace.widthPt');
  requirePositive(coordinateSpace.heightPt, 'coordinateSpace.heightPt');
  assertItems(children);
  const scaleX = groupFrame.widthPt / coordinateSpace.widthPt;
  const scaleY = groupFrame.heightPt / coordinateSpace.heightPt;
  const groupCenter = frameCenter(groupFrame);
  return children.map((child) => {
    const localCenterXPt = (child.frame.xPt + child.frame.widthPt / 2) * scaleX;
    const localCenterYPt = (child.frame.yPt + child.frame.heightPt / 2) * scaleY;
    const offset = rotateVector(
      {
        dxPt: localCenterXPt - groupFrame.widthPt / 2,
        dyPt: localCenterYPt - groupFrame.heightPt / 2,
      },
      groupFrame.rotationDeg,
    );
    const widthPt = child.frame.widthPt * scaleX;
    const heightPt = child.frame.heightPt * scaleY;
    const centerXPt = groupCenter.xPt + offset.dxPt;
    const centerYPt = groupCenter.yPt + offset.dyPt;
    return {
      ...child,
      frame: {
        xPt: cleanZero(centerXPt - widthPt / 2),
        yPt: cleanZero(centerYPt - heightPt / 2),
        widthPt: cleanZero(widthPt),
        heightPt: cleanZero(heightPt),
        rotationDeg: normalizeRotation(child.frame.rotationDeg + groupFrame.rotationDeg),
      },
    };
  });
};

export const transformItemsWithGroup = <T extends GeometryItem>(
  items: readonly T[],
  nextGroupFrame: Frame,
): readonly T[] => {
  const group = createGroupGeometry(items);
  return projectGroupChildren(nextGroupFrame, group.coordinateSpace, group.children);
};
