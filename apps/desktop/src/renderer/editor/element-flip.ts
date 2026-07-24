import {
  boundsForPoints,
  normalizeRotation,
  rotatePointAround,
  rotatedCorners,
  type Bounds,
  type Point,
} from '@htmllelujah/geometry';
import type {
  ConnectorElement,
  ConnectorEndpoint,
  Element,
  Frame,
  PathCommand,
  PathElement,
  ShapeElement,
  ShapeKind,
} from '@htmllelujah/document-core';

export type ElementFlipAxis = 'horizontal' | 'vertical';

export type ElementFlipIssueCode =
  | 'EMPTY_SELECTION'
  | 'DUPLICATE_ELEMENT_ID'
  | 'LOCKED_ELEMENT'
  | 'INVALID_FRAME'
  | 'INVALID_SELECTION_BOUNDS'
  | 'INVALID_PATH_GEOMETRY'
  | 'INVALID_CONNECTOR_GEOMETRY'
  | 'UNSUPPORTED_ELEMENT_TYPE'
  | 'UNSUPPORTED_SHAPE_GEOMETRY'
  | 'CONTENT_TRANSFORM_UNREPRESENTABLE'
  | 'EXTERNAL_CONNECTOR_BINDING'
  | 'UNSUPPORTED_CONNECTOR_BINDING_TARGET';

export type ElementFlipIssue = Readonly<{
  code: ElementFlipIssueCode;
  message: string;
  elementId?: string | undefined;
  elementType?: Element['type'] | undefined;
}>;

export type ElementFlipFailure = Readonly<{
  ok: false;
  code: ElementFlipIssueCode;
  message: string;
  issues: readonly ElementFlipIssue[];
}>;

export type ElementFlipSuccess = Readonly<{
  ok: true;
  elements: readonly Element[];
  sourceIds: readonly string[];
  bounds: Bounds;
}>;

export type ElementFlipResult = ElementFlipSuccess | ElementFlipFailure;

type SupportedElement = ShapeElement | PathElement | ConnectorElement;
type ExplicitAnchor = NonNullable<ConnectorEndpoint['binding']['anchor']>;

type ShapeFlipTransform = Readonly<{
  shape: ShapeKind;
  rotationDeltaDeg: number;
}>;

const EPSILON = 1e-8;

const cleanCoordinate = (value: number): number => (Math.abs(value) <= EPSILON ? 0 : value);

const issue = (
  code: ElementFlipIssueCode,
  message: string,
  element?: Element,
): ElementFlipIssue => ({
  code,
  message,
  ...(element === undefined ? {} : { elementId: element.id, elementType: element.type }),
});

const validFrame = (frame: Frame): boolean =>
  Number.isFinite(frame.xPt) &&
  Number.isFinite(frame.yPt) &&
  Number.isFinite(frame.widthPt) &&
  Number.isFinite(frame.heightPt) &&
  Number.isFinite(frame.rotationDeg) &&
  Number.isFinite(frame.xPt + frame.widthPt) &&
  Number.isFinite(frame.yPt + frame.heightPt) &&
  Number.isFinite(frame.xPt + frame.widthPt / 2) &&
  Number.isFinite(frame.yPt + frame.heightPt / 2) &&
  frame.widthPt > 0 &&
  frame.heightPt > 0;

const finiteBounds = (bounds: Bounds): boolean =>
  Object.values(bounds).every((value) => Number.isFinite(value));

const pointWithinFrame = (point: Point, frame: Frame): boolean =>
  Number.isFinite(point.xPt) &&
  Number.isFinite(point.yPt) &&
  point.xPt >= -EPSILON &&
  point.yPt >= -EPSILON &&
  point.xPt <= frame.widthPt + EPSILON &&
  point.yPt <= frame.heightPt + EPSILON;

const commandPoints = (command: PathCommand): readonly Point[] => {
  switch (command.type) {
    case 'move':
    case 'line':
      return [{ xPt: command.xPt, yPt: command.yPt }];
    case 'cubic':
      return [
        { xPt: command.control1XPt, yPt: command.control1YPt },
        { xPt: command.control2XPt, yPt: command.control2YPt },
        { xPt: command.xPt, yPt: command.yPt },
      ];
    case 'close':
      return [];
  }
};

/**
 * The current document model has no generic mirror bit. These mappings are the
 * subset of native shapes whose reflected geometry can be represented exactly
 * by the existing shape kind plus, where necessary, a rotation or counterpart.
 */
