import {
  DOCUMENT_LIMITS,
  type PathCommand,
  type PathElement,
  type ShapeElement,
  type ShapeKind,
} from '@htmllelujah/document-core';

export type ShapeBooleanInput = ShapeElement | PathElement;

export type ShapeBooleanOperation = 'union' | 'combine' | 'intersect' | 'subtract' | 'fragment';

export type ShapeBooleanFailureCode =
  | 'SELECTION_TOO_SMALL'
  | 'SELECTION_TOO_LARGE'
  | 'LOCKED_ELEMENT'
  | 'CONTENT_WOULD_BE_LOST'
  | 'UNSUPPORTED_GEOMETRY'
  | 'DEGENERATE_GEOMETRY'
  | 'RESULT_EMPTY'
  | 'RESULT_TOO_COMPLEX'
  | 'RESULT_HAS_HOLES'
  | 'RESULT_OUT_OF_BOUNDS'
  | 'INVALID_RESULT_ID';

export type ShapeBooleanFailure = Readonly<{
  ok: false;
  code: ShapeBooleanFailureCode;
  message: string;
  elementId?: string | undefined;
}>;

export type ShapeBooleanSuccess = Readonly<{
  ok: true;
  elements: readonly PathElement[];
  sourceIds: readonly string[];
}>;

export type ShapeBooleanResult = ShapeBooleanSuccess | ShapeBooleanFailure;

export type ShapeBooleanOptions = Readonly<{
  idFactory: () => string;
  /** Deterministic segment count used for ellipses. */
  ellipseSegments?: number | undefined;
  /** Deterministic segment count used for each rounded corner. */
  roundedCornerSegments?: number | undefined;
}>;

type Point = Readonly<{ xPt: number; yPt: number }>;
type Polygon = readonly Point[];
type Edge = Readonly<{
  start: Point;
  end: Point;
  polygonIndex: number;
  edgeIndex: number;
}>;
type AtomicSegment = Readonly<{ start: Point; end: Point }>;
type Vertex = { xTotal: number; yTotal: number; count: number };
type KeyedSegment = Readonly<{
  startKey: string;
  endKey: string;
}>;

const MAX_INPUT_ELEMENTS = 16;
const MAX_INPUT_EDGES = 512;
const MAX_ATOMIC_SEGMENTS = DOCUMENT_LIMITS.maxPathCommands * 4;
const DEFAULT_ELLIPSE_SEGMENTS = 48;
const DEFAULT_CORNER_SEGMENTS = 8;
const MIN_CURVE_SEGMENTS = 4;
const MAX_CURVE_SEGMENTS = 96;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const operationLabel = (operation: ShapeBooleanOperation): string => {
  switch (operation) {
    case 'union':
      return 'Union';
    case 'combine':
      return 'Combine';
    case 'intersect':
      return 'Intersect';
    case 'subtract':
      return 'Subtract';
    case 'fragment':
      return 'Fragment';
  }
};

const failure = (
  code: ShapeBooleanFailureCode,
  message: string,
  elementId?: string,
): ShapeBooleanFailure => ({
  ok: false,
  code,
  message,
  ...(elementId === undefined ? {} : { elementId }),
});

const finitePoint = (point: Point): boolean =>
  Number.isFinite(point.xPt) && Number.isFinite(point.yPt);

const cross = (left: Point, right: Point): number => left.xPt * right.yPt - left.yPt * right.xPt;

const subtractPoints = (left: Point, right: Point): Point => ({
  xPt: left.xPt - right.xPt,
  yPt: left.yPt - right.yPt,
});

const distanceSquared = (left: Point, right: Point): number => {
  const deltaX = left.xPt - right.xPt;
  const deltaY = left.yPt - right.yPt;
  return deltaX * deltaX + deltaY * deltaY;
};

const interpolate = (start: Point, end: Point, parameter: number): Point => ({
  xPt: start.xPt + (end.xPt - start.xPt) * parameter,
  yPt: start.yPt + (end.yPt - start.yPt) * parameter,
});

const polygonSignedArea = (polygon: Polygon): number =>
  polygon.reduce((area, point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return next === undefined ? area : area + point.xPt * next.yPt - next.xPt * point.yPt;
  }, 0) / 2;

const geometryExtent = (polygons: readonly Polygon[]): number => {
  const points = polygons.flat();
  if (points.length === 0) return 1;
  const minimumX = Math.min(...points.map((point) => point.xPt));
  const minimumY = Math.min(...points.map((point) => point.yPt));
  const maximumX = Math.max(...points.map((point) => point.xPt));
  const maximumY = Math.max(...points.map((point) => point.yPt));
  return Math.max(1, maximumX - minimumX, maximumY - minimumY);
};

const normalizedCurveSegments = (requested: number | undefined, fallback: number): number => {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(MAX_CURVE_SEGMENTS, Math.max(MIN_CURVE_SEGMENTS, Math.round(requested)));
};

