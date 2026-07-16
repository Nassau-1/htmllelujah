import type {
  AlignElementsCommand,
  DistributeElementsCommand,
  DocumentCommand,
  GroupElementsCommand,
  TransactionMetadata,
  TransactionOptions,
  UngroupElementsCommand,
} from './commands.js';
import { documentCommandSchema, transactionMetadataSchema } from './commands.js';
import { DOCUMENT_LIMITS } from './limits.js';
import type {
  DeckDocument,
  ConnectorEndpoint,
  Element,
  ElementStylePatch,
  Frame,
  GroupElement,
  PageSize,
  PlaceholderElement,
  RichTextDocument,
  TableCell,
  TableElement,
  Slide,
} from './model.js';
import {
  canonicalizeConnectorGeometry,
  canonicalizeElementConnectorGeometry,
  canonicalizeElementsConnectorGeometry,
  connectorFallbackBounds,
  resolveDocumentConnectorGeometries,
  type ResolvedDocumentConnectorGeometry,
} from './connector-geometry.js';
import { createRevisionToken } from './revision.js';
import { parseTsv, TsvParseError } from './tsv.js';
import { DocumentValidationError, parseDeck, validateDeck } from './validation.js';

export type DocumentCommandErrorCode =
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID_INDEX'
  | 'LOCKED'
  | 'INVALID_SELECTION'
  | 'ID_MISMATCH'
  | 'EMPTY_TRANSACTION'
  | 'LAST_SLIDE'
  | 'LAST_RESOURCE'
  | 'DEPENDENCY_IN_USE'
  | 'TYPE_MISMATCH'
  | 'UNSUPPORTED_OPERATION'
  | 'LIMIT_EXCEEDED';

export class DocumentCommandError extends Error {
  public readonly code: DocumentCommandErrorCode;

  public constructor(code: DocumentCommandErrorCode, message: string) {
    super(message);
    this.name = 'DocumentCommandError';
    this.code = code;
  }
}

export interface DocumentSnapshot {
  readonly document: DeckDocument;
  readonly revision: string;
}

export interface TransactionResult extends DocumentSnapshot {
  readonly previousRevision: string;
  readonly metadata: TransactionMetadata;
  readonly commands: readonly DocumentCommand[];
  readonly undoSnapshot: DocumentSnapshot;
}

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const replaceSlide = (
  document: DeckDocument,
  slideId: string,
  update: (slide: Slide) => Slide,
): DeckDocument => {
  let found = false;
  const slides = document.slides.map((slide) => {
    if (slide.id !== slideId) return slide;
    found = true;
    return update(slide);
  });
  if (!found) {
    throw new DocumentCommandError('NOT_FOUND', `Slide ${slideId} does not exist.`);
  }
  return { ...document, slides };
};

const findGroup = (elements: readonly Element[], groupId: string): GroupElement | undefined => {
  for (const element of elements) {
    if (element.type !== 'group') continue;
    if (element.id === groupId) return element;
    const nested = findGroup(element.children, groupId);
    if (nested !== undefined) return nested;
  }
  return undefined;
};

const updateContainer = (
  rootElements: readonly Element[],
  containerId: string | undefined,
  update: (elements: readonly Element[]) => readonly Element[],
): readonly Element[] => {
  if (containerId === undefined) return update(rootElements);

  let found = false;
  const visit = (elements: readonly Element[]): readonly Element[] =>
    elements.map((element) => {
      if (element.type !== 'group') return element;
      if (element.id === containerId) {
        found = true;
        if (element.locked) {
          throw new DocumentCommandError('LOCKED', `Group container ${containerId} is locked.`);
        }
        return { ...element, children: update(element.children) };
      }
      return { ...element, children: visit(element.children) };
    });

  const result = visit(rootElements);
  if (!found) {
    throw new DocumentCommandError('NOT_FOUND', `Group container ${containerId} does not exist.`);
  }
  return result;
};

const updateSlideContainer = (
  document: DeckDocument,
  slideId: string,
  containerId: string | undefined,
  update: (elements: readonly Element[]) => readonly Element[],
): DeckDocument =>
  replaceSlide(document, slideId, (slide) => ({
    ...slide,
    elements: updateContainer(slide.elements, containerId, update),
  }));

const requireElements = (
  elements: readonly Element[],
  elementIds: readonly string[],
): readonly Element[] => {
  const requested = new Set(elementIds);
  const selected = elements.filter((element) => requested.has(element.id));
  if (selected.length !== requested.size) {
    const found = new Set(selected.map((element) => element.id));
    const missing = elementIds.filter((identifier) => !found.has(identifier));
    throw new DocumentCommandError(
      'NOT_FOUND',
      `Element(s) ${missing.join(', ')} do not exist in the target container.`,
    );
  }
  return selected;
};

const requireEditable = (elements: readonly Element[]): void => {
  const locked = elements.filter((element) => element.locked);
  if (locked.length > 0) {
    throw new DocumentCommandError(
      'LOCKED',
      `Element(s) ${locked.map((element) => element.id).join(', ')} are locked.`,
    );
  }
};

const sameFrame = (left: Frame, right: Frame): boolean =>
  left.xPt === right.xPt &&
  left.yPt === right.yPt &&
  left.widthPt === right.widthPt &&
  left.heightPt === right.heightPt &&
  left.rotationDeg === right.rotationDeg;

const sameConnectorEndpointGeometry = (
  left: ConnectorEndpoint,
  right: ConnectorEndpoint,
): boolean =>
  left.xPt === right.xPt &&
  left.yPt === right.yPt &&
  left.binding.elementId === right.binding.elementId &&
  left.binding.anchor === right.binding.anchor;

const structurallyEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
};

/**
 * Generic replacement is intentionally not a geometry escape hatch. Connector
 * geometry changes must go through commands that can materialize live anchors,
 * detach atomically, and preserve exact undo state.
 */
const requireSafeElementReplacement = (current: Element, replacement: Element): void => {
  if (current.type === 'group' || replacement.type === 'group') {
    if (
      current.type !== 'group' ||
      replacement.type !== 'group' ||
      !structurallyEqual(current.children, replacement.children)
    ) {
      throw new DocumentCommandError(
        'UNSUPPORTED_OPERATION',
        'Group children must be changed with dedicated element or connector commands targeting the group with containerId.',
      );
    }
    return;
  }
  if (current.type !== 'connector' && replacement.type !== 'connector') return;
  if (current.type !== 'connector' || replacement.type !== 'connector') {
    throw new DocumentCommandError(
      'TYPE_MISMATCH',
      'element.update cannot change an element to or from a connector.',
    );
  }
  if (
    !sameFrame(current.frame, replacement.frame) ||
    !sameConnectorEndpointGeometry(current.start, replacement.start) ||
    !sameConnectorEndpointGeometry(current.end, replacement.end)
  ) {
    throw new DocumentCommandError(
      'UNSUPPORTED_OPERATION',
      'Connector geometry and bindings must be changed with element.transform or connector.update-endpoint.',
    );
  }
};

const elementGeometryBounds = (
  element: Element,
  connectorGeometries?: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): Bounds =>
  element.type === 'connector'
    ? (connectorGeometries?.get(element.id)?.boundsInContainer ?? connectorFallbackBounds(element))
    : {
        left: element.frame.xPt,
        top: element.frame.yPt,
        right: element.frame.xPt + element.frame.widthPt,
        bottom: element.frame.yPt + element.frame.heightPt,
      };

const selectionBounds = (
  elements: readonly Element[],
  connectorGeometries?: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): Bounds => {
  const bounds = elements.map((element) => elementGeometryBounds(element, connectorGeometries));
  return {
    left: Math.min(...bounds.map(({ left }) => left)),
    top: Math.min(...bounds.map(({ top }) => top)),
    right: Math.max(...bounds.map(({ right }) => right)),
    bottom: Math.max(...bounds.map(({ bottom }) => bottom)),
  };
};

