import {
  parseDeck,
  resolveSlide,
  type DeckDocument,
  type DeckDocumentInput,
  type Element,
  type ResolvedSlide,
  type Slide,
} from '@htmllelujah/document-core';
import { RENDERER_CSS, SlideSurface, formatNumber, formatPoint } from '@htmllelujah/renderer';
import { renderToStaticMarkup } from 'react-dom/server';

import { createDataAssetResolver } from './assets.js';
import { buildHtmlDocument, escapeHtmlAttribute, escapeHtmlText } from './html.js';
import { PRINT_READINESS_SCRIPT, STANDALONE_VIEWER_SCRIPT } from './scripts.js';
import type {
  BaseHtmlExportOptions,
  ExportAssets,
  HiddenSlidePolicy,
  PrintHtmlOptions,
  StandaloneHtmlOptions,
} from './types.js';
import { ExporterError } from './types.js';

const TITLE_LIMIT = 512;

const STANDALONE_CSS = `${RENDERER_CSS}
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #101318; }
body { color: #ffffff; font-family: system-ui, sans-serif; }
.hl-export-viewer { position: relative; width: 100%; height: 100%; background: #101318; }
.hl-export-stage { width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden; }
.hl-export-slide { grid-area: 1 / 1; display: grid; place-items: center; width: 100%; height: 100%; overflow: hidden; }
.hl-export-slide[hidden] { display: none !important; }
.hl-export-empty { margin: auto; color: #cbd2dc; font-size: 16px; }
.hl-export-controls { position: fixed; left: 50%; bottom: max(14px, env(safe-area-inset-bottom)); z-index: 2147483647; display: flex; align-items: center; gap: 8px; transform: translateX(-50%); padding: 8px; border-radius: 12px; background: rgb(15 19 26 / 88%); box-shadow: 0 4px 24px rgb(0 0 0 / 35%); }
.hl-export-controls button { min-width: 42px; min-height: 36px; padding: 6px 10px; border: 1px solid #637089; border-radius: 7px; color: #ffffff; background: #263044; font: inherit; cursor: pointer; }
.hl-export-controls button:disabled { cursor: default; opacity: 0.45; }
.hl-export-controls button:focus-visible { outline: 3px solid #7db0ff; outline-offset: 2px; }
.hl-export-counter { min-width: 64px; text-align: center; font-variant-numeric: tabular-nums; }
@media print { .hl-export-controls { display: none !important; } }
`;

