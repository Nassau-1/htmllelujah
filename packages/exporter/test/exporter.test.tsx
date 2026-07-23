import { createHash } from 'node:crypto';

import * as documentCore from '@htmllelujah/document-core';
import {
  resolveSlide,
  STANDARD_PAGE_SIZES,
  type DeckDocument,
  type ImageElement,
  type TextElement,
} from '@htmllelujah/document-core';
import { RENDERER_CSS, SlideSurface } from '@htmllelujah/renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  BoundedUtf8Builder,
  EXPORT_LIMITS,
  ExporterError,
  HTMLLELUJAH_LICENSE_URL,
  HTMLLELUJAH_REQUIRED_NOTICE,
  PRINT_READINESS_SCRIPT,
  STANDALONE_VIEWER_SCRIPT,
  createDataAssetResolver,
  createPrintHtml,
  createStandaloneHtml,
  sha256Base64,
} from '../src/index.js';
import { createExportFixture } from './fixtures.js';

const scriptText = (html: string): string => {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/giu)];
  expect(matches).toHaveLength(1);
  return matches[0]?.[1] ?? '';
};

const styleText = (html: string): string => {
  const match = /<style>([\s\S]*?)<\/style>/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};

const surfaceMarkup = (html: string): string => {
  const match = /<section class="hl-slide-surface[\s\S]*?<\/section>/.exec(html);
  expect(match).not.toBeNull();
  return match?.[0] ?? '';
};

const normalizeModeMarkup = (html: string): string =>
  html
    .replace(/hl-mode-(?:editor|html|pdf)/g, 'hl-mode-COMMON')
    .replace(/data-render-mode="(?:editor|html|pdf)"/g, 'data-render-mode="COMMON"')
    .replace(/ data-locked="true"/g, '');

const inheritedProjectionFixture = (): DeckDocument => {
  const fixture = createExportFixture();
  const master = fixture.deck.masters[0];
  const layout = fixture.deck.layouts.find((candidate) => candidate.masterId === master?.id);
  const sourceText = fixture.deck.slides
    .flatMap((slide) => slide.elements)
    .find((element): element is TextElement => element.type === 'text');
  if (master === undefined || layout === undefined || sourceText === undefined) {
    throw new Error('Projection fixture is incomplete.');
  }
  const firstBlock = sourceText.content.blocks[0];
  const inheritedMarks =
    firstBlock?.type === 'list' ? firstBlock.items[0]?.runs[0]?.marks : firstBlock?.runs[0]?.marks;
  const { placeholderBinding: _placeholderBinding, ...unboundText } = sourceText;
  const inheritedText: TextElement = {
    ...unboundText,
    content: {
      blocks: [
        {
          id: '42000000-0000-4000-8000-000000000001',
          type: 'paragraph',
          alignment: 'left',
          runs: [
            {
              text: 'x',
              marks: inheritedMarks ?? {
                bold: false,
                italic: false,
                underline: false,
                strikethrough: false,
              },
            },
          ],
        },
      ],
    },
  };
  return {
    ...fixture.deck,
    masters: fixture.deck.masters.map((candidate) =>
      candidate.id === master.id ? { ...candidate, elements: [inheritedText] } : candidate,
    ),
    layouts: fixture.deck.layouts.map((candidate) =>
      candidate.id === layout.id ? { ...candidate, elements: [] } : candidate,
    ),
    slides: fixture.deck.slides.map((slide, index) => ({
      ...slide,
      layoutId: layout.id,
      hidden: index === 2,
      elements: [],
    })),
    assets: [],
  };
};