const containerBounds = (slide: Slide, containerId: string | undefined, page: PageSize): Bounds => {
  if (containerId === undefined) {
    return { left: 0, top: 0, right: page.widthPt, bottom: page.heightPt };
  }

  const group = findGroup(slide.elements, containerId);
  if (group === undefined) {
    throw new DocumentCommandError('NOT_FOUND', `Group container ${containerId} does not exist.`);
  }
  return {
    left: 0,
    top: 0,
    right: group.coordinateSpace.widthPt,
    bottom: group.coordinateSpace.heightPt,
  };
};

const replaceFrames = (
  elements: readonly Element[],
  frames: ReadonlyMap<string, Frame>,
): readonly Element[] =>
  elements.map((element) => {
    const frame = frames.get(element.id);
    if (frame === undefined) return element;
    if (element.type !== 'connector') {
      return withPlaceholderOverride({ ...element, frame }, 'frame');
    }
    const connector = canonicalizeConnectorGeometry(element);
    const transformed = {
      ...connector,
      frame,
      start: connectorEndpointAfterFrameTransform(connector.start, connector.frame, frame),
      end: connectorEndpointAfterFrameTransform(connector.end, connector.frame, frame),
    };
    return withPlaceholderOverride(transformed, 'frame');
  });

/**
 * Alignment and distribution are explicit whole-object relocation commands.
 * A bound endpoint cannot be transformed independently of its target, so
 * intentional connector relocation commands first freeze the two currently
 * painted points as fallbacks and atomically release their bindings. Structural
 * group/ungroup changes use separate coordinate conversions and retain bindings.
 */
const materializeConnectorGeometryForRelocation = (
  elements: readonly Element[],
  frames: ReadonlyMap<string, Frame>,
  geometries: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): readonly Element[] =>
  elements.map((element) => {
    if (element.type !== 'connector' || !frames.has(element.id)) return element;
    const geometry = geometries.get(element.id);
    if (geometry === undefined) return canonicalizeConnectorGeometry(element);
    const connector = canonicalizeConnectorGeometry(element);
    return {
      ...connector,
      start: { ...connector.start, ...geometry.startInContainer, binding: {} },
      end: { ...connector.end, ...geometry.endInContainer, binding: {} },
    };
  });

const rotatePoint = (
  point: Readonly<{ xPt: number; yPt: number }>,
  centerXPt: number,
  centerYPt: number,
  rotationDeg: number,
): Readonly<{ xPt: number; yPt: number }> => {
  if (rotationDeg === 0) return point;
  const radians = (rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = point.xPt - centerXPt;
  const deltaY = point.yPt - centerYPt;
  return {
    xPt: centerXPt + deltaX * cosine - deltaY * sine,
    yPt: centerYPt + deltaX * sine + deltaY * cosine,
  };
};

/**
 * Connector endpoint coordinates are persisted in their container coordinate space.
 * Re-express the fallback point in the replacement frame so moving, resizing, and
 * rotating a connector never leaves its hit frame detached from the painted line.
 * This helper preserves the binding supplied by its caller. Intentional connector
 * transforms materialize and detach effective endpoints before reaching it.
 */
const connectorEndpointAfterFrameTransform = (
  endpoint: ConnectorEndpoint,
  previousFrame: Frame,
  nextFrame: Frame,
): ConnectorEndpoint => {
  const previousCenterX = previousFrame.xPt + previousFrame.widthPt / 2;
  const previousCenterY = previousFrame.yPt + previousFrame.heightPt / 2;
  const unrotated = rotatePoint(
    endpoint,
    previousCenterX,
    previousCenterY,
    -previousFrame.rotationDeg,
  );
  const normalizedX = (unrotated.xPt - previousFrame.xPt) / previousFrame.widthPt;
  const normalizedY = (unrotated.yPt - previousFrame.yPt) / previousFrame.heightPt;
  const nextCenterX = nextFrame.xPt + nextFrame.widthPt / 2;
  const nextCenterY = nextFrame.yPt + nextFrame.heightPt / 2;
  const nextUnrotated = {
    xPt: nextFrame.xPt + normalizedX * nextFrame.widthPt,
    yPt: nextFrame.yPt + normalizedY * nextFrame.heightPt,
  };
  const transformed = rotatePoint(nextUnrotated, nextCenterX, nextCenterY, nextFrame.rotationDeg);
  return { ...endpoint, ...transformed };
};

const collectElementIds = (elements: readonly Element[], output: Set<string>): void => {
  for (const element of elements) {
    output.add(element.id);
    if (element.type === 'group') collectElementIds(element.children, output);
  }
};

const releaseDeletedConnectorBindings = (
  elements: readonly Element[],
  deletedIds: ReadonlySet<string>,
  geometries: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): readonly Element[] =>
  elements.map((element) => {
    if (element.type === 'group') {
      return {
        ...element,
        children: releaseDeletedConnectorBindings(element.children, deletedIds, geometries),
      };
    }
    if (element.type !== 'connector') return element;
    const connector = canonicalizeConnectorGeometry(element);
    const geometry = geometries.get(connector.id);
    const release = (
      endpoint: ConnectorEndpoint,
      effectivePoint: Readonly<{ xPt: number; yPt: number }> | undefined,
    ): ConnectorEndpoint =>
      endpoint.binding.elementId !== undefined && deletedIds.has(endpoint.binding.elementId)
        ? { ...endpoint, ...(effectivePoint ?? {}), binding: {} }
        : endpoint;
    return {
      ...connector,
      start: release(connector.start, geometry?.startInContainer),
      end: release(connector.end, geometry?.endInContainer),
    };
  });

const deleteElementsAndReleaseConnectorBindings = (
  document: DeckDocument,
  slideId: string,
  containerId: string | undefined,
  elementIds: readonly string[],
): DeckDocument =>
  replaceSlide(document, slideId, (slide) => {
    const connectorGeometries = resolveDocumentConnectorGeometries(slide.elements);
    const deletedIds = new Set<string>();
    const withoutDeleted = updateContainer(slide.elements, containerId, (elements) => {
      const selected = requireElements(elements, elementIds);
      requireEditable(selected);
      collectElementIds(selected, deletedIds);
      return elements.filter((element) => !deletedIds.has(element.id));
    });
    return {
      ...slide,
      elements: releaseDeletedConnectorBindings(withoutDeleted, deletedIds, connectorGeometries),
    };
  });

function withPlaceholderOverride(
  element: Element,
  override: 'frame' | 'style' | 'visibility',
): Element {
  if (element.placeholderBinding === undefined) return element;
  return {
    ...element,
    placeholderBinding: {
      ...element.placeholderBinding,
      overrides: [...new Set([...element.placeholderBinding.overrides, override])],
    },
  };
}

const alignedElementFrame = (
  element: Element,
  mode: AlignElementsCommand['mode'],
  target: Bounds,
  connectorGeometries: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): Frame => {
  const bounds = elementGeometryBounds(element, connectorGeometries);
  let deltaX = 0;
  let deltaY = 0;
  switch (mode) {
    case 'left':
      deltaX = target.left - bounds.left;
      break;
    case 'horizontal-center':
      deltaX = (target.left + target.right - bounds.left - bounds.right) / 2;
      break;
    case 'right':
      deltaX = target.right - bounds.right;
      break;
    case 'top':
      deltaY = target.top - bounds.top;
      break;
    case 'vertical-middle':
      deltaY = (target.top + target.bottom - bounds.top - bounds.bottom) / 2;
      break;
    case 'bottom':
      deltaY = target.bottom - bounds.bottom;
      break;
  }
  return {
    ...element.frame,
    xPt: element.frame.xPt + deltaX,
    yPt: element.frame.yPt + deltaY,
  };
};

const alignElements = (document: DeckDocument, command: AlignElementsCommand): DeckDocument => {
  const slide = document.slides.find((candidate) => candidate.id === command.slideId);
  if (slide === undefined) {
    throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
  }
  const connectorGeometries = resolveDocumentConnectorGeometries(slide.elements);
  return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selected = requireElements(elements, command.elementIds);
    requireEditable(selected);
    const target =
      command.relativeTo === 'selection'
        ? selectionBounds(selected, connectorGeometries)
        : containerBounds(slide, command.containerId, document.page);
    const frames = new Map(
      selected.map((element) => [
        element.id,
        alignedElementFrame(element, command.mode, target, connectorGeometries),
      ]),
    );
    return replaceFrames(
      materializeConnectorGeometryForRelocation(elements, frames, connectorGeometries),
      frames,
    );
  });
};