const localShapePolygon = (
  shape: ShapeKind,
  width: number,
  height: number,
  cornerRadiusPt: number,
  ellipseSegments: number,
  roundedCornerSegments: number,
): Polygon | undefined => {
  switch (shape) {
    case 'rectangle':
      return [
        { xPt: 0, yPt: 0 },
        { xPt: width, yPt: 0 },
        { xPt: width, yPt: height },
        { xPt: 0, yPt: height },
      ];
    case 'rounded-rectangle': {
      const radius = Math.min(
        width / 2,
        height / 2,
        Math.max(0, Number.isFinite(cornerRadiusPt) ? cornerRadiusPt : 0),
      );
      if (radius <= 0) {
        return localShapePolygon(
          'rectangle',
          width,
          height,
          0,
          ellipseSegments,
          roundedCornerSegments,
        );
      }
      const corners = [
        { center: { xPt: width - radius, yPt: radius }, startAngle: -Math.PI / 2 },
        { center: { xPt: width - radius, yPt: height - radius }, startAngle: 0 },
        { center: { xPt: radius, yPt: height - radius }, startAngle: Math.PI / 2 },
        { center: { xPt: radius, yPt: radius }, startAngle: Math.PI },
      ] as const;
      return corners.flatMap(({ center, startAngle }) =>
        Array.from({ length: roundedCornerSegments }, (_, index): Point => {
          const angle = startAngle + (index / roundedCornerSegments) * (Math.PI / 2);
          return {
            xPt: center.xPt + Math.cos(angle) * radius,
            yPt: center.yPt + Math.sin(angle) * radius,
          };
        }),
      );
    }
    case 'ellipse':
      return Array.from({ length: ellipseSegments }, (_, index): Point => {
        const angle = (index / ellipseSegments) * Math.PI * 2;
        return {
          xPt: width / 2 + Math.cos(angle) * (width / 2),
          yPt: height / 2 + Math.sin(angle) * (height / 2),
        };
      });
    case 'triangle':
      return [
        { xPt: width / 2, yPt: 0 },
        { xPt: width, yPt: height },
        { xPt: 0, yPt: height },
      ];
    case 'right-triangle':
      return [
        { xPt: 0, yPt: 0 },
        { xPt: width, yPt: height },
        { xPt: 0, yPt: height },
      ];
    case 'diamond':
      return [
        { xPt: width / 2, yPt: 0 },
        { xPt: width, yPt: height / 2 },
        { xPt: width / 2, yPt: height },
        { xPt: 0, yPt: height / 2 },
      ];
    case 'parallelogram':
      return [
        { xPt: width * 0.2, yPt: 0 },
        { xPt: width, yPt: 0 },
        { xPt: width * 0.8, yPt: height },
        { xPt: 0, yPt: height },
      ];
    case 'trapezoid':
      return [
        { xPt: width * 0.2, yPt: 0 },
        { xPt: width * 0.8, yPt: 0 },
        { xPt: width, yPt: height },
        { xPt: 0, yPt: height },
      ];
    case 'pentagon':
      return [
        { xPt: width * 0.5, yPt: 0 },
        { xPt: width, yPt: height * 0.38 },
        { xPt: width * 0.82, yPt: height },
        { xPt: width * 0.18, yPt: height },
        { xPt: 0, yPt: height * 0.38 },
      ];
    case 'hexagon':
      return [
        { xPt: width * 0.25, yPt: 0 },
        { xPt: width * 0.75, yPt: 0 },
        { xPt: width, yPt: height * 0.5 },
        { xPt: width * 0.75, yPt: height },
        { xPt: width * 0.25, yPt: height },
        { xPt: 0, yPt: height * 0.5 },
      ];
    case 'octagon':
      return [
        { xPt: width * 0.292893, yPt: 0 },
        { xPt: width * 0.707107, yPt: 0 },
        { xPt: width, yPt: height * 0.292893 },
        { xPt: width, yPt: height * 0.707107 },
        { xPt: width * 0.707107, yPt: height },
        { xPt: width * 0.292893, yPt: height },
        { xPt: 0, yPt: height * 0.707107 },
        { xPt: 0, yPt: height * 0.292893 },
      ];
    case 'chevron':
      return [
        { xPt: 0, yPt: 0 },
        { xPt: width * 0.65, yPt: 0 },
        { xPt: width, yPt: height * 0.5 },
        { xPt: width * 0.65, yPt: height },
        { xPt: 0, yPt: height },
        { xPt: width * 0.35, yPt: height * 0.5 },
      ];
    case 'cross':
      return [
        { xPt: width / 3, yPt: 0 },
        { xPt: (width * 2) / 3, yPt: 0 },
        { xPt: (width * 2) / 3, yPt: height / 3 },
        { xPt: width, yPt: height / 3 },
        { xPt: width, yPt: (height * 2) / 3 },
        { xPt: (width * 2) / 3, yPt: (height * 2) / 3 },
        { xPt: (width * 2) / 3, yPt: height },
        { xPt: width / 3, yPt: height },
        { xPt: width / 3, yPt: (height * 2) / 3 },
        { xPt: 0, yPt: (height * 2) / 3 },
        { xPt: 0, yPt: height / 3 },
        { xPt: width / 3, yPt: height / 3 },
      ];
    case 'donut':
    case 'left-bracket':
    case 'right-bracket':
    case 'arc':
    case 'line':
    case 'arrow':
      return undefined;
  }
};

