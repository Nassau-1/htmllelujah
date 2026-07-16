import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  applyTransaction,
  createDefaultDeck,
  createDuplicateSlide,
  createNeutralDemoDeck,
  DETERMINISTIC_MIGRATION_TIMESTAMP,
  documentCommandSchema,
  DocumentCommandError,
  migrateDeckV1ToV2,
  parseDeck,
  parseTsv,
  resolveDocumentConnectorGeometries,
  resolveSlide,
  resolveSlideFromValidatedDocument,
  undoTransaction,
  validateDeck,
  type DeckDocument,
  type DeckDocumentV1,
  type Element,
  type TableCell,
  type TableElement,
  type TransactionOptions,
} from '../src/index.js';

const metadata = (suffix = '1'): TransactionOptions => ({
  metadata: {
    transactionId: `99000000-0000-4000-8000-00000000000${suffix}`,
    actorId: 'v2-test-user',
    origin: 'agent',
    label: 'V2 test',
    timestamp: `2026-07-15T12:00:0${suffix}.000Z`,
  },
});

const idFactory = (): (() => string) => {
  let count = 0;
  return () => {
    count += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
};

const requireTable = (document: DeckDocument): { slideId: string; table: TableElement } => {
  for (const slide of document.slides) {
    const table = slide.elements.find(
      (element): element is TableElement => element.type === 'table',
    );
    if (table !== undefined) return { slideId: slide.id, table };
  }
  throw new Error('Missing table fixture.');
};

const textOfCell = (cell: TableCell): string => {
  const block = cell.content.blocks[0];
  if (block === undefined) return '';
  return block.type === 'list'
    ? (block.items[0]?.runs.map((run) => run.text).join('') ?? '')
    : block.runs.map((run) => run.text).join('');
};

describe('schema V2 and migration', () => {
  it('accepts V1 input, migrates deterministically, and leaves the source untouched', () => {
    const current = createNeutralDemoDeck();
    const { metadata: _metadata, settings: _settings, ...base } = current;
    const legacy: DeckDocumentV1 = { ...base, schemaVersion: 1 };
    const before = JSON.stringify(legacy);

    const first = parseDeck(legacy);
    const second = migrateDeckV1ToV2(legacy);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(2);
    expect(first.metadata.createdAt).toBe(DETERMINISTIC_MIGRATION_TIMESTAMP);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it('rejects one-sided image dimensions and dimensions on font assets', () => {
    const source = createNeutralDemoDeck();
    const halfSized = {
      ...source,
      assets: [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          kind: 'image' as const,
          hash: 'a'.repeat(64),
          mediaType: 'image/png',
          fileName: 'x.png',
          widthPx: 100,
        },
      ],
    };
    const result = validateDeck(halfSized);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid dimensions.');
    expect(result.issues.some((issue) => issue.code === 'ASSET_DIMENSION_INVALID')).toBe(true);
  });

  it('creates a valid default deck with an injectable ID and clock source', () => {
    const deck = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-07-15T10:00:00.000Z',
      locale: 'fr-FR',
      creator: 'Test',
    });
    expect(validateDeck(deck)).toMatchObject({ success: true });
    expect(deck.metadata).toMatchObject({ locale: 'fr-FR', creator: 'Test' });
    expect(new Set(deck.themes[0]?.textStyles.map((style) => style.role)).size).toBe(6);
  });

  it('reopens pre-marker V2 rotation without rotating final endpoints a second time', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const legacyConnector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000390',
      type: 'connector',
      name: 'Legacy rotated connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 90 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 85, yPt: -5, binding: {} },
      end: { xPt: 35, yPt: 95, binding: {} },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const legacyDocument = {
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? { ...candidate, elements: [...candidate.elements, legacyConnector] }
          : candidate,
      ),
    };

    const opened = parseDeck(JSON.parse(JSON.stringify(legacyDocument)));
    const reopened = parseDeck(JSON.parse(JSON.stringify(opened)));
    const migrated = opened.slides[2]!.elements.find(
      (element) => element.id === legacyConnector.id,
    );

    expect(migrated?.type).toBe('connector');
    if (migrated?.type !== 'connector') throw new Error('Missing migrated connector.');
    expect(migrated.geometryVersion).toBe(2);
    expect(migrated.start.xPt).toBeCloseTo(85, 10);
    expect(migrated.start.yPt).toBeCloseTo(-5, 10);
    expect(migrated.end.xPt).toBeCloseTo(35, 10);
    expect(migrated.end.yPt).toBeCloseTo(95, 10);
    expect(reopened).toEqual(opened);
    expect('geometryVersion' in legacyConnector).toBe(false);
  });
});

