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
      return {
        ...element,
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
        ...(patch.verticalAlignment === undefined
          ? {}
          : { verticalAlignment: patch.verticalAlignment }),
        ...(patch.styleRole === undefined ? {} : { styleRole: patch.styleRole }),
        ...(patch.style === undefined
          ? {}
          : { style: { ...(element.style ?? {}), ...patch.style } }),
      };
    case 'shape': {
      if (element.type !== 'shape') return element;
      const { shadow: currentShadow, ...withoutShadow } = element;
      const base = patch.shadow === null ? withoutShadow : element;
      return {
        ...base,
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
        ...(patch.fill === undefined ? {} : { fill: patch.fill }),
        ...(patch.stroke === undefined ? {} : { stroke: patch.stroke }),
        ...(patch.cornerRadiusPt === undefined ? {} : { cornerRadiusPt: patch.cornerRadiusPt }),
        ...(patch.shadow === undefined || patch.shadow === null ? {} : { shadow: patch.shadow }),
      };
    }
    case 'table':
      if (element.type !== 'table') return element;
      return {
        ...element,
        ...(patch.opacity === undefined ? {} : { opacity: patch.opacity }),
        ...(patch.border === undefined ? {} : { border: patch.border }),
        ...(patch.style === undefined
          ? {}
          : { style: { ...(element.style ?? {}), ...patch.style } }),
      };
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
  if (!found) {
    throw new DocumentCommandError(
      'NOT_FOUND',
      `No slide element is bound to placeholder ${placeholder.id}.`,
    );
  }
  return result;
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
      return {
        ...document,
        masters: document.masters.map((master) =>
          master.id === command.masterId ? command.replacement : master,
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
      return {
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
      return {
        ...document,
        layouts: document.layouts.map((layout) =>
          layout.id === command.layoutId ? command.replacement : layout,
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
      return {
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
        (element) => ({ ...element, visible: command.visible }),
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
    case 'connector.update-endpoint':
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
          return { ...element, [command.endpoint]: command.value };
        },
      );
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