const rotateLocalPoint = (point: Point, frame: ShapeBooleanInput['frame']): Point => {
  const centerX = frame.xPt + frame.widthPt / 2;
  const centerY = frame.yPt + frame.heightPt / 2;
  const unrotatedX = frame.xPt + point.xPt;
  const unrotatedY = frame.yPt + point.yPt;
  if (frame.rotationDeg === 0) return { xPt: unrotatedX, yPt: unrotatedY };
  const radians = (frame.rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = unrotatedX - centerX;
  const deltaY = unrotatedY - centerY;
  return {
    xPt: centerX + deltaX * cosine - deltaY * sine,
    yPt: centerY + deltaX * sine + deltaY * cosine,
  };
};

const pathLocalPolygon = (element: PathElement): Polygon | undefined => {
  if (
    element.commands.length < 4 ||
    element.commands[0]?.type !== 'move' ||
    element.commands.at(-1)?.type !== 'close'
  ) {
    return undefined;
  }
  const points: Point[] = [];
  for (const [index, command] of element.commands.entries()) {
    if (command.type === 'move') {
      if (index !== 0) return undefined;
      points.push({ xPt: command.xPt, yPt: command.yPt });
      continue;
    }
    if (command.type === 'line') {
      points.push({ xPt: command.xPt, yPt: command.yPt });
      continue;
    }
    if (command.type === 'close') {
      if (index !== element.commands.length - 1) return undefined;
      continue;
    }
    return undefined;
  }
  const first = points[0];
  const last = points.at(-1);
  if (first !== undefined && last !== undefined && distanceSquared(first, last) <= 1e-16) {
    points.pop();
  }
  return points;
};

const segmentsIntersectBeyondSharedEndpoint = (
  firstStart: Point,
  firstEnd: Point,
  secondStart: Point,
  secondEnd: Point,
  tolerance: number,
): boolean => {
  const first = subtractPoints(firstEnd, firstStart);
  const second = subtractPoints(secondEnd, secondStart);
  const offset = subtractPoints(secondStart, firstStart);
  const denominator = cross(first, second);
  const firstLength = Math.hypot(first.xPt, first.yPt);
  const secondLength = Math.hypot(second.xPt, second.yPt);
  const parameterTolerance = tolerance / Math.max(1, firstLength, secondLength);
  const parallelTolerance = 1e-10 * Math.max(1, firstLength * secondLength);
  if (Math.abs(denominator) <= parallelTolerance) {
    if (Math.abs(cross(offset, first)) > tolerance * Math.max(1, firstLength)) return false;
    const firstLengthSquared = distanceSquared(firstStart, firstEnd);
    if (firstLengthSquared <= tolerance * tolerance) return true;
    const parameter = (point: Point): number =>
      ((point.xPt - firstStart.xPt) * first.xPt + (point.yPt - firstStart.yPt) * first.yPt) /
      firstLengthSquared;
    const overlapStart = Math.max(0, Math.min(parameter(secondStart), parameter(secondEnd)));
    const overlapEnd = Math.min(1, Math.max(parameter(secondStart), parameter(secondEnd)));
    return overlapEnd - overlapStart > parameterTolerance;
  }
  const firstParameter = cross(offset, second) / denominator;
  const secondParameter = cross(offset, first) / denominator;
  return (
    firstParameter > parameterTolerance &&
    firstParameter < 1 - parameterTolerance &&
    secondParameter > parameterTolerance &&
    secondParameter < 1 - parameterTolerance
  );
};

const simplePolygon = (polygon: Polygon, tolerance: number): boolean => {
  if (polygon.length < 3 || polygon.some((point) => !finitePoint(point))) return false;
  const minimumDistanceSquared = tolerance * tolerance;
  for (let firstIndex = 0; firstIndex < polygon.length; firstIndex += 1) {
    const first = polygon[firstIndex];
    if (first === undefined) return false;
    for (let secondIndex = firstIndex + 1; secondIndex < polygon.length; secondIndex += 1) {
      const second = polygon[secondIndex];
      if (second !== undefined && distanceSquared(first, second) <= minimumDistanceSquared) {
        return false;
      }
    }
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const nextIndex = (index + 1) % polygon.length;
    const start = polygon[index];
    const end = polygon[nextIndex];
    if (
      start === undefined ||
      end === undefined ||
      distanceSquared(start, end) <= minimumDistanceSquared
    ) {
      return false;
    }
    for (let otherIndex = index + 1; otherIndex < polygon.length; otherIndex += 1) {
      const otherNextIndex = (otherIndex + 1) % polygon.length;
      if (index === otherIndex || nextIndex === otherIndex || otherNextIndex === index) {
        continue;
      }
      const otherStart = polygon[otherIndex];
      const otherEnd = polygon[otherNextIndex];
      if (
        otherStart !== undefined &&
        otherEnd !== undefined &&
        segmentsIntersectBeyondSharedEndpoint(start, end, otherStart, otherEnd, tolerance)
      ) {
        return false;
      }
    }
  }
  return Math.abs(polygonSignedArea(polygon)) > tolerance * tolerance;
};

const polygonizeElement = (
  element: ShapeBooleanInput,
  ellipseSegments: number,
  roundedCornerSegments: number,
): Polygon | ShapeBooleanFailure => {
  const local =
    element.type === 'shape'
      ? localShapePolygon(
          element.shape,
          element.frame.widthPt,
          element.frame.heightPt,
          element.cornerRadiusPt,
          ellipseSegments,
          roundedCornerSegments,
        )
      : pathLocalPolygon(element);
  if (local === undefined) {
    return failure(
      'UNSUPPORTED_GEOMETRY',
      element.type === 'shape'
        ? `${element.name} uses ${element.shape} geometry, which cannot be converted to a closed polygon safely.`
        : `${element.name} must be a single closed path made only of straight segments.`,
      element.id,
    );
  }
  const polygon = local.map((point) => rotateLocalPoint(point, element.frame));
  const extent = geometryExtent([polygon]);
  const tolerance = Math.max(1e-8, extent * 1e-10);
  if (!simplePolygon(polygon, tolerance)) {
    return failure(
      'DEGENERATE_GEOMETRY',
      `${element.name} is degenerate or self-intersecting and cannot participate in a boolean operation.`,
      element.id,
    );
  }
  return polygon;
};

const edgesForPolygons = (polygons: readonly Polygon[]): Edge[] =>
  polygons.flatMap((polygon, polygonIndex) =>
    polygon.map((start, edgeIndex): Edge => ({
      start,
      end: polygon[(edgeIndex + 1) % polygon.length] ?? start,
      polygonIndex,
      edgeIndex,
    })),
  );

const addUniqueParameter = (parameters: number[], requested: number, tolerance: number): void => {
  const value = Math.min(1, Math.max(0, requested));
  if (!parameters.some((existing) => Math.abs(existing - value) <= tolerance)) {
    parameters.push(value);
  }
};

const splitAtIntersection = (
  first: Edge,
  second: Edge,
  firstParameters: number[],
  secondParameters: number[],
  coordinateTolerance: number,
): void => {
  const firstVector = subtractPoints(first.end, first.start);
  const secondVector = subtractPoints(second.end, second.start);
  const offset = subtractPoints(second.start, first.start);
  const denominator = cross(firstVector, secondVector);
  const firstLength = Math.hypot(firstVector.xPt, firstVector.yPt);
  const secondLength = Math.hypot(secondVector.xPt, secondVector.yPt);
  const parallelTolerance = 1e-10 * Math.max(1, firstLength * secondLength);
  const parameterTolerance = Math.max(
    1e-10,
    coordinateTolerance / Math.max(1, firstLength, secondLength),
  );

  if (Math.abs(denominator) > parallelTolerance) {
    const firstParameter = cross(offset, secondVector) / denominator;
    const secondParameter = cross(offset, firstVector) / denominator;
    if (
      firstParameter >= -parameterTolerance &&
      firstParameter <= 1 + parameterTolerance &&
      secondParameter >= -parameterTolerance &&
      secondParameter <= 1 + parameterTolerance
    ) {
      addUniqueParameter(firstParameters, firstParameter, parameterTolerance);
      addUniqueParameter(secondParameters, secondParameter, parameterTolerance);
    }
    return;
  }

  if (Math.abs(cross(offset, firstVector)) > coordinateTolerance * Math.max(1, firstLength)) {
    return;
  }
  const firstLengthSquared = firstLength * firstLength;
  const secondLengthSquared = secondLength * secondLength;
  if (firstLengthSquared <= coordinateTolerance * coordinateTolerance) return;
  if (secondLengthSquared <= coordinateTolerance * coordinateTolerance) return;
  const parameterOnFirst = (point: Point): number =>
    ((point.xPt - first.start.xPt) * firstVector.xPt +
      (point.yPt - first.start.yPt) * firstVector.yPt) /
    firstLengthSquared;
  const parameterOnSecond = (point: Point): number =>
    ((point.xPt - second.start.xPt) * secondVector.xPt +
      (point.yPt - second.start.yPt) * secondVector.yPt) /
    secondLengthSquared;
  for (const point of [second.start, second.end]) {
    const parameter = parameterOnFirst(point);
    if (parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance) {
      addUniqueParameter(firstParameters, parameter, parameterTolerance);
    }
  }
  for (const point of [first.start, first.end]) {
    const parameter = parameterOnSecond(point);
    if (parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance) {
      addUniqueParameter(secondParameters, parameter, parameterTolerance);
    }
  }
};

const atomicSegments = (
  edges: readonly Edge[],
  coordinateTolerance: number,
): readonly AtomicSegment[] | ShapeBooleanFailure => {
  const splitParameters = edges.map(() => [0, 1]);
  for (let firstIndex = 0; firstIndex < edges.length; firstIndex += 1) {
    const first = edges[firstIndex];
    const firstParameters = splitParameters[firstIndex];
    if (first === undefined || firstParameters === undefined) continue;
    for (let secondIndex = firstIndex + 1; secondIndex < edges.length; secondIndex += 1) {
      const second = edges[secondIndex];
      const secondParameters = splitParameters[secondIndex];
      if (second === undefined || secondParameters === undefined) continue;
      splitAtIntersection(first, second, firstParameters, secondParameters, coordinateTolerance);
    }
  }

  const segments: AtomicSegment[] = [];
  for (const [index, edge] of edges.entries()) {
    const parameters = splitParameters[index]?.toSorted((left, right) => left - right) ?? [];
    for (let parameterIndex = 0; parameterIndex < parameters.length - 1; parameterIndex += 1) {
      const startParameter = parameters[parameterIndex];
      const endParameter = parameters[parameterIndex + 1];
      if (
        startParameter === undefined ||
        endParameter === undefined ||
        endParameter - startParameter <= 1e-10
      ) {
        continue;
      }
      const start = interpolate(edge.start, edge.end, startParameter);
      const end = interpolate(edge.start, edge.end, endParameter);
      if (distanceSquared(start, end) <= coordinateTolerance * coordinateTolerance) continue;
      segments.push({ start, end });
      if (segments.length > MAX_ATOMIC_SEGMENTS) {
        return failure(
          'RESULT_TOO_COMPLEX',
          'The boolean arrangement is too complex for a bounded native path.',
        );
      }
    }
  }
  return segments;
};

const pointInsidePolygon = (point: Point, polygon: Polygon): boolean => {
  let inside = false;
  for (
    let index = 0, previousIndex = polygon.length - 1;
    index < polygon.length;
    previousIndex = index, index += 1
  ) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (current === undefined || previous === undefined) continue;
    const straddles = current.yPt > point.yPt !== previous.yPt > point.yPt;
    if (!straddles) continue;
    const intersectionX =
      ((previous.xPt - current.xPt) * (point.yPt - current.yPt)) / (previous.yPt - current.yPt) +
      current.xPt;
    if (point.xPt < intersectionX) inside = !inside;
  }
  return inside;
};