const distributedFrames = (
  elements: readonly Element[],
  axis: DistributeElementsCommand['axis'],
  target: Bounds,
  connectorGeometries: ReadonlyMap<string, ResolvedDocumentConnectorGeometry>,
): ReadonlyMap<string, Frame> => {
  const geometryById = new Map(
    elements.map((element) => [element.id, elementGeometryBounds(element, connectorGeometries)]),
  );
  const sorted = [...elements].sort((left, right) =>
    axis === 'horizontal'
      ? (geometryById.get(left.id)?.left ?? 0) - (geometryById.get(right.id)?.left ?? 0)
      : (geometryById.get(left.id)?.top ?? 0) - (geometryById.get(right.id)?.top ?? 0),
  );
  const totalSize = sorted.reduce((sum, element) => {
    const bounds =
      geometryById.get(element.id) ?? elementGeometryBounds(element, connectorGeometries);
    return sum + (axis === 'horizontal' ? bounds.right - bounds.left : bounds.bottom - bounds.top);
  }, 0);
  const span = axis === 'horizontal' ? target.right - target.left : target.bottom - target.top;
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = axis === 'horizontal' ? target.left : target.top;
  const frames = new Map<string, Frame>();
  sorted.forEach((element) => {
    const bounds =
      geometryById.get(element.id) ?? elementGeometryBounds(element, connectorGeometries);
    const frame =
      axis === 'horizontal'
        ? { ...element.frame, xPt: element.frame.xPt + cursor - bounds.left }
        : { ...element.frame, yPt: element.frame.yPt + cursor - bounds.top };
    frames.set(element.id, frame);
    cursor +=
      (axis === 'horizontal' ? bounds.right - bounds.left : bounds.bottom - bounds.top) + gap;
  });
  return frames;
};

const distributeElements = (
  document: DeckDocument,
  command: DistributeElementsCommand,
): DeckDocument => {
  const slide = document.slides.find((candidate) => candidate.id === command.slideId);
  if (slide === undefined) {
    throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
  }
  const connectorGeometries = resolveDocumentConnectorGeometries(slide.elements);
  return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selected = requireElements(elements, command.elementIds);
    requireEditable(selected);
    const target =
      command.relativeTo === 'selection'
        ? selectionBounds(selected, connectorGeometries)
        : containerBounds(slide, command.containerId, document.page);
    const frames = distributedFrames(selected, command.axis, target, connectorGeometries);
    return replaceFrames(
      materializeConnectorGeometryForRelocation(elements, frames, connectorGeometries),
      frames,
    );
  });
};

const groupElements = (document: DeckDocument, command: GroupElementsCommand): DeckDocument => {
  const slide = document.slides.find((candidate) => candidate.id === command.slideId);
  if (slide === undefined) {
    throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
  }
  const connectorGeometries = resolveDocumentConnectorGeometries(slide.elements);
  return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selectedInput = requireElements(elements, command.elementIds);
    requireEditable(selectedInput);
    const selected = selectedInput.map(canonicalizeElementConnectorGeometry);
    const rawBounds = selectionBounds(selected, connectorGeometries);
    const minimumGroupDimensionPt = 1;
    const missingWidth = Math.max(0, minimumGroupDimensionPt - (rawBounds.right - rawBounds.left));
    const missingHeight = Math.max(0, minimumGroupDimensionPt - (rawBounds.bottom - rawBounds.top));
    const bounds = {
      left: rawBounds.left - missingWidth / 2,
      top: rawBounds.top - missingHeight / 2,
      right: rawBounds.right + missingWidth / 2,
      bottom: rawBounds.bottom + missingHeight / 2,
    };
    const selectedIds = new Set(command.elementIds);
    const selectedById = new Map(selected.map((element) => [element.id, element] as const));
    const insertionIndex = Math.min(
      ...elements
        .map((element, index) => (selectedIds.has(element.id) ? index : undefined))
        .filter((index): index is number => index !== undefined),
    );
    const children = elements
      .filter((element) => selectedIds.has(element.id))
      .map((inputElement): Element => {
        const element = selectedById.get(inputElement.id) ?? inputElement;
        const frame = {
          ...element.frame,
          xPt: element.frame.xPt - bounds.left,
          yPt: element.frame.yPt - bounds.top,
        };
        if (element.type !== 'connector') return { ...element, frame };
        const intoGroup = (endpoint: ConnectorEndpoint): ConnectorEndpoint => ({
          ...endpoint,
          xPt: endpoint.xPt - bounds.left,
          yPt: endpoint.yPt - bounds.top,
        });
        return {
          ...element,
          frame,
          start: intoGroup(element.start),
          end: intoGroup(element.end),
        };
      });
    const group: GroupElement = {
      id: command.groupId,
      name: command.name,
      type: 'group',
      frame: {
        xPt: bounds.left,
        yPt: bounds.top,
        widthPt: bounds.right - bounds.left,
        heightPt: bounds.bottom - bounds.top,
        rotationDeg: 0,
      },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: {
        widthPt: bounds.right - bounds.left,
        heightPt: bounds.bottom - bounds.top,
      },
      children,
    };
    const remaining = elements.filter((element) => !selectedIds.has(element.id));
    return [...remaining.slice(0, insertionIndex), group, ...remaining.slice(insertionIndex)];
  });
};

const childFrameAfterUngroup = (child: Element, group: GroupElement): Frame => {
  const coordinateWidth = Math.max(0.001, group.coordinateSpace.widthPt);
  const coordinateHeight = Math.max(0.001, group.coordinateSpace.heightPt);
  const scaleX = group.frame.widthPt / coordinateWidth;
  const scaleY = group.frame.heightPt / coordinateHeight;
  const localCenterX = child.frame.xPt + child.frame.widthPt / 2;
  const localCenterY = child.frame.yPt + child.frame.heightPt / 2;
  const offsetX = (localCenterX - coordinateWidth / 2) * scaleX;
  const offsetY = (localCenterY - coordinateHeight / 2) * scaleY;
  const radians = (group.frame.rotationDeg * Math.PI) / 180;
  const rotatedX = offsetX * Math.cos(radians) - offsetY * Math.sin(radians);
  const rotatedY = offsetX * Math.sin(radians) + offsetY * Math.cos(radians);
  const widthPt = child.frame.widthPt * scaleX;
  const heightPt = child.frame.heightPt * scaleY;
  const centerX = group.frame.xPt + group.frame.widthPt / 2 + rotatedX;
  const centerY = group.frame.yPt + group.frame.heightPt / 2 + rotatedY;
  return {
    xPt: centerX - widthPt / 2,
    yPt: centerY - heightPt / 2,
    widthPt,
    heightPt,
    rotationDeg: child.frame.rotationDeg + group.frame.rotationDeg,
  };
};

