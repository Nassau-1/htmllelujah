import { describe, expect, it } from 'vitest';

import {
  applyTransaction,
  canonicalSerialize,
  createDuplicateSlide,
  createNeutralDemoDeck,
  enforceThemeAcrossDeck,
  parseDeck,
  undoTransaction,
  validateDeck,
  type ConnectorElement,
  type PathElement,
  type ShapeKind,
  type TransactionOptions,
} from '../src/index.js';

const PATH_ID = '71000000-0000-4000-8000-000000000001';

const metadata = (suffix: string): TransactionOptions => ({
  metadata: {
    transactionId: `71000000-0000-4000-8000-0000000000${suffix}`,
    actorId: 'vector-test',
    origin: 'user',
    label: 'Vector test',
    timestamp: '2026-07-24T09:00:00.000Z',
  },
});

const freeform = (): PathElement => ({
  id: PATH_ID,
  name: 'Freeform',
  type: 'path',
  frame: { xPt: 120, yPt: 80, widthPt: 100, heightPt: 80, rotationDeg: 0 },
  opacity: 1,
  visible: true,
  locked: false,
  commands: [
    { type: 'move', xPt: 0, yPt: 40 },
    {
      type: 'cubic',
      control1XPt: 20,
      control1YPt: 0,
      control2XPt: 80,
      control2YPt: 80,
      xPt: 100,
      yPt: 40,
    },
    { type: 'line', xPt: 50, yPt: 80 },
    { type: 'close' },
  ],
  fill: '#DDEEFF',
  stroke: { color: '#225588', widthPt: 2, dash: 'solid' },
  fillRule: 'evenodd',
  shadow: {
    color: '#000000',
    blurPt: 4,
    offsetXPt: 2,
    offsetYPt: 3,
    opacity: 0.25,
  },
});