const coverageAtPoint = (point: Point, polygons: readonly Polygon[]): readonly boolean[] =>
  polygons.map((polygon) => pointInsidePolygon(point, polygon));

const operationContains = (
  coverage: readonly boolean[],
  operation: Exclude<ShapeBooleanOperation, 'fragment'>,
): boolean => {
  switch (operation) {
    case 'union':
      return coverage.some(Boolean);
    case 'combine':
      return coverage.filter(Boolean).length % 2 === 1;
    case 'intersect':
      return coverage.every(Boolean);
    case 'subtract':
      return coverage[0] === true && !coverage.slice(1).some(Boolean);
  }
};

const coverageSignature = (coverage: readonly boolean[]): string =>
  coverage.map((inside) => (inside ? '1' : '0')).join('');

const sampleSegmentSides = (
  segment: AtomicSegment,
  polygons: readonly Polygon[],
  coordinateTolerance: number,
): Readonly<{ left: readonly boolean[]; right: readonly boolean[] }> => {
  const deltaX = segment.end.xPt - segment.start.xPt;
  const deltaY = segment.end.yPt - segment.start.yPt;
  const length = Math.hypot(deltaX, deltaY);
  const midpoint = {
    xPt: (segment.start.xPt + segment.end.xPt) / 2,
    yPt: (segment.start.yPt + segment.end.yPt) / 2,
  };
  const offset = Math.max(
    coordinateTolerance * 16,
    Math.min(length * 0.1, Math.max(1e-5, geometryExtent(polygons) * 1e-7)),
  );
  const normalX = (-deltaY / length) * offset;
  const normalY = (deltaX / length) * offset;
  return {
    left: coverageAtPoint({ xPt: midpoint.xPt + normalX, yPt: midpoint.yPt + normalY }, polygons),
    right: coverageAtPoint({ xPt: midpoint.xPt - normalX, yPt: midpoint.yPt - normalY }, polygons),
  };
};