const connectorEndpointAfterUngroup = (
  endpoint: ConnectorEndpoint,
  group: GroupElement,
): ConnectorEndpoint => {
  const scaleX = group.frame.widthPt / Math.max(0.001, group.coordinateSpace.widthPt);
  const scaleY = group.frame.heightPt / Math.max(0.001, group.coordinateSpace.heightPt);
  const unrotated = {
    xPt: group.frame.xPt + endpoint.xPt * scaleX,
    yPt: group.frame.yPt + endpoint.yPt * scaleY,
  };
  const transformed = rotatePoint(
    unrotated,
    group.frame.xPt + group.frame.widthPt / 2,
    group.frame.yPt + group.frame.heightPt / 2,
    group.frame.rotationDeg,
  );
  return { ...endpoint, ...transformed };
};

const ungroupElements = (document: DeckDocument, command: UngroupElementsCommand): DeckDocument =>
  updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const groupIndex = elements.findIndex((element) => element.id === command.groupId);
    const element = elements[groupIndex];
    if (element === undefined || element.type !== 'group') {
      throw new DocumentCommandError(
        'NOT_FOUND',
        `Group ${command.groupId} does not exist in the target container.`,
      );
    }
    requireEditable([element]);
    const children = element.children.map((inputChild): Element => {
      const child = canonicalizeElementConnectorGeometry(inputChild);
      const frame = childFrameAfterUngroup(child, element);
      const opacity = child.opacity * element.opacity;
      const visible = child.visible && element.visible;
      if (child.type !== 'connector') return { ...child, frame, opacity, visible };
      return {
        ...child,
        frame,
        opacity,
        visible,
        start: connectorEndpointAfterUngroup(child.start, element),
        end: connectorEndpointAfterUngroup(child.end, element),
      };
    });
    return [...elements.slice(0, groupIndex), ...children, ...elements.slice(groupIndex + 1)];
  });

const insertAt = <T>(
  items: readonly T[],
  item: T,
  index: number | undefined,
  label: string,
): readonly T[] => {
  const insertionIndex = index ?? items.length;
  if (insertionIndex > items.length) {
    throw new DocumentCommandError(
      'INVALID_INDEX',
      `${label} insertion index ${insertionIndex} exceeds ${items.length}.`,
    );
  }
  return [...items.slice(0, insertionIndex), item, ...items.slice(insertionIndex)];
};

const updateTargetElement = (
  document: DeckDocument,
  slideId: string,
  containerId: string | undefined,
  elementId: string,
  update: (element: Element) => Element,
  options: Readonly<{ permitLocked?: boolean }> = {},
): DeckDocument =>
  updateSlideContainer(document, slideId, containerId, (elements) => {
    const selected = requireElements(elements, [elementId]);
    if (!options.permitLocked) requireEditable(selected);
    return elements.map((element) => (element.id === elementId ? update(element) : element));
  });

const applyStylePatch = (element: Element, patch: ElementStylePatch): Element => {
  if (element.type !== patch.kind) {
    throw new DocumentCommandError(
      'TYPE_MISMATCH',
      `A ${patch.kind} style patch cannot be applied to a ${element.type} element.`,
    );
  }
  switch (patch.kind) {
    case 'text':
      if (element.type !== 'text') return element;
      {
        const updated = withPlaceholderOverride(
          {
            ...element,
            ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
            ...(patch.verticalAlignment === undefined
              ? {}
              : { verticalAlignment: patch.verticalAlignment }),
            ...(patch.styleRole === undefined ? {} : { styleRole: patch.styleRole }),
            ...(patch.style === undefined
              ? {}
              : { style: { ...(element.style ?? {}), ...patch.style } }),
          },
          'style',
        );
        return patch.opacity === undefined
          ? updated
          : withPlaceholderOverride(updated, 'visibility');
      }
    case 'shape': {
      if (element.type !== 'shape') return element;
      const { shadow: currentShadow, ...withoutShadow } = element;
      const base = patch.shadow === null ? withoutShadow : element;
      const updated = withPlaceholderOverride(
        {
          ...base,
          ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
          ...(patch.fill === undefined ? {} : { fill: patch.fill }),
          ...(patch.stroke === undefined ? {} : { stroke: patch.stroke }),
          ...(patch.cornerRadiusPt === undefined ? {} : { cornerRadiusPt: patch.cornerRadiusPt }),
          ...(patch.shadow === undefined || patch.shadow === null ? {} : { shadow: patch.shadow }),
        },
        'style',
      );
      return patch.opacity === undefined ? updated : withPlaceholderOverride(updated, 'visibility');
    }
    case 'table':
      if (element.type !== 'table') return element;
      {
        const updated = withPlaceholderOverride(
          {
            ...element,
            ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
            ...(patch.border === undefined ? {} : { border: patch.border }),
            ...(patch.style === undefined
              ? {}
              : { style: { ...(element.style ?? {}), ...patch.style } }),
          },
          'style',
        );
        return patch.opacity === undefined
          ? updated
          : withPlaceholderOverride(updated, 'visibility');
      }
  }
};

const updateTable = (
  document: DeckDocument,
  slideId: string,
  containerId: string | undefined,
  tableId: string,
  update: (table: TableElement) => TableElement,
): DeckDocument =>
  updateTargetElement(document, slideId, containerId, tableId, (element) => {
    if (element.type !== 'table') {
      throw new DocumentCommandError('TYPE_MISMATCH', `Element ${tableId} is not a table.`);
    }
    return update(element);
  });

const requireSimpleTable = (table: TableElement): void => {
  if (table.cells.some((cell) => cell.rowSpan !== 1 || cell.columnSpan !== 1)) {
    throw new DocumentCommandError(
      'UNSUPPORTED_OPERATION',
      'Row and column operations require a table without merged cells.',
    );
  }
};

const validateInsertedCells = (
  cells: readonly TableCell[],
  count: number,
  coordinate: 'row' | 'column',
  index: number,
): void => {
  if (cells.length !== count) {
    throw new DocumentCommandError(
      'INVALID_SELECTION',
      `Insertion requires exactly ${count} fresh cells.`,
    );
  }
  const opposite = coordinate === 'row' ? 'column' : 'row';
  const positions = new Set<number>();
  for (const cell of cells) {
    if (
      cell[coordinate] !== index ||
      cell.rowSpan !== 1 ||
      cell.columnSpan !== 1 ||
      cell[opposite] < 0 ||
      cell[opposite] >= count
    ) {
      throw new DocumentCommandError(
        'INVALID_SELECTION',
        'Inserted cells must be single-span and exactly cover the new row or column.',
      );
    }
    positions.add(cell[opposite]);
  }
  if (positions.size !== count) {
    throw new DocumentCommandError(
      'INVALID_SELECTION',
      'Inserted cells must occupy unique coordinates.',
    );
  }
};

const replaceRichTextWithPlainText = (
  content: RichTextDocument,
  text: string,
): RichTextDocument => {
  const first = content.blocks[0];
  if (first === undefined) return content;
  if (first.type === 'list') {
    const item = first.items[0];
    if (item === undefined) return content;
    const marks = item.runs[0]?.marks ?? {
      bold: false,
      italic: false,
      underline: false,
      strikethrough: false,
    };
    return {
      blocks: [
        {
          ...first,
          items: [{ ...item, runs: [{ text, marks }] }],
        },
      ],
    };
  }
  const marks = first.runs[0]?.marks ?? {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };
  return { blocks: [{ ...first, runs: [{ text, marks }] }] };
};

