/**
 * Presentation-space connector routing.
 *
 * Every coordinate and option is expressed in document points. Screen zoom is
 * intentionally absent from this API so the same deck always produces the
 * same geometry in the editor, thumbnails, exports, and print output.
 */

export type ConnectorRouteAnchor = 'top' | 'right' | 'bottom' | 'left' | 'center';

export type ConnectorRouteEndpoint = Readonly<{
  xPt: number;
  yPt: number;
  binding?: Readonly<{
    elementId?: string | undefined;
    anchor?: ConnectorRouteAnchor | undefined;
  }>;
}>;

export type ConnectorRoutingMode = 'straight' | 'elbow' | 'curved';

export type ConnectorRouteOptions = Readonly<{
  /**
   * Fraction of the endpoint distance used for each Bézier control arm.
   * Values outside the safe range are clamped.
   */
  curvature?: number | undefined;
  minControlDistancePt?: number | undefined;
  maxControlDistancePt?: number | undefined;
  selfLoopRadiusPt?: number | undefined;
}>;

export type ConnectorLineSegment = Readonly<{
  type: 'line';
  end: ConnectorRoutePoint;
}>;

export type ConnectorCubicSegment = Readonly<{
  type: 'cubic';
  control1: ConnectorRoutePoint;
  control2: ConnectorRoutePoint;
  end: ConnectorRoutePoint;
}>;

export type ConnectorRouteSegment = ConnectorLineSegment | ConnectorCubicSegment;

export type ConnectorRoutePoint = Readonly<{
  xPt: number;
  yPt: number;
}>;

export type ConnectorRouteBounds = Readonly<{
  xPt: number;
  yPt: number;
  widthPt: number;
  heightPt: number;
}>;

export type ConnectorRoute = Readonly<{
  routing: ConnectorRoutingMode;
  start: ConnectorRoutePoint;
  segments: readonly ConnectorRouteSegment[];
  isSelfLoop: boolean;
  bounds: ConnectorRouteBounds;
  pathData: string;
}>;

export type ConnectorRouteErrorCode =
  'invalid-start-point' | 'invalid-end-point' | 'invalid-routing';

export type ConnectorRouteResult =
  | Readonly<{ ok: true; route: ConnectorRoute }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code: ConnectorRouteErrorCode;
        message: string;
      }>;
    }>;

export type ConnectorRouteInput = Readonly<{
  routing: ConnectorRoutingMode;
  start: ConnectorRouteEndpoint;
  end: ConnectorRouteEndpoint;
  options?: ConnectorRouteOptions | undefined;
}>;

export const CONNECTOR_ROUTE_LIMITS = Object.freeze({
  maxAbsoluteCoordinatePt: 1_000_000,
  minCurvature: 0.1,
  maxCurvature: 0.9,
  minControlDistancePt: 0,
  maxControlDistancePt: 720,
  minSelfLoopRadiusPt: 12,
  maxSelfLoopRadiusPt: 720,
});

const DEFAULT_CURVATURE = 0.38;
const DEFAULT_MIN_CONTROL_DISTANCE_PT = 24;
const DEFAULT_MAX_CONTROL_DISTANCE_PT = 180;
const DEFAULT_SELF_LOOP_RADIUS_PT = 54;
const COINCIDENT_POINT_TOLERANCE_PT = 0.01;
const VECTOR_EPSILON = 1e-9;
const OUTPUT_PRECISION = 1_000_000;

type Vector = ConnectorRoutePoint;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const safeOption = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number =>
  clamp(value !== undefined && Number.isFinite(value) ? value : fallback, minimum, maximum);

const finiteCoordinate = (value: number): boolean =>
  Number.isFinite(value) && Math.abs(value) <= CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt;

const validPoint = (
  candidate: ConnectorRouteEndpoint | null | undefined,
): candidate is ConnectorRouteEndpoint =>
  candidate !== undefined &&
  candidate !== null &&
  finiteCoordinate(candidate.xPt) &&
  finiteCoordinate(candidate.yPt);

const point = (xPt: number, yPt: number): ConnectorRoutePoint => ({
  xPt: clamp(
    xPt,
    -CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt,
    CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt,
  ),
  yPt: clamp(
    yPt,
    -CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt,
    CONNECTOR_ROUTE_LIMITS.maxAbsoluteCoordinatePt,
  ),
});

const add = (origin: ConnectorRoutePoint, vector: Vector, scale = 1): ConnectorRoutePoint =>
  point(origin.xPt + vector.xPt * scale, origin.yPt + vector.yPt * scale);

const subtract = (left: ConnectorRoutePoint, right: ConnectorRoutePoint): Vector => ({
  xPt: left.xPt - right.xPt,
  yPt: left.yPt - right.yPt,
});

const magnitude = (vector: Vector): number => Math.hypot(vector.xPt, vector.yPt);