const quantizedPointKey = (point: Point, tolerance: number): string =>
  `${Math.round(point.xPt / tolerance)},${Math.round(point.yPt / tolerance)}`;

const boundarySegments = (
  segments: readonly AtomicSegment[],
  polygons: readonly Polygon[],
  coordinateTolerance: number,
  contains: (coverage: readonly boolean[]) => boolean,
): Readonly<{
  segments: readonly KeyedSegment[];
  vertices: ReadonlyMap<string, Point>;
}> => {
  const balances = new Map<
    string,
    {
      canonicalStartKey: string;
      canonicalEndKey: string;
      balance: number;
    }
  >();
  const vertexAccumulators = new Map<string, Vertex>();

  const registerVertex = (key: string, point: Point): void => {
    const existing = vertexAccumulators.get(key);
    if (existing === undefined) {
      vertexAccumulators.set(key, { xTotal: point.xPt, yTotal: point.yPt, count: 1 });
      return;
    }
    existing.xTotal += point.xPt;
    existing.yTotal += point.yPt;
    existing.count += 1;
  };

  for (const segment of segments) {
    const sides = sampleSegmentSides(segment, polygons, coordinateTolerance);
    const leftInside = contains(sides.left);
    const rightInside = contains(sides.right);
    if (leftInside === rightInside) continue;
    const orientedStart = leftInside ? segment.start : segment.end;
    const orientedEnd = leftInside ? segment.end : segment.start;
    const orientedStartKey = quantizedPointKey(orientedStart, coordinateTolerance);
    const orientedEndKey = quantizedPointKey(orientedEnd, coordinateTolerance);
    if (orientedStartKey === orientedEndKey) continue;
    registerVertex(orientedStartKey, orientedStart);
    registerVertex(orientedEndKey, orientedEnd);
    const canonicalForward = orientedStartKey < orientedEndKey;
    const canonicalStartKey = canonicalForward ? orientedStartKey : orientedEndKey;
    const canonicalEndKey = canonicalForward ? orientedEndKey : orientedStartKey;
    const edgeKey = `${canonicalStartKey}|${canonicalEndKey}`;
    const existing = balances.get(edgeKey);
    const direction = canonicalForward ? 1 : -1;
    if (existing === undefined) {
      balances.set(edgeKey, { canonicalStartKey, canonicalEndKey, balance: direction });
    } else {
      existing.balance += direction;
    }
  }

  const vertices = new Map<string, Point>(
    [...vertexAccumulators.entries()].map(([key, vertex]) => [
      key,
      { xPt: vertex.xTotal / vertex.count, yPt: vertex.yTotal / vertex.count },
    ]),
  );
  const result = [...balances.values()].flatMap(
    ({ canonicalStartKey, canonicalEndKey, balance }): readonly KeyedSegment[] => {
      if (balance === 0) return [];
      return [
        balance > 0
          ? { startKey: canonicalStartKey, endKey: canonicalEndKey }
          : { startKey: canonicalEndKey, endKey: canonicalStartKey },
      ];
    },
  );
  return { segments: result, vertices };
};