const placeholdersForSlide = (
  document: DeckDocument,
  slide: Slide,
): ReadonlyMap<string, PlaceholderElement> => {
  const output = new Map<string, PlaceholderElement>();
  const visit = (elements: readonly Element[]): void => {
    for (const element of elements) {
      if (element.type === 'placeholder') output.set(element.id, element);
      if (element.type === 'group') visit(element.children);
    }
  };
  const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
  const master =
    layout === undefined
      ? undefined
      : document.masters.find((candidate) => candidate.id === layout.masterId);
  if (master !== undefined) visit(master.elements);
  if (layout !== undefined) visit(layout.elements);
  return output;
};

const placeholderAcceptsElement = (placeholder: PlaceholderElement, element: Element): boolean =>
  element.type !== 'connector' &&
  element.type !== 'group' &&
  element.type !== 'placeholder' &&
  placeholder.accepts.includes(element.type);

const remapPlaceholderBindings = (
  sourceDocument: DeckDocument,
  targetDocument: DeckDocument,
  slide: Slide,
  layoutId: string,
): readonly Element[] => {
  const sourcePlaceholders = placeholdersForSlide(sourceDocument, slide);
  const targetPlaceholders = [
    ...placeholdersForSlide(targetDocument, { ...slide, layoutId }).values(),
  ];
  const targetPlaceholdersById = new Map(
    targetPlaceholders.map((placeholder) => [placeholder.id, placeholder]),
  );

  // Reserve bindings inherited by both layouts before remapping. This prevents an
  // earlier element from claiming a shared placeholder that a later element already uses.
  const retainedPlaceholderIds = new Set<string>();
  const reserveRetainedBindings = (element: Element): void => {
    if (element.type === 'group') {
      element.children.forEach(reserveRetainedBindings);
      return;
    }
    const placeholderId = element.placeholderBinding?.placeholderId;
    if (placeholderId === undefined) return;
    const targetPlaceholder = targetPlaceholdersById.get(placeholderId);
    if (targetPlaceholder !== undefined && placeholderAcceptsElement(targetPlaceholder, element)) {
      retainedPlaceholderIds.add(placeholderId);
    }
  };
  slide.elements.forEach(reserveRetainedBindings);

  const usedPlaceholderIds = new Set(retainedPlaceholderIds);
  const visit = (element: Element): Element => {
    if (element.type === 'group') {
      return { ...element, children: element.children.map(visit) };
    }
    const binding = element.placeholderBinding;
    if (binding === undefined) return element;

    const retainedPlaceholder = targetPlaceholdersById.get(binding.placeholderId);
    if (
      retainedPlaceholder !== undefined &&
      placeholderAcceptsElement(retainedPlaceholder, element)
    ) {
      return element;
    }

    const sourcePlaceholder = sourcePlaceholders.get(binding.placeholderId);
    const replacement =
      sourcePlaceholder === undefined
        ? undefined
        : targetPlaceholders.find(
            (candidate) =>
              candidate.role === sourcePlaceholder.role &&
              !usedPlaceholderIds.has(candidate.id) &&
              placeholderAcceptsElement(candidate, element),
          );
    if (replacement === undefined) {
      const { placeholderBinding: _placeholderBinding, ...unbound } = element;
      return unbound;
    }

    usedPlaceholderIds.add(replacement.id);
    return {
      ...element,
      placeholderBinding: { ...binding, placeholderId: replacement.id },
    };
  };

  return slide.elements.map(visit);
};

const resetPlaceholderElements = (
  elements: readonly Element[],
  placeholder: PlaceholderElement,
): readonly Element[] => {
  let found = false;
  const containsBinding = (element: Element): boolean =>
    element.placeholderBinding?.placeholderId === placeholder.id ||
    (element.type === 'group' && element.children.some(containsBinding));
  const visit = (element: Element): Element => {
    if (element.type === 'group') {
      if (element.locked && element.children.some(containsBinding)) {
        throw new DocumentCommandError('LOCKED', `Group ${element.id} is locked.`);
      }
      return { ...element, children: element.children.map(visit) };
    }
    if (element.placeholderBinding?.placeholderId !== placeholder.id) return element;
    found = true;
    if (element.locked) {
      throw new DocumentCommandError('LOCKED', `Element ${element.id} is locked.`);
    }
    const common = {
      ...element,
      frame: placeholder.frame,
      visible: placeholder.visible,
      opacity: placeholder.opacity,
      placeholderBinding: { placeholderId: placeholder.id, overrides: [] },
    };
    if (common.type !== 'text') return common;
    const { style: _style, ...withoutStyle } = common;
    return withoutStyle;
  };
  const result = elements.map(visit);
  return found ? result : elements;
};

const elementReferencesAsset = (element: Element, assetId: string): boolean => {
  if (element.type === 'image' && element.assetId === assetId) return true;
  return (
    element.type === 'group' &&
    element.children.some((child) => elementReferencesAsset(child, assetId))
  );
};

const backgroundReferencesAsset = (
  background: DeckDocument['settings']['defaultBackground'] | undefined,
  assetId: string,
): boolean => background?.type === 'image' && background.assetId === assetId;

const documentReferencesAsset = (document: DeckDocument, assetId: string): boolean =>
  backgroundReferencesAsset(document.settings.defaultBackground, assetId) ||
  document.masters.some(
    (master) =>
      backgroundReferencesAsset(master.background, assetId) ||
      master.elements.some((element) => elementReferencesAsset(element, assetId)),
  ) ||
  document.layouts.some(
    (layout) =>
      backgroundReferencesAsset(layout.background, assetId) ||
      layout.elements.some((element) => elementReferencesAsset(element, assetId)),
  ) ||
  document.slides.some(
    (slide) =>
      backgroundReferencesAsset(slide.background, assetId) ||
      slide.elements.some((element) => elementReferencesAsset(element, assetId)),
  );

const sortedTableCells = (cells: readonly TableCell[]): readonly TableCell[] =>
  [...cells].sort((left, right) => left.row - right.row || left.column - right.column);