const shapeFlipTransform = (
  shape: ShapeKind,
  axis: ElementFlipAxis,
): ShapeFlipTransform | undefined => {
  switch (shape) {
    case 'rectangle':
    case 'rounded-rectangle':
    case 'ellipse':
    case 'diamond':
    case 'hexagon':
    case 'octagon':
    case 'cross':
    case 'donut':
    case 'line':
      return { shape, rotationDeltaDeg: 0 };
    case 'triangle':
    case 'trapezoid':
    case 'pentagon':
    case 'arc':
      return { shape, rotationDeltaDeg: axis === 'vertical' ? 180 : 0 };
    case 'chevron':
      return { shape, rotationDeltaDeg: axis === 'horizontal' ? 180 : 0 };
    case 'left-bracket':
      return {
        shape: axis === 'horizontal' ? 'right-bracket' : shape,
        rotationDeltaDeg: 0,
      };
    case 'right-bracket':
      return {
        shape: axis === 'horizontal' ? 'left-bracket' : shape,
        rotationDeltaDeg: 0,
      };
    case 'arrow':
      return { shape, rotationDeltaDeg: axis === 'horizontal' ? 180 : 0 };
    case 'right-triangle':
    case 'parallelogram':
      return undefined;
  }
};

const explicitMappedAnchor = (anchor: ExplicitAnchor, axis: ElementFlipAxis): ExplicitAnchor => {
  if (axis === 'horizontal') {
    if (anchor === 'left') return 'right';
    if (anchor === 'right') return 'left';
    return anchor;
  }
  if (anchor === 'top') return 'bottom';
  if (anchor === 'bottom') return 'top';
  return anchor;
};