describe('projection and placeholders', () => {
  it('keeps the trusted-document resolver exactly in parity with the validating boundary', () => {
    const source = createNeutralDemoDeck();

    for (const slide of source.slides) {
      expect(resolveSlideFromValidatedDocument(source, slide.id)).toEqual(
        resolveSlide(source, slide.id),
      );
    }
  });

  it('resolves theme, master, layout, inherited frames, and inherited text style', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const slide = source.slides[0];
    const localTitle = slide?.elements[0];
    if (slide === undefined || localTitle?.type !== 'text') throw new Error('Missing title.');
    const moved: DeckDocument = {
      ...source,
      slides: [
        {
          ...slide,
          elements: [
            { ...localTitle, frame: { ...localTitle.frame, xPt: 400 } },
            ...slide.elements.slice(1),
          ],
        },
      ],
    };

    const resolved = resolveSlide(moved, slide.id);
    const title = resolved.elements.find((item) => item.element.id === localTitle.id);
    expect(resolved.background).toEqual({ type: 'solid', color: resolved.theme.colors.background });
    expect(title?.element.frame.xPt).toBe(72);
    expect(title?.resolvedTextStyle?.fontFamily).toBe('Arial');
    expect(resolved.elements.every((item) => item.element.type !== 'placeholder')).toBe(true);
  });

  it('honors explicit placeholder overrides and resets them transactionally', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const slide = source.slides[0];
    const title = slide?.elements[0];
    if (slide === undefined || title?.type !== 'text' || title.placeholderBinding === undefined) {
      throw new Error('Missing bound title.');
    }
    const overriddenTitle = {
      ...title,
      frame: { ...title.frame, xPt: 333 },
      visible: false,
      style: { fontFamily: 'Georgia', fontSizePt: 40 },
      placeholderBinding: {
        ...title.placeholderBinding,
        overrides: ['frame', 'style', 'visibility'] as const,
      },
    };
    const overridden: DeckDocument = {
      ...source,
      slides: [{ ...slide, elements: [overriddenTitle, ...slide.elements.slice(1)] }],
    };
    const projection = resolveSlide(overridden, slide.id);
    const projected = projection.elements.find((item) => item.element.id === title.id);
    expect(projected?.element.frame.xPt).toBe(333);
    expect(projected?.element.visible).toBe(false);
    expect(projected?.resolvedTextStyle?.fontFamily).toBe('Georgia');

    const reset = applyCommand(
      overridden,
      {
        type: 'slide.reset-placeholder',
        slideId: slide.id,
        placeholderId: title.placeholderBinding.placeholderId,
      },
      metadata(),
    );
    const resetTitle = reset.document.slides[0]?.elements[0];
    expect(resetTitle?.placeholderBinding?.overrides).toEqual([]);
    expect(resetTitle?.frame.xPt).toBe(72);
    expect(undoTransaction(reset.document, reset)).toEqual(overridden);
  });

  it('remaps layout bindings deterministically by placeholder role and accepted element type', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const layout = source.layouts[0];
    const slide = source.slides[0];
    const title = slide?.elements[0];
    const body = slide?.elements[1];
    const titlePlaceholder = layout?.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'title',
    );
    const bodyPlaceholder = layout?.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'body',
    );
    if (
      layout === undefined ||
      slide === undefined ||
      title === undefined ||
      body === undefined ||
      titlePlaceholder?.type !== 'placeholder' ||
      bodyPlaceholder?.type !== 'placeholder'
    ) {
      throw new Error('Missing layout fixture.');
    }

    const targetLayoutId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
    const incompatibleBodyId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
    const targetTitleId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003';
    const targetBodyId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000004';
    const fallbackBodyId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000005';
    const deck: DeckDocument = {
      ...source,
      layouts: [
        ...source.layouts,
        {
          ...layout,
          id: targetLayoutId,
          name: 'Alternative',
          elements: [
            {
              ...bodyPlaceholder,
              id: incompatibleBodyId,
              name: 'Image-only body',
              accepts: ['image'],
            },
            {
              ...titlePlaceholder,
              id: targetTitleId,
              name: 'Alternative title',
              frame: { ...titlePlaceholder.frame, yPt: 36 },
            },
            {
              ...bodyPlaceholder,
              id: targetBodyId,
              name: 'Alternative body',
              accepts: ['text'],
              frame: { ...bodyPlaceholder.frame, yPt: 180 },
            },
            {
              ...bodyPlaceholder,
              id: fallbackBodyId,
              name: 'Fallback body',
              accepts: ['text'],
            },
          ],
        },
      ],
    };
    const before = JSON.stringify(deck);

    const result = applyTransaction(
      deck,
      [{ type: 'slide.set-layout', slideId: slide.id, layoutId: targetLayoutId }],
      metadata('2'),
    );
    const changedSlide = result.document.slides[0];
    const changedTitle = changedSlide?.elements.find((element) => element.id === title.id);
    const changedBody = changedSlide?.elements.find((element) => element.id === body.id);

    expect(changedSlide?.layoutId).toBe(targetLayoutId);
    expect(changedTitle?.placeholderBinding).toEqual({
      ...title.placeholderBinding,
      placeholderId: targetTitleId,
    });
    expect(changedBody?.placeholderBinding).toEqual({
      ...body.placeholderBinding,
      placeholderId: targetBodyId,
    });
    expect(changedTitle?.frame).toEqual(title.frame);
    expect(changedBody?.frame).toEqual(body.frame);
    if (changedTitle?.type !== 'text' || title.type !== 'text') {
      throw new Error('Missing mapped title.');
    }
    if (changedBody?.type !== 'text' || body.type !== 'text') {
      throw new Error('Missing mapped body.');
    }
    expect(changedTitle.content).toEqual(title.content);
    expect(changedBody.content).toEqual(body.content);
    expect(validateDeck(result.document)).toMatchObject({ success: true });
    expect(JSON.stringify(deck)).toBe(before);
    expect(undoTransaction(result.document, result)).toEqual(deck);
  });

  it('keeps unmatched content local when the new layout has no role-and-type compatible placeholder', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const layout = source.layouts[0];
    const slide = source.slides[0];
    const title = slide?.elements[0];
    const body = slide?.elements[1];
    const titlePlaceholder = layout?.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'title',
    );
    const bodyPlaceholder = layout?.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'body',
    );
    if (
      layout === undefined ||
      slide === undefined ||
      title === undefined ||
      body === undefined ||
      titlePlaceholder?.type !== 'placeholder' ||
      bodyPlaceholder?.type !== 'placeholder'
    ) {
      throw new Error('Missing layout fixture.');
    }

    const targetLayoutId = 'cccccccc-cccc-4ccc-8ccc-000000000001';
    const targetTitleId = 'cccccccc-cccc-4ccc-8ccc-000000000002';
    const deck: DeckDocument = {
      ...source,
      layouts: [
        ...source.layouts,
        {
          ...layout,
          id: targetLayoutId,
          name: 'Title and image',
          elements: [
            { ...titlePlaceholder, id: targetTitleId },
            {
              ...bodyPlaceholder,
              id: 'cccccccc-cccc-4ccc-8ccc-000000000003',
              accepts: ['image'],
            },
          ],
        },
      ],
    };

    const result = applyCommand(
      deck,
      { type: 'slide.set-layout', slideId: slide.id, layoutId: targetLayoutId },
      metadata('3'),
    );
    const changedTitle = result.document.slides[0]?.elements.find(
      (element) => element.id === title.id,
    );
    const changedBody = result.document.slides[0]?.elements.find(
      (element) => element.id === body.id,
    );
    const { placeholderBinding: _bodyBinding, ...expectedLocalBody } = body;

    expect(changedTitle?.placeholderBinding?.placeholderId).toBe(targetTitleId);
    expect(changedBody).toEqual(expectedLocalBody);
    expect(validateDeck(result.document)).toMatchObject({ success: true });
  });

  it('treats resetting a valid but unused placeholder as a successful no-op', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const layout = source.layouts[0];
    const slide = source.slides[0];
    const titlePlaceholder = layout?.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'title',
    );
    if (layout === undefined || slide === undefined || titlePlaceholder?.type !== 'placeholder') {
      throw new Error('Missing placeholder fixture.');
    }
    const unusedPlaceholderId = 'dddddddd-dddd-4ddd-8ddd-000000000001';
    const partial: DeckDocument = {
      ...source,
      layouts: [
        {
          ...layout,
          elements: [
            ...layout.elements,
            {
              ...titlePlaceholder,
              id: unusedPlaceholderId,
              name: 'Optional subtitle',
              role: 'subtitle',
            },
          ],
        },
      ],
    };

    const result = applyCommand(
      partial,
      {
        type: 'slide.reset-placeholder',
        slideId: slide.id,
        placeholderId: unusedPlaceholderId,
      },
      metadata('4'),
    );

    expect(result.document.slides[0]?.elements).toEqual(slide.elements);
    expect(result.document.metadata.modifiedAt).toBe(metadata('4').metadata.timestamp);
    expect(validateDeck(result.document)).toMatchObject({ success: true });
    expect(undoTransaction(result.document, result)).toEqual(partial);
  });

  it('remaps live slide bindings when a layout is updated or deleted with a replacement', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const layout = source.layouts[0]!;
    const slide = source.slides[0]!;
    const replacementIds = new Map<string, string>();
    const replacementElements = layout.elements.map((element, index) => {
      const nextId = `e1000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      replacementIds.set(element.id, nextId);
      return { ...element, id: nextId };
    });
    const updated = applyCommand(
      source,
      {
        type: 'layout.update',
        layoutId: layout.id,
        replacement: { ...layout, elements: replacementElements },
      },
      metadata('5'),
    ).document;
    for (const element of slide.elements) {
      const oldPlaceholderId = element.placeholderBinding?.placeholderId;
      if (oldPlaceholderId !== undefined) {
        expect(
          updated.slides[0]?.elements.find((candidate) => candidate.id === element.id)
            ?.placeholderBinding?.placeholderId,
        ).toBe(replacementIds.get(oldPlaceholderId));
      }
    }
    expect(validateDeck(updated)).toMatchObject({ success: true });

    const alternateLayoutId = 'e1000000-0000-4000-8000-000000000100';
    const alternateIds = new Map<string, string>();
    const alternate = {
      ...layout,
      id: alternateLayoutId,
      name: 'Replacement layout',
      elements: layout.elements.map((element, index) => {
        const nextId = `e1000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`;
        alternateIds.set(element.id, nextId);
        return { ...element, id: nextId };
      }),
    };
    const deleted = applyCommand(
      { ...source, layouts: [...source.layouts, alternate] },
      {
        type: 'layout.delete',
        layoutId: layout.id,
        replacementLayoutId: alternateLayoutId,
      },
      metadata('6'),
    ).document;
    expect(deleted.slides[0]?.layoutId).toBe(alternateLayoutId);
    for (const element of slide.elements) {
      const oldPlaceholderId = element.placeholderBinding?.placeholderId;
      if (oldPlaceholderId !== undefined) {
        expect(
          deleted.slides[0]?.elements.find((candidate) => candidate.id === element.id)
            ?.placeholderBinding?.placeholderId,
        ).toBe(alternateIds.get(oldPlaceholderId));
      }
    }
    expect(validateDeck(deleted)).toMatchObject({ success: true });
  });

  it('remaps master placeholder bindings when a master is updated or replaced', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const master = source.masters[0]!;
    const layout = source.layouts[0]!;
    const slide = source.slides[0]!;
    const titlePlaceholder = layout.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'title',
    );
    const title = slide.elements.find((element) => element.type === 'text');
    if (titlePlaceholder?.type !== 'placeholder' || title?.type !== 'text') {
      throw new Error('Missing title fixture.');
    }
    const oldMasterPlaceholderId = 'e2000000-0000-4000-8000-000000000001';
    const masterPlaceholder = { ...titlePlaceholder, id: oldMasterPlaceholderId };
    const deck: DeckDocument = {
      ...source,
      masters: [{ ...master, elements: [...master.elements, masterPlaceholder] }],
      layouts: [
        {
          ...layout,
          elements: layout.elements.filter((element) => element.id !== titlePlaceholder.id),
        },
      ],
      slides: [
        {
          ...slide,
          elements: slide.elements.map((element) =>
            element.id === title.id
              ? {
                  ...element,
                  placeholderBinding: {
                    placeholderId: oldMasterPlaceholderId,
                    overrides: element.placeholderBinding?.overrides ?? [],
                  },
                }
              : element,
          ),
        },
      ],
    };
    expect(validateDeck(deck)).toMatchObject({ success: true });

    const updatedPlaceholderId = 'e2000000-0000-4000-8000-000000000002';
    const updated = applyCommand(
      deck,
      {
        type: 'master.update',
        masterId: master.id,
        replacement: {
          ...deck.masters[0]!,
          elements: [{ ...masterPlaceholder, id: updatedPlaceholderId }],
        },
      },
      metadata('7'),
    ).document;
    expect(
      updated.slides[0]?.elements.find((element) => element.id === title.id)?.placeholderBinding
        ?.placeholderId,
    ).toBe(updatedPlaceholderId);
    expect(validateDeck(updated)).toMatchObject({ success: true });

    const replacementMasterId = 'e2000000-0000-4000-8000-000000000003';
    const replacementPlaceholderId = 'e2000000-0000-4000-8000-000000000004';
    const replacementMaster = {
      ...master,
      id: replacementMasterId,
      name: 'Replacement master',
      elements: [{ ...masterPlaceholder, id: replacementPlaceholderId }],
    };
    const deleted = applyCommand(
      { ...deck, masters: [...deck.masters, replacementMaster] },
      {
        type: 'master.delete',
        masterId: master.id,
        replacementMasterId,
      },
      metadata('8'),
    ).document;
    expect(deleted.layouts[0]?.masterId).toBe(replacementMasterId);
    expect(
      deleted.slides[0]?.elements.find((element) => element.id === title.id)?.placeholderBinding
        ?.placeholderId,
    ).toBe(replacementPlaceholderId);
    expect(validateDeck(deleted)).toMatchObject({ success: true });
  });

  it('records placeholder overrides automatically when a user moves, styles, or hides bound content', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const slide = source.slides[0];
    const title = slide?.elements[0];
    if (slide === undefined || title?.type !== 'text') throw new Error('Missing bound title.');
    const result = applyTransaction(
      source,
      [
        {
          type: 'element.transform',
          slideId: slide.id,
          transforms: [{ elementId: title.id, frame: { ...title.frame, xPt: 210 } }],
        },
        {
          type: 'element.update-style',
          slideId: slide.id,
          elementId: title.id,
          patch: { kind: 'text', style: { fontFamily: 'Georgia', fontSizePt: 42 } },
        },
        { type: 'element.set-visible', slideId: slide.id, elementId: title.id, visible: false },
      ],
      metadata(),
    );
    const changed = result.document.slides[0]?.elements[0];
    expect(changed?.placeholderBinding?.overrides).toEqual(['frame', 'style', 'visibility']);
    const projected = resolveSlide(result.document, slide.id).elements.find(
      (entry) => entry.element.id === title.id,
    );
    expect(projected?.element.frame.xPt).toBe(210);
    expect(projected?.element.visible).toBe(false);
    expect(projected?.resolvedTextStyle?.fontFamily).toBe('Georgia');
  });

  it('rejects a binding to a placeholder that does not accept the element type', () => {
    const source = createDefaultDeck({
      idFactory: idFactory(),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const slide = source.slides[0];
    const title = slide?.elements[0];
    const body = slide?.elements[1];
    if (slide === undefined || title?.placeholderBinding === undefined || body === undefined) {
      throw new Error('Missing placeholders.');
    }
    const invalidElement: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
      type: 'shape',
      name: 'Bad binding',
      frame: body.frame,
      opacity: 1,
      visible: true,
      locked: false,
      placeholderBinding: { placeholderId: title.placeholderBinding.placeholderId, overrides: [] },
      shape: 'rectangle',
      fill: '#FFFFFF',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const result = validateDeck({
      ...source,
      slides: [{ ...slide, elements: [...slide.elements, invalidElement] }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid binding.');
    expect(result.issues.some((issue) => issue.code === 'PLACEHOLDER_BINDING_INVALID')).toBe(true);
  });
});

describe('strict V1 command contract and CRUD', () => {
  it('rejects unknown fields and empty partial updates', () => {
    expect(
      documentCommandSchema.safeParse({ type: 'deck.rename', name: 'New', extra: true }).success,
    ).toBe(false);
    expect(
      documentCommandSchema.safeParse({
        type: 'slide.update',
        slideId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      }).success,
    ).toBe(false);
  });

  it('renames, resizes, updates export options, and modifiedAt without mutating the input', () => {
    const source = createNeutralDemoDeck();
    const json = JSON.stringify(source);
    const result = applyTransaction(
      source,
      [
        { type: 'deck.rename', name: 'Renamed deck' },
        { type: 'deck.set-page', page: { widthPt: 720, heightPt: 540 } },
        { type: 'deck.set-export-options', includeHiddenSlidesInExport: true },
      ],
      metadata(),
    );
    expect(result.document.name).toBe('Renamed deck');
    expect(result.document.page.widthPt).toBe(720);
    expect(result.document.settings.includeHiddenSlidesInExport).toBe(true);
    expect(result.document.metadata.modifiedAt).toBe(metadata().metadata.timestamp);
    expect(JSON.stringify(source)).toBe(json);
  });

  it('creates and deletes themes while safely rewiring dependent masters', () => {
    const source = createNeutralDemoDeck();
    const originalTheme = source.themes[0];
    if (originalTheme === undefined) throw new Error('Missing theme.');
    const replacement = {
      ...originalTheme,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000010',
      name: 'Replacement',
      textStyles: originalTheme.textStyles.map((style, index) => ({
        ...style,
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${(index + 20).toString().padStart(12, '0')}`,
      })),
    };
    const result = applyTransaction(
      source,
      [
        { type: 'theme.create', theme: replacement },
        {
          type: 'theme.delete',
          themeId: originalTheme.id,
          replacementThemeId: replacement.id,
        },
      ],
      metadata(),
    );
    expect(result.document.themes.map((theme) => theme.id)).toEqual([replacement.id]);
    expect(result.document.masters.every((master) => master.themeId === replacement.id)).toBe(true);
  });

  it('blocks deletion of an in-use resource when no replacement is supplied', () => {
    const source = createNeutralDemoDeck();
    const second = {
      ...source.layouts[0]!,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000099',
      name: 'Unused layout',
      elements: [],
    };
    const withSecond = applyCommand(
      source,
      { type: 'layout.create', layout: second },
      metadata(),
    ).document;
    expect(() =>
      applyCommand(
        withSecond,
        { type: 'layout.delete', layoutId: source.layouts[0]!.id },
        metadata('2'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_IN_USE' }));
  });

  it('duplicates a slide with fresh nested IDs and connector-safe references', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[1]!;
    const duplicate = createDuplicateSlide(source, slide.id, idFactory());
    const result = applyCommand(
      source,
      { type: 'slide.duplicate', slideId: slide.id, duplicate },
      metadata(),
    );
    expect(result.document.slides[2]?.id).toBe(duplicate.id);
    expect(validateDeck(result.document)).toMatchObject({ success: true });
    expect(
      new Set([...slide.elements, ...duplicate.elements].map((element) => element.id)).size,
    ).toBe(slide.elements.length + duplicate.elements.length);
  });
});