const executeCommand = (document: DeckDocument, command: DocumentCommand): DeckDocument => {
  switch (command.type) {
    case 'deck.rename':
      return { ...document, name: command.name };
    case 'deck.set-page':
      return { ...document, page: command.page };
    case 'deck.set-export-options':
      return {
        ...document,
        settings: {
          ...document.settings,
          includeHiddenSlidesInExport: command.includeHiddenSlidesInExport,
        },
      };
    case 'theme.create':
      return {
        ...document,
        themes: insertAt(document.themes, command.theme, command.index, 'Theme'),
      };
    case 'theme.update': {
      if (command.themeId !== command.replacement.id) {
        throw new DocumentCommandError(
          'ID_MISMATCH',
          'A theme replacement must retain its identifier.',
        );
      }
      if (!document.themes.some((theme) => theme.id === command.themeId)) {
        throw new DocumentCommandError('NOT_FOUND', `Theme ${command.themeId} does not exist.`);
      }
      return {
        ...document,
        themes: document.themes.map((theme) =>
          theme.id === command.themeId ? command.replacement : theme,
        ),
      };
    }
    case 'theme.delete': {
      if (document.themes.length === 1) {
        throw new DocumentCommandError('LAST_RESOURCE', 'A deck must retain at least one theme.');
      }
      if (!document.themes.some((theme) => theme.id === command.themeId)) {
        throw new DocumentCommandError('NOT_FOUND', `Theme ${command.themeId} does not exist.`);
      }
      const used = document.masters.some((master) => master.themeId === command.themeId);
      if (used && command.replacementThemeId === undefined) {
        throw new DocumentCommandError(
          'DEPENDENCY_IN_USE',
          `Theme ${command.themeId} is still used by a master.`,
        );
      }
      if (
        command.replacementThemeId !== undefined &&
        (command.replacementThemeId === command.themeId ||
          !document.themes.some((theme) => theme.id === command.replacementThemeId))
      ) {
        throw new DocumentCommandError('NOT_FOUND', 'Replacement theme does not exist.');
      }
      return {
        ...document,
        themes: document.themes.filter((theme) => theme.id !== command.themeId),
        masters:
          command.replacementThemeId === undefined
            ? document.masters
            : document.masters.map((master) =>
                master.themeId === command.themeId
                  ? { ...master, themeId: command.replacementThemeId as string }
                  : master,
              ),
      };
    }
    case 'master.create':
      return {
        ...document,
        masters: insertAt(document.masters, command.master, command.index, 'Master'),
      };
    case 'master.update': {
      if (command.masterId !== command.replacement.id) {
        throw new DocumentCommandError(
          'ID_MISMATCH',
          'A master replacement must retain its identifier.',
        );
      }
      if (!document.masters.some((master) => master.id === command.masterId)) {
        throw new DocumentCommandError('NOT_FOUND', `Master ${command.masterId} does not exist.`);
      }
      const targetDocument: DeckDocument = {
        ...document,
        masters: document.masters.map((master) =>
          master.id === command.masterId ? command.replacement : master,
        ),
      };
      const affectedLayoutIds = new Set(
        document.layouts
          .filter((layout) => layout.masterId === command.masterId)
          .map((layout) => layout.id),
      );
      return {
        ...targetDocument,
        slides: document.slides.map((slide) =>
          affectedLayoutIds.has(slide.layoutId)
            ? {
                ...slide,
                elements: remapPlaceholderBindings(document, targetDocument, slide, slide.layoutId),
              }
            : slide,
        ),
      };
    }
    case 'master.delete': {
      if (document.masters.length === 1) {
        throw new DocumentCommandError('LAST_RESOURCE', 'A deck must retain at least one master.');
      }
      if (!document.masters.some((master) => master.id === command.masterId)) {
        throw new DocumentCommandError('NOT_FOUND', `Master ${command.masterId} does not exist.`);
      }
      const used = document.layouts.some((layout) => layout.masterId === command.masterId);
      if (used && command.replacementMasterId === undefined) {
        throw new DocumentCommandError(
          'DEPENDENCY_IN_USE',
          `Master ${command.masterId} is still used by a layout.`,
        );
      }
      if (
        command.replacementMasterId !== undefined &&
        (command.replacementMasterId === command.masterId ||
          !document.masters.some((master) => master.id === command.replacementMasterId))
      ) {
        throw new DocumentCommandError('NOT_FOUND', 'Replacement master does not exist.');
      }
      const targetDocument: DeckDocument = {
        ...document,
        masters: document.masters.filter((master) => master.id !== command.masterId),
        layouts:
          command.replacementMasterId === undefined
            ? document.layouts
            : document.layouts.map((layout) =>
                layout.masterId === command.masterId
                  ? { ...layout, masterId: command.replacementMasterId as string }
                  : layout,
              ),
      };
      const affectedLayoutIds = new Set(
        document.layouts
          .filter((layout) => layout.masterId === command.masterId)
          .map((layout) => layout.id),
      );
      return {
        ...targetDocument,
        slides: document.slides.map((slide) =>
          affectedLayoutIds.has(slide.layoutId)
            ? {
                ...slide,
                elements: remapPlaceholderBindings(document, targetDocument, slide, slide.layoutId),
              }
            : slide,
        ),
      };
    }
    case 'layout.create':
      return {
        ...document,
        layouts: insertAt(document.layouts, command.layout, command.index, 'Layout'),
      };
    case 'layout.update': {
      if (command.layoutId !== command.replacement.id) {
        throw new DocumentCommandError(
          'ID_MISMATCH',
          'A layout replacement must retain its identifier.',
        );
      }
      if (!document.layouts.some((layout) => layout.id === command.layoutId)) {
        throw new DocumentCommandError('NOT_FOUND', `Layout ${command.layoutId} does not exist.`);
      }
      const targetDocument: DeckDocument = {
        ...document,
        layouts: document.layouts.map((layout) =>
          layout.id === command.layoutId ? command.replacement : layout,
        ),
      };
      return {
        ...targetDocument,
        slides: document.slides.map((slide) =>
          slide.layoutId === command.layoutId
            ? {
                ...slide,
                elements: remapPlaceholderBindings(document, targetDocument, slide, slide.layoutId),
              }
            : slide,
        ),
      };
    }
    case 'layout.delete': {
      if (document.layouts.length === 1) {
        throw new DocumentCommandError('LAST_RESOURCE', 'A deck must retain at least one layout.');
      }
      if (!document.layouts.some((layout) => layout.id === command.layoutId)) {
        throw new DocumentCommandError('NOT_FOUND', `Layout ${command.layoutId} does not exist.`);
      }
      const used = document.slides.some((slide) => slide.layoutId === command.layoutId);
      if (used && command.replacementLayoutId === undefined) {
        throw new DocumentCommandError(
          'DEPENDENCY_IN_USE',
          `Layout ${command.layoutId} is still used by a slide.`,
        );
      }
      if (
        command.replacementLayoutId !== undefined &&
        (command.replacementLayoutId === command.layoutId ||
          !document.layouts.some((layout) => layout.id === command.replacementLayoutId))
      ) {
        throw new DocumentCommandError('NOT_FOUND', 'Replacement layout does not exist.');
      }
      const targetDocument: DeckDocument = {
        ...document,
        layouts: document.layouts.filter((layout) => layout.id !== command.layoutId),
        slides:
          command.replacementLayoutId === undefined
            ? document.slides
            : document.slides.map((slide) =>
                slide.layoutId === command.layoutId
                  ? { ...slide, layoutId: command.replacementLayoutId as string }
                  : slide,
              ),
      };
      return {
        ...targetDocument,
        slides: document.slides.map((slide) =>
          slide.layoutId === command.layoutId && command.replacementLayoutId !== undefined
            ? {
                ...slide,
                layoutId: command.replacementLayoutId,
                elements: remapPlaceholderBindings(
                  document,
                  targetDocument,
                  slide,
                  command.replacementLayoutId,
                ),
              }
            : slide,
        ),
      };
    }
    case 'slide.duplicate': {
      const sourceIndex = document.slides.findIndex((slide) => slide.id === command.slideId);
      if (sourceIndex < 0) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      if (command.duplicate.id === command.slideId) {
        throw new DocumentCommandError(
          'ID_MISMATCH',
          'A duplicated slide needs a fresh identifier.',
        );
      }
      return {
        ...document,
        slides: insertAt(
          document.slides,
          command.duplicate,
          command.index ?? sourceIndex + 1,
          'Slide',
        ),
      };
    }
    case 'slide.update':
      return replaceSlide(document, command.slideId, (slide) => {
        if (command.background === null) {
          const { background: _background, ...withoutBackground } = slide;
          return {
            ...withoutBackground,
            ...(command.name === undefined ? {} : { name: command.name }),
          };
        }
        return {
          ...slide,
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(command.background === undefined ? {} : { background: command.background }),
        };
      });
    case 'slide.set-layout':
      if (!document.layouts.some((layout) => layout.id === command.layoutId)) {
        throw new DocumentCommandError('NOT_FOUND', `Layout ${command.layoutId} does not exist.`);
      }
      return replaceSlide(document, command.slideId, (slide) => ({
        ...slide,
        layoutId: command.layoutId,
        elements: remapPlaceholderBindings(document, document, slide, command.layoutId),
      }));
    case 'slide.reset-placeholder':
      return replaceSlide(document, command.slideId, (slide) => {
        const placeholder = placeholdersForSlide(document, slide).get(command.placeholderId);
        if (placeholder === undefined) {
          throw new DocumentCommandError(
            'NOT_FOUND',
            `Placeholder ${command.placeholderId} is unavailable for slide ${slide.id}.`,
          );
        }
        return {
          ...slide,
          elements: resetPlaceholderElements(slide.elements, placeholder),
        };
      });
    case 'slide.set-hidden':
      return replaceSlide(document, command.slideId, (slide) => ({
        ...slide,
        hidden: command.hidden,
      }));
    case 'element.update-style':
      return updateTargetElement(
        document,
        command.slideId,
        command.containerId,
        command.elementId,
        (element) => applyStylePatch(element, command.patch),
      );
    case 'element.set-locked':
      return updateTargetElement(
        document,
        command.slideId,
        command.containerId,
        command.elementId,
        (element) => ({ ...element, locked: command.locked }),
        { permitLocked: true },
      );
    case 'element.set-visible':
      return updateTargetElement(
        document,
        command.slideId,
        command.containerId,
        command.elementId,
        (element) =>
          withPlaceholderOverride({ ...element, visible: command.visible }, 'visibility'),
      );
    case 'element.reorder':
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        if (command.toIndex >= elements.length) {
          throw new DocumentCommandError(
            'INVALID_INDEX',
            `Element target index ${command.toIndex} is outside the container.`,
          );
        }
        const selected = requireElements(elements, [command.elementId]);
        requireEditable(selected);
        const fromIndex = elements.findIndex((element) => element.id === command.elementId);
        const reordered = [...elements];
        const removed = reordered.splice(fromIndex, 1)[0];
        if (removed === undefined) {
          throw new DocumentCommandError(
            'NOT_FOUND',
            `Element ${command.elementId} does not exist.`,
          );
        }
        reordered.splice(command.toIndex, 0, removed);
        return reordered;
      });
    case 'text.replace-content':
      return updateTargetElement(
        document,
        command.slideId,
        command.containerId,
        command.textId,
        (element) => {
          if (element.type !== 'text') {
            throw new DocumentCommandError(
              'TYPE_MISMATCH',
              `Element ${command.textId} is not text.`,
            );
          }
          return { ...element, content: command.content };
        },
      );
    case 'table.insert-row':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          requireSimpleTable(table);
          if (command.index > table.rowCount) {
            throw new DocumentCommandError(
              'INVALID_INDEX',
              'Row insertion index is outside the table.',
            );
          }
          if (table.rowCount >= DOCUMENT_LIMITS.maxTableRows) {
            throw new DocumentCommandError(
              'LIMIT_EXCEEDED',
              'The table has reached the row limit.',
            );
          }
          validateInsertedCells(command.cells, table.columnCount, 'row', command.index);
          return {
            ...table,
            rowCount: table.rowCount + 1,
            rowHeightsPt: insertAt(table.rowHeightsPt, command.heightPt, command.index, 'Row'),
            cells: sortedTableCells([
              ...table.cells.map((cell) =>
                cell.row >= command.index ? { ...cell, row: cell.row + 1 } : cell,
              ),
              ...command.cells,
            ]),
          };
        },
      );
    case 'table.delete-row':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          requireSimpleTable(table);
          if (table.rowCount === 1) {
            throw new DocumentCommandError(
              'LAST_RESOURCE',
              'A table must retain at least one row.',
            );
          }
          if (command.index >= table.rowCount) {
            throw new DocumentCommandError(
              'INVALID_INDEX',
              'Row deletion index is outside the table.',
            );
          }
          return {
            ...table,
            rowCount: table.rowCount - 1,
            rowHeightsPt: table.rowHeightsPt.filter((_, index) => index !== command.index),
            cells: table.cells
              .filter((cell) => cell.row !== command.index)
              .map((cell) => (cell.row > command.index ? { ...cell, row: cell.row - 1 } : cell)),
          };
        },
      );
    case 'table.insert-column':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          requireSimpleTable(table);
          if (command.index > table.columnCount) {
            throw new DocumentCommandError(
              'INVALID_INDEX',
              'Column insertion index is outside the table.',
            );
          }
          if (table.columnCount >= DOCUMENT_LIMITS.maxTableColumns) {
            throw new DocumentCommandError(
              'LIMIT_EXCEEDED',
              'The table has reached the column limit.',
            );
          }
          validateInsertedCells(command.cells, table.rowCount, 'column', command.index);
          return {
            ...table,
            columnCount: table.columnCount + 1,
            columnWidthsPt: insertAt(
              table.columnWidthsPt,
              command.widthPt,
              command.index,
              'Column',
            ),
            cells: sortedTableCells([
              ...table.cells.map((cell) =>
                cell.column >= command.index ? { ...cell, column: cell.column + 1 } : cell,
              ),
              ...command.cells,
            ]),
          };
        },
      );
    case 'table.delete-column':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          requireSimpleTable(table);
          if (table.columnCount === 1) {
            throw new DocumentCommandError(
              'LAST_RESOURCE',
              'A table must retain at least one column.',
            );
          }
          if (command.index >= table.columnCount) {
            throw new DocumentCommandError(
              'INVALID_INDEX',
              'Column deletion index is outside the table.',
            );
          }
          return {
            ...table,
            columnCount: table.columnCount - 1,
            columnWidthsPt: table.columnWidthsPt.filter((_, index) => index !== command.index),
            cells: table.cells
              .filter((cell) => cell.column !== command.index)
              .map((cell) =>
                cell.column > command.index ? { ...cell, column: cell.column - 1 } : cell,
              ),
          };
        },
      );
    case 'table.update-cell':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          if (!table.cells.some((cell) => cell.id === command.cellId)) {
            throw new DocumentCommandError('NOT_FOUND', `Cell ${command.cellId} does not exist.`);
          }
          return {
            ...table,
            cells: table.cells.map((cell) =>
              cell.id === command.cellId
                ? {
                    ...cell,
                    ...(command.content === undefined ? {} : { content: command.content }),
                    ...(command.style === undefined ? {} : { style: command.style }),
                  }
                : cell,
            ),
          };
        },
      );
    case 'table.update-style':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          if (command.style === null) {
            const { style: _style, ...withoutStyle } = table;
            return {
              ...withoutStyle,
              ...(command.border === undefined ? {} : { border: command.border }),
            };
          }
          return {
            ...table,
            ...(command.border === undefined ? {} : { border: command.border }),
            ...(command.style === undefined
              ? {}
              : { style: { ...(table.style ?? {}), ...command.style } }),
          };
        },
      );
    case 'table.paste-tsv':
      return updateTable(
        document,
        command.slideId,
        command.containerId,
        command.tableId,
        (table) => {
          requireSimpleTable(table);
          let matrix: readonly (readonly string[])[];
          try {
            matrix = parseTsv(command.tsv);
          } catch (error) {
            if (error instanceof TsvParseError) {
              throw new DocumentCommandError('INVALID_SELECTION', error.message);
            }
            throw error;
          }
          const width = matrix[0]?.length ?? 0;
          if (
            command.startRow + matrix.length > table.rowCount ||
            command.startColumn + width > table.columnCount
          ) {
            throw new DocumentCommandError(
              'INVALID_SELECTION',
              'Pasted TSV does not fit inside the selected table range.',
            );
          }
          const values = new Map<string, string>();
          matrix.forEach((row, rowOffset) =>
            row.forEach((value, columnOffset) =>
              values.set(
                `${command.startRow + rowOffset}:${command.startColumn + columnOffset}`,
                value,
              ),
            ),
          );
          return {
            ...table,
            cells: table.cells.map((cell) => {
              const value = values.get(`${cell.row}:${cell.column}`);
              return value === undefined
                ? cell
                : { ...cell, content: replaceRichTextWithPlainText(cell.content, value) };
            }),
          };
        },
      );
    case 'asset.register':
      if (
        command.asset.kind === 'image' &&
        (command.asset.widthPx === undefined || command.asset.heightPx === undefined)
      ) {
        throw new DocumentCommandError(
          'INVALID_SELECTION',
          'Registered image assets require widthPx and heightPx.',
        );
      }
      return { ...document, assets: [...document.assets, command.asset] };
    case 'asset.remove':
      if (!document.assets.some((asset) => asset.id === command.assetId)) {
        throw new DocumentCommandError('NOT_FOUND', `Asset ${command.assetId} does not exist.`);
      }
      if (documentReferencesAsset(document, command.assetId)) {
        throw new DocumentCommandError(
          'DEPENDENCY_IN_USE',
          `Asset ${command.assetId} is still referenced by the document.`,
        );
      }
      return {
        ...document,
        assets: document.assets.filter((asset) => asset.id !== command.assetId),
      };
    case 'connector.update-endpoint': {
      const slide = document.slides.find((candidate) => candidate.id === command.slideId);
      if (slide === undefined) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      const geometry = resolveDocumentConnectorGeometries(slide.elements).get(command.connectorId);
      return updateTargetElement(
        document,
        command.slideId,
        command.containerId,
        command.connectorId,
        (element) => {
          if (element.type !== 'connector') {
            throw new DocumentCommandError(
              'TYPE_MISMATCH',
              `Element ${command.connectorId} is not a connector.`,
            );
          }
          const connector = canonicalizeConnectorGeometry(element);
          const previousEndpoint = connector[command.endpoint];
          const removesBinding =
            previousEndpoint.binding.elementId !== undefined &&
            command.value.binding.elementId === undefined;
          const effectivePoint =
            command.endpoint === 'start' ? geometry?.startInContainer : geometry?.endInContainer;
          return {
            ...connector,
            [command.endpoint]:
              removesBinding && effectivePoint !== undefined
                ? { ...command.value, ...effectivePoint }
                : command.value,
          };
        },
      );
    }
    case 'slide.create': {
      const index = command.index ?? document.slides.length;
      if (index > document.slides.length) {
        throw new DocumentCommandError(
          'INVALID_INDEX',
          `Slide insertion index ${index} exceeds ${document.slides.length}.`,
        );
      }
      return {
        ...document,
        slides: [
          ...document.slides.slice(0, index),
          {
            ...command.slide,
            elements: canonicalizeElementsConnectorGeometry(command.slide.elements),
          },
          ...document.slides.slice(index),
        ],
      };
    }
    case 'slide.delete': {
      if (document.slides.length === 1) {
        throw new DocumentCommandError('LAST_SLIDE', 'A deck must retain at least one slide.');
      }
      const index = document.slides.findIndex((slide) => slide.id === command.slideId);
      if (index < 0) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      return {
        ...document,
        slides: document.slides.filter((slide) => slide.id !== command.slideId),
      };
    }
    case 'slide.reorder': {
      if (command.toIndex >= document.slides.length) {
        throw new DocumentCommandError(
          'INVALID_INDEX',
          `Slide target index ${command.toIndex} is outside the deck.`,
        );
      }
      const fromIndex = document.slides.findIndex((slide) => slide.id === command.slideId);
      if (fromIndex < 0) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      const slides = [...document.slides];
      const removed = slides.splice(fromIndex, 1)[0];
      if (removed === undefined) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      slides.splice(command.toIndex, 0, removed);
      return { ...document, slides };
    }
    case 'element.insert':
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        const index = command.index ?? elements.length;
        if (index > elements.length) {
          throw new DocumentCommandError(
            'INVALID_INDEX',
            `Element insertion index ${index} exceeds ${elements.length}.`,
          );
        }
        return [
          ...elements.slice(0, index),
          canonicalizeElementConnectorGeometry(command.element),
          ...elements.slice(index),
        ];
      });
    case 'element.update':
      if (command.elementId !== command.replacement.id) {
        throw new DocumentCommandError(
          'ID_MISMATCH',
          'An element replacement must retain the original identifier.',
        );
      }
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        const selected = requireElements(elements, [command.elementId]);
        requireEditable(selected);
        const current = selected[0];
        if (current === undefined) {
          throw new DocumentCommandError(
            'NOT_FOUND',
            `Element ${command.elementId} does not exist.`,
          );
        }
        requireSafeElementReplacement(current, command.replacement);
        return elements.map((element) =>
          element.id === command.elementId
            ? canonicalizeElementConnectorGeometry(command.replacement)
            : element,
        );
      });
    case 'element.delete':
      return deleteElementsAndReleaseConnectorBindings(
        document,
        command.slideId,
        command.containerId,
        command.elementIds,
      );
    case 'element.transform': {
      const slide = document.slides.find((candidate) => candidate.id === command.slideId);
      if (slide === undefined) {
        throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
      }
      const connectorGeometries = resolveDocumentConnectorGeometries(slide.elements);
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        const elementIds = command.transforms.map((transform) => transform.elementId);
        const selected = requireElements(elements, elementIds);
        requireEditable(selected);
        const frames = new Map(
          command.transforms.map((transform) => [transform.elementId, transform.frame]),
        );
        return replaceFrames(
          materializeConnectorGeometryForRelocation(elements, frames, connectorGeometries),
          frames,
        );
      });
    }
    case 'element.align':
      return alignElements(document, command);
    case 'element.distribute':
      return distributeElements(document, command);
    case 'element.group':
      return groupElements(document, command);
    case 'element.ungroup':
      return ungroupElements(document, command);
  }
};

