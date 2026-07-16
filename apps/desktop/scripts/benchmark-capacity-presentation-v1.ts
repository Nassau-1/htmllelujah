import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createDefaultDeck,
  createDuplicateSlide,
  DOCUMENT_LIMITS,
  parseDeck,
  resolveSlideFromValidatedDocument,
  type DeckDocument,
  type Element,
  type ShapeElement,
} from '@htmllelujah/document-core';
import { SlideSurface } from '@htmllelujah/renderer';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const PRESENTATION_THRESHOLD_MS = 100;
const PRESENTATION_WARMUP_SAMPLES = 25;
const PRESENTATION_MEASURED_SAMPLES = 200;

const percentile = (samples: readonly number[], quantile: number): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
};

const rounded = (value: number): number => Math.round(value * 100) / 100;

const deterministicIdFactory = (): (() => string) => {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `70000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`;
  };
};

const removePlaceholderBinding = (element: Element): Element => {
  const { placeholderBinding: _placeholderBinding, ...unbound } = element;
  return unbound as Element;
};

const createCapacityShape = (
  id: string,
  slideIndex: number,
  elementIndex: number,
): ShapeElement => ({
  id,
  name: `Capacity shape ${slideIndex + 1}-${elementIndex + 1}`,
  type: 'shape',
  frame: {
    xPt: 36 + (elementIndex % 6) * 150,
    yPt: 42 + Math.floor(elementIndex / 6) * 120,
    widthPt: 120,
    heightPt: 80,
    rotationDeg: 0,
  },
  opacity: 1,
  visible: true,
  locked: false,
  shape: elementIndex % 2 === 0 ? 'rectangle' : 'rounded-rectangle',
  fill: elementIndex % 2 === 0 ? '#EAF0FF' : '#F4F6F8',
  stroke: { color: '#2F6BFF', widthPt: 1, dash: 'solid' },
  cornerRadiusPt: elementIndex % 2 === 0 ? 0 : 8,
});

const buildSupportedCapacityDeck = (): DeckDocument => {
  const idFactory = deterministicIdFactory();
  const raw = createDefaultDeck({
    idFactory,
    now: () => '2026-07-16T00:00:00.000Z',
    name: '500 slide, 10,000 element capacity fixture',
  });
  const firstSlide = raw.slides[0];
  if (firstSlide === undefined) throw new Error('The capacity fixture has no source slide.');

  // Capacity is spent on slide content rather than template placeholders so the fixture
  // exercises exactly 10,000 visible presentation elements.
  const initial: DeckDocument = {
    ...raw,
    layouts: raw.layouts.map((layout) => ({ ...layout, elements: [] })),
    slides: [
      {
        ...firstSlide,
        elements: firstSlide.elements.map(removePlaceholderBinding),
      },
    ],
  };
  const slides = [...initial.slides];
  for (let index = 1; index < DOCUMENT_LIMITS.maxSlides; index += 1) {
    slides.push(
      createDuplicateSlide(initial, firstSlide.id, idFactory, `Capacity slide ${index + 1}`),
    );
  }

  const baseElementsPerSlide = Math.floor(DOCUMENT_LIMITS.maxElements / slides.length);
  const slidesWithExtraElement = DOCUMENT_LIMITS.maxElements % slides.length;
  return {
    ...initial,
    slides: slides.map((slide, slideIndex) => {
      const targetElementCount =
        baseElementsPerSlide + (slideIndex < slidesWithExtraElement ? 1 : 0);
      const missingElements = targetElementCount - slide.elements.length;
      if (missingElements < 0) {
        throw new Error('The source slide already exceeds its capacity allocation.');
      }
      return {
        ...slide,
        elements: [
          ...slide.elements,
          ...Array.from({ length: missingElements }, (_, index) =>
            createCapacityShape(idFactory(), slideIndex, index),
          ),
        ],
      };
    }),
  };
};

const countElementTree = (element: Element): number =>
  1 +
  (element.type === 'group'
    ? element.children.reduce((sum, child) => sum + countElementTree(child), 0)
    : 0);

const countElements = (document: DeckDocument): number =>
  [...document.masters, ...document.layouts, ...document.slides].reduce(
    (total, container) =>
      total + container.elements.reduce((sum, element) => sum + countElementTree(element), 0),
    0,
  );

