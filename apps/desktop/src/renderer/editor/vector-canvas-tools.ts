import {
  DOCUMENT_LIMITS,
  type ConnectorEndpoint,
  type DocumentCommand,
  type Element,
  type Frame,
  type PathCommand,
  type PathElement,
} from '@htmllelujah/document-core';

export type CanvasPoint = Readonly<{ xPt: number; yPt: number }>;

export type CanvasVectorTool =
  | Readonly<{ kind: 'select' }>
  | Readonly<{ kind: 'freeform'; closed: boolean }>
  | Readonly<{ kind: 'edit-path'; elementId: string }>;

export type PathPointRole = 'anchor' | 'control1' | 'control2';

export type PathPointHandle = Readonly<{
  commandIndex: number;
  role: PathPointRole;
  point: CanvasPoint;
}>;

export type ConnectorAnchorName = NonNullable<ConnectorEndpoint['binding']['anchor']>;

export type ConnectorAnchorCandidate = Readonly<{
  elementId: string;
  elementName: string;
  anchor: ConnectorAnchorName;
  point: CanvasPoint;
}>;

export type ConnectorEndpointSnap = Readonly<{
  endpoint: ConnectorEndpoint;
  candidate?: ConnectorAnchorCandidate | undefined;
}>;

const ANCHOR_ORDER: readonly ConnectorAnchorName[] = ['top', 'right', 'bottom', 'left', 'center'];

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const rotatePoint = (point: CanvasPoint, center: CanvasPoint, rotationDeg: number): CanvasPoint => {
  if (!Number.isFinite(rotationDeg) || rotationDeg === 0) return point;
  const radians = (rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = point.xPt - center.xPt;
  const deltaY = point.yPt - center.yPt;
  return {
    xPt: center.xPt + deltaX * cosine - deltaY * sine,
    yPt: center.yPt + deltaX * sine + deltaY * cosine,
  };
};

const frameCenter = (frame: Frame): CanvasPoint => ({
  xPt: frame.xPt + frame.widthPt / 2,
  yPt: frame.yPt + frame.heightPt / 2,
});

export const clampCanvasPoint = (
  point: CanvasPoint,
  bounds: Readonly<{ widthPt: number; heightPt: number }>,
): CanvasPoint => ({
  xPt: clamp(point.xPt, 0, Math.max(0, bounds.widthPt)),
  yPt: clamp(point.yPt, 0, Math.max(0, bounds.heightPt)),
});

export const appendDistinctCanvasPoint = (
  points: readonly CanvasPoint[],
  point: CanvasPoint,
  tolerancePt = 0.75,
): readonly CanvasPoint[] => {
  const previous = points.at(-1);
  if (
    previous !== undefined &&
    Math.hypot(previous.xPt - point.xPt, previous.yPt - point.yPt) <= Math.max(0, tolerancePt)
  ) {
    return points;
  }
  // Keep one command available for a possible close instruction.
  const maximum = DOCUMENT_LIMITS.maxPathCommands - 1;
  return points.length >= maximum ? points : [...points, point];
};

export const canFinishFreeform = (points: readonly CanvasPoint[], closed: boolean): boolean =>
  points.length >= (closed ? 3 : 2);

export const createPathElementFromCanvasPoints = (
  points: readonly CanvasPoint[],
  closed: boolean,
  id: string,
): PathElement => {
  if (!canFinishFreeform(points, closed)) {
    throw new Error(
      closed
        ? 'A closed freeform needs at least three points.'
        : 'An open freeform needs at least two points.',
    );
  }
  const bounded = points.slice(0, DOCUMENT_LIMITS.maxPathCommands - (closed ? 1 : 0));
  const minimumX = Math.min(...bounded.map((point) => point.xPt));
  const minimumY = Math.min(...bounded.map((point) => point.yPt));
  const maximumX = Math.max(...bounded.map((point) => point.xPt));
  const maximumY = Math.max(...bounded.map((point) => point.yPt));
  const widthPt = Math.max(1, maximumX - minimumX);
  const heightPt = Math.max(1, maximumY - minimumY);
  const commands: PathCommand[] = bounded.map((point, index) => ({
    type: index === 0 ? 'move' : 'line',
    xPt: clamp(point.xPt - minimumX, 0, widthPt),
    yPt: clamp(point.yPt - minimumY, 0, heightPt),
  }));
  if (closed) commands.push({ type: 'close' });
  return {
    id,
    name: closed ? 'Closed freeform' : 'Open freeform',
    type: 'path',
    frame: { xPt: minimumX, yPt: minimumY, widthPt, heightPt, rotationDeg: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    commands,
    fill: closed ? '#DCE8FF' : null,
    stroke: { color: '#295BC7', widthPt: 2, dash: 'solid' },
    fillRule: 'nonzero',
  };
};

export const pathPointHandles = (element: PathElement): readonly PathPointHandle[] =>
  element.commands.flatMap((command, commandIndex): readonly PathPointHandle[] => {
    switch (command.type) {
      case 'move':
      case 'line':
        return [{ commandIndex, role: 'anchor', point: { xPt: command.xPt, yPt: command.yPt } }];
      case 'cubic':
        return [
          {
            commandIndex,
            role: 'control1',
            point: { xPt: command.control1XPt, yPt: command.control1YPt },
          },
          {
            commandIndex,
            role: 'control2',
            point: { xPt: command.control2XPt, yPt: command.control2YPt },
          },
          { commandIndex, role: 'anchor', point: { xPt: command.xPt, yPt: command.yPt } },
        ];
      case 'close':
        return [];
    }
  });

export const updatePathPoint = (
  element: PathElement,
  commandIndex: number,
  role: PathPointRole,
  requestedPoint: CanvasPoint,
): readonly PathCommand[] => {
  const point = clampCanvasPoint(requestedPoint, element.frame);
  return element.commands.map((command, index): PathCommand => {
    if (index !== commandIndex) return command;
    if (role === 'anchor') {
      if (command.type === 'move' || command.type === 'line' || command.type === 'cubic') {
        return { ...command, xPt: point.xPt, yPt: point.yPt };
      }
      return command;
    }
    if (command.type !== 'cubic') return command;
    return role === 'control1'
      ? { ...command, control1XPt: point.xPt, control1YPt: point.yPt }
      : { ...command, control2XPt: point.xPt, control2YPt: point.yPt };
  });
};

export const slidePointToFrameLocal = (point: CanvasPoint, frame: Frame): CanvasPoint => {
  const unrotated = rotatePoint(point, frameCenter(frame), -frame.rotationDeg);
  return clampCanvasPoint(
    { xPt: unrotated.xPt - frame.xPt, yPt: unrotated.yPt - frame.yPt },
    frame,
  );
};

export const frameLocalPointToSlide = (point: CanvasPoint, frame: Frame): CanvasPoint =>
  rotatePoint(
    { xPt: frame.xPt + point.xPt, yPt: frame.yPt + point.yPt },
    frameCenter(frame),
    frame.rotationDeg,
  );

const anchorLocalPoint = (frame: Frame, anchor: ConnectorAnchorName): CanvasPoint => {
  switch (anchor) {
    case 'top':
      return { xPt: frame.widthPt / 2, yPt: 0 };
    case 'right':
      return { xPt: frame.widthPt, yPt: frame.heightPt / 2 };
    case 'bottom':
      return { xPt: frame.widthPt / 2, yPt: frame.heightPt };
    case 'left':
      return { xPt: 0, yPt: frame.heightPt / 2 };
    case 'center':
      return { xPt: frame.widthPt / 2, yPt: frame.heightPt / 2 };
  }
};

export const connectorAnchorCandidates = (
  elements: readonly Element[],
  connectorId: string,
): readonly ConnectorAnchorCandidate[] =>
  elements.flatMap((element): readonly ConnectorAnchorCandidate[] => {
    if (
      element.id === connectorId ||
      element.type === 'connector' ||
      element.type === 'placeholder' ||
      !element.visible
    ) {
      return [];
    }
    return ANCHOR_ORDER.map((anchor) => ({
      elementId: element.id,
      elementName: element.name,
      anchor,
      point: frameLocalPointToSlide(anchorLocalPoint(element.frame, anchor), element.frame),
    }));
  });

export const snapConnectorEndpoint = (
  point: CanvasPoint,
  candidates: readonly ConnectorAnchorCandidate[],
  tolerancePt: number,
): ConnectorEndpointSnap => {
  const boundedTolerance = Math.max(0, Number.isFinite(tolerancePt) ? tolerancePt : 0);
  const nearest = candidates
    .map((candidate) => ({
      candidate,
      distance: Math.hypot(candidate.point.xPt - point.xPt, candidate.point.yPt - point.yPt),
    }))
    .filter(({ distance }) => distance <= boundedTolerance)
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.candidate.elementId.localeCompare(right.candidate.elementId) ||
        ANCHOR_ORDER.indexOf(left.candidate.anchor) - ANCHOR_ORDER.indexOf(right.candidate.anchor),
    )[0]?.candidate;
  if (nearest === undefined) {
    return { endpoint: { ...point, binding: {} } };
  }
  return {
    candidate: nearest,
    endpoint: {
      ...nearest.point,
      binding: { elementId: nearest.elementId, anchor: nearest.anchor },
    },
  };
};

/**
 * A bound endpoint is detached and relocated with two commands in one
 * transaction: document-core first materializes its live anchor, then applies
 * the requested free point. Unbound moves and new bindings need one command.
 */
export const directConnectorEndpointCommands = (
  slideId: string,
  connector: Extract<Element, { readonly type: 'connector' }>,
  endpoint: 'start' | 'end',
  value: ConnectorEndpoint,
): readonly DocumentCommand[] => {
  const command = {
    type: 'connector.update-endpoint' as const,
    slideId,
    connectorId: connector.id,
    endpoint,
    value,
  };
  return connector[endpoint].binding.elementId !== undefined &&
    value.binding.elementId === undefined
    ? [command, command]
    : [command];
};
