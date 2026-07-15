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
import type { DeckDocument, Element, Frame, GroupElement, PageSize, Slide } from './model.js';
import { createRevisionToken } from './revision.js';
import { DocumentValidationError, parseDeck, validateDeck } from './validation.js';

export type DocumentCommandErrorCode =
  | 'REVISION_CONFLICT'
  | 'NOT_FOUND'
  | 'INVALID_INDEX'
  | 'LOCKED'
  | 'INVALID_SELECTION'
  | 'ID_MISMATCH'
  | 'EMPTY_TRANSACTION'
  | 'LAST_SLIDE';

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

const selectionBounds = (elements: readonly Element[]): Bounds => ({
  left: Math.min(...elements.map((element) => element.frame.xPt)),
  top: Math.min(...elements.map((element) => element.frame.yPt)),
  right: Math.max(...elements.map((element) => element.frame.xPt + element.frame.widthPt)),
  bottom: Math.max(...elements.map((element) => element.frame.yPt + element.frame.heightPt)),
});

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
    return frame === undefined ? element : { ...element, frame };
  });

const alignedFrame = (frame: Frame, mode: AlignElementsCommand['mode'], target: Bounds): Frame => {
  switch (mode) {
    case 'left':
      return { ...frame, xPt: target.left };
    case 'horizontal-center':
      return { ...frame, xPt: (target.left + target.right - frame.widthPt) / 2 };
    case 'right':
      return { ...frame, xPt: target.right - frame.widthPt };
    case 'top':
      return { ...frame, yPt: target.top };
    case 'vertical-middle':
      return { ...frame, yPt: (target.top + target.bottom - frame.heightPt) / 2 };
    case 'bottom':
      return { ...frame, yPt: target.bottom - frame.heightPt };
  }
};

const alignElements = (document: DeckDocument, command: AlignElementsCommand): DeckDocument => {
  const slide = document.slides.find((candidate) => candidate.id === command.slideId);
  if (slide === undefined) {
    throw new DocumentCommandError('NOT_FOUND', `Slide ${command.slideId} does not exist.`);
  }
  return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selected = requireElements(elements, command.elementIds);
    requireEditable(selected);
    const target =
      command.relativeTo === 'selection'
        ? selectionBounds(selected)
        : containerBounds(slide, command.containerId, document.page);
    const frames = new Map(
      selected.map((element) => [element.id, alignedFrame(element.frame, command.mode, target)]),
    );
    return replaceFrames(elements, frames);
  });
};

const distributedFrames = (
  elements: readonly Element[],
  axis: DistributeElementsCommand['axis'],
  target: Bounds,
): ReadonlyMap<string, Frame> => {
  const sorted = [...elements].sort((left, right) =>
    axis === 'horizontal' ? left.frame.xPt - right.frame.xPt : left.frame.yPt - right.frame.yPt,
  );
  const totalSize = sorted.reduce(
    (sum, element) =>
      sum + (axis === 'horizontal' ? element.frame.widthPt : element.frame.heightPt),
    0,
  );
  const span = axis === 'horizontal' ? target.right - target.left : target.bottom - target.top;
  const gap = (span - totalSize) / (sorted.length - 1);
  let cursor = axis === 'horizontal' ? target.left : target.top;
  const frames = new Map<string, Frame>();
  sorted.forEach((element) => {
    const frame =
      axis === 'horizontal' ? { ...element.frame, xPt: cursor } : { ...element.frame, yPt: cursor };
    frames.set(element.id, frame);
    cursor += (axis === 'horizontal' ? element.frame.widthPt : element.frame.heightPt) + gap;
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
  return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selected = requireElements(elements, command.elementIds);
    requireEditable(selected);
    const target =
      command.relativeTo === 'selection'
        ? selectionBounds(selected)
        : containerBounds(slide, command.containerId, document.page);
    return replaceFrames(elements, distributedFrames(selected, command.axis, target));
  });
};

const groupElements = (document: DeckDocument, command: GroupElementsCommand): DeckDocument =>
  updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
    const selected = requireElements(elements, command.elementIds);
    requireEditable(selected);
    const bounds = selectionBounds(selected);
    const selectedIds = new Set(command.elementIds);
    const insertionIndex = Math.min(
      ...elements
        .map((element, index) => (selectedIds.has(element.id) ? index : undefined))
        .filter((index): index is number => index !== undefined),
    );
    const children = elements
      .filter((element) => selectedIds.has(element.id))
      .map((element) => ({
        ...element,
        frame: {
          ...element.frame,
          xPt: element.frame.xPt - bounds.left,
          yPt: element.frame.yPt - bounds.top,
        },
      }));
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

const childFrameAfterUngroup = (child: Element, group: GroupElement): Frame => {
  const scaleX = group.frame.widthPt / group.coordinateSpace.widthPt;
  const scaleY = group.frame.heightPt / group.coordinateSpace.heightPt;
  const localCenterX = child.frame.xPt + child.frame.widthPt / 2;
  const localCenterY = child.frame.yPt + child.frame.heightPt / 2;
  const offsetX = (localCenterX - group.coordinateSpace.widthPt / 2) * scaleX;
  const offsetY = (localCenterY - group.coordinateSpace.heightPt / 2) * scaleY;
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
    const children = element.children.map((child): Element => ({
      ...child,
      frame: childFrameAfterUngroup(child, element),
      opacity: child.opacity * element.opacity,
      visible: child.visible && element.visible,
    }));
    return [...elements.slice(0, groupIndex), ...children, ...elements.slice(groupIndex + 1)];
  });

const executeCommand = (document: DeckDocument, command: DocumentCommand): DeckDocument => {
  switch (command.type) {
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
          command.slide,
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
        return [...elements.slice(0, index), command.element, ...elements.slice(index)];
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
        return elements.map((element) =>
          element.id === command.elementId ? command.replacement : element,
        );
      });
    case 'element.delete':
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        const selected = requireElements(elements, command.elementIds);
        requireEditable(selected);
        const selectedIds = new Set(command.elementIds);
        return elements.filter((element) => !selectedIds.has(element.id));
      });
    case 'element.transform':
      return updateSlideContainer(document, command.slideId, command.containerId, (elements) => {
        const elementIds = command.transforms.map((transform) => transform.elementId);
        const selected = requireElements(elements, elementIds);
        requireEditable(selected);
        return replaceFrames(
          elements,
          new Map(command.transforms.map((transform) => [transform.elementId, transform.frame])),
        );
      });
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