const printCss = (document: DeckDocument): string => `${RENDERER_CSS}
@page { size: ${formatPoint(document.page.widthPt)} ${formatPoint(document.page.heightPt)}; margin: 0; }
html, body { margin: 0; padding: 0; width: ${formatPoint(document.page.widthPt)}; background: #ffffff; }
body, .hl-print-root, .hl-print-page, .hl-slide-surface { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
.hl-print-root { margin: 0; padding: 0; }
.hl-print-page { position: relative; box-sizing: border-box; width: ${formatPoint(document.page.widthPt)}; height: ${formatPoint(document.page.heightPt)}; margin: 0; padding: 0; overflow: hidden; break-after: page; page-break-after: always; }
.hl-print-page:last-child { break-after: auto; page-break-after: auto; }
.hl-print-page .hl-slide-surface { break-after: auto !important; page-break-after: auto !important; }
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function assertOptions(
  options: unknown,
  allowedKeys: readonly string[],
): asserts options is Record<string, unknown> {
  if (!isRecord(options) || Object.keys(options).some((key) => !allowedKeys.includes(key))) {
    throw new ExporterError('INVALID_REQUEST', 'Export options are invalid.');
  }
}

const hiddenPolicy = (document: DeckDocument, requested: unknown): HiddenSlidePolicy => {
  if (requested === undefined) {
    return document.settings.includeHiddenSlidesInExport ? 'include' : 'exclude';
  }
  if (requested !== 'include' && requested !== 'exclude') {
    throw new ExporterError('INVALID_REQUEST', 'The hidden-slide policy is invalid.');
  }
  return requested;
};

const exportTitle = (document: DeckDocument, requested: unknown): string => {
  if (requested === undefined) return document.name;
  if (typeof requested !== 'string' || requested.length > TITLE_LIMIT) {
    throw new ExporterError('INVALID_REQUEST', 'The export title is invalid.');
  }
  return requested;
};

const parseDocument = (input: DeckDocumentInput): DeckDocument => {
  try {
    return parseDeck(input);
  } catch {
    throw new ExporterError('INVALID_REQUEST', 'The deck could not be validated for export.');
  }
};

const eligibleSlides = (document: DeckDocument, policy: HiddenSlidePolicy): readonly Slide[] =>
  policy === 'include' ? document.slides : document.slides.filter((slide) => !slide.hidden);

const collectElementAssetIds = (element: Element, output: Set<string>): void => {
  if (element.type === 'image') output.add(element.assetId);
  if (element.type === 'group') {
    for (const child of element.children) collectElementAssetIds(child, output);
  }
};

const collectProjectionAssetIds = (projection: ResolvedSlide, output: Set<string>): void => {
  if (projection.background.type === 'image') output.add(projection.background.assetId);
  for (const resolved of projection.elements) collectElementAssetIds(resolved.element, output);
};

const prepareProjections = (
  input: DeckDocumentInput,
  assets: ExportAssets,
  policyInput: unknown,
): Readonly<{
  document: DeckDocument;
  projections: readonly ResolvedSlide[];
  resolveAsset: (assetId: string) => string | null;
}> => {
  const document = parseDocument(input);
  const policy = hiddenPolicy(document, policyInput);
  const slides = eligibleSlides(document, policy);
  let projections: readonly ResolvedSlide[];
  try {
    projections = slides.map((slide) => resolveSlide(document, slide.id));
  } catch {
    throw new ExporterError('INVALID_REQUEST', 'A slide could not be resolved for export.');
  }
  const requiredAssets = new Set<string>();
  for (const projection of projections) collectProjectionAssetIds(projection, requiredAssets);
  const resolveAsset = createDataAssetResolver(document, assets, requiredAssets);
  return { document, projections, resolveAsset };
};

const renderProjection = (
  projection: ResolvedSlide,
  mode: 'html' | 'pdf',
  resolveAsset: (assetId: string) => string | null,
): string => {
  try {
    return renderToStaticMarkup(
      <SlideSurface slide={projection} mode={mode} resolveAsset={resolveAsset} />,
    );
  } catch {
    throw new ExporterError('EXPORT_FAILED', 'The shared renderer could not create export markup.');
  }
};

export const createStandaloneHtml = (
  deck: DeckDocumentInput,
  assets: ExportAssets,
  options: StandaloneHtmlOptions = {},
): string => {
  assertOptions(options, ['hiddenSlides', 'title', 'startSlideId', 'clickNavigation']);
  if (options.clickNavigation !== undefined && typeof options.clickNavigation !== 'boolean') {
    throw new ExporterError('INVALID_REQUEST', 'The click-navigation option is invalid.');
  }
  if (options.startSlideId !== undefined && typeof options.startSlideId !== 'string') {
    throw new ExporterError('INVALID_REQUEST', 'The starting slide is invalid.');
  }
  const prepared = prepareProjections(deck, assets, options.hiddenSlides);
  const title = exportTitle(prepared.document, options.title);
  const startIndex =
    options.startSlideId === undefined
      ? 0
      : prepared.projections.findIndex(
          (projection) => projection.slide.id === options.startSlideId,
        );
  if (options.startSlideId !== undefined && startIndex < 0) {
    throw new ExporterError('NOT_FOUND', 'The requested starting slide is not exportable.');
  }
  const slides = prepared.projections
    .map((projection, index) => {
      const active = index === startIndex;
      const markup = renderProjection(projection, 'html', prepared.resolveAsset);
      return `<section class="hl-export-slide" data-export-slide="${index}" data-testid="export-slide" aria-hidden="${active ? 'false' : 'true'}"${active ? '' : ' hidden'}>${markup}</section>`;
    })
    .join('\n');
  const count = prepared.projections.length;
  const body = `<main class="hl-export-viewer" data-htmllelujah-viewer="true" data-testid="presentation-root" data-start-index="${Math.max(0, startIndex)}" data-click-navigation="${options.clickNavigation === false ? 'false' : 'true'}" aria-label="${escapeHtmlAttribute(title)}">
  <div class="hl-export-stage" data-export-stage="true">${slides || '<p class="hl-export-empty">No slides to present.</p>'}</div>
  <nav class="hl-export-controls" aria-label="Presentation controls">
    <button type="button" data-action="previous" aria-label="Previous slide"${count === 0 || startIndex === 0 ? ' disabled' : ''}>‹</button>
    <output class="hl-export-counter" data-slide-counter="true" aria-live="polite">${count === 0 ? '0 / 0' : `${startIndex + 1} / ${count}`}</output>
    <button type="button" data-action="next" aria-label="Next slide"${count === 0 || startIndex === count - 1 ? ' disabled' : ''}>›</button>
    <button type="button" data-action="fullscreen" aria-label="Toggle fullscreen">⛶</button>
  </nav>
</main>`;
  return buildHtmlDocument({
    kind: 'standalone',
    locale: prepared.document.metadata.locale,
    title,
    css: STANDALONE_CSS,
    script: STANDALONE_VIEWER_SCRIPT,
    body,
  });
};

export const createPrintHtml = (
  deck: DeckDocumentInput,
  assets: ExportAssets,
  options: PrintHtmlOptions = {},
): string => {
  assertOptions(options, ['hiddenSlides', 'title', 'readinessDeadlineMs']);
  const requestedDeadline: unknown = options.readinessDeadlineMs;
  const deadline = requestedDeadline ?? 10_000;
  if (
    typeof deadline !== 'number' ||
    !Number.isInteger(deadline) ||
    deadline < 100 ||
    deadline > 60_000
  ) {
    throw new ExporterError('INVALID_REQUEST', 'The readiness deadline is invalid.');
  }
  const prepared = prepareProjections(deck, assets, options.hiddenSlides);
  if (prepared.projections.length === 0) {
    throw new ExporterError(
      'INVALID_REQUEST',
      'Print export requires at least one eligible slide.',
    );
  }
  const title = exportTitle(prepared.document, options.title);
  const pages = prepared.projections
    .map((projection, index) => {
      const markup = renderProjection(projection, 'pdf', prepared.resolveAsset);
      return `<section class="hl-print-page" data-print-page="${index}" data-testid="page-root">${markup}</section>`;
    })
    .join('\n');
  const body = `<main class="hl-print-root" data-print-root="true" data-testid="print-root">${pages}</main>`;
  return buildHtmlDocument({
    kind: 'print',
    locale: prepared.document.metadata.locale,
    title,
    css: printCss(prepared.document),
    script: PRINT_READINESS_SCRIPT,
    body,
    htmlDataAttributes: {
      'render-ready': 'pending',
      'readiness-deadline-ms': String(deadline),
      'page-count': String(prepared.projections.length),
      'page-width-pt': formatNumber(prepared.document.page.widthPt),
      'page-height-pt': formatNumber(prepared.document.page.heightPt),
      testid: 'render-ready-state',
    },
  });
};
