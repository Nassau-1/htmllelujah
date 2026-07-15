import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  EditorOverlay,
  RENDERER_CSS,
  SlideProjectionError,
  SlideSurface,
  formatNumber,
  formatPoint,
  isoCountryCodeToFlag,
  normalizeResolvedSlide,
  resolveSlideFromDeck,
  safeAssetUrl,
  safeColor,
  safeDomId,
  type DeckLike,
  type DocumentResolvedSlideProjection,
  type RenderElement,
} from '../src/index.js';
import { assetResolver, fixtureSlide, MODES, paragraph } from './fixtures.js';

const renderSlide = (mode: (typeof MODES)[number]): string =>
  renderToStaticMarkup(
    <SlideSurface slide={fixtureSlide} mode={mode} resolveAsset={assetResolver} />,
  );

describe('SlideSurface', () => {
  it.each(MODES)('renders deterministic slide content in %s mode', (mode) => {
    const first = renderSlide(mode);
    const second = renderSlide(mode);

    expect(first).toBe(second);
    expect(first).toContain(`data-render-mode="${mode}"`);
    expect(first).toContain('width:720pt;height:405pt');
    expect(first).toContain('Heading 1');
    expect(first).toContain('First bullet');
    expect(first).toContain('First step');
    expect(first).toContain('Nested group content');
    expect(first).not.toContain('MUST_NOT_RENDER');
    if (mode === 'editor') {
      expect(first).toContain('Drop media &lt;here&gt;');
      expect(first).toContain('data-locked="true"');
    } else {
      expect(first).not.toContain('Drop media');
      expect(first).not.toContain('data-locked=');
    }
  });

  it.each([
    ['widescreen', 960, 540],
    ['standard', 720, 540],
    ['a4-landscape', 841.89, 595.28],
  ] as const)('preserves the complete %s page coordinate space', (_name, widthPt, heightPt) => {
    const html = renderToStaticMarkup(
      <SlideSurface
        slide={{ ...fixtureSlide, page: { widthPt, heightPt } }}
        mode="thumbnail"
        resolveAsset={assetResolver}
      />,
    );

    expect(html).toContain(`data-page-width-pt="${formatNumber(widthPt)}"`);
    expect(html).toContain(`data-page-height-pt="${formatNumber(heightPt)}"`);
    expect(html).toContain(`width:${formatPoint(widthPt)}`);
    expect(html).toContain(`height:${formatPoint(heightPt)}`);
  });

  it('renders semantic rich text and preserves safe marks', () => {
    const html = renderSlide('editor');

    for (let level = 1; level <= 6; level += 1) {
      expect(html).toContain(`<h${level}`);
      expect(html).toContain(`Heading ${level}</span></h${level}>`);
    }
    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html).toContain('<li');
    expect(html).toContain('font-weight:700');
    expect(html).toContain('font-style:italic');
    expect(html).toContain('text-decoration:underline line-through');
    expect(html).toContain('&lt;script&gt;globalThis.compromised = true&lt;/script&gt; &amp; safe');
  });

  it('renders native tables, spans, vectors, connectors, groups, icons and flags', () => {
    const html = renderSlide('editor');

    expect(html).toContain('<table aria-label="Element table-main"');
    expect(html).toContain('font-family:Inter, sans-serif;font-size:16pt');
    expect(html).toContain('colSpan="2"');
    expect(html).toContain('rowSpan="2"');
    expect(html).toContain('Merged &lt;header&gt;');
    expect(html).toContain('Body &amp; details');
    expect(html.match(/data-element-type="shape"/g) ?? []).toHaveLength(8);
    expect(html).toContain('<rect');
    expect(html).toContain('<ellipse');
    expect(html).toContain('<polygon');
    expect(html).toContain('<line');
    expect(html).toContain('marker-end="url(#hl-arrow-shape-arrow)"');
    expect(html).toContain('data-element-id="connector-straight"');
    expect(html).toContain('data-element-id="connector-elbow"');
    expect(html).toContain('L 525 270 L 525 305');
    expect(html).toContain('data-element-id="group-inner"');
    expect(html).toContain('data-element-id="nested-shape"');
    expect(html).toContain(isoCountryCodeToFlag('FR'));
    expect(html).toContain('data-render-warning="ICON_UNKNOWN"');
  });

  it('accepts only opaque local raster asset sources and never emits a remote URL', () => {
    const html = renderSlide('presentation');

    expect(html).toContain('htmllelujah-asset://deck/images/safe.png');
    expect(html).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(html).toContain('data-render-warning="ASSET_UNAVAILABLE"');
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/file:\/\//i);
    expect(html).not.toContain('tracking.invalid');
    expect(html).not.toContain(' onerror="globalThis');
  });

  it('applies normalized crop geometry inside the clipped image frame', () => {
    const html = renderSlide('presentation');

    expect(html).toContain('left:-33.333333%');
    expect(html).toContain('top:-12.5%');
    expect(html).toContain('width:166.666667%');
    expect(html).toContain('height:125%');
    expect(html).toContain('object-fit:cover');
  });

  it('escapes document strings instead of creating executable markup', () => {
    const html = renderSlide('editor');

    expect(html).not.toContain('<script>');
    expect(html).toContain('data-slide-id="slide-&lt;unsafe&gt;"');
    expect(html).toContain('aria-label="Slide &quot;unsafe&quot; &lt;name&gt;"');
    expect(html).toContain('&quot; onerror=&quot;globalThis.compromised=true');
  });

  it('marks a missing background without exposing the resolver response', () => {
    const html = renderToStaticMarkup(
      <SlideSurface
        slide={fixtureSlide}
        mode="pdf"
        resolveAsset={() => 'file:///private/path.png'}
      />,
    );

    expect(html).toContain('data-render-warning="ASSET_UNAVAILABLE"');
    expect(html).not.toContain('private/path');
  });

  it('contains asset resolver failures behind generic placeholders', () => {
    const html = renderToStaticMarkup(
      <SlideSurface
        slide={fixtureSlide}
        mode="thumbnail"
        resolveAsset={() => {
          throw new Error('private resolver state');
        }}
      />,
    );

    expect(html).toContain('data-render-warning="ASSET_UNAVAILABLE"');
    expect(html).toContain('Image unavailable');
    expect(html).not.toContain('private resolver state');
  });
});