const positiveTurn = (incoming: Point, outgoing: Point): number => {
  const angle = Math.atan2(
    cross(incoming, outgoing),
    incoming.xPt * outgoing.xPt + incoming.yPt * outgoing.yPt,
  );
  return angle < -1e-12 ? angle + Math.PI * 2 : Math.max(0, angle);
};

const simplifyLoop = (requested: Polygon, tolerance: number): Polygon => {
  let points = requested.filter(
    (point, index) =>
      index === 0 || distanceSquared(point, requested[index - 1] ?? point) > tolerance * tolerance,
  );
  let changed = true;
  while (changed && points.length >= 3) {
    changed = false;
    const next: Point[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const previous = points[(index - 1 + points.length) % points.length];
      const current = points[index];
      const following = points[(index + 1) % points.length];
      if (previous === undefined || current === undefined || following === undefined) continue;
      const incoming = subtractPoints(current, previous);
      const outgoing = subtractPoints(following, current);
      const scale = Math.max(
        1,
        Math.hypot(incoming.xPt, incoming.yPt),
        Math.hypot(outgoing.xPt, outgoing.yPt),
      );
      if (
        Math.abs(cross(incoming, outgoing)) <= tolerance * scale &&
        incoming.xPt * outgoing.xPt + incoming.yPt * outgoing.yPt >= 0
      ) {
        changed = true;
      } else {
        next.push(current);
      }
    }
    points = next;
  }
  return points;
};

const traceLoops = (
  boundary: ReturnType<typeof boundarySegments>,
  coordinateTolerance: number,
): readonly Polygon[] | ShapeBooleanFailure => {
  const outgoing = new Map<string, number[]>();
  for (const [index, segment] of boundary.segments.entries()) {
    const bucket = outgoing.get(segment.startKey) ?? [];
    bucket.push(index);
    outgoing.set(segment.startKey, bucket);
  }
  const used = new Set<number>();
  const loops: Polygon[] = [];
  for (let startIndex = 0; startIndex < boundary.segments.length; startIndex += 1) {
    if (used.has(startIndex)) continue;
    const firstSegment = boundary.segments[startIndex];
    if (firstSegment === undefined) continue;
    const startPoint = boundary.vertices.get(firstSegment.startKey);
    const firstEndPoint = boundary.vertices.get(firstSegment.endKey);
    if (startPoint === undefined || firstEndPoint === undefined) {
      return failure('DEGENERATE_GEOMETRY', 'The boolean boundary contains an invalid vertex.');
    }
    const loop: Point[] = [startPoint];
    let currentSegmentIndex = startIndex;
    let currentKey = firstSegment.endKey;
    let incoming = subtractPoints(firstEndPoint, startPoint);
    used.add(currentSegmentIndex);

    while (currentKey !== firstSegment.startKey) {
      const candidates = (outgoing.get(currentKey) ?? []).filter((index) => !used.has(index));
      if (candidates.length === 0) {
        return failure(
          'DEGENERATE_GEOMETRY',
          'The boolean boundary could not be reconstructed as closed native paths.',
        );
      }
      const currentPoint = boundary.vertices.get(currentKey);
      if (currentPoint === undefined) {
        return failure('DEGENERATE_GEOMETRY', 'The boolean boundary contains an invalid vertex.');
      }
      loop.push(currentPoint);
      const nextIndex = candidates.toSorted((leftIndex, rightIndex) => {
        const left = boundary.segments[leftIndex];
        const right = boundary.segments[rightIndex];
        const leftEnd = left === undefined ? undefined : boundary.vertices.get(left.endKey);
        const rightEnd = right === undefined ? undefined : boundary.vertices.get(right.endKey);
        if (leftEnd === undefined) return 1;
        if (rightEnd === undefined) return -1;
        const leftTurn = positiveTurn(incoming, subtractPoints(leftEnd, currentPoint));
        const rightTurn = positiveTurn(incoming, subtractPoints(rightEnd, currentPoint));
        return leftTurn - rightTurn || leftIndex - rightIndex;
      })[0];
      if (nextIndex === undefined) {
        return failure('DEGENERATE_GEOMETRY', 'The boolean boundary has no continuation.');
      }
      const nextSegment = boundary.segments[nextIndex];
      const nextEnd =
        nextSegment === undefined ? undefined : boundary.vertices.get(nextSegment.endKey);
      if (nextSegment === undefined || nextEnd === undefined) {
        return failure('DEGENERATE_GEOMETRY', 'The boolean boundary contains an invalid segment.');
      }
      incoming = subtractPoints(nextEnd, currentPoint);
      currentKey = nextSegment.endKey;
      currentSegmentIndex = nextIndex;
      used.add(currentSegmentIndex);
      if (loop.length > boundary.segments.length + 1) {
        return failure(
          'RESULT_TOO_COMPLEX',
          'The boolean boundary exceeded its bounded traversal.',
        );
      }
    }

    const simplified = simplifyLoop(loop, coordinateTolerance);
    if (
      simplified.length >= 3 &&
      Math.abs(polygonSignedArea(simplified)) > coordinateTolerance * coordinateTolerance
    ) {
      loops.push(simplified);
    }
  }
  return loops;
};

