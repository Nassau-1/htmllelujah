import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  createDefaultDeck,
  resolveDocumentConnectorGeometries,
  resolveSlide,
  type DeckDocument,
  type Element,
  type PlaceholderElement,
  type TextElement,
} from '../../document-core/src/index.js';
import { EditorOverlay, SlideSurface, resolveConnectorGeometries } from '../src/index.js';

const createCanonicalDeck = (): DeckDocument => {
  let nextId = 0;
  return createDefaultDeck({
    idFactory: () => `00000000-0000-4000-8000-${(++nextId).toString(16).padStart(12, '0')}`,
    now: () => '2026-07-15T00:00:00.000Z',
  });
};

const titleParts = (
  deck: DeckDocument,
): Readonly<{
  slideTitle: TextElement;
  titlePlaceholder: PlaceholderElement;
}> => {
  const slide = deck.slides[0];
  const layout = deck.layouts[0];
  if (slide === undefined || layout === undefined) throw new Error('Fixture is incomplete.');
  const slideTitle = slide.elements.find(
    (element): element is TextElement => element.type === 'text' && element.styleRole === 'title',
  );
  const titlePlaceholder = layout.elements.find(
    (element): element is PlaceholderElement =>
      element.type === 'placeholder' && element.role === 'title',
  );
  if (slideTitle === undefined || titlePlaceholder === undefined) {
    throw new Error('Fixture title binding is incomplete.');
  }
  return { slideTitle, titlePlaceholder };
};

const replaceElement = (elements: readonly Element[], replacement: Element): readonly Element[] =>
  elements.map((element) => (element.id === replacement.id ? replacement : element));

describe('document-core V2 compatibility', () => {
  it('keeps bound legacy connector geometry in parity across core and renderer group transforms', () => {
    const target: Element = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Nested rotated target',
      type: 'shape',
      frame: { xPt: 20, yPt: 10, widthPt: 40, heightPt: 20, rotationDeg: 90 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector: Element = {
      id: '10000000-0000-4000-8000-000000000002',
      name: 'Nested legacy connector',
      type: 'connector',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 50, rotationDeg: 90 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 0, yPt: 0, binding: {} },
      end: { xPt: 100, yPt: 50, binding: { elementId: target.id, anchor: 'right' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const group: Element = {
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Scaled rotated group',
      type: 'group',
      frame: { xPt: 100, yPt: 50, widthPt: 300, heightPt: 100, rotationDeg: 30 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 100, heightPt: 50 },
      children: [target, connector],
    };
    const core = resolveDocumentConnectorGeometries([group]).get(connector.id)!;
    const renderer = resolveConnectorGeometries([group]).get(connector.id)!;

    expect(renderer.startInContainer).toEqual(core.startInContainer);
    expect(renderer.endInContainer).toEqual(core.endInContainer);
    expect(renderer.startInSlide).toEqual(core.startInDocument);
    expect(renderer.endInSlide).toEqual(core.endInDocument);
    expect(renderer.boundsInSlide).toEqual({
      xPt: core.boundsInDocument.left,
      yPt: core.boundsInDocument.top,
      widthPt: core.boundsInDocument.right - core.boundsInDocument.left,
      heightPt: core.boundsInDocument.bottom - core.boundsInDocument.top,
    });
  });

  it('renders the actual canonical projection with inherited placeholder frame, style and visibility', () => {
    const source = createCanonicalDeck();
    const { slideTitle, titlePlaceholder } = titleParts(source);
    const inheritedPlaceholder: PlaceholderElement = {
      ...titlePlaceholder,
      frame: { ...titlePlaceholder.frame, xPt: 84, yPt: 62 },
      opacity: 0.73,
      visible: true,
      defaultTextStyle: {
        fontFamily: 'Georgia, serif',
        fontSizePt: 29,
        fontWeight: 725,
        italic: true,
        color: '#008844',
        alignment: 'right',
        lineHeight: 1.45,
        letterSpacingPt: 0.75,
      },
    };
    const localTitle: TextElement = {
      ...slideTitle,
      frame: { ...slideTitle.frame, xPt: 600, yPt: 300 },
      opacity: 0.12,
      visible: false,
      style: { fontSizePt: 90, color: '#ff0000' },
      placeholderBinding: {
        placeholderId: titlePlaceholder.id,
        overrides: [],
      },
    };
    const layout = source.layouts[0];
    const slide = source.slides[0];
    if (layout === undefined || slide === undefined) throw new Error('Fixture is incomplete.');
    const deck: DeckDocument = {
      ...source,
      layouts: [
        {
          ...layout,
          guides: [
            {
              id: '10000000-0000-4000-8000-000000000001',
              orientation: 'vertical',
              positionPt: 84,
            },
            {
              id: '10000000-0000-4000-8000-000000000002',
              orientation: 'horizontal',
              positionPt: 62,
            },
          ],
          elements: replaceElement(layout.elements, inheritedPlaceholder),
        },
      ],
      slides: [{ ...slide, elements: replaceElement(slide.elements, localTitle) }],
    };

    const resolved = resolveSlide(deck, slide.id);
    const html = renderToStaticMarkup(<SlideSurface slide={resolved} mode="presentation" />);
    const overlay = renderToStaticMarkup(
      <EditorOverlay page={resolved.page} selections={[]} guides={resolved.guides} />,
    );

    expect(html).toContain(`data-slide-id="${slide.id}"`);
    expect(html).toContain('left:84pt');
    expect(html).toContain('top:62pt');
    expect(html).toContain('opacity:0.73');
    expect(html).toContain('font-family:Georgia, serif');
    expect(html).toContain('font-size:29pt');
    expect(html).toContain('font-weight:725');
    expect(html).toContain('font-style:italic');
    expect(html).toContain('color:#008844');
    expect(html).toContain('letter-spacing:0.75pt');
    expect(html).not.toContain('left:600pt');
    expect(html).not.toContain('font-size:90pt');
    expect(overlay).toContain('data-guide-axis="x"');
    expect(overlay).toContain('data-guide-axis="y"');
  });

  it('honors canonical frame, style and visibility override bindings', () => {
    const source = createCanonicalDeck();
    const { slideTitle, titlePlaceholder } = titleParts(source);
    const localTitle: TextElement = {
      ...slideTitle,
      frame: { ...slideTitle.frame, xPt: 321, yPt: 123, rotationDeg: 7.5 },
      opacity: 0.44,
      visible: true,
      style: {
        fontFamily: 'Arial, sans-serif',
        fontSizePt: 31,
        fontWeight: 810,
        italic: false,
        color: '#aa2244',
        alignment: 'center',
        lineHeight: 1.1,
        letterSpacingPt: 0.2,
      },
      placeholderBinding: {
        placeholderId: titlePlaceholder.id,
        overrides: ['frame', 'style', 'visibility'],
      },
    };
    const slide = source.slides[0];
    if (slide === undefined) throw new Error('Fixture is incomplete.');
    const deck: DeckDocument = {
      ...source,
      slides: [{ ...slide, elements: replaceElement(slide.elements, localTitle) }],
    };

    const resolved = resolveSlide(deck, slide.id);
    const html = renderToStaticMarkup(<SlideSurface slide={resolved} mode="html" />);

    expect(html).toContain('left:321pt');
    expect(html).toContain('top:123pt');
    expect(html).toContain('opacity:0.44');
    expect(html).toContain('rotate(7.5deg)');
    expect(html).toContain('font-size:31pt');
    expect(html).toContain('font-weight:810');
    expect(html).toContain('color:#aa2244');
    expect(html).toContain('text-align:center');
  });
});
