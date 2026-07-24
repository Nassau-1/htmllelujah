import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  createDefaultDeck,
  createDuplicateSlide,
  deckDocumentSchema,
  DOCUMENT_LIMITS,
  elementSchema,
  parseDeck,
  resetElementThemeStyles,
  resolveElementDynamicFields,
  shapeSupportsText,
  validateDeck,
  type DeckDocument,
  type DeckDocumentV1,
  type PlaceholderElement,
  type ShapeElement,
  type TransactionOptions,
} from '../src/index.js';

const transactionOptions = (suffix: string): TransactionOptions => ({
  metadata: {
    transactionId: `f0000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    actorId: 'shape-text-test',
    origin: 'user',
    label: 'Shape text test',
    timestamp: '2026-07-24T12:00:00.000Z',
  },
});

const shapeText = (
  blockId = 'f1000000-0000-4000-8000-000000000001',
  itemId = 'f1000000-0000-4000-8000-000000000002',
) => ({
  content: {
    blocks: [
      {
        id: blockId,
        type: 'list' as const,
        ordered: false,
        items: [
          {
            id: itemId,
            level: 0,
            runs: [
              {
                text: 'Revenue {{page}}',
                marks: {
                  bold: true,
                  italic: false,
                  underline: false,
                  strikethrough: false,
                  color: '#123456',
                  fontFamily: 'Legacy Font',
                  fontSizePt: 14,
                },
              },
            ],
          },
        ],
      },
    ],
  },
  styleRole: 'label' as const,
  style: {
    fontFamily: 'Legacy Font',
    fontSizePt: 18,
    fontWeight: 600,
    italic: true,
    color: '#654321',
    alignment: 'center' as const,
    lineHeight: 1.3,
  },
  verticalAlignment: 'middle' as const,
  margins: { topPt: 3, rightPt: 4, bottomPt: 5, leftPt: 6 },
  locale: 'fr-fr',
});

const shape = (id = 'f1000000-0000-4000-8000-000000000003', withText = true): ShapeElement => ({
  id,
  name: 'Text shape',
  type: 'shape',
  frame: { xPt: 40, yPt: 60, widthPt: 220, heightPt: 100, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  shape: 'rounded-rectangle',
  fill: '#DCE8FF',
  stroke: { color: '#295BC7', widthPt: 1.5, dash: 'solid' },
  cornerRadiusPt: 12,
  ...(withText ? { text: shapeText() } : {}),
});

const withSlideElements = (
  document: DeckDocument,
  elements: readonly ShapeElement[],
): DeckDocument => ({
  ...document,
  slides: document.slides.map((slide, index) =>
    index === 0 ? { ...slide, elements: [...slide.elements, ...elements] } : slide,
  ),
});

describe('canonical shape text', () => {
  it('round-trips in V2 and V1 migration while remaining optional for old shapes', () => {
    const original = createDefaultDeck({ now: () => '2026-07-24T12:00:00.000Z' });
    const authored = withSlideElements(original, [shape()]);
    const parsed = deckDocumentSchema.parse(JSON.parse(JSON.stringify(authored)));
    const parsedShape = parsed.slides[0]?.elements.find(
      (element): element is ShapeElement => element.id === shape().id && element.type === 'shape',
    );

    expect(parsedShape?.text?.locale).toBe('fr-FR');
    expect(parsedShape?.text?.margins).toEqual({ topPt: 3, rightPt: 4, bottomPt: 5, leftPt: 6 });
    expect(validateDeck(parsed)).toMatchObject({ success: true });
    expect(deckDocumentSchema.parse(original).slides[0]?.elements).not.toContainEqual(
      expect.objectContaining({ text: expect.anything() }),
    );

    const { metadata: _metadata, settings: _settings, ...legacyBase } = authored;
    const legacy: DeckDocumentV1 = { ...legacyBase, schemaVersion: 1 };
    const migrated = parseDeck(JSON.parse(JSON.stringify(legacy)));
    const migratedShape = migrated.slides[0]?.elements.find(
      (element): element is ShapeElement => element.id === shape().id && element.type === 'shape',
    );
    expect(migratedShape?.text?.locale).toBe('fr-FR');
    expect(migratedShape?.text?.content).toEqual(parsedShape?.text?.content);
  });

  it('bounds margins and language, and rejects text on line, arrow, and arc geometry', () => {
    for (const kind of ['line', 'arrow', 'arc'] as const) {
      expect(shapeSupportsText(kind)).toBe(false);
      expect(elementSchema.safeParse({ ...shape(), shape: kind }).success).toBe(false);
      expect(
        elementSchema.safeParse({
          ...shape(`f4000000-0000-4000-8000-00000000000${kind.length}`, false),
          shape: kind,
        }).success,
      ).toBe(true);
    }
    expect(shapeSupportsText('rectangle')).toBe(true);
    expect(
      elementSchema.safeParse({
        ...shape(),
        text: {
          ...shapeText(),
          margins: {
            ...shapeText().margins,
            topPt: DOCUMENT_LIMITS.maxShapeTextMarginPt + 1,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      elementSchema.safeParse({
        ...shape(),
        text: { ...shapeText(), locale: 'not_a_language' },
      }).success,
    ).toBe(false);
  });

  it('freshens nested IDs, survives group/ungroup, and resolves dynamic fields', () => {
    const source = parseDeck(
      withSlideElements(createDefaultDeck(), [
        shape(),
        shape('f1000000-0000-4000-8000-000000000004', false),
      ]),
    );
    let nextId = 1;
    const duplicate = createDuplicateSlide(
      source,
      source.slides[0]!.id,
      () => `f2000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
    );
    const duplicateShape = duplicate.elements.find(
      (element): element is ShapeElement => element.type === 'shape' && element.text !== undefined,
    );
    const sourceShape = source.slides[0]!.elements.find(
      (element): element is ShapeElement => element.type === 'shape' && element.text !== undefined,
    );
    expect(duplicateShape?.text?.content.blocks[0]?.id).not.toBe(
      sourceShape?.text?.content.blocks[0]?.id,
    );
    expect(
      duplicateShape?.text?.content.blocks[0]?.type === 'list'
        ? duplicateShape.text.content.blocks[0].items[0]?.id
        : undefined,
    ).not.toBe(
      sourceShape?.text?.content.blocks[0]?.type === 'list'
        ? sourceShape.text.content.blocks[0].items[0]?.id
        : undefined,
    );
    expect(validateDeck({ ...source, slides: [...source.slides, duplicate] })).toMatchObject({
      success: true,
    });

    const grouped = applyCommand(
      source,
      {
        type: 'element.group',
        slideId: source.slides[0]!.id,
        elementIds: [
          'f1000000-0000-4000-8000-000000000003',
          'f1000000-0000-4000-8000-000000000004',
        ],
        groupId: 'f1000000-0000-4000-8000-000000000005',
        name: 'Grouped shapes',
      },
      transactionOptions('1'),
    );
    const group = grouped.document.slides[0]!.elements.find(
      (element) => element.id === 'f1000000-0000-4000-8000-000000000005',
    );
    const groupedShape =
      group?.type === 'group'
        ? group.children.find(
            (child): child is ShapeElement => child.id === shape().id && child.type === 'shape',
          )
        : undefined;
    expect(groupedShape?.text).toEqual(sourceShape?.text);

    const ungrouped = applyCommand(
      grouped.document,
      {
        type: 'element.ungroup',
        slideId: source.slides[0]!.id,
        groupId: 'f1000000-0000-4000-8000-000000000005',
      },
      transactionOptions('2'),
    );
    const ungroupedShape = ungrouped.document.slides[0]!.elements.find(
      (element): element is ShapeElement => element.id === shape().id && element.type === 'shape',
    );
    expect(ungroupedShape?.text).toEqual(sourceShape?.text);
    expect(validateDeck(ungrouped.document)).toMatchObject({ success: true });

    const resolved = resolveElementDynamicFields(shape(), {
      page: '7',
      pages: '12',
      title: 'Plan',
      date: '24/07/2026',
      time: '12:00',
    });
    expect(
      resolved.type === 'shape' &&
        resolved.text?.content.blocks[0]?.type === 'list' &&
        resolved.text.content.blocks[0].items[0]?.runs[0]?.text,
    ).toBe('Revenue 7');
  });

  it('obeys theme enforcement and placeholder reset without losing authored content', () => {
    const original = shape();
    const theme = createDefaultDeck().themes[0]!;
    const enforced = resetElementThemeStyles(original, theme);
    if (enforced.type !== 'shape' || enforced.text === undefined) {
      throw new Error('Expected enforced shape text.');
    }
    expect(enforced.text.style).toEqual({
      fontSizePt: 18,
      fontWeight: 600,
      italic: true,
      alignment: 'center',
      lineHeight: 1.3,
    });
    const marks =
      enforced.text.content.blocks[0]?.type === 'list'
        ? enforced.text.content.blocks[0].items[0]?.runs[0]?.marks
        : undefined;
    expect(marks).toEqual({
      bold: true,
      italic: false,
      underline: false,
      strikethrough: false,
      fontSizePt: 14,
    });
    expect(enforced.text.locale).toBe('fr-fr');
    expect(original.text?.style?.fontFamily).toBe('Legacy Font');

    const source = createDefaultDeck();
    const layout = source.layouts[0]!;
    const slide = source.slides[0]!;
    const placeholder: PlaceholderElement = {
      id: 'f3000000-0000-4000-8000-000000000001',
      name: 'Shape placeholder',
      type: 'placeholder',
      frame: { xPt: 300, yPt: 220, widthPt: 180, heightPt: 90, rotationDeg: 0 },
      opacity: 0.8,
      visible: true,
      locked: false,
      role: 'body',
      accepts: ['shape'],
      prompt: 'Add a shape',
    };
    const boundShape: ShapeElement = {
      ...shape('f3000000-0000-4000-8000-000000000002'),
      frame: { xPt: 10, yPt: 10, widthPt: 80, heightPt: 40, rotationDeg: 15 },
      visible: false,
      opacity: 0.2,
      placeholderBinding: {
        placeholderId: placeholder.id,
        overrides: ['frame', 'style', 'visibility'],
      },
    };
    const bound: DeckDocument = {
      ...source,
      layouts: [{ ...layout, elements: [...layout.elements, placeholder] }],
      slides: [{ ...slide, elements: [...slide.elements, boundShape] }],
    };
    expect(validateDeck(bound)).toMatchObject({ success: true });

    const reset = applyCommand(
      bound,
      {
        type: 'slide.reset-placeholder',
        slideId: slide.id,
        placeholderId: placeholder.id,
      },
      transactionOptions('3'),
    );
    const resetShape = reset.document.slides[0]!.elements.find(
      (element): element is ShapeElement =>
        element.id === boundShape.id && element.type === 'shape',
    );
    expect(resetShape?.frame).toEqual(placeholder.frame);
    expect(resetShape).toMatchObject({ visible: true, opacity: 0.8 });
    expect(resetShape?.placeholderBinding?.overrides).toEqual([]);
    expect(resetShape?.text?.style).toBeUndefined();
    expect(resetShape?.text?.content).toEqual(boundShape.text?.content);
  });
});
