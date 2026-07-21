import type {
  BackgroundStyle,
  DeckDocument,
  DocumentCommand,
  Element,
  Slide,
} from '@htmllelujah/document-core';

import type { CommandAccess } from './contracts.js';

export const deckNameKey = 'deck:name';
export const deckSlideOrderKey = 'deck:slide-order';
export const deckPageKey = 'deck:page';
export const deckExportSettingsKey = 'deck:export-settings';
export const themeCollectionKey = 'deck:themes';
export const masterCollectionKey = 'deck:masters';
export const layoutCollectionKey = 'deck:layouts';
export const assetCollectionKey = 'deck:assets';
export const themeReferenceKey = 'references:themes';
export const masterReferenceKey = 'references:masters';
export const layoutReferenceKey = 'references:layouts';
export const assetReferenceKey = 'references:assets';

export const slideEntityKey = (slideId: string): string => `slide:${slideId}`;
export const elementEntityKey = (elementId: string): string => `element:${elementId}`;
export const themeEntityKey = (themeId: string): string => `theme:${themeId}`;
export const masterEntityKey = (masterId: string): string => `master:${masterId}`;
export const layoutEntityKey = (layoutId: string): string => `layout:${layoutId}`;
export const assetEntityKey = (assetId: string): string => `asset:${assetId}`;
export const elementCollectionKey = (slideId: string, containerId?: string): string =>
  `elements:${slideId}:${containerId ?? 'root'}`;

/**
 * This record is deliberately typed as the complete discriminant union. Adding a
 * document command without classifying it makes collaboration fail typechecking.
 * The runtime test also compares these keys with the command schema so `test`
 * alone catches drift.
 */
export const DOCUMENT_COMMAND_ACCESS_CLASSIFICATION = {
  'deck.rename': 'deck',
  'deck.set-page': 'deck',
  'deck.set-export-options': 'deck',
  'theme.create': 'theme',
  'theme.update': 'theme',
  'theme.delete': 'theme',
  'master.create': 'master',
  'master.update': 'master',
  'master.delete': 'master',
  'layout.create': 'layout',
  'layout.update': 'layout',
  'layout.delete': 'layout',
  'slide.create': 'slide',
  'slide.delete': 'slide',
  'slide.reorder': 'slide',
  'slide.duplicate': 'slide',
  'slide.update': 'slide',
  'slide.set-layout': 'slide',
  'slide.reset-placeholder': 'slide',
  'slide.set-hidden': 'slide',
  'element.insert': 'element',
  'element.update': 'element',
  'element.delete': 'element',
  'element.transform': 'element',
  'element.align': 'element',
  'element.distribute': 'element',
  'element.group': 'element',
  'element.ungroup': 'element',
  'element.update-style': 'element',
  'element.set-locked': 'element',
  'element.set-visible': 'element',
  'element.reorder': 'element',
  'text.replace-content': 'text',
  'table.insert-row': 'table',
  'table.delete-row': 'table',
  'table.insert-column': 'table',
  'table.delete-column': 'table',
  'table.update-cell': 'table',
  'table.update-style': 'table',
  'table.paste-tsv': 'table',
  'asset.register': 'asset',
  'asset.remove': 'asset',
  'connector.update-endpoint': 'connector',
} as const satisfies Readonly<
  Record<
    DocumentCommand['type'],
    | 'deck'
    | 'theme'
    | 'master'
    | 'layout'
    | 'slide'
    | 'element'
    | 'text'
    | 'table'
    | 'asset'
    | 'connector'
  >
>;

const compareKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const assertNever = (value: never): never => {
  throw new Error(`Unclassified document command: ${JSON.stringify(value)}`);
};