describe('EditorOverlay', () => {
  it('keeps guides and selection affordances outside slide content', () => {
    const slideHtml = renderSlide('editor');
    const overlayHtml = renderToStaticMarkup(
      <EditorOverlay
        page={{ widthPt: 720, heightPt: 405 }}
        guides={[
          { axis: 'x', positionPt: 125.5 },
          { axis: 'y', positionPt: 210 },
        ]}
        selections={[
          {
            id: 'unsafe"><selection',
            primary: true,
            frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 60, rotationDeg: 15 },
          },
          {
            id: 'secondary',
            frame: { xPt: 130, yPt: 40, widthPt: 80, heightPt: 50, rotationDeg: 0 },
          },
        ]}
      />,
    );

    expect(slideHtml).not.toContain('hl-editor-overlay');
    expect(overlayHtml).toContain('data-editor-overlay="true"');
    expect(overlayHtml).toContain('data-guide-axis="x"');
    expect(overlayHtml).toContain('data-guide-axis="y"');
    expect(overlayHtml.match(/data-handle-index=/g) ?? []).toHaveLength(8);
    expect(overlayHtml).toContain('rotate(15 60 50)');
    expect(overlayHtml).toContain('data-selection-id="unsafe&quot;&gt;&lt;selection"');
    expect(overlayHtml).toContain(`id="hl-selection-${safeDomId('unsafe"><selection')}"`);
  });
});