const repeatedAssetFixture = (): Readonly<{
  deck: DeckDocument;
  assets: ReadonlyMap<string, Uint8Array>;
  dataUrl: string;
}> => {
  const fixture = createExportFixture();
  const base = inheritedProjectionFixture();
  const sourceImage = fixture.deck.slides
    .flatMap((slide) => slide.elements)
    .find(
      (element): element is ImageElement =>
        element.type === 'image' && element.assetId === fixture.visibleAssetId,
    );
  const reference = fixture.deck.assets.find((asset) => asset.id === fixture.visibleAssetId);
  if (sourceImage === undefined || reference === undefined) {
    throw new Error('Asset occurrence fixture is incomplete.');
  }
  const slides = base.slides.slice(0, 2).map((slide, index) => ({
    ...slide,
    hidden: false,
    elements: [
      {
        ...sourceImage,
        id: `43000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      },
    ],
  }));
  const dataUrl = `data:${reference.mediaType};base64,${Buffer.from(fixture.visibleBytes).toString('base64')}`;
  return {
    deck: {
      ...base,
      masters: base.masters.map((master) => ({ ...master, elements: [] })),
      slides,
      assets: [reference],
    },
    assets: new Map([[fixture.visibleAssetId, fixture.visibleBytes]]),
    dataUrl,
  };
};

describe('createStandaloneHtml', () => {
  it('is deterministic, single-file, offline and contains working static controls', () => {
    const fixture = createExportFixture();
    const first = createStandaloneHtml(fixture.deck, fixture.assets);
    const second = createStandaloneHtml(fixture.deck, fixture.assets);

    expect(first).toBe(second);
    expect(first).toContain('<!doctype html>');
    expect(first).toContain('data-htmllelujah-export="standalone-v1"');
    expect(first).toContain('data-testid="presentation-root"');
    expect(first).toContain('data-action="previous"');
    expect(first).toContain('data-action="next"');
    expect(first).toContain('data-action="fullscreen"');
    expect(first).toContain('1 / 2');
    expect(first).toContain('ArrowRight');
    expect(first).toContain('requestFullscreen');
    expect(first).toContain('data-render-mode="html"');
    expect(first).toContain(HTMLLELUJAH_REQUIRED_NOTICE);
    expect(first.split(HTMLLELUJAH_LICENSE_URL)).toHaveLength(2);
    expect(first).toContain(
      'This notice applies to the viewer software, not to user presentation content.',
    );
    expect(first).toContain(
      `data:image/png;base64,${Buffer.from(fixture.visibleBytes).toString('base64')}`,
    );
    expect(first).not.toContain(Buffer.from(fixture.hiddenBytes).toString('base64'));
    expect(first).not.toContain('HIDDEN_SLIDE_SECRET');
    expect(first).not.toContain('private-visible.png');
    expect(first.replace(HTMLLELUJAH_LICENSE_URL, '')).not.toMatch(/https?:\/\//i);
    expect(first).not.toMatch(/file:\/\//i);
    expect(first).not.toMatch(/wss?:\/\//i);
    expect(first).not.toContain('serviceWorker');
    expect(first).not.toContain('window.open');
    expect(first).not.toContain('fetch(');
  });

  it('physically includes hidden slides and their assets only on opt-in', () => {
    const fixture = createExportFixture();
    const html = createStandaloneHtml(fixture.deck, fixture.assets, {
      hiddenSlides: 'include',
      startSlideId: fixture.deck.slides[2]?.id,
      clickNavigation: false,
    });

    expect(html).toContain('HIDDEN_SLIDE_SECRET');
    expect(html).toContain(Buffer.from(fixture.hiddenBytes).toString('base64'));
    expect(html).toContain('data-start-index="2"');
    expect(html).toContain('data-click-navigation="false"');
    expect(html).toContain('3 / 3');
  });

  it('does not require an asset used only by an excluded hidden slide', () => {
    const fixture = createExportFixture();
    const visibleOnly = new Map([[fixture.visibleAssetId, fixture.visibleBytes]]);

    expect(() => createStandaloneHtml(fixture.deck, visibleOnly)).not.toThrow();
    expect(() =>
      createStandaloneHtml(fixture.deck, visibleOnly, { hiddenSlides: 'include' }),
    ).toThrowError(ExporterError);
  });

  it('escapes hostile document strings outside the sole static script', () => {
    const fixture = createExportFixture();
    const html = createStandaloneHtml(fixture.deck, fixture.assets);

    expect(scriptText(html)).toBe(STANDALONE_VIEWER_SCRIPT);
    expect(html).toContain(
      '&lt;/script&gt;&lt;script&gt;globalThis.compromised=true&lt;/script&gt;',
    );
    expect(html).toContain(
      '<title>Deck &lt;/title&gt;&lt;script&gt;unsafe&lt;/script&gt; &amp; Unicode 😀</title>',
    );
    expect(html).not.toContain('<script>globalThis.compromised');
    expect(html).toContain('&quot; onerror=&quot;globalThis.compromised=true');
  });

  it('hashes the exact sole viewer script and exact inline stylesheet in a restrictive CSP', () => {
    const fixture = createExportFixture();
    const html = createStandaloneHtml(fixture.deck, fixture.assets);
    const script = scriptText(html);
    const css = styleText(html);

    expect(html).toContain(`sha256-${sha256Base64(script)}`);
    expect(html).toContain(`sha256-${sha256Base64(css)}`);
    expect(html).toContain('default-src &#39;none&#39;');
    expect(html).toContain('connect-src &#39;none&#39;');
    expect(html).toContain('script-src-attr &#39;none&#39;');
    expect(html).toContain('style-src-attr &#39;unsafe-inline&#39;');
    expect(html).toContain('img-src data:');
    expect(html).not.toContain('unsafe-eval');
    expect(html.match(/<script>/giu)).toHaveLength(1);
  });

  it('rejects unknown options and a non-exportable starting slide', () => {
    const fixture = createExportFixture();

    expect(() =>
      createStandaloneHtml(fixture.deck, fixture.assets, {
        startSlideId: fixture.deck.slides[2]?.id,
      }),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() =>
      createStandaloneHtml(fixture.deck, fixture.assets, {
        injectedCss: 'body{}',
      } as never),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('createPrintHtml', () => {
  it.each([
    ['widescreen', STANDARD_PAGE_SIZES.widescreen],
    ['standard', STANDARD_PAGE_SIZES.standard],
    ['a4', STANDARD_PAGE_SIZES.a4Landscape],
  ] as const)('emits exact %s page boxes, backgrounds and readiness markers', (_name, page) => {
    const fixture = createExportFixture();
    const deck = { ...fixture.deck, page };
    const html = createPrintHtml(deck, fixture.assets, { readinessDeadlineMs: 5_000 });

    expect(html).toContain(`@page { size: ${page.widthPt}pt ${page.heightPt}pt; margin: 0; }`);
    expect(html).toContain(`data-page-width-pt="${page.widthPt}"`);
    expect(html).toContain(`data-page-height-pt="${page.heightPt}"`);
    expect(html).toContain('data-page-count="2"');
    expect(html).toContain('data-render-ready="pending"');
    expect(html).toContain('data-testid="render-ready-state"');
    expect(html).toContain('data-render-mode="pdf"');
    expect(html.match(/data-testid="page-root"/g)).toHaveLength(2);
    expect(html).toContain('-webkit-print-color-adjust: exact');
    expect(html).toContain('break-after: page');
    expect(scriptText(html)).toBe(PRINT_READINESS_SCRIPT);
    expect(html).not.toContain('hl-export-controls');
  });

  it('requires at least one eligible page and validates the bounded deadline', () => {
    const fixture = createExportFixture();
    const allHidden = {
      ...fixture.deck,
      slides: fixture.deck.slides.map((slide) => ({ ...slide, hidden: true })),
    };

    expect(() => createPrintHtml(allHidden, fixture.assets)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() =>
      createPrintHtml(fixture.deck, fixture.assets, { readinessDeadlineMs: 0 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});

describe('shared renderer parity', () => {
  it('uses byte-identical SlideSurface markup in HTML and PDF modes', () => {
    const fixture = createExportFixture();
    const projection = resolveSlide(fixture.deck, fixture.deck.slides[0]?.id ?? '');
    const required = new Set([fixture.visibleAssetId]);
    const resolver = createDataAssetResolver(fixture.deck, fixture.assets, required);
    const directHtml = renderToStaticMarkup(
      <SlideSurface slide={projection} mode="html" resolveAsset={resolver} />,
    );
    const directPdf = renderToStaticMarkup(
      <SlideSurface slide={projection} mode="pdf" resolveAsset={resolver} />,
    );
    const directEditor = renderToStaticMarkup(
      <SlideSurface slide={projection} mode="editor" resolveAsset={resolver} />,
    );
    const standalone = createStandaloneHtml(fixture.deck, fixture.assets);
    const print = createPrintHtml(fixture.deck, fixture.assets);

    expect(surfaceMarkup(standalone)).toBe(directHtml);
    expect(surfaceMarkup(print)).toBe(directPdf);
    expect(normalizeModeMarkup(directHtml)).toBe(normalizeModeMarkup(directPdf));
    expect(normalizeModeMarkup(directHtml)).toBe(normalizeModeMarkup(directEditor));
    expect(styleText(standalone)).toContain(RENDERER_CSS.trim());
  });
});

describe('asset integrity', () => {
  it('rejects missing, undeclared, corrupted and non-raster assets with safe errors', () => {
    const fixture = createExportFixture();
    expect(() => createStandaloneHtml(fixture.deck, new Map())).toThrowError(
      expect.objectContaining({ code: 'ASSET_INVALID' }),
    );
    expect(() =>
      createStandaloneHtml(
        fixture.deck,
        new Map([[fixture.visibleAssetId, new Uint8Array([0x89, 0x50, 0x4e, 0x47])]]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ASSET_LIMIT_EXCEEDED' }));
    expect(() =>
      createStandaloneHtml(
        fixture.deck,
        new Map([
          ...fixture.assets,
          ['50000000-0000-4000-8000-000000000001', fixture.visibleBytes],
        ]),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ASSET_INVALID' }));
    const svgDeck = {
      ...fixture.deck,
      assets: fixture.deck.assets.map((asset) =>
        asset.id === fixture.visibleAssetId ? { ...asset, mediaType: 'image/svg+xml' } : asset,
      ),
    };
    expect(() => createStandaloneHtml(svgDeck, fixture.assets)).toThrowError(
      expect.objectContaining({ code: 'ASSET_INVALID' }),
    );
  });

  it('never exposes asset identifiers, filenames or bytes in diagnostics', () => {
    const fixture = createExportFixture();
    let failure: unknown;
    try {
      createStandaloneHtml(fixture.deck, new Map());
    } catch (error: unknown) {
      failure = error;
    }
    const serialized = JSON.stringify(failure, Object.getOwnPropertyNames(failure as object));
    expect(serialized).not.toContain(fixture.visibleAssetId);
    expect(serialized).not.toContain('private-visible.png');
    expect(serialized).not.toContain(Buffer.from(fixture.visibleBytes).toString('base64'));
  });
});

describe('bounded export representability', () => {
  it('parses the document once and resolves every eligible slide from that validation', () => {
    const fixture = createExportFixture();
    const parse = vi.spyOn(documentCore, 'parseDeck');
    try {
      createStandaloneHtml(fixture.deck, fixture.assets);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('counts inherited element and escaped-text occurrences before standalone or print render', () => {
    const deck = inheritedProjectionFixture();

    expect(() =>
      createStandaloneHtml(
        deck,
        new Map(),
        {},
        {
          maxProjectedElementOccurrences: 2,
          maxProjectedContentBytes: 2,
        },
      ),
    ).not.toThrow();
    expect(() =>
      createPrintHtml(
        deck,
        new Map(),
        {},
        {
          maxProjectedElementOccurrences: 2,
          maxProjectedContentBytes: 2,
        },
      ),
    ).not.toThrow();
    expect(() =>
      createStandaloneHtml(
        deck,
        new Map(),
        { hiddenSlides: 'include' },
        {
          maxProjectedElementOccurrences: 2,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXPORT_LIMIT_EXCEEDED' }));
    expect(() =>
      createPrintHtml(
        deck,
        new Map(),
        { hiddenSlides: 'include' },
        {
          maxProjectedContentBytes: 2,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXPORT_LIMIT_EXCEEDED' }));
    expect(() =>
      createStandaloneHtml(
        deck,
        new Map(),
        { hiddenSlides: 'include' },
        {
          maxProjectedElementOccurrences: 3,
          maxProjectedContentBytes: 3,
        },
      ),
    ).not.toThrow();
  });

  it('charges each emitted data-URL occurrence before base64 rendering', () => {
    const fixture = repeatedAssetFixture();
    const exactProjectedBytes = Buffer.byteLength(fixture.dataUrl, 'utf8') * 2;
    const standalone = createStandaloneHtml(
      fixture.deck,
      fixture.assets,
      {},
      {
        maxProjectedAssetBytes: exactProjectedBytes,
      },
    );
    expect(standalone.split(fixture.dataUrl)).toHaveLength(3);
    expect(() =>
      createPrintHtml(
        fixture.deck,
        fixture.assets,
        {},
        {
          maxProjectedAssetBytes: exactProjectedBytes,
        },
      ),
    ).not.toThrow();
    expect(() =>
      createStandaloneHtml(
        fixture.deck,
        fixture.assets,
        {},
        {
          maxProjectedAssetBytes: exactProjectedBytes - 1,
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXPORT_LIMIT_EXCEEDED' }));
  });

  it('bounds UTF-8 accumulation exactly and rejects raised test ceilings', () => {
    const output = new BoundedUtf8Builder(7);
    output.append('é').append('&amp;');
    expect(output.byteLength).toBe(7);
    expect(output.toString()).toBe('é&amp;');
    expect(() => output.append('x')).toThrowError(
      expect.objectContaining({ code: 'EXPORT_LIMIT_EXCEEDED' }),
    );
    expect(() => new BoundedUtf8Builder(EXPORT_LIMITS.maxOutputUtf8Bytes + 1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
  });

  it('keeps print image readiness work at four concurrent decoders', () => {
    expect(PRINT_READINESS_SCRIPT).toContain('Math.min(4, images.length)');
    expect(PRINT_READINESS_SCRIPT).not.toContain('Promise.all(Array.from(document.images).map');
  });
});
