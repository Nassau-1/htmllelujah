import type {
  BackgroundStyle,
  DeckDocument,
  Element,
  Layout,
  Master,
  RichTextDocument,
  Slide,
} from '@htmllelujah/document-core';

import type { ExportLimits } from './limits.js';
import { ExporterError } from './types.js';

export interface ProjectionBudget {
  readonly requiredAssetIds: ReadonlySet<string>;
  readonly assetOccurrences: ReadonlyMap<string, number>;
  readonly elementOccurrences: number;
  readonly projectedContentBytes: number;
}

interface MutableBudget {
  elementOccurrences: number;
  projectedContentBytes: number;
  readonly assetOccurrences: Map<string, number>;
}

const failLimit = (): never => {
  throw new ExporterError('EXPORT_LIMIT_EXCEEDED', 'The export exceeds a representability limit.');
};

const checkedAdd = (current: number, increment: number, limit: number): number => {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    current > limit - increment
  ) {
    return failLimit();
  }
  return current + increment;
};

const escapedTextBytes = (value: string): number => {
  let bytes = Buffer.byteLength(value, 'utf8');
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character === 0x26) bytes += 4;
    else if (character === 0x3c || character === 0x3e) bytes += 3;
  }
  return bytes;
};

const escapedAttributeBytes = (value: string): number => {
  let bytes = Buffer.byteLength(value, 'utf8');
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character === 0x26) bytes += 4;
    else if (character === 0x3c || character === 0x3e) bytes += 3;
    else if (character === 0x22 || character === 0x27) bytes += 5;
  }
  return bytes;
};

const richTextBytes = (content: RichTextDocument): number => {
  let total = 0;
  for (const block of content.blocks) {
    const addRuns = (runs: readonly { readonly text: string }[]): void => {
      for (const run of runs) {
        const bytes = escapedTextBytes(run.text);
        if (!Number.isSafeInteger(bytes) || total > Number.MAX_SAFE_INTEGER - bytes) failLimit();
        total += bytes;
      }
    };
    if (block.type === 'list') {
      for (const item of block.items) addRuns(item.runs);
    } else {
      addRuns(block.runs);
    }
  }
  return total;
};

const addContent = (budget: MutableBudget, bytes: number, limits: ExportLimits): void => {
  budget.projectedContentBytes = checkedAdd(
    budget.projectedContentBytes,
    bytes,
    limits.maxProjectedContentBytes,
  );
};

const addAssetOccurrence = (budget: MutableBudget, assetId: string): void => {
  const current = budget.assetOccurrences.get(assetId) ?? 0;
  if (current === Number.MAX_SAFE_INTEGER) failLimit();
  budget.assetOccurrences.set(assetId, current + 1);
};

const hasFixedRenderableElement = (element: Element): boolean => {
  if (element.type === 'placeholder') return false;
  if (element.type !== 'group') return true;
  return element.children.some(hasFixedRenderableElement);
};

const measureElement = (
  element: Element,
  budget: MutableBudget,
  limits: ExportLimits,
  stripTemplatePlaceholders: boolean,
): boolean => {
  if (stripTemplatePlaceholders && element.type === 'placeholder') return false;

  if (element.type === 'group' && stripTemplatePlaceholders) {
    if (!hasFixedRenderableElement(element)) return false;
    budget.elementOccurrences = checkedAdd(
      budget.elementOccurrences,
      1,
      limits.maxProjectedElementOccurrences,
    );
    for (const child of element.children) measureElement(child, budget, limits, true);
    return true;
  }

  budget.elementOccurrences = checkedAdd(
    budget.elementOccurrences,
    1,
    limits.maxProjectedElementOccurrences,
  );
  if (element.type === 'group') {
    for (const child of element.children) measureElement(child, budget, limits, false);
  } else if (element.type === 'text') {
    addContent(budget, richTextBytes(element.content), limits);
  } else if (element.type === 'table') {
    addContent(budget, escapedAttributeBytes(element.name), limits);
    for (const cell of element.cells) addContent(budget, richTextBytes(cell.content), limits);
  } else if (element.type === 'image') {
    addContent(budget, escapedAttributeBytes(element.altText), limits);
    addAssetOccurrence(budget, element.assetId);
  }
  return true;
};

const requiredLayout = (document: DeckDocument, slide: Slide): Layout => {
  const layout = document.layouts.find((candidate) => candidate.id === slide.layoutId);
  if (layout === undefined) {
    throw new ExporterError('INVALID_REQUEST', 'A slide could not be resolved for export.');
  }
  return layout;
};

const requiredMaster = (document: DeckDocument, layout: Layout): Master => {
  const master = document.masters.find((candidate) => candidate.id === layout.masterId);
  if (master === undefined) {
    throw new ExporterError('INVALID_REQUEST', 'A slide could not be resolved for export.');
  }
  return master;
};

const resolvedBackground = (
  document: DeckDocument,
  slide: Slide,
  layout: Layout,
  master: Master,
): BackgroundStyle =>
  slide.background ?? layout.background ?? master.background ?? document.settings.defaultBackground;

export const preflightProjectionBudget = (
  document: DeckDocument,
  slides: readonly Slide[],
  limits: ExportLimits,
): ProjectionBudget => {
  const budget: MutableBudget = {
    elementOccurrences: 0,
    projectedContentBytes: 0,
    assetOccurrences: new Map(),
  };

  for (const slide of slides) {
    const layout = requiredLayout(document, slide);
    const master = requiredMaster(document, layout);
    const background = resolvedBackground(document, slide, layout, master);
    if (background.type === 'image') addAssetOccurrence(budget, background.assetId);
    for (const element of master.elements) measureElement(element, budget, limits, true);
    for (const element of layout.elements) measureElement(element, budget, limits, true);
    for (const element of slide.elements) measureElement(element, budget, limits, false);
  }

  return Object.freeze({
    requiredAssetIds: new Set(budget.assetOccurrences.keys()),
    assetOccurrences: new Map(budget.assetOccurrences),
    elementOccurrences: budget.elementOccurrences,
    projectedContentBytes: budget.projectedContentBytes,
  });
};