const resolvedAnchorPoint = (target: Element, anchor: ExplicitAnchor | undefined): Point => {
  const frame = target.frame;
  const local = (() => {
    switch (anchor ?? 'center') {
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
  })();
  const center = {
    xPt: frame.xPt + frame.widthPt / 2,
    yPt: frame.yPt + frame.heightPt / 2,
  };
  return rotatePointAround(
    { xPt: frame.xPt + local.xPt, yPt: frame.yPt + local.yPt },
    center,
    normalizeRotation(frame.rotationDeg),
  );
};

const resolvedEndpoint = (
  endpoint: ConnectorEndpoint,
  selectedById: ReadonlyMap<string, Element>,
): Point => {
  const targetId = endpoint.binding.elementId;
  const target = targetId === undefined ? undefined : selectedById.get(targetId);
  return target === undefined
    ? { xPt: endpoint.xPt, yPt: endpoint.yPt }
    : resolvedAnchorPoint(target, endpoint.binding.anchor);
};

const selectionPoints = (
  elements: readonly SupportedElement[],
  selectedById: ReadonlyMap<string, Element>,
): readonly Point[] =>
  elements.flatMap((element): readonly Point[] => {
    if (element.type !== 'connector') {
      return rotatedCorners({
        ...element.frame,
        rotationDeg: normalizeRotation(element.frame.rotationDeg),
      });
    }
    return [
      resolvedEndpoint(element.start, selectedById),
      resolvedEndpoint(element.end, selectedById),
    ];
  });

const elementSupportIssues = (
  elements: readonly Element[],
  axis: ElementFlipAxis,
): readonly ElementFlipIssue[] => {
  if (elements.length === 0) {
    return [issue('EMPTY_SELECTION', 'Select at least one element to flip.')];
  }

  const issues: ElementFlipIssue[] = [];
  const selectedById = new Map<string, Element>();
  for (const element of elements) {
    if (selectedById.has(element.id)) {
      issues.push(
        issue(
          'DUPLICATE_ELEMENT_ID',
          `Element ${element.id} appears more than once in the flip selection.`,
          element,
        ),
      );
    } else {
      selectedById.set(element.id, element);
    }
    if (!validFrame(element.frame)) {
      issues.push(
        issue(
          'INVALID_FRAME',
          `${element.name} has a non-finite or non-positive frame and cannot be flipped safely.`,
          element,
        ),
      );
    }
    if (element.locked) {
      issues.push(
        issue('LOCKED_ELEMENT', `${element.name} is locked and cannot be flipped.`, element),
      );
    }
  }

  for (const element of elements) {
    switch (element.type) {
      case 'shape': {
        const transform = shapeFlipTransform(element.shape, axis);
        if (transform === undefined) {
          issues.push(
            issue(
              'UNSUPPORTED_SHAPE_GEOMETRY',
              `${element.name} uses ${element.shape}, whose mirror cannot be represented by the current canonical shape model.`,
              element,
            ),
          );
        } else if (element.text !== undefined && transform.rotationDeltaDeg !== 0) {
          issues.push(
            issue(
              'CONTENT_TRANSFORM_UNREPRESENTABLE',
              `${element.name} contains text; mirroring this shape would rotate that text because the model has no independent shape mirror transform.`,
              element,
            ),
          );
        }
        break;
      }
      case 'path':
        if (
          element.commands.some((command) =>
            commandPoints(command).some((point) => !pointWithinFrame(point, element.frame)),
          )
        ) {
          issues.push(
            issue(
              'INVALID_PATH_GEOMETRY',
              `${element.name} contains a non-finite or out-of-frame path point and cannot be mirrored safely.`,
              element,
            ),
          );
        }
        break;
      case 'connector': {
        if (
          !Number.isFinite(element.start.xPt) ||
          !Number.isFinite(element.start.yPt) ||
          !Number.isFinite(element.end.xPt) ||
          !Number.isFinite(element.end.yPt)
        ) {
          issues.push(
            issue(
              'INVALID_CONNECTOR_GEOMETRY',
              `${element.name} contains a non-finite connector endpoint.`,
              element,
            ),
          );
        }
        for (const endpoint of [element.start, element.end]) {
          const targetId = endpoint.binding.elementId;
          if (targetId === undefined) continue;
          const target = selectedById.get(targetId);
          if (target === undefined) {
            issues.push(
              issue(
                'EXTERNAL_CONNECTOR_BINDING',
                `${element.name} is bound to ${targetId}, which is outside the flip selection.`,
                element,
              ),
            );
          } else if (target.type === 'connector') {
            issues.push(
              issue(
                'UNSUPPORTED_CONNECTOR_BINDING_TARGET',
                `${element.name} is bound to another connector, which cannot provide a stable mirrored anchor.`,
                element,
              ),
            );
          }
        }
        break;
      }
      case 'text':
      case 'image':
      case 'table':
      case 'icon':
      case 'placeholder':
      case 'group':
        issues.push(
          issue(
            'UNSUPPORTED_ELEMENT_TYPE',
            `${element.name} is a ${element.type}; the current model has no lossless mirror transform for this element type.`,
            element,
          ),
        );
        break;
    }
  }
  if (issues.length === 0) {
    try {
      const supported = elements as readonly SupportedElement[];
      const bounds = boundsForPoints(selectionPoints(supported, selectedById));
      if (bounds === null || !finiteBounds(bounds)) {
        issues.push(
          issue(
            'INVALID_SELECTION_BOUNDS',
            'The collective selection bounds are not finite and cannot define a safe mirror axis.',
          ),
        );
      }
    } catch {
      issues.push(
        issue(
          'INVALID_SELECTION_BOUNDS',
          'The collective selection bounds cannot define a safe mirror axis.',
        ),
      );
    }
  }
  return issues;
};

/**
 * Returns every reason a selection cannot be mirrored atomically. The function
 * is suitable for menu enablement and does not mutate the supplied elements.
 */
export const inspectElementFlip = (
  elements: readonly Element[],
  axis: ElementFlipAxis,
): readonly ElementFlipIssue[] => elementSupportIssues(elements, axis);

const reflectPoint = (point: Point, bounds: Bounds, axis: ElementFlipAxis): Point =>
  axis === 'horizontal'
    ? {
        xPt: cleanCoordinate(2 * bounds.centerXPt - point.xPt),
        yPt: cleanCoordinate(point.yPt),
      }
    : {
        xPt: cleanCoordinate(point.xPt),
        yPt: cleanCoordinate(2 * bounds.centerYPt - point.yPt),
      };

const transformFrame = (
  frame: Frame,
  bounds: Bounds,
  axis: ElementFlipAxis,
  rotationDeltaDeg = 0,
): Frame => {
  const center = {
    xPt: frame.xPt + frame.widthPt / 2,
    yPt: frame.yPt + frame.heightPt / 2,
  };
  const reflectedCenter = reflectPoint(center, bounds, axis);
  return {
    xPt: cleanCoordinate(reflectedCenter.xPt - frame.widthPt / 2),
    yPt: cleanCoordinate(reflectedCenter.yPt - frame.heightPt / 2),
    widthPt: frame.widthPt,
    heightPt: frame.heightPt,
    rotationDeg: normalizeRotation(-frame.rotationDeg + rotationDeltaDeg),
  };
};

const mirrorPathCoordinate = (point: Point, frame: Frame, axis: ElementFlipAxis): Point =>
  axis === 'horizontal'
    ? { xPt: cleanCoordinate(frame.widthPt - point.xPt), yPt: cleanCoordinate(point.yPt) }
    : { xPt: cleanCoordinate(point.xPt), yPt: cleanCoordinate(frame.heightPt - point.yPt) };

const mirrorPathCommand = (
  command: PathCommand,
  frame: Frame,
  axis: ElementFlipAxis,
): PathCommand => {
  switch (command.type) {
    case 'move':
    case 'line': {
      const point = mirrorPathCoordinate(command, frame, axis);
      return { ...command, ...point };
    }
    case 'cubic': {
      const control1 = mirrorPathCoordinate(
        { xPt: command.control1XPt, yPt: command.control1YPt },
        frame,
        axis,
      );
      const control2 = mirrorPathCoordinate(
        { xPt: command.control2XPt, yPt: command.control2YPt },
        frame,
        axis,
      );
      const point = mirrorPathCoordinate(command, frame, axis);
      return {
        ...command,
        control1XPt: control1.xPt,
        control1YPt: control1.yPt,
        control2XPt: control2.xPt,
        control2YPt: control2.yPt,
        xPt: point.xPt,
        yPt: point.yPt,
      };
    }
    case 'close':
      return command;
  }
};

const transformEndpoint = (
  endpoint: ConnectorEndpoint,
  bounds: Bounds,
  axis: ElementFlipAxis,
  selectedById: ReadonlyMap<string, Element>,
): ConnectorEndpoint => {
  const point = reflectPoint(resolvedEndpoint(endpoint, selectedById), bounds, axis);
  const explicitAnchor = endpoint.binding.anchor;
  return {
    ...endpoint,
    ...point,
    binding:
      explicitAnchor === undefined
        ? endpoint.binding
        : { ...endpoint.binding, anchor: explicitMappedAnchor(explicitAnchor, axis) },
  };
};

const transformElement = (
  element: SupportedElement,
  bounds: Bounds,
  axis: ElementFlipAxis,
  selectedById: ReadonlyMap<string, Element>,
): SupportedElement => {
  switch (element.type) {
    case 'shape': {
      const transform = shapeFlipTransform(element.shape, axis);
      // Preflight makes this branch unreachable for unsupported shapes.
      if (transform === undefined) return element;
      return {
        ...element,
        frame: transformFrame(element.frame, bounds, axis, transform.rotationDeltaDeg),
        shape: transform.shape,
      };
    }
    case 'path':
      return {
        ...element,
        frame: transformFrame(element.frame, bounds, axis),
        commands: element.commands.map((command) =>
          mirrorPathCommand(command, element.frame, axis),
        ),
      };
    case 'connector':
      return {
        ...element,
        frame: transformFrame(element.frame, bounds, axis),
        start: transformEndpoint(element.start, bounds, axis, selectedById),
        end: transformEndpoint(element.end, bounds, axis, selectedById),
      };
  }
};

/**
 * Mirrors a supported selection around the axis-aligned visual bounds shared by
 * that selection. The operation is atomic: any unsupported or unsafe element
 * produces a structured failure and no partially transformed output.
 */
export const flipElementsAroundSelectionBounds = (
  elements: readonly Element[],
  axis: ElementFlipAxis,
): ElementFlipResult => {
  const issues = elementSupportIssues(elements, axis);
  if (issues.length > 0) {
    const primary = issues[0]!;
    return {
      ok: false,
      code: primary.code,
      message: issues.map((current) => current.message).join(' '),
      issues,
    };
  }

  const supported = elements as readonly SupportedElement[];
  const selectedById = new Map(elements.map((element) => [element.id, element] as const));
  const bounds = boundsForPoints(selectionPoints(supported, selectedById));
  if (bounds === null) {
    const emptyIssue = issue('EMPTY_SELECTION', 'Select at least one element to flip.');
    return {
      ok: false,
      code: emptyIssue.code,
      message: emptyIssue.message,
      issues: [emptyIssue],
    };
  }
  return {
    ok: true,
    elements: supported.map((element) => transformElement(element, bounds, axis, selectedById)),
    sourceIds: elements.map((element) => element.id),
    bounds,
  };
};