const findElement = (elements: readonly Element[], elementId: string): Element | undefined => {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const nested = findElement(element.children, elementId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const findSlide = (document: DeckDocument | undefined, slideId: string): Slide | undefined =>
  document?.slides.find((slide) => slide.id === slideId);

const addElementTreeWrites = (element: Element, slideId: string, writes: Set<string>): void => {
  writes.add(elementEntityKey(element.id));
  if (element.type !== 'group') return;

  writes.add(elementCollectionKey(slideId, element.id));
  element.children.forEach((child) => addElementTreeWrites(child, slideId, writes));
};

const addSlideTreeWrites = (slide: Slide, writes: Set<string>): void => {
  writes.add(slideEntityKey(slide.id));
  writes.add(elementCollectionKey(slide.id));
  slide.elements.forEach((element) => addElementTreeWrites(element, slide.id, writes));
};

const addElementTreeEntityWrites = (element: Element, writes: Set<string>): void => {
  writes.add(elementEntityKey(element.id));
  if (element.type === 'group') {
    element.children.forEach((child) => addElementTreeEntityWrites(child, writes));
  }
};

const addContainerReads = (
  slideId: string,
  containerId: string | undefined,
  reads: Set<string>,
): void => {
  reads.add(slideEntityKey(slideId));
  if (containerId !== undefined) reads.add(elementEntityKey(containerId));
};

const addElementReads = (elementIds: readonly string[], reads: Set<string>): void => {
  elementIds.forEach((elementId) => reads.add(elementEntityKey(elementId)));
};

const addElementWrites = (elementIds: readonly string[], writes: Set<string>): void => {
  elementIds.forEach((elementId) => writes.add(elementEntityKey(elementId)));
};

const collectElementAssetIds = (element: Element, assetIds: Set<string>): void => {
  if (element.type === 'image') assetIds.add(element.assetId);
  if (element.type === 'group') {
    element.children.forEach((child) => collectElementAssetIds(child, assetIds));
  }
};

const collectBackgroundAssetId = (
  background: BackgroundStyle | null | undefined,
  assetIds: Set<string>,
): void => {
  if (background?.type === 'image') assetIds.add(background.assetId);
};

const addAssetReferenceReads = (
  elements: readonly Element[],
  background: BackgroundStyle | null | undefined,
  reads: Set<string>,
): void => {
  const assetIds = new Set<string>();
  elements.forEach((element) => collectElementAssetIds(element, assetIds));
  collectBackgroundAssetId(background, assetIds);
  assetIds.forEach((assetId) => reads.add(assetEntityKey(assetId)));
};

const addBoundPlaceholderAccess = (
  slide: Slide | undefined,
  placeholderId: string,
  reads: Set<string>,
  writes: Set<string>,
): void => {
  if (slide === undefined) return;
  const visit = (elements: readonly Element[]): void => {
    elements.forEach((element) => {
      if (element.placeholderBinding?.placeholderId === placeholderId) {
        reads.add(elementEntityKey(element.id));
        addElementTreeWrites(element, slide.id, writes);
      }
      if (element.type === 'group') visit(element.children);
    });
  };
  visit(slide.elements);
};

const addExistingElementTreeWrites = (
  document: DeckDocument | undefined,
  slideId: string,
  elementIds: readonly string[],
  writes: Set<string>,
): void => {
  const slide = findSlide(document, slideId);
  if (slide === undefined) return;
  elementIds.forEach((elementId) => {
    const element = findElement(slide.elements, elementId);
    if (element !== undefined) addElementTreeWrites(element, slideId, writes);
  });
};

/**
 * Computes conservative, stable entity dependencies directly from typed commands.
 * The optional current document lets the authoritative host resolve indirect writes
 * (placeholder resets and replacement-based resource deletion) without making all
 * element edits on a slide conflict with each other.
 */
export const analyzeCommandAccess = (
  commands: readonly DocumentCommand[],
  document?: DeckDocument,
): CommandAccess => {
  const reads = new Set<string>();
  const writes = new Set<string>();

  commands.forEach((command) => {
    switch (command.type) {
      case 'deck.rename':
        writes.add(deckNameKey);
        break;

      case 'deck.set-page':
        writes.add(deckPageKey);
        break;

      case 'deck.set-export-options':
        writes.add(deckExportSettingsKey);
        break;

      case 'theme.create':
        reads.add(themeCollectionKey);
        writes.add(themeCollectionKey);
        writes.add(themeEntityKey(command.theme.id));
        break;

      case 'theme.update':
        reads.add(themeEntityKey(command.themeId));
        writes.add(themeEntityKey(command.themeId));
        writes.add(themeEntityKey(command.replacement.id));
        break;

      case 'theme.delete': {
        reads.add(themeCollectionKey);
        reads.add(themeEntityKey(command.themeId));
        reads.add(themeReferenceKey);
        writes.add(themeCollectionKey);
        writes.add(themeEntityKey(command.themeId));
        writes.add(themeReferenceKey);
        if (command.replacementThemeId !== undefined) {
          reads.add(themeEntityKey(command.replacementThemeId));
        }
        const affected = document?.masters.filter((master) => master.themeId === command.themeId);
        if (affected === undefined) writes.add(masterCollectionKey);
        else affected.forEach((master) => writes.add(masterEntityKey(master.id)));
        break;
      }

      case 'master.create':
        reads.add(masterCollectionKey);
        reads.add(themeEntityKey(command.master.themeId));
        addAssetReferenceReads(command.master.elements, command.master.background, reads);
        writes.add(masterCollectionKey);
        writes.add(masterEntityKey(command.master.id));
        writes.add(themeReferenceKey);
        writes.add(assetReferenceKey);
        command.master.elements.forEach((element) => addElementTreeEntityWrites(element, writes));
        break;

      case 'master.update': {
        reads.add(masterEntityKey(command.masterId));
        reads.add(themeEntityKey(command.replacement.themeId));
        addAssetReferenceReads(command.replacement.elements, command.replacement.background, reads);
        writes.add(masterEntityKey(command.masterId));
        writes.add(masterEntityKey(command.replacement.id));
        writes.add(themeReferenceKey);
        writes.add(assetReferenceKey);
        command.replacement.elements.forEach((element) =>
          addElementTreeEntityWrites(element, writes),
        );
        if (document !== undefined) {
          const affectedLayoutIds = new Set(
            document.layouts
              .filter((layout) => layout.masterId === command.masterId)
              .map((layout) => layout.id),
          );
          document.slides
            .filter((slide) => affectedLayoutIds.has(slide.layoutId))
            .forEach((slide) => addSlideTreeWrites(slide, writes));
        }
        break;
      }

      case 'master.delete': {
        reads.add(masterCollectionKey);
        reads.add(masterEntityKey(command.masterId));
        reads.add(masterReferenceKey);
        writes.add(masterCollectionKey);
        writes.add(masterEntityKey(command.masterId));
        writes.add(masterReferenceKey);
        writes.add(themeReferenceKey);
        writes.add(assetReferenceKey);
        if (command.replacementMasterId !== undefined) {
          reads.add(masterEntityKey(command.replacementMasterId));
        }
        const affected = document?.layouts.filter((layout) => layout.masterId === command.masterId);
        if (affected === undefined) writes.add(layoutCollectionKey);
        else {
          const affectedLayoutIds = new Set(affected.map((layout) => layout.id));
          affected.forEach((layout) => writes.add(layoutEntityKey(layout.id)));
          document?.slides
            .filter((slide) => affectedLayoutIds.has(slide.layoutId))
            .forEach((slide) => addSlideTreeWrites(slide, writes));
        }
        break;
      }

      case 'layout.create':
        reads.add(layoutCollectionKey);
        reads.add(masterEntityKey(command.layout.masterId));
        addAssetReferenceReads(command.layout.elements, command.layout.background, reads);
        writes.add(layoutCollectionKey);
        writes.add(layoutEntityKey(command.layout.id));
        writes.add(masterReferenceKey);
        writes.add(assetReferenceKey);
        command.layout.elements.forEach((element) => addElementTreeEntityWrites(element, writes));
        break;

      case 'layout.update': {
        reads.add(layoutEntityKey(command.layoutId));
        reads.add(masterEntityKey(command.replacement.masterId));
        addAssetReferenceReads(command.replacement.elements, command.replacement.background, reads);
        writes.add(layoutEntityKey(command.layoutId));
        writes.add(layoutEntityKey(command.replacement.id));
        writes.add(masterReferenceKey);
        writes.add(assetReferenceKey);
        command.replacement.elements.forEach((element) =>
          addElementTreeEntityWrites(element, writes),
        );
        document?.slides
          .filter((slide) => slide.layoutId === command.layoutId)
          .forEach((slide) => addSlideTreeWrites(slide, writes));
        break;
      }

      case 'layout.delete': {
        reads.add(layoutCollectionKey);
        reads.add(layoutEntityKey(command.layoutId));
        reads.add(layoutReferenceKey);
        writes.add(layoutCollectionKey);
        writes.add(layoutEntityKey(command.layoutId));
        writes.add(layoutReferenceKey);
        writes.add(masterReferenceKey);
        writes.add(assetReferenceKey);
        if (command.replacementLayoutId !== undefined) {
          reads.add(layoutEntityKey(command.replacementLayoutId));
        }
        const affected = document?.slides.filter((slide) => slide.layoutId === command.layoutId);
        if (affected === undefined) writes.add(deckSlideOrderKey);
        else affected.forEach((slide) => writes.add(slideEntityKey(slide.id)));
        break;
      }

      case 'slide.create':
        reads.add(deckSlideOrderKey);
        reads.add(layoutEntityKey(command.slide.layoutId));
        addAssetReferenceReads(command.slide.elements, command.slide.background, reads);
        writes.add(deckSlideOrderKey);
        writes.add(slideEntityKey(command.slide.id));
        writes.add(elementCollectionKey(command.slide.id));
        writes.add(layoutReferenceKey);
        writes.add(assetReferenceKey);
        command.slide.elements.forEach((element) =>
          addElementTreeWrites(element, command.slide.id, writes),
        );
        break;

      case 'slide.delete': {
        reads.add(deckSlideOrderKey);
        reads.add(slideEntityKey(command.slideId));
        writes.add(deckSlideOrderKey);
        writes.add(slideEntityKey(command.slideId));
        writes.add(layoutReferenceKey);
        writes.add(assetReferenceKey);
        const slide = findSlide(document, command.slideId);
        slide?.elements.forEach((element) => addElementTreeWrites(element, slide.id, writes));
        break;
      }

      case 'slide.reorder':
        reads.add(deckSlideOrderKey);
        reads.add(slideEntityKey(command.slideId));
        writes.add(deckSlideOrderKey);
        break;

      case 'slide.duplicate':
        reads.add(deckSlideOrderKey);
        reads.add(slideEntityKey(command.slideId));
        reads.add(layoutEntityKey(command.duplicate.layoutId));
        addAssetReferenceReads(command.duplicate.elements, command.duplicate.background, reads);
        writes.add(deckSlideOrderKey);
        writes.add(slideEntityKey(command.duplicate.id));
        writes.add(elementCollectionKey(command.duplicate.id));
        writes.add(layoutReferenceKey);
        writes.add(assetReferenceKey);
        command.duplicate.elements.forEach((element) =>
          addElementTreeWrites(element, command.duplicate.id, writes),
        );
        break;

      case 'slide.update':
        reads.add(slideEntityKey(command.slideId));
        writes.add(slideEntityKey(command.slideId));
        if (command.background !== undefined) {
          const assetIds = new Set<string>();
          collectBackgroundAssetId(command.background, assetIds);
          assetIds.forEach((assetId) => reads.add(assetEntityKey(assetId)));
          writes.add(assetReferenceKey);
        }
        break;

      case 'slide.set-layout':
        reads.add(slideEntityKey(command.slideId));
        reads.add(layoutEntityKey(command.layoutId));
        writes.add(slideEntityKey(command.slideId));
        writes.add(layoutReferenceKey);
        break;

      case 'slide.reset-placeholder': {
        const slide = findSlide(document, command.slideId);
        reads.add(slideEntityKey(command.slideId));
        writes.add(slideEntityKey(command.slideId));
        if (slide === undefined) {
          reads.add(layoutCollectionKey);
          reads.add(masterCollectionKey);
        } else {
          reads.add(layoutEntityKey(slide.layoutId));
          const layout = document?.layouts.find((candidate) => candidate.id === slide.layoutId);
          if (layout !== undefined) reads.add(masterEntityKey(layout.masterId));
          addBoundPlaceholderAccess(slide, command.placeholderId, reads, writes);
        }
        break;
      }

      case 'slide.set-hidden':
        reads.add(slideEntityKey(command.slideId));
        writes.add(slideEntityKey(command.slideId));
        break;

      case 'element.insert': {
        const collectionKey = elementCollectionKey(command.slideId, command.containerId);
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(collectionKey);
        const assetIds = new Set<string>();
        collectElementAssetIds(command.element, assetIds);
        assetIds.forEach((assetId) => reads.add(assetEntityKey(assetId)));
        writes.add(collectionKey);
        if (assetIds.size > 0) writes.add(assetReferenceKey);
        addElementTreeWrites(command.element, command.slideId, writes);
        break;
      }

      case 'element.update':
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(elementEntityKey(command.elementId));
        writes.add(elementEntityKey(command.elementId));
        writes.add(assetReferenceKey);
        addExistingElementTreeWrites(document, command.slideId, [command.elementId], writes);
        addElementTreeWrites(command.replacement, command.slideId, writes);
        {
          const assetIds = new Set<string>();
          collectElementAssetIds(command.replacement, assetIds);
          assetIds.forEach((assetId) => reads.add(assetEntityKey(assetId)));
        }
        break;

      case 'element.delete': {
        const collectionKey = elementCollectionKey(command.slideId, command.containerId);
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(collectionKey);
        addElementReads(command.elementIds, reads);
        writes.add(collectionKey);
        writes.add(assetReferenceKey);
        addElementWrites(command.elementIds, writes);
        addExistingElementTreeWrites(document, command.slideId, command.elementIds, writes);
        break;
      }

      case 'element.transform': {
        const elementIds = command.transforms.map((transform) => transform.elementId);
        addContainerReads(command.slideId, command.containerId, reads);
        addElementReads(elementIds, reads);
        addElementWrites(elementIds, writes);
        break;
      }

      case 'element.align':
      case 'element.distribute':
        addContainerReads(command.slideId, command.containerId, reads);
        addElementReads(command.elementIds, reads);
        addElementWrites(command.elementIds, writes);
        if (command.relativeTo === 'container' && command.containerId === undefined) {
          reads.add(deckPageKey);
        }
        break;

      case 'element.group': {
        const collectionKey = elementCollectionKey(command.slideId, command.containerId);
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(collectionKey);
        addElementReads(command.elementIds, reads);
        writes.add(collectionKey);
        addElementWrites(command.elementIds, writes);
        writes.add(elementEntityKey(command.groupId));
        writes.add(elementCollectionKey(command.slideId, command.groupId));
        break;
      }

      case 'element.ungroup': {
        const collectionKey = elementCollectionKey(command.slideId, command.containerId);
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(collectionKey);
        reads.add(elementEntityKey(command.groupId));
        writes.add(collectionKey);
        writes.add(elementEntityKey(command.groupId));
        writes.add(elementCollectionKey(command.slideId, command.groupId));
        break;
      }

      case 'element.update-style':
      case 'element.set-locked':
      case 'element.set-visible':
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(elementEntityKey(command.elementId));
        writes.add(elementEntityKey(command.elementId));
        break;

      case 'element.reorder': {
        const collectionKey = elementCollectionKey(command.slideId, command.containerId);
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(collectionKey);
        reads.add(elementEntityKey(command.elementId));
        writes.add(collectionKey);
        writes.add(elementEntityKey(command.elementId));
        break;
      }

      case 'text.replace-content':
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(elementEntityKey(command.textId));
        writes.add(elementEntityKey(command.textId));
        break;

      case 'table.insert-row':
      case 'table.delete-row':
      case 'table.insert-column':
      case 'table.delete-column':
      case 'table.update-cell':
      case 'table.update-style':
      case 'table.paste-tsv':
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(elementEntityKey(command.tableId));
        writes.add(elementEntityKey(command.tableId));
        break;

      case 'asset.register':
        reads.add(assetCollectionKey);
        writes.add(assetCollectionKey);
        writes.add(assetEntityKey(command.asset.id));
        break;

      case 'asset.remove':
        reads.add(assetCollectionKey);
        reads.add(assetEntityKey(command.assetId));
        reads.add(assetReferenceKey);
        writes.add(assetCollectionKey);
        writes.add(assetEntityKey(command.assetId));
        break;

      case 'connector.update-endpoint':
        addContainerReads(command.slideId, command.containerId, reads);
        reads.add(elementEntityKey(command.connectorId));
        if (command.value.binding.elementId !== undefined) {
          reads.add(elementEntityKey(command.value.binding.elementId));
        }
        writes.add(elementEntityKey(command.connectorId));
        break;

      default:
        assertNever(command);
    }
  });

  return {
    readSet: [...reads].sort(compareKeys),
    writeSet: [...writes].sort(compareKeys),
  };
};
