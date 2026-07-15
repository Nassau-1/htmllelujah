import { DOCUMENT_LIMITS } from './limits.js';
import type { DeckDocument, Element, RichTextDocument, Slide, TableCell } from './model.js';
import type { IdFactory } from './styles.js';

const cloneRichText = (content: RichTextDocument, idFactory: IdFactory): RichTextDocument => ({
  blocks: content.blocks.map((block) =>
    block.type === 'list'
      ? {
          ...block,
          id: idFactory(),
          items: block.items.map((item) => ({ ...item, id: idFactory() })),
        }
      : { ...block, id: idFactory() },
  ),
});

const collectElementIds = (
  elements: readonly Element[],
  idFactory: IdFactory,
  output = new Map<string, string>(),
): ReadonlyMap<string, string> => {
  for (const element of elements) {
    output.set(element.id, idFactory());
    if (element.type === 'group') collectElementIds(element.children, idFactory, output);
  }
  return output;
};

const cloneCell = (cell: TableCell, idFactory: IdFactory): TableCell => ({
  ...cell,
  id: idFactory(),
  content: cloneRichText(cell.content, idFactory),
});

const cloneElement = (
  element: Element,
  idMap: ReadonlyMap<string, string>,
  idFactory: IdFactory,
): Element => {
  const id = idMap.get(element.id);
  if (id === undefined) throw new Error(`Missing cloned identifier for element ${element.id}.`);
  switch (element.type) {
    case 'text':
      return { ...element, id, content: cloneRichText(element.content, idFactory) };
    case 'table':
      return { ...element, id, cells: element.cells.map((cell) => cloneCell(cell, idFactory)) };
    case 'connector': {
      const rebind = (elementId: string | undefined): string | undefined =>
        elementId === undefined ? undefined : (idMap.get(elementId) ?? elementId);
      return {
        ...element,
        id,
        start: {
          ...element.start,
          binding: {
            ...element.start.binding,
            elementId: rebind(element.start.binding.elementId),
          },
        },
        end: {
          ...element.end,
          binding: {
            ...element.end.binding,
            elementId: rebind(element.end.binding.elementId),
          },
        },
      };
    }
    case 'group':
      return {
        ...element,
        id,
        children: element.children.map((child) => cloneElement(child, idMap, idFactory)),
      };
    case 'image':
    case 'shape':
    case 'icon':
    case 'placeholder':
      return { ...element, id };
  }
};

/** Builds the deterministic payload expected by slide.duplicate, including all nested IDs. */
export const createDuplicateSlide = (
  document: DeckDocument,
  slideId: string,
  idFactory: IdFactory,
  name?: string,
): Slide => {
  const source = document.slides.find((slide) => slide.id === slideId);
  if (source === undefined) throw new Error(`Slide ${slideId} does not exist.`);
  const idMap = collectElementIds(source.elements, idFactory);
  const duplicateName = (name ?? `${source.name} copy`).slice(0, DOCUMENT_LIMITS.maxNameLength);
  return {
    ...source,
    id: idFactory(),
    name: duplicateName,
    elements: source.elements.map((element) => cloneElement(element, idMap, idFactory)),
  };
};