const normalize = (vector: Vector, fallback: Vector): Vector => {
  const length = magnitude(vector);
  return length > VECTOR_EPSILON
    ? { xPt: vector.xPt / length, yPt: vector.yPt / length }
    : fallback;
};

const negate = (vector: Vector): Vector => ({ xPt: -vector.xPt, yPt: -vector.yPt });

const perpendicular = (vector: Vector): Vector => ({ xPt: -vector.yPt, yPt: vector.xPt });

const dot = (left: Vector, right: Vector): number => left.xPt * right.xPt + left.yPt * right.yPt;

const anchorDirection = (anchor: ConnectorRouteAnchor | undefined): Vector | undefined => {
  switch (anchor) {
    case 'top':
      return { xPt: 0, yPt: -1 };
    case 'right':
      return { xPt: 1, yPt: 0 };
    case 'bottom':
      return { xPt: 0, yPt: 1 };
    case 'left':
      return { xPt: -1, yPt: 0 };
    case 'center':
    case undefined:
      return undefined;
  }
};

const endpointDirection = (
  endpoint: ConnectorRouteEndpoint,
  other: ConnectorRouteEndpoint,
): Vector => {
  const anchored = anchorDirection(endpoint.binding?.anchor);
  if (anchored !== undefined) return anchored;
  return normalize(subtract(other, endpoint), { xPt: 1, yPt: 0 });
};

const sameBoundElement = (start: ConnectorRouteEndpoint, end: ConnectorRouteEndpoint): boolean => {
  const startElementId = start.binding?.elementId?.trim();
  const endElementId = end.binding?.elementId?.trim();
  return (
    startElementId !== undefined && startElementId.length > 0 && startElementId === endElementId
  );
};

const routeBounds = (
  start: ConnectorRoutePoint,
  segments: readonly ConnectorRouteSegment[],
): ConnectorRouteBounds => {
  const points = [
    start,
    ...segments.flatMap((segment): readonly ConnectorRoutePoint[] =>
      segment.type === 'cubic' ? [segment.control1, segment.control2, segment.end] : [segment.end],
    ),
  ];
  const minimumX = Math.min(...points.map((entry) => entry.xPt));
  const minimumY = Math.min(...points.map((entry) => entry.yPt));
  const maximumX = Math.max(...points.map((entry) => entry.xPt));
  const maximumY = Math.max(...points.map((entry) => entry.yPt));
  return {
    xPt: minimumX,
    yPt: minimumY,
    widthPt: maximumX - minimumX,
    heightPt: maximumY - minimumY,
  };
};