describe('safe static rendering primitives', () => {
  it('formats point values deterministically and clamps unsafe inputs', () => {
    expect(formatPoint(1 / 3)).toBe('0.333333pt');
    expect(formatPoint(-0)).toBe('0pt');
    expect(formatPoint(Number.NaN)).toBe('0pt');
    expect(formatNumber(12.3456789)).toBe('12.345679');
    expect(safeColor('url(https://tracking.invalid)')).toBe('transparent');
  });

  it('accepts only the renderer asset allowlist', () => {
    expect(safeAssetUrl('htmllelujah-asset://deck/a.png')).toBe('htmllelujah-asset://deck/a.png');
    expect(safeAssetUrl('blob:https://localhost/id')).toBe('blob:https://localhost/id');
    expect(safeAssetUrl('blob:null/2d87d08d-8431-4cbc-b1dd-d7025ab9aa18')).toBe(
      'blob:null/2d87d08d-8431-4cbc-b1dd-d7025ab9aa18',
    );
    expect(safeAssetUrl('data:image/webp;base64,AAAA')).toBe('data:image/webp;base64,AAAA');
    for (const unsafe of [
      'https://tracking.invalid/a.png',
      'http://tracking.invalid/a.png',
      'file:///private/a.png',
      'htmllelujah-asset://deck/../private.png',
      'javascript:alert(1)',
      'blob:javascript:alert(1)',
      'blob:https://localhost/id" onerror="alert(1)',
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      'data:image/svg+xml,<svg onload=alert(1)>',
    ]) {
      expect(safeAssetUrl(unsafe)).toBeNull();
    }
  });

  it('creates collision-resistant DOM ids for unsafe document ids', () => {
    expect(safeDomId('shape-arrow')).toBe('shape-arrow');
    expect(safeDomId('a/b')).not.toBe(safeDomId('a?b'));
    expect(safeDomId('a/b')).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(safeDomId('')).toMatch(/^element-[0-9a-f]{8}$/);
  });

  it('ships static CSS with no external reference', () => {
    expect(RENDERER_CSS).toContain('.hl-slide-surface');
    expect(RENDERER_CSS).toContain('.hl-editor-overlay');
    expect(RENDERER_CSS).not.toMatch(/https?:\/\//i);
    expect(RENDERER_CSS).not.toMatch(/@import/i);
    expect(RENDERER_CSS).not.toMatch(/url\s*\(/i);
  });
});

describe('resolveSlideFromDeck', () => {
  const placeholder: RenderElement = {
    id: 'placeholder-title',
    name: 'Title placeholder',
    type: 'placeholder',
    role: 'title',
    accepts: ['text'],
    prompt: 'Title',
    defaultTextStyle: { color: '#008844', fontSizePt: 24 },
    frame: { xPt: 10, yPt: 10, widthPt: 200, heightPt: 40, rotationDeg: 0 },
    opacity: 0.67,
    visible: true,
    locked: false,
  };
  const masterText: RenderElement = {
    id: 'master-text',
    name: 'Master text',
    type: 'text',
    styleRole: 'caption',
    verticalAlignment: 'top',
    content: paragraph('Master'),
    frame: { xPt: 0, yPt: 380, widthPt: 200, heightPt: 20, rotationDeg: 0 },
    opacity: 1,
    visible: true,
    locked: true,
  };
  const slideText: RenderElement = {
    id: 'slide-title',
    name: 'Slide title',
    type: 'text',
    styleRole: 'title',
    verticalAlignment: 'top',
    content: paragraph('Resolved title'),
    style: { color: '#cc0033', fontSizePt: 40 },
    frame: { xPt: 10, yPt: 10, widthPt: 200, heightPt: 40, rotationDeg: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    placeholderBinding: { placeholderId: 'placeholder-title', overrides: ['frame'] },
  };
  const deck: DeckLike = {
    page: { widthPt: 720, heightPt: 405 },
    themes: [
      {
        id: 'theme',
        colors: {
          background: '#ffffff',
          surface: '#ffffff',
          text: '#111111',
          mutedText: '#666666',
          accent: '#2255aa',
        },
        headingFontFamily: 'Arial',
        bodyFontFamily: 'Arial',
        textStyles: [],
      },
    ],
    masters: [
      {
        id: 'master',
        themeId: 'theme',
        background: { type: 'solid', color: '#eeeeee' },
        elements: [placeholder, masterText],
      },
    ],
    layouts: [
      {
        id: 'layout',
        masterId: 'master',
        background: { type: 'solid', color: '#ddeeff' },
        elements: [],
      },
    ],
    slides: [
      {
        id: 'slide',
        name: 'Slide',
        layoutId: 'layout',
        background: { type: 'theme' },
        elements: [slideText],
      },
    ],
    settings: { defaultBackground: { type: 'solid', color: '#cccccc' } },
  };

  it('resolves inheritance, background cascade, z-order and bound placeholders immutably', () => {
    const before = JSON.stringify(deck);
    const slide = resolveSlideFromDeck(deck, 'slide');

    expect(slide.background).toEqual({ type: 'solid', color: '#ffffff' });
    expect(slide.elements.map((element) => element.id)).toEqual(['master-text', 'slide-title']);
    expect(slide.elements).not.toContain(placeholder);
    const resolvedTitle = slide.elements.find((element) => element.id === 'slide-title');
    expect(resolvedTitle?.opacity).toBe(0.67);
    expect(resolvedTitle?.type === 'text' ? resolvedTitle.style : undefined).toEqual({
      color: '#008844',
      fontSizePt: 24,
    });
    expect(JSON.stringify(deck)).toBe(before);
    expect(slide.page).not.toBe(deck.page);
  });

  it('uses lower background layers only when the higher layer is absent', () => {
    const slideWithoutBackground = {
      ...deck,
      slides: deck.slides.map((slide) => ({
        id: slide.id,
        name: slide.name,
        layoutId: slide.layoutId,
        elements: slide.elements,
      })),
    } satisfies DeckLike;

    expect(resolveSlideFromDeck(slideWithoutBackground, 'slide').background).toEqual({
      type: 'solid',
      color: '#ddeeff',
    });
  });

  it('honors explicit placeholder frame, style and visibility overrides', () => {
    const overriddenTitle: RenderElement = {
      ...slideText,
      frame: { ...slideText.frame, xPt: 333 },
      opacity: 0.22,
      style: { color: '#cc0033', fontSizePt: 40 },
      placeholderBinding: {
        placeholderId: 'placeholder-title',
        overrides: ['frame', 'style', 'visibility'],
      },
    };
    const overriddenDeck: DeckLike = {
      ...deck,
      slides: deck.slides.map((slide) => ({
        ...slide,
        elements: [overriddenTitle],
      })),
    };
    const resolved = resolveSlideFromDeck(overriddenDeck, 'slide');
    const title = resolved.elements.find((element) => element.id === 'slide-title');

    expect(title?.frame.xPt).toBe(333);
    expect(title?.opacity).toBe(0.22);
    expect(title?.type === 'text' ? title.style : undefined).toEqual({
      color: '#cc0033',
      fontSizePt: 40,
    });
  });

  it('fails with typed projection errors for missing relationships', () => {
    expect(() => resolveSlideFromDeck(deck, 'missing')).toThrow(SlideProjectionError);
    const withoutLayout: DeckLike = { ...deck, layouts: [] };
    expect(() => resolveSlideFromDeck(withoutLayout, 'slide')).toThrow(
      'The slide layout was not found.',
    );
  });
});

describe('document-core projection compatibility', () => {
  it('accepts a source-aware ResolvedSlide projection and applies its resolved text style', () => {
    const projection: DocumentResolvedSlideProjection = {
      documentId: 'document',
      page: { widthPt: 720, heightPt: 405 },
      slide: { id: 'core-slide', name: 'Core slide' },
      theme: fixtureSlide.theme,
      background: { type: 'theme' },
      elements: [
        {
          source: 'slide',
          element: {
            id: 'resolved-text',
            name: 'Resolved text',
            type: 'text',
            styleRole: 'body',
            verticalAlignment: 'top',
            content: paragraph('Canonical projection'),
            style: { color: '#ff0000', fontSizePt: 9 },
            frame: { xPt: 10, yPt: 10, widthPt: 300, heightPt: 50, rotationDeg: 0 },
            opacity: 1,
            visible: true,
            locked: false,
          },
          resolvedTextStyle: {
            fontFamily: 'Arial, sans-serif',
            fontSizePt: 23,
            fontWeight: 650,
            italic: true,
            color: '#00aa44',
            alignment: 'right',
            lineHeight: 1.4,
            letterSpacingPt: 0.5,
          },
        },
      ],
    };
    const before = JSON.stringify(projection);
    const normalized = normalizeResolvedSlide(projection);
    const html = renderToStaticMarkup(<SlideSurface slide={projection} mode="presentation" />);

    expect(normalized.id).toBe('core-slide');
    expect(normalized.background).toEqual({ type: 'solid', color: '#fafafa' });
    expect(html).toContain('data-slide-id="core-slide"');
    expect(html).toContain('Canonical projection');
    expect(html).toContain('font-size:23pt');
    expect(html).toContain('font-weight:650');
    expect(html).toContain('font-style:italic');
    expect(html).toContain('color:#00aa44');
    expect(html).toContain('text-align:right');
    expect(JSON.stringify(projection)).toBe(before);
  });
});