const loopsForPredicate = (
  segments: readonly AtomicSegment[],
  polygons: readonly Polygon[],
  coordinateTolerance: number,
  contains: (coverage: readonly boolean[]) => boolean,
): readonly Polygon[] | ShapeBooleanFailure => {
  const boundary = boundarySegments(segments, polygons, coordinateTolerance, contains);
  return traceLoops(boundary, coordinateTolerance);
};

const sortedLoops = (loops: readonly Polygon[]): readonly Polygon[] =>
  loops.toSorted((left, right) => {
    const leftMinimumX = Math.min(...left.map((point) => point.xPt));
    const leftMinimumY = Math.min(...left.map((point) => point.yPt));
    const rightMinimumX = Math.min(...right.map((point) => point.xPt));
    const rightMinimumY = Math.min(...right.map((point) => point.yPt));
    return (
      leftMinimumY - rightMinimumY ||
      leftMinimumX - rightMinimumX ||
      Math.abs(polygonSignedArea(right)) - Math.abs(polygonSignedArea(left))
    );
  });

const fragmentLoops = (
  segments: readonly AtomicSegment[],
  polygons: readonly Polygon[],
  coordinateTolerance: number,
): readonly Polygon[] | ShapeBooleanFailure => {
  const signatures = new Set<string>();
  for (const segment of segments) {
    const sides = sampleSegmentSides(segment, polygons, coordinateTolerance);
    const leftSignature = coverageSignature(sides.left);
    const rightSignature = coverageSignature(sides.right);
    if (leftSignature.includes('1')) signatures.add(leftSignature);
    if (rightSignature.includes('1')) signatures.add(rightSignature);
  }
  const loops: Polygon[] = [];
  for (const signature of [...signatures].toSorted()) {
    const signatureLoops = loopsForPredicate(
      segments,
      polygons,
      coordinateTolerance,
      (coverage) => coverageSignature(coverage) === signature,
    );
    if ('ok' in signatureLoops) return signatureLoops;
    loops.push(...signatureLoops);
  }
  return sortedLoops(loops);
};

const validateResultLoops = (
  loops: readonly Polygon[],
  coordinateTolerance: number,
): ShapeBooleanFailure | undefined => {
  if (loops.length === 0) {
    return failure('RESULT_EMPTY', 'The selected operation produces no visible area.');
  }
  if (loops.some((loop) => polygonSignedArea(loop) < -coordinateTolerance * coordinateTolerance)) {
    return failure(
      'RESULT_HAS_HOLES',
      'This result contains a hole. The current canonical path model cannot preserve it without loss.',
    );
  }
  if (
    loops.some(
      (loop) =>
        loop.length + 1 > DOCUMENT_LIMITS.maxPathCommands ||
        loop.some(
          (point) =>
            point.xPt < -DOCUMENT_LIMITS.maxFrameCoordinatePt ||
            point.xPt > DOCUMENT_LIMITS.maxFrameCoordinatePt ||
            point.yPt < -DOCUMENT_LIMITS.maxFrameCoordinatePt ||
            point.yPt > DOCUMENT_LIMITS.maxFrameCoordinatePt,
        ),
    )
  ) {
    return failure(
      'RESULT_OUT_OF_BOUNDS',
      'The result exceeds canonical path coordinate or command limits.',
    );
  }
  return undefined;
};