const formatNumber = (value: number): string => {
  const rounded = Math.round(value * OUTPUT_PRECISION) / OUTPUT_PRECISION;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

export const connectorRoutePathData = (
  start: ConnectorRoutePoint,
  segments: readonly ConnectorRouteSegment[],
): string => {
  const commands = [`M ${formatNumber(start.xPt)} ${formatNumber(start.yPt)}`];
  for (const segment of segments) {
    commands.push(
      segment.type === 'line'
        ? `L ${formatNumber(segment.end.xPt)} ${formatNumber(segment.end.yPt)}`
        : `C ${formatNumber(segment.control1.xPt)} ${formatNumber(segment.control1.yPt)} ${formatNumber(segment.control2.xPt)} ${formatNumber(segment.control2.yPt)} ${formatNumber(segment.end.xPt)} ${formatNumber(segment.end.yPt)}`,
    );
  }
  return commands.join(' ');
};

const cubicSegments = (
  start: ConnectorRouteEndpoint,
  end: ConnectorRouteEndpoint,
  options: ConnectorRouteOptions | undefined,
): Readonly<{ segments: readonly ConnectorCubicSegment[]; isSelfLoop: boolean }> => {
  const startPoint = point(start.xPt, start.yPt);
  const endPoint = point(end.xPt, end.yPt);
  const delta = subtract(endPoint, startPoint);
  const distance = magnitude(delta);
  const isSelfLoop = sameBoundElement(start, end) || distance <= COINCIDENT_POINT_TOLERANCE_PT;
  const curvature = safeOption(
    options?.curvature,
    DEFAULT_CURVATURE,
    CONNECTOR_ROUTE_LIMITS.minCurvature,
    CONNECTOR_ROUTE_LIMITS.maxCurvature,
  );
  const maximumControlDistance = safeOption(
    options?.maxControlDistancePt,
    DEFAULT_MAX_CONTROL_DISTANCE_PT,
    CONNECTOR_ROUTE_LIMITS.minControlDistancePt,
    CONNECTOR_ROUTE_LIMITS.maxControlDistancePt,
  );
  const minimumControlDistance = Math.min(
    maximumControlDistance,
    safeOption(
      options?.minControlDistancePt,
      DEFAULT_MIN_CONTROL_DISTANCE_PT,
      CONNECTOR_ROUTE_LIMITS.minControlDistancePt,
      CONNECTOR_ROUTE_LIMITS.maxControlDistancePt,
    ),
  );
  const startDirection = endpointDirection(start, end);
  const endDirection = endpointDirection(end, start);

  if (!isSelfLoop) {
    const distanceAwareMinimum = Math.min(minimumControlDistance, distance / 2);
    const controlDistance = clamp(
      distance * curvature,
      distanceAwareMinimum,
      maximumControlDistance,
    );
    return {
      isSelfLoop: false,
      segments: [
        {
          type: 'cubic',
          control1: add(startPoint, startDirection, controlDistance),
          control2: add(endPoint, endDirection, controlDistance),
          end: endPoint,
        },
      ],
    };
  }

  const loopRadius = safeOption(
    options?.selfLoopRadiusPt,
    DEFAULT_SELF_LOOP_RADIUS_PT,
    CONNECTOR_ROUTE_LIMITS.minSelfLoopRadiusPt,
    CONNECTOR_ROUTE_LIMITS.maxSelfLoopRadiusPt,
  );
  const midpoint = point((startPoint.xPt + endPoint.xPt) / 2, (startPoint.yPt + endPoint.yPt) / 2);
  const outwardSum = {
    xPt: startDirection.xPt + endDirection.xPt,
    yPt: startDirection.yPt + endDirection.yPt,
  };
  const chordDirection = normalize(delta, perpendicular(startDirection));
  const loopDirection =
    magnitude(outwardSum) > 0.25
      ? normalize(outwardSum, { xPt: 0, yPt: -1 })
      : normalize(perpendicular(chordDirection), { xPt: 0, yPt: -1 });
  const loopExtent = Math.min(
    CONNECTOR_ROUTE_LIMITS.maxSelfLoopRadiusPt,
    Math.max(loopRadius, distance * 0.65),
  );
  const apex = add(midpoint, loopDirection, loopExtent);
  const rawApexTangent = normalize(perpendicular(loopDirection), { xPt: 1, yPt: 0 });
  const apexTangent =
    distance > COINCIDENT_POINT_TOLERANCE_PT && dot(rawApexTangent, chordDirection) < 0
      ? negate(rawApexTangent)
      : rawApexTangent;
  const endpointControlDistance = Math.min(
    maximumControlDistance,
    Math.max(minimumControlDistance, loopExtent * 0.55),
  );
  const apexControlDistance = Math.min(maximumControlDistance, loopExtent * 0.42);

  return {
    isSelfLoop: true,
    segments: [
      {
        type: 'cubic',
        control1: add(startPoint, startDirection, endpointControlDistance),
        control2: add(apex, apexTangent, -apexControlDistance),
        end: apex,
      },
      {
        type: 'cubic',
        control1: add(apex, apexTangent, apexControlDistance),
        control2: add(endPoint, endDirection, endpointControlDistance),
        end: endPoint,
      },
    ],
  };
};

/**
 * Builds a renderer-ready route without throwing on untrusted geometry.
 */
export const computeConnectorRoute = (input: ConnectorRouteInput): ConnectorRouteResult => {
  if (!validPoint(input.start)) {
    return {
      ok: false,
      error: {
        code: 'invalid-start-point',
        message: 'Connector start must contain finite, bounded document-point coordinates.',
      },
    };
  }
  if (!validPoint(input.end)) {
    return {
      ok: false,
      error: {
        code: 'invalid-end-point',
        message: 'Connector end must contain finite, bounded document-point coordinates.',
      },
    };
  }
  if (input.routing !== 'straight' && input.routing !== 'elbow' && input.routing !== 'curved') {
    return {
      ok: false,
      error: {
        code: 'invalid-routing',
        message: 'Connector routing must be straight, elbow, or curved.',
      },
    };
  }

  const start = point(input.start.xPt, input.start.yPt);
  const end = point(input.end.xPt, input.end.yPt);
  let segments: readonly ConnectorRouteSegment[];
  let isSelfLoop = false;

  if (input.routing === 'straight') {
    segments = [{ type: 'line', end }];
  } else if (input.routing === 'elbow') {
    const midpointX = (start.xPt + end.xPt) / 2;
    segments = [
      { type: 'line', end: point(midpointX, start.yPt) },
      { type: 'line', end: point(midpointX, end.yPt) },
      { type: 'line', end },
    ];
  } else {
    const curved = cubicSegments(input.start, input.end, input.options);
    segments = curved.segments;
    isSelfLoop = curved.isSelfLoop;
  }

  return {
    ok: true,
    route: {
      routing: input.routing,
      start,
      segments,
      isSelfLoop,
      bounds: routeBounds(start, segments),
      pathData: connectorRoutePathData(start, segments),
    },
  };
};