describe('element, text, table, asset, and connector commands', () => {
  it('updates compatible styles, visibility, lock state, and stacking order', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const first = slide.elements[0]!;
    const result = applyTransaction(
      source,
      [
        {
          type: 'element.update-style',
          slideId: slide.id,
          elementId: first.id,
          patch: { kind: 'text', opacity: 0.5, style: { fontFamily: 'Georgia', fontSizePt: 22 } },
        },
        { type: 'element.set-visible', slideId: slide.id, elementId: first.id, visible: false },
        { type: 'element.reorder', slideId: slide.id, elementId: first.id, toIndex: 1 },
        { type: 'element.set-locked', slideId: slide.id, elementId: first.id, locked: true },
      ],
      metadata(),
    );
    const changed = result.document.slides[0]!.elements[1]!;
    expect(changed).toMatchObject({ id: first.id, opacity: 0.5, visible: false, locked: true });
    expect(changed.type === 'text' ? changed.style?.fontFamily : undefined).toBe('Georgia');
  });

  it('replaces rich text content and rejects a text command targeting a shape', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const text = slide.elements[0]!;
    const content = {
      blocks: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000111',
          type: 'heading' as const,
          level: 2 as const,
          alignment: 'center' as const,
          runs: [
            {
              text: 'Replacement',
              marks: {
                bold: true,
                italic: false,
                underline: false,
                strikethrough: false,
                fontFamily: 'Inter',
                fontSizePt: 20,
                fontWeight: 700,
              },
            },
          ],
        },
      ],
    };
    const result = applyCommand(
      source,
      { type: 'text.replace-content', slideId: slide.id, textId: text.id, content },
      metadata(),
    );
    expect(result.document.slides[0]!.elements[0]).toMatchObject({ content });
  });

  it('parses quoted spreadsheet TSV and pastes it without changing cell IDs', () => {
    expect(parseTsv('"A\tB"\tC\r\nD\t"E""F"')).toEqual([
      ['A\tB', 'C'],
      ['D', 'E"F'],
    ]);
    const source = createNeutralDemoDeck();
    const fixture = requireTable(source);
    const ids = fixture.table.cells.map((cell) => cell.id);
    const result = applyCommand(
      source,
      {
        type: 'table.paste-tsv',
        slideId: fixture.slideId,
        tableId: fixture.table.id,
        startRow: 1,
        startColumn: 0,
        tsv: 'A\tB\r\nC\tD',
      },
      metadata(),
    );
    const table = requireTable(result.document).table;
    expect(table.cells.map((cell) => cell.id)).toEqual(ids);
    expect(table.cells.filter((cell) => cell.row > 0).map(textOfCell)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('inserts and deletes simple table rows atomically', () => {
    const source = createNeutralDemoDeck();
    const fixture = requireTable(source);
    const cells = fixture.table.cells.slice(0, 2).map((cell, column): TableCell => ({
      ...cell,
      id: `bbbbbbbb-bbbb-4bbb-8bbb-${(column + 200).toString().padStart(12, '0')}`,
      row: 1,
      column,
      content: {
        blocks: [
          {
            ...cell.content.blocks[0]!,
            id: `bbbbbbbb-bbbb-4bbb-8bbb-${(column + 210).toString().padStart(12, '0')}`,
          },
        ],
      },
    }));
    const inserted = applyCommand(
      source,
      {
        type: 'table.insert-row',
        slideId: fixture.slideId,
        tableId: fixture.table.id,
        index: 1,
        heightPt: 60,
        cells,
      },
      metadata(),
    );
    expect(requireTable(inserted.document).table.rowCount).toBe(4);
    const deleted = applyCommand(
      inserted.document,
      { type: 'table.delete-row', slideId: fixture.slideId, tableId: fixture.table.id, index: 1 },
      metadata('2'),
    );
    expect(requireTable(deleted.document).table.rowCount).toBe(3);
  });

  it('rejects structural edits of merged tables and out-of-range TSV atomically', () => {
    const source = createNeutralDemoDeck();
    const fixture = requireTable(source);
    expect(() =>
      applyCommand(
        source,
        {
          type: 'table.paste-tsv',
          slideId: fixture.slideId,
          tableId: fixture.table.id,
          startRow: 2,
          startColumn: 1,
          tsv: 'A\tB',
        },
        metadata(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_SELECTION' }));
    expect(requireTable(source).table.rowCount).toBe(3);
  });

  it('registers dimensioned assets and blocks removal while referenced', () => {
    const source = createNeutralDemoDeck();
    const asset = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000300',
      kind: 'image' as const,
      hash: 'b'.repeat(64),
      mediaType: 'image/png',
      fileName: 'image.png',
      byteLength: 100,
      widthPx: 100,
      heightPx: 80,
    };
    const registered = applyCommand(source, { type: 'asset.register', asset }, metadata());
    const slide = registered.document.slides[2]!;
    const image: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000301',
      type: 'image',
      name: 'Image',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 80, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId: asset.id,
      altText: 'Test',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const used = applyCommand(
      registered.document,
      { type: 'element.insert', slideId: slide.id, element: image },
      metadata('2'),
    );
    expect(() =>
      applyCommand(used.document, { type: 'asset.remove', assetId: asset.id }, metadata('3')),
    ).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_IN_USE' }));
    const removed = applyCommand(
      registered.document,
      { type: 'asset.remove', assetId: asset.id },
      metadata('2'),
    );
    expect(removed.document.assets).toHaveLength(0);
  });

  it('updates connector endpoints and validates bound targets', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target = slide.elements[0]!;
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000401',
      type: 'connector',
      name: 'Connector',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 0, yPt: 0, binding: {} },
      end: { xPt: 100, yPt: 100, binding: {} },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const result = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: connector },
        {
          type: 'connector.update-endpoint',
          slideId: slide.id,
          connectorId: connector.id,
          endpoint: 'end',
          value: { xPt: 10, yPt: 20, binding: { elementId: target.id, anchor: 'left' } },
        },
      ],
      metadata(),
    );
    const updated = result.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );
    expect(updated?.type === 'connector' ? updated.end.binding.elementId : undefined).toBe(
      target.id,
    );
  });

  it('frees a nested bound endpoint at its current painted anchor after the target moves', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000402',
      type: 'shape',
      name: 'Nested moving endpoint target',
      frame: { xPt: 10, yPt: 10, widthPt: 40, heightPt: 20, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000403',
      type: 'connector',
      geometryVersion: 2,
      name: 'Nested bound connector',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 0, yPt: 0, binding: {} },
      end: { xPt: 99, yPt: 88, binding: { elementId: target.id, anchor: 'right' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const filler: Element = {
      ...target,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000404',
      name: 'Nested endpoint filler',
      frame: { xPt: 70, yPt: 10, widthPt: 10, heightPt: 10, rotationDeg: 0 },
    };
    const group: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000405',
      type: 'group',
      name: 'Nested endpoint group',
      frame: { xPt: 100, yPt: 50, widthPt: 200, heightPt: 100, rotationDeg: 30 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 100, heightPt: 50 },
      children: [target, connector, filler],
    };
    const inserted = applyCommand(
      source,
      { type: 'element.insert', slideId: slide.id, element: group },
      metadata(),
    );
    const movedTarget = applyCommand(
      inserted.document,
      {
        type: 'element.transform',
        slideId: slide.id,
        containerId: group.id,
        transforms: [
          {
            elementId: target.id,
            frame: { xPt: 20, yPt: 10, widthPt: 40, heightPt: 20, rotationDeg: 90 },
          },
        ],
      },
      metadata('2'),
    );
    const effectiveBeforeFree = resolveDocumentConnectorGeometries(
      movedTarget.document.slides[2]!.elements,
    ).get(connector.id)!;
    expect(effectiveBeforeFree.endInContainer).toEqual({ xPt: 40, yPt: 40 });

    const freed = applyCommand(
      movedTarget.document,
      {
        type: 'connector.update-endpoint',
        slideId: slide.id,
        containerId: group.id,
        connectorId: connector.id,
        endpoint: 'end',
        value: { xPt: 99, yPt: 88, binding: {} },
      },
      metadata('3'),
    );
    const freedGroup = freed.document.slides[2]!.elements.find(
      (element) => element.id === group.id,
    );
    const result =
      freedGroup?.type === 'group'
        ? freedGroup.children.find((element) => element.id === connector.id)
        : undefined;
    expect(result?.type === 'connector' ? result.end : undefined).toEqual({
      xPt: 40,
      yPt: 40,
      binding: {},
    });
    expect(undoTransaction(freed.document, freed)).toEqual(movedTarget.document);
  });

  it('moves, resizes, and rotates connector fallback endpoints with their frame', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000410',
      type: 'connector',
      name: 'Transformable connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 10, yPt: 20, binding: {} },
      end: { xPt: 110, yPt: 70, binding: {} },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const inserted = applyCommand(
      source,
      { type: 'element.insert', slideId: slide.id, element: connector },
      metadata(),
    );
    const transform = (document: DeckDocument, frame: Element['frame'], suffix: string) =>
      applyCommand(
        document,
        {
          type: 'element.transform',
          slideId: slide.id,
          transforms: [{ elementId: connector.id, frame }],
        },
        metadata(suffix),
      );
    const requireConnector = (document: DeckDocument) => {
      const element = document.slides[2]!.elements.find(
        (candidate) => candidate.id === connector.id,
      );
      if (element?.type !== 'connector') throw new Error('Missing connector fixture.');
      return element;
    };

    const moved = transform(
      inserted.document,
      { xPt: 30, yPt: 40, widthPt: 100, heightPt: 50, rotationDeg: 0 },
      '2',
    );
    expect(requireConnector(moved.document)).toMatchObject({
      start: { xPt: 30, yPt: 40, binding: {} },
      end: { xPt: 130, yPt: 90, binding: {} },
    });

    const resized = transform(
      moved.document,
      { xPt: 30, yPt: 40, widthPt: 200, heightPt: 100, rotationDeg: 0 },
      '3',
    );
    expect(requireConnector(resized.document)).toMatchObject({
      start: { xPt: 30, yPt: 40, binding: {} },
      end: { xPt: 230, yPt: 140, binding: {} },
    });

    const rotated = transform(
      resized.document,
      { xPt: 30, yPt: 40, widthPt: 200, heightPt: 100, rotationDeg: 90 },
      '4',
    );
    const result = requireConnector(rotated.document);
    expect(result.start.xPt).toBeCloseTo(180, 10);
    expect(result.start.yPt).toBeCloseTo(-10, 10);
    expect(result.end.xPt).toBeCloseTo(80, 10);
    expect(result.end.yPt).toBeCloseTo(190, 10);
    expect(result.end.binding).toEqual({});
    expect(undoTransaction(rotated.document, rotated)).toEqual(resized.document);
  });

  it('rejects connector geometry and binding changes through generic replacement atomically', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target = slide.elements[0]!;
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000417',
      type: 'connector',
      name: 'Guarded connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 17 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 10, yPt: 20, binding: {} },
      end: { xPt: 110, yPt: 70, binding: { elementId: target.id, anchor: 'left' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const inserted = applyCommand(
      source,
      { type: 'element.insert', slideId: slide.id, element: connector },
      metadata(),
    );
    const current = inserted.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );
    if (current?.type !== 'connector') throw new Error('Missing guarded connector.');

    const replacements: readonly Element[] = [
      { ...current, frame: { ...current.frame, xPt: current.frame.xPt + 10 } },
      { ...current, start: { ...current.start, xPt: current.start.xPt + 10 } },
      { ...current, end: { ...current.end, binding: {} } },
    ];
    for (const replacement of replacements) {
      expect(() =>
        applyCommand(
          inserted.document,
          {
            type: 'element.update',
            slideId: slide.id,
            elementId: connector.id,
            replacement,
          },
          metadata('2'),
        ),
      ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    }

    const before = structuredClone(inserted.document);
    expect(() =>
      applyTransaction(
        inserted.document,
        [
          { type: 'deck.rename', name: 'Must not leak from failed transaction' },
          {
            type: 'element.update',
            slideId: slide.id,
            elementId: connector.id,
            replacement: replacements[0]!,
          },
        ],
        metadata('3'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    expect(inserted.document).toEqual(before);

    const restyled = applyCommand(
      inserted.document,
      {
        type: 'element.update',
        slideId: slide.id,
        elementId: connector.id,
        replacement: {
          ...current,
          stroke: { ...current.stroke, color: '#ff0000' },
        },
      },
      metadata('4'),
    );
    expect(
      restyled.document.slides[2]!.elements.find((element) => element.id === connector.id),
    ).toMatchObject({ stroke: { color: '#ff0000' } });
  });

  it('keeps group replacement properties editable without exposing its child structure', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000511',
      type: 'shape',
      name: 'Protected nested target',
      frame: { xPt: 10, yPt: 10, widthPt: 30, heightPt: 20, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const filler: Element = {
      ...target,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000512',
      name: 'Protected nested filler',
      frame: { xPt: 50, yPt: 10, widthPt: 20, heightPt: 20, rotationDeg: 0 },
    };
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000513',
      type: 'connector',
      name: 'Protected nested connector',
      frame: { xPt: 0, yPt: 0, widthPt: 90, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 0, yPt: 25, binding: {} },
      end: { xPt: 25, yPt: 20, binding: { elementId: target.id, anchor: 'center' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const group: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000514',
      type: 'group',
      name: 'Protected group',
      frame: { xPt: 100, yPt: 100, widthPt: 100, heightPt: 60, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 100, heightPt: 60 },
      children: [target, filler, connector],
    };
    const inserted = applyCommand(
      source,
      { type: 'element.insert', slideId: slide.id, element: group },
      metadata(),
    );
    const current = inserted.document.slides[2]!.elements.find(
      (element) => element.id === group.id,
    );
    if (current?.type !== 'group') throw new Error('Missing protected group.');
    const currentConnector = current.children.find((element) => element.id === connector.id);
    if (currentConnector?.type !== 'connector') {
      throw new Error('Missing protected nested connector.');
    }

    const endpointMutation: Element = {
      ...current,
      children: current.children.map((element) =>
        element.id === currentConnector.id
          ? { ...currentConnector, end: { ...currentConnector.end, xPt: 999 } }
          : element,
      ),
    };
    const before = structuredClone(inserted.document);
    expect(() =>
      applyTransaction(
        inserted.document,
        [
          { type: 'deck.rename', name: 'Must remain atomic' },
          {
            type: 'element.update',
            slideId: slide.id,
            elementId: current.id,
            replacement: endpointMutation,
          },
        ],
        metadata('2'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));
    expect(inserted.document).toEqual(before);

    expect(() =>
      applyCommand(
        inserted.document,
        {
          type: 'element.update',
          slideId: slide.id,
          elementId: current.id,
          replacement: {
            ...current,
            children: current.children.filter((element) => element.id !== target.id),
          },
        },
        metadata('3'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }));

    const propertiesOnly = applyCommand(
      inserted.document,
      {
        type: 'element.update',
        slideId: slide.id,
        elementId: current.id,
        replacement: {
          ...current,
          name: 'Restyled protected group',
          frame: { ...current.frame, xPt: 140, rotationDeg: 20 },
          opacity: 0.75,
          children: current.children,
        },
      },
      metadata('4'),
    );
    const result = propertiesOnly.document.slides[2]!.elements.find(
      (element) => element.id === current.id,
    );
    expect(result).toMatchObject({
      name: 'Restyled protected group',
      frame: { xPt: 140, rotationDeg: 20 },
      opacity: 0.75,
    });
    expect(result?.type === 'group' ? result.children : undefined).toEqual(current.children);
  });

  it('atomically materializes and detaches a moved connector while a moved target keeps binding live', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000418',
      type: 'shape',
      name: 'Movable binding target',
      frame: { xPt: 300, yPt: 100, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000419',
      type: 'connector',
      geometryVersion: 2,
      name: 'Bound movable connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 10, yPt: 20, binding: {} },
      end: { xPt: 110, yPt: 70, binding: { elementId: target.id, anchor: 'right' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const inserted = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: target },
        { type: 'element.insert', slideId: slide.id, element: connector },
      ],
      metadata(),
    );
    const initialGeometry = resolveDocumentConnectorGeometries(
      inserted.document.slides[2]!.elements,
    ).get(connector.id)!;
    expect(initialGeometry.endInContainer).toEqual({ xPt: 400, yPt: 150 });

    const movedConnector = applyCommand(
      inserted.document,
      {
        type: 'element.transform',
        slideId: slide.id,
        transforms: [
          {
            elementId: connector.id,
            frame: { ...connector.frame, xPt: 30, yPt: 40 },
          },
        ],
      },
      metadata('2'),
    );
    const detached = movedConnector.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );
    if (detached?.type !== 'connector') throw new Error('Missing detached connector.');
    expect(detached.start).toEqual({ xPt: 30, yPt: 40, binding: {} });
    expect(detached.end).toEqual({ xPt: 420, yPt: 170, binding: {} });
    expect(undoTransaction(movedConnector.document, movedConnector)).toEqual(inserted.document);

    const movedTarget = applyCommand(
      inserted.document,
      {
        type: 'element.transform',
        slideId: slide.id,
        transforms: [
          {
            elementId: target.id,
            frame: { ...target.frame, xPt: target.frame.xPt + 50, rotationDeg: 90 },
          },
        ],
      },
      metadata('3'),
    );
    const stillBound = movedTarget.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );
    expect(stillBound?.type === 'connector' ? stillBound.end.binding : undefined).toEqual({
      elementId: target.id,
      anchor: 'right',
    });
    const followed = resolveDocumentConnectorGeometries(
      movedTarget.document.slides[2]!.elements,
    ).get(connector.id)!;
    expect(followed.endInContainer).toEqual({ xPt: 400, yPt: 200 });
    expect(undoTransaction(movedTarget.document, movedTarget)).toEqual(inserted.document);
  });

  it('aligns connector fallback geometry rather than its padded editing frame', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const bindingTarget: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000416',
      type: 'shape',
      name: 'Moved binding target',
      frame: { xPt: 200, yPt: 100, widthPt: 50, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000411',
      type: 'connector',
      geometryVersion: 2,
      name: 'Alignment connector',
      frame: { xPt: 250, yPt: 60, widthPt: 240, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 300, yPt: 110, binding: {} },
      end: {
        xPt: 400,
        yPt: 110,
        binding: { elementId: bindingTarget.id, anchor: 'right' },
      },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const shape: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000412',
      type: 'shape',
      name: 'Alignment shape',
      frame: { xPt: 800, yPt: 200, widthPt: 50, heightPt: 30, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const inserted = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: bindingTarget },
        { type: 'element.insert', slideId: slide.id, element: connector },
        { type: 'element.insert', slideId: slide.id, element: shape },
      ],
      metadata(),
    );
    const aligned = applyCommand(
      inserted.document,
      {
        type: 'element.align',
        slideId: slide.id,
        elementIds: [connector.id, shape.id],
        mode: 'right',
        relativeTo: 'selection',
      },
      metadata('2'),
    );
    const result = aligned.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );

    if (result?.type !== 'connector') throw new Error('Missing aligned connector.');
    expect(result.frame.xPt).toBe(800);
    expect(result.start).toMatchObject({ xPt: 850, yPt: 110, binding: {} });
    expect(result.end).toMatchObject({ xPt: 800, yPt: 125, binding: {} });
    expect(undoTransaction(aligned.document, aligned)).toEqual(inserted.document);
  });

  it('distributes effective connector widths with equal visual gaps and atomic detachment', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const bindingTarget: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000417',
      type: 'shape',
      name: 'Moved distribution target',
      frame: { xPt: 500, yPt: 100, widthPt: 50, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector = (id: string, startX: number, width: number, binding = false): Element => ({
      id,
      type: 'connector',
      geometryVersion: 2,
      name: `Distributed connector ${id.slice(-1)}`,
      frame: { xPt: startX - 40, yPt: 80, widthPt: width + 80, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: startX, yPt: 130, binding: {} },
      end: {
        xPt: startX + width,
        yPt: 130,
        binding: binding ? { elementId: bindingTarget.id, anchor: 'left' } : {},
      },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    });
    const connectors = [
      connector('bbbbbbbb-bbbb-4bbb-8bbb-000000000413', 100, 20),
      connector('bbbbbbbb-bbbb-4bbb-8bbb-000000000414', 330, 40, true),
      connector('bbbbbbbb-bbbb-4bbb-8bbb-000000000415', 800, 60),
    ];
    const inserted = applyTransaction(
      source,
      [
        { type: 'element.insert' as const, slideId: slide.id, element: bindingTarget },
        ...connectors.map((element) => ({
          type: 'element.insert' as const,
          slideId: slide.id,
          element,
        })),
      ],
      metadata(),
    );
    const distributed = applyCommand(
      inserted.document,
      {
        type: 'element.distribute',
        slideId: slide.id,
        elementIds: connectors.map(({ id }) => id),
        axis: 'horizontal',
        relativeTo: 'selection',
      },
      metadata('2'),
    );
    const results = connectors.map(({ id }) => {
      const element = distributed.document.slides[2]!.elements.find(
        (candidate) => candidate.id === id,
      );
      if (element?.type !== 'connector') throw new Error(`Missing distributed connector ${id}.`);
      return element;
    });
    const firstGap = results[1]!.start.xPt - results[0]!.end.xPt;
    const secondGap = results[2]!.start.xPt - results[1]!.end.xPt;

    expect(firstGap).toBeCloseTo(secondGap, 10);
    expect(results[0]!.start.xPt).toBe(100);
    expect(results[2]!.end.xPt).toBe(860);
    expect(results[1]!.end.binding).toEqual({});
    expect(undoTransaction(distributed.document, distributed)).toEqual(inserted.document);
  });

  it('preserves connector geometry while grouping, transforming, and ungrouping', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const filler: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000421',
      type: 'shape',
      name: 'Grouping target',
      frame: { xPt: 50, yPt: 30, widthPt: 10, heightPt: 10, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const connector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000420',
      type: 'connector',
      name: 'Grouped connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 10, yPt: 20, binding: {} },
      end: { xPt: 110, yPt: 70, binding: { elementId: filler.id, anchor: 'center' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const groupId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000422';
    const inserted = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: connector },
        { type: 'element.insert', slideId: slide.id, element: filler },
      ],
      metadata(),
    );
    const grouped = applyCommand(
      inserted.document,
      {
        type: 'element.group',
        slideId: slide.id,
        elementIds: [connector.id, filler.id],
        groupId,
        name: 'Connector group',
      },
      metadata('2'),
    );
    const beforeGroupingGeometry = resolveDocumentConnectorGeometries(
      inserted.document.slides[2]!.elements,
    ).get(connector.id);
    const afterGroupingGeometry = resolveDocumentConnectorGeometries(
      grouped.document.slides[2]!.elements,
    ).get(connector.id);
    const group = grouped.document.slides[2]!.elements.find((element) => element.id === groupId);
    expect(group?.frame).toEqual({
      xPt: 10,
      yPt: 20,
      widthPt: 50,
      heightPt: 20,
      rotationDeg: 0,
    });
    expect(afterGroupingGeometry?.startInDocument).toEqual(beforeGroupingGeometry?.startInDocument);
    expect(afterGroupingGeometry?.endInDocument).toEqual(beforeGroupingGeometry?.endInDocument);
    const groupedConnector =
      group?.type === 'group'
        ? group.children.find((element) => element.id === connector.id)
        : undefined;
    expect(groupedConnector?.type === 'connector' ? groupedConnector.start : null).toEqual({
      xPt: 0,
      yPt: 0,
      binding: {},
    });
    expect(groupedConnector?.type === 'connector' ? groupedConnector.end : null).toEqual({
      xPt: 100,
      yPt: 50,
      binding: { elementId: filler.id, anchor: 'center' },
    });

    const transformed = applyCommand(
      grouped.document,
      {
        type: 'element.transform',
        slideId: slide.id,
        transforms: [
          {
            elementId: groupId,
            frame: { xPt: 30, yPt: 40, widthPt: 200, heightPt: 100, rotationDeg: 90 },
          },
        ],
      },
      metadata('3'),
    );
    const ungrouped = applyCommand(
      transformed.document,
      { type: 'element.ungroup', slideId: slide.id, groupId },
      metadata('4'),
    );
    const beforeUngroupGeometry = resolveDocumentConnectorGeometries(
      transformed.document.slides[2]!.elements,
    ).get(connector.id);
    const afterUngroupGeometry = resolveDocumentConnectorGeometries(
      ungrouped.document.slides[2]!.elements,
    ).get(connector.id);
    const result = ungrouped.document.slides[2]!.elements.find(
      (element) => element.id === connector.id,
    );
    if (result?.type !== 'connector') throw new Error('Missing ungrouped connector.');
    expect(afterUngroupGeometry?.startInDocument).toEqual(beforeUngroupGeometry?.startInDocument);
    expect(afterUngroupGeometry?.endInDocument).toEqual(beforeUngroupGeometry?.endInDocument);
    expect(result.end.binding).toEqual({ elementId: filler.id, anchor: 'center' });
    expect(validateDeck(ungrouped.document)).toMatchObject({ success: true });
    expect(undoTransaction(ungrouped.document, ungrouped)).toEqual(transformed.document);
  });

  it('groups and ungroups a rotated legacy connector without a second rotation', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000423',
      type: 'shape',
      name: 'Legacy binding target',
      frame: { xPt: 50, yPt: 30, widthPt: 10, heightPt: 10, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const legacyConnector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000424',
      type: 'connector',
      name: 'Legacy grouped connector',
      frame: { xPt: 10, yPt: 20, widthPt: 100, heightPt: 50, rotationDeg: 90 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 85, yPt: -5, binding: {} },
      end: { xPt: 35, yPt: 95, binding: { elementId: target.id, anchor: 'center' } },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const inserted = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: legacyConnector },
        { type: 'element.insert', slideId: slide.id, element: target },
      ],
      metadata(),
    );
    const groupId = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000425';
    const grouped = applyCommand(
      inserted.document,
      {
        type: 'element.group',
        slideId: slide.id,
        elementIds: [legacyConnector.id, target.id],
        groupId,
        name: 'Legacy geometry group',
      },
      metadata('2'),
    );
    const ungrouped = applyCommand(
      grouped.document,
      { type: 'element.ungroup', slideId: slide.id, groupId },
      metadata('3'),
    );
    const before = inserted.document.slides[2]!.elements.find(
      (element) => element.id === legacyConnector.id,
    );
    const after = ungrouped.document.slides[2]!.elements.find(
      (element) => element.id === legacyConnector.id,
    );

    expect(after).toEqual(before);
    expect(after?.type === 'connector' ? after.geometryVersion : undefined).toBe(2);
    expect(after?.type === 'connector' ? after.end.binding : undefined).toEqual({
      elementId: target.id,
      anchor: 'center',
    });
    expect(undoTransaction(ungrouped.document, ungrouped)).toEqual(grouped.document);
  });

  it('releases connector bindings recursively when a target or its group is deleted', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[2]!;
    const target: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000501',
      type: 'shape',
      name: 'Nested target',
      frame: { xPt: 10, yPt: 10, widthPt: 40, heightPt: 30, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#ffffff',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      cornerRadiusPt: 0,
    };
    const nestedConnector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000502',
      type: 'connector',
      name: 'Nested connector',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 60, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 7, yPt: 8, binding: { elementId: target.id, anchor: 'left' } },
      end: { xPt: 90, yPt: 50, binding: {} },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'none',
    };
    const filler: Element = {
      ...target,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000504',
      name: 'Nested filler',
      frame: { xPt: 60, yPt: 10, widthPt: 30, heightPt: 30, rotationDeg: 0 },
    };
    const group: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000500',
      type: 'group',
      name: 'Target group',
      frame: { xPt: 100, yPt: 100, widthPt: 120, heightPt: 80, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 120, heightPt: 80 },
      children: [target, filler, nestedConnector],
    };
    const rootConnector: Element = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000503',
      type: 'connector',
      name: 'Root connector',
      frame: { xPt: 0, yPt: 0, widthPt: 300, heightPt: 200, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 1, yPt: 2, binding: {} },
      end: { xPt: 203, yPt: 104, binding: { elementId: target.id, anchor: 'center' } },
      routing: 'elbow',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const withBindings = applyTransaction(
      source,
      [
        { type: 'element.insert', slideId: slide.id, element: group },
        { type: 'element.insert', slideId: slide.id, element: rootConnector },
      ],
      metadata(),
    );

    const targetDeleted = applyCommand(
      withBindings.document,
      {
        type: 'element.delete',
        slideId: slide.id,
        containerId: group.id,
        elementIds: [target.id],
      },
      metadata('2'),
    );
    const changedGroup = targetDeleted.document.slides[2]!.elements.find(
      (element) => element.id === group.id,
    );
    const changedNestedConnector =
      changedGroup?.type === 'group'
        ? changedGroup.children.find((element) => element.id === nestedConnector.id)
        : undefined;
    const changedRootConnector = targetDeleted.document.slides[2]!.elements.find(
      (element) => element.id === rootConnector.id,
    );
    expect(
      changedNestedConnector?.type === 'connector' ? changedNestedConnector.start : null,
    ).toEqual({ xPt: 10, yPt: 25, binding: {} });
    expect(changedRootConnector?.type === 'connector' ? changedRootConnector.end : null).toEqual({
      xPt: 130,
      yPt: 125,
      binding: {},
    });
    expect(validateDeck(targetDeleted.document)).toMatchObject({ success: true });
    expect(undoTransaction(targetDeleted.document, targetDeleted)).toEqual(withBindings.document);

    const groupDeleted = applyCommand(
      withBindings.document,
      { type: 'element.delete', slideId: slide.id, elementIds: [group.id] },
      metadata('3'),
    );
    const survivingConnector = groupDeleted.document.slides[2]!.elements.find(
      (element) => element.id === rootConnector.id,
    );
    expect(survivingConnector?.type === 'connector' ? survivingConnector.end : null).toEqual({
      xPt: 130,
      yPt: 125,
      binding: {},
    });
    expect(validateDeck(groupDeleted.document)).toMatchObject({ success: true });
    expect(undoTransaction(groupDeleted.document, groupDeleted)).toEqual(withBindings.document);
  });

  it('rolls back an earlier valid command when a later command fails', () => {
    const source = createNeutralDemoDeck();
    expect(() =>
      applyTransaction(
        source,
        [
          { type: 'deck.rename', name: 'Should roll back' },
          { type: 'asset.remove', assetId: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000999' },
        ],
        metadata(),
      ),
    ).toThrow(DocumentCommandError);
    expect(source.name).toBe('Neutral demonstration');
  });
});