const pathFromLoop = (
  loop: Polygon,
  primary: ShapeBooleanInput,
  id: string,
  name: string,
): PathElement | ShapeBooleanFailure => {
  const minimumX = Math.min(...loop.map((point) => point.xPt));
  const minimumY = Math.min(...loop.map((point) => point.yPt));
  const maximumX = Math.max(...loop.map((point) => point.xPt));
  const maximumY = Math.max(...loop.map((point) => point.yPt));
  const widthPt = maximumX - minimumX;
  const heightPt = maximumY - minimumY;
  if (
    widthPt <= 0 ||
    heightPt <= 0 ||
    widthPt > DOCUMENT_LIMITS.maxFrameDimensionPt ||
    heightPt > DOCUMENT_LIMITS.maxFrameDimensionPt
  ) {
    return failure('RESULT_OUT_OF_BOUNDS', 'The result exceeds canonical frame limits.');
  }
  const localPoint = (point: Point): Point => ({
    xPt: Math.min(widthPt, Math.max(0, point.xPt - minimumX)),
    yPt: Math.min(heightPt, Math.max(0, point.yPt - minimumY)),
  });
  const first = localPoint(loop[0] ?? { xPt: minimumX, yPt: minimumY });
  const commands: PathCommand[] = [
    { type: 'move', xPt: first.xPt, yPt: first.yPt },
    ...loop.slice(1).map((point): PathCommand => {
      const local = localPoint(point);
      return { type: 'line', xPt: local.xPt, yPt: local.yPt };
    }),
    { type: 'close' },
  ];
  return {
    id,
    name,
    type: 'path',
    frame: { xPt: minimumX, yPt: minimumY, widthPt, heightPt, rotationDeg: 0 },
    opacity: primary.opacity,
    visible: primary.visible,
    locked: false,
    commands,
    fill: primary.fill,
    stroke: primary.stroke,
    fillRule: 'nonzero',
    ...(primary.shadow === undefined ? {} : { shadow: primary.shadow }),
  };
};

/**
 * Computes useful PowerPoint-style boolean operations without arbitrary SVG data.
 *
 * Inputs are polygonized in slide coordinates, including frame rotation. Results
 * are one or more single-contour canonical paths. A result containing holes is
 * rejected because the current PathElement contract permits only one subpath;
 * silently filling such holes would corrupt the requested geometry.
 */
export const performShapeBooleanOperation = (
  inputs: readonly ShapeBooleanInput[],
  operation: ShapeBooleanOperation,
  options: ShapeBooleanOptions,
): ShapeBooleanResult => {
  if (inputs.length < 2) {
    return failure('SELECTION_TOO_SMALL', 'Select at least two shapes or closed paths.');
  }
  if (inputs.length > MAX_INPUT_ELEMENTS) {
    return failure(
      'SELECTION_TOO_LARGE',
      `Select at most ${MAX_INPUT_ELEMENTS} shapes or closed paths at once.`,
    );
  }
  const locked = inputs.find((element) => element.locked);
  if (locked !== undefined) {
    return failure(
      'LOCKED_ELEMENT',
      `${locked.name} is locked. Unlock it before merging shapes.`,
      locked.id,
    );
  }
  const contentBearing = inputs.find(
    (element) =>
      element.placeholderBinding !== undefined ||
      (element.type === 'shape' && element.text !== undefined),
  );
  if (contentBearing !== undefined) {
    return failure(
      'CONTENT_WOULD_BE_LOST',
      `${contentBearing.name} contains text or a placeholder binding that a native path cannot preserve.`,
      contentBearing.id,
    );
  }
  const ellipseSegments = normalizedCurveSegments(
    options.ellipseSegments,
    DEFAULT_ELLIPSE_SEGMENTS,
  );
  const roundedCornerSegments = normalizedCurveSegments(
    options.roundedCornerSegments,
    DEFAULT_CORNER_SEGMENTS,
  );
  const polygons: Polygon[] = [];
  for (const element of inputs) {
    const polygon = polygonizeElement(element, ellipseSegments, roundedCornerSegments);
    if ('ok' in polygon) return polygon;
    polygons.push(polygon);
  }
  const edges = edgesForPolygons(polygons);
  if (edges.length > MAX_INPUT_EDGES) {
    return failure(
      'RESULT_TOO_COMPLEX',
      `The selection has ${edges.length} polygon edges; the safe limit is ${MAX_INPUT_EDGES}.`,
    );
  }
  const extent = geometryExtent(polygons);
  const coordinateTolerance = Math.max(1e-7, extent * 1e-9);
  const segments = atomicSegments(edges, coordinateTolerance);
  if ('ok' in segments) return segments;
  const requestedLoops =
    operation === 'fragment'
      ? fragmentLoops(segments, polygons, coordinateTolerance)
      : loopsForPredicate(segments, polygons, coordinateTolerance, (coverage) =>
          operationContains(coverage, operation),
        );
  if ('ok' in requestedLoops) return requestedLoops;
  const loops = sortedLoops(requestedLoops);
  const invalidLoops = validateResultLoops(loops, coordinateTolerance);
  if (invalidLoops !== undefined) return invalidLoops;

  const primary = inputs[0];
  if (primary === undefined) {
    return failure('SELECTION_TOO_SMALL', 'Select at least two shapes or closed paths.');
  }
  const sourceIds = new Set(inputs.map((element) => element.id));
  const resultIds = new Set<string>();
  const paths: PathElement[] = [];
  for (const [index, loop] of loops.entries()) {
    const id = options.idFactory();
    if (!UUID_PATTERN.test(id) || sourceIds.has(id) || resultIds.has(id)) {
      return failure(
        'INVALID_RESULT_ID',
        'The boolean operation needs a fresh UUID for every resulting path.',
      );
    }
    resultIds.add(id);
    const label = operationLabel(operation);
    const path = pathFromLoop(
      loop,
      primary,
      id,
      loops.length === 1 ? label : `${label} ${index + 1}`,
    );
    if ('ok' in path) return path;
    paths.push(path);
  }
  return { ok: true, elements: paths, sourceIds: inputs.map((element) => element.id) };
};