export const applyTransaction = (
  document: DeckDocument,
  commands: readonly DocumentCommand[],
  options: TransactionOptions,
): TransactionResult => {
  if (commands.length === 0) {
    throw new DocumentCommandError('EMPTY_TRANSACTION', 'A transaction needs a command.');
  }

  const startingDocument = parseDeck(document);
  const previousRevision = createRevisionToken(startingDocument);
  if (options.expectedRevision !== undefined && options.expectedRevision !== previousRevision) {
    throw new DocumentCommandError(
      'REVISION_CONFLICT',
      `Expected ${options.expectedRevision}, received ${previousRevision}.`,
    );
  }

  const metadata = transactionMetadataSchema.parse(options.metadata);
  const parsedCommands = commands.map((command) => documentCommandSchema.parse(command));
  let workingDocument = startingDocument;
  for (const command of parsedCommands) {
    workingDocument = executeCommand(workingDocument, command);
  }
  workingDocument = {
    ...workingDocument,
    metadata: { ...workingDocument.metadata, modifiedAt: metadata.timestamp },
  };

  const validation = validateDeck(workingDocument);
  if (!validation.success) throw new DocumentValidationError(validation.issues);
  const committedDocument = validation.document;
  return {
    document: committedDocument,
    revision: createRevisionToken(committedDocument),
    previousRevision,
    metadata,
    commands: parsedCommands,
    undoSnapshot: {
      document: structuredClone(startingDocument),
      revision: previousRevision,
    },
  };
};

export const applyCommand = (
  document: DeckDocument,
  command: DocumentCommand,
  options: TransactionOptions,
): TransactionResult => applyTransaction(document, [command], options);

/** Restores the immutable pre-transaction snapshot if no later edit intervened. */
export const undoTransaction = (
  currentDocument: DeckDocument,
  transaction: TransactionResult,
): DeckDocument => {
  const currentRevision = createRevisionToken(currentDocument);
  if (currentRevision !== transaction.revision) {
    throw new DocumentCommandError(
      'REVISION_CONFLICT',
      'The transaction cannot be undone after a later document revision.',
    );
  }
  return structuredClone(transaction.undoSnapshot.document);
};