const benchmarkPresentationNavigation = (
  document: DeckDocument,
): {
  readonly warmupSamples: number;
  readonly measuredSamples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly thresholdMs: number;
  readonly passed: boolean;
  readonly renderedBytes: number;
} => {
  const durations: number[] = [];
  let renderedBytes = 0;
  const totalSamples = PRESENTATION_WARMUP_SAMPLES + PRESENTATION_MEASURED_SAMPLES;
  for (let index = 0; index < totalSamples; index += 1) {
    const slide = document.slides[index % document.slides.length];
    if (slide === undefined) throw new Error('The presentation fixture has no visible slide.');
    const startedAt = performance.now();
    const projection = resolveSlideFromValidatedDocument(document, slide.id);
    const markup = renderToStaticMarkup(
      createElement(SlideSurface, { slide: projection, mode: 'presentation' }),
    );
    const durationMs = performance.now() - startedAt;
    if (!markup.includes(`data-slide-id="${slide.id}"`)) {
      throw new Error(`Presentation rendering did not materialize slide ${slide.id}.`);
    }
    renderedBytes += Buffer.byteLength(markup, 'utf8');
    if (index >= PRESENTATION_WARMUP_SAMPLES) durations.push(durationMs);
  }

  const p95Ms = rounded(percentile(durations, 0.95));
  return {
    warmupSamples: PRESENTATION_WARMUP_SAMPLES,
    measuredSamples: durations.length,
    p50Ms: rounded(percentile(durations, 0.5)),
    p95Ms,
    maxMs: rounded(Math.max(...durations)),
    thresholdMs: PRESENTATION_THRESHOLD_MS,
    passed: p95Ms < PRESENTATION_THRESHOLD_MS,
    renderedBytes,
  };
};

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0 && process.argv[outputIndex + 1] === undefined) {
  throw new Error('--output requires a path.');
}
const outputPath = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];

const fixtureHeapBefore = process.memoryUsage().heapUsed;
const fixtureStartedAt = performance.now();
const fixture = buildSupportedCapacityDeck();
const fixtureBuildMs = performance.now() - fixtureStartedAt;
const fixtureHeapDeltaBytes = process.memoryUsage().heapUsed - fixtureHeapBefore;

const validationStartedAt = performance.now();
const document = parseDeck(fixture);
const validationMs = performance.now() - validationStartedAt;
const elementCount = countElements(document);
const capacityPassed =
  document.slides.length === DOCUMENT_LIMITS.maxSlides &&
  elementCount === DOCUMENT_LIMITS.maxElements;
const presentationNavigation = benchmarkPresentationNavigation(document);

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  evidenceScope: {
    kind: 'source-benchmark',
    productPath:
      'resolveSlideFromValidatedDocument -> SlideSurface(mode=presentation) -> React markup',
    includes:
      'The synchronous projection and shared renderer component used by PresentationWindow after its validated runtime snapshot and assets are ready.',
    excludes:
      'Packaged Electron input dispatch, React DOM reconciliation, browser layout, paint, compositor, display refresh, and asset loading.',
  },
  fixture: {
    slides: document.slides.length,
    elements: elementCount,
    elementsPerSlideMin: Math.min(...document.slides.map((slide) => slide.elements.length)),
    elementsPerSlideMax: Math.max(...document.slides.map((slide) => slide.elements.length)),
    assets: document.assets.length,
    assetsReady: document.assets.length === 0,
    buildMs: rounded(fixtureBuildMs),
    heapDeltaBytes: fixtureHeapDeltaBytes,
  },
  capacity: {
    slideLimit: DOCUMENT_LIMITS.maxSlides,
    elementLimit: DOCUMENT_LIMITS.maxElements,
    validationMs: rounded(validationMs),
    passed: capacityPassed,
  },
  presentationNavigation,
};

if (!result.capacity.passed) {
  throw new Error(
    `Capacity fixture mismatch: got ${result.fixture.slides} slides and ${result.fixture.elements} elements.`,
  );
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath !== undefined) {
  const absoluteOutput = path.resolve(outputPath);
  await mkdir(path.dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, serialized, { encoding: 'utf8', flag: 'w' });
}
process.stdout.write(serialized);
if (!result.presentationNavigation.passed) process.exitCode = 1;