describe('business vectors and canonical freeform paths', () => {
  it('round-trips the canonical curved connector routing mode', () => {
    const source = createNeutralDemoDeck();
    const curved: ConnectorElement = {
      id: '71000000-0000-4000-8000-000000000099',
      name: 'Curved connector',
      type: 'connector',
      geometryVersion: 2,
      frame: { xPt: 20, yPt: 30, widthPt: 180, heightPt: 90, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 20, yPt: 30, binding: { anchor: 'right' } },
      end: { xPt: 200, yPt: 120, binding: { anchor: 'left' } },
      routing: 'curved',
      stroke: { color: '#123456', widthPt: 2, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const document = {
      ...source,
      slides: source.slides.map((slide, index) =>
        index === 0 ? { ...slide, elements: [...slide.elements, curved] } : slide,
      ),
    };

    const result = validateDeck(document);
    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error('Expected curved connector routing to validate.');
    const reparsed = parseDeck(JSON.parse(canonicalSerialize(result.document)));
    const connector = reparsed.slides[0]?.elements.find((element) => element.id === curved.id);
    expect(connector?.type === 'connector' ? connector.routing : undefined).toBe('curved');
  });

  it('accepts the complete bounded business shape set without a schema bump', () => {
    const shapeKinds: readonly ShapeKind[] = [
      'rectangle',
      'rounded-rectangle',
      'ellipse',
      'triangle',
      'right-triangle',
      'diamond',
      'parallelogram',
      'trapezoid',
      'pentagon',
      'hexagon',
      'octagon',
      'chevron',
      'cross',
      'donut',
      'left-bracket',
      'right-bracket',
      'arc',
      'line',
      'arrow',
    ];
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const document = {
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? {
              ...candidate,
              elements: [
                ...candidate.elements,
                ...shapeKinds.map((shape, index) => ({
                  id: `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
                  name: shape,
                  type: 'shape' as const,
                  frame: {
                    xPt: 10 + index,
                    yPt: 10 + index,
                    widthPt: 80,
                    heightPt: 50,
                    rotationDeg: 0,
                  },
                  opacity: 1,
                  visible: true,
                  locked: false,
                  shape,
                  fill: shape === 'line' || shape === 'arrow' ? null : '#FFFFFF',
                  stroke: { color: '#000000', widthPt: 1, dash: 'solid' as const },
                  cornerRadiusPt: 6,
                })),
              ],
            }
          : candidate,
      ),
    };

    const result = validateDeck(document);
    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error('Expected business shapes to validate.');
    expect(result.document.schemaVersion).toBe(2);
  });

  it('round-trips, styles, resizes, and undoes a path transactionally', () => {
    const source = createNeutralDemoDeck();
    const slideId = source.slides[0]!.id;
    const inserted = applyTransaction(
      source,
      [{ type: 'element.insert', slideId, element: freeform() }],
      metadata('01'),
    );
    const serialized = canonicalSerialize(inserted.document);
    const reparsed = parseDeck(JSON.parse(serialized));
    expect(canonicalSerialize(reparsed)).toBe(serialized);

    const updated = applyTransaction(
      inserted.document,
      [
        {
          type: 'element.update-style',
          slideId,
          elementId: PATH_ID,
          patch: {
            kind: 'path',
            fill: null,
            fillRule: 'nonzero',
            stroke: { color: '#CC3300', widthPt: 3, dash: 'dash' },
            shadow: null,
          },
        },
        {
          type: 'element.transform',
          slideId,
          transforms: [
            {
              elementId: PATH_ID,
              frame: { xPt: 40, yPt: 50, widthPt: 200, heightPt: 40, rotationDeg: 15 },
            },
          ],
        },
      ],
      metadata('02'),
    );
    const path = updated.document.slides[0]!.elements.find(
      (element): element is PathElement => element.id === PATH_ID && element.type === 'path',
    );
    expect(path).toMatchObject({
      fill: null,
      fillRule: 'nonzero',
      frame: { xPt: 40, yPt: 50, widthPt: 200, heightPt: 40, rotationDeg: 15 },
    });
    expect(path?.shadow).toBeUndefined();
    expect(path?.commands).toEqual([
      { type: 'move', xPt: 0, yPt: 20 },
      {
        type: 'cubic',
        control1XPt: 40,
        control1YPt: 0,
        control2XPt: 160,
        control2YPt: 40,
        xPt: 200,
        yPt: 20,
      },
      { type: 'line', xPt: 100, yPt: 40 },
      { type: 'close' },
    ]);
    expect(undoTransaction(updated.document, updated)).toEqual(inserted.document);
  });

  it('keeps path colors under the same explicit theme authority as native shapes', () => {
    const source = createNeutralDemoDeck();
    const slideId = source.slides[0]!.id;
    const inserted = applyTransaction(
      source,
      [{ type: 'element.insert', slideId, element: freeform() }],
      metadata('03'),
    ).document;
    const theme = inserted.themes[0]!;
    const themed = enforceThemeAcrossDeck(inserted, theme.id);
    const path = themed.slides[0]!.elements.find(
      (element): element is PathElement => element.id === PATH_ID && element.type === 'path',
    );

    expect(path).toMatchObject({
      fill: theme.colors.surface,
      stroke: { color: theme.colors.accent },
      shadow: { color: theme.colors.mutedText },
    });
  });

  it('clones path geometry while replacing only canonical object identifiers', () => {
    const source = createNeutralDemoDeck();
    const slideId = source.slides[0]!.id;
    const pathOnly = {
      ...source,
      slides: source.slides.map((slide) =>
        slide.id === slideId ? { ...slide, elements: [freeform()] } : slide,
      ),
    };
    const ids = ['73000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000002'];
    const duplicate = createDuplicateSlide(pathOnly, slideId, () => ids.shift()!);
    const cloned = duplicate.elements.find((element) => element.type === 'path');

    expect(duplicate.id).toBe('73000000-0000-4000-8000-000000000002');
    expect(cloned?.id).toBe('73000000-0000-4000-8000-000000000001');
    expect(cloned).toMatchObject({
      type: 'path',
      commands: freeform().commands,
      fillRule: 'evenodd',
    });
  });

  it('bakes group resizing into local path coordinates when ungrouping', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const companion = slide.elements[0]!;
    const inserted = applyTransaction(
      source,
      [{ type: 'element.insert', slideId: slide.id, element: freeform() }],
      metadata('04'),
    ).document;
    const groupId = '74000000-0000-4000-8000-000000000001';
    const grouped = applyTransaction(
      inserted,
      [
        {
          type: 'element.group',
          slideId: slide.id,
          elementIds: [companion.id, PATH_ID],
          groupId,
          name: 'Scaled path group',
        },
      ],
      metadata('05'),
    ).document;
    const group = grouped.slides[0]!.elements.find((element) => element.id === groupId);
    if (group?.type !== 'group') throw new Error('Expected a group.');
    const resized = applyTransaction(
      grouped,
      [
        {
          type: 'element.transform',
          slideId: slide.id,
          transforms: [
            {
              elementId: groupId,
              frame: {
                ...group.frame,
                widthPt: group.frame.widthPt * 2,
                heightPt: group.frame.heightPt * 2,
              },
            },
          ],
        },
      ],
      metadata('06'),
    ).document;
    const ungrouped = applyTransaction(
      resized,
      [{ type: 'element.ungroup', slideId: slide.id, groupId }],
      metadata('07'),
    ).document;
    const path = ungrouped.slides[0]!.elements.find(
      (element): element is PathElement => element.id === PATH_ID && element.type === 'path',
    );

    expect(path?.frame.widthPt).toBe(200);
    expect(path?.frame.heightPt).toBe(160);
    expect(path?.commands[1]).toMatchObject({
      type: 'cubic',
      control2XPt: 160,
      control2YPt: 160,
      xPt: 200,
      yPt: 80,
    });
    expect(validateDeck(ungrouped)).toMatchObject({ success: true });
  });

  it('rejects malformed and out-of-frame path geometry at the trusted boundary', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const withPath = (path: unknown) => ({
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? { ...candidate, elements: [...candidate.elements, path] }
          : candidate,
      ),
    });

    const badOrder = {
      ...freeform(),
      commands: [
        { type: 'line', xPt: 0, yPt: 0 },
        { type: 'line', xPt: 10, yPt: 10 },
      ],
    };
    const badOrderResult = validateDeck(withPath(badOrder));
    expect(badOrderResult).toMatchObject({ success: false });
    if (badOrderResult.success) throw new Error('Expected invalid path ordering.');
    expect(badOrderResult.issues[0]?.code).toBe('SCHEMA_INVALID');

    const outside = {
      ...freeform(),
      commands: [
        { type: 'move', xPt: 0, yPt: 0 },
        { type: 'line', xPt: 101, yPt: 20 },
      ],
    };
    const outsideResult = validateDeck(withPath(outside));
    expect(outsideResult).toMatchObject({ success: false });
    if (outsideResult.success) throw new Error('Expected local-coordinate rejection.');
    expect(outsideResult.issues).toContainEqual(
      expect.objectContaining({
        code: 'PATH_COORDINATE_OUT_OF_BOUNDS',
        path: expect.stringContaining('.commands.1.xPt'),
      }),
    );
  });
});
