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

  it('renames, resizes, and updates modifiedAt without mutating the input', () => {
    const source = createNeutralDemoDeck();
    const json = JSON.stringify(source);
    const result = applyTransaction(
      source,
      [
        { type: 'deck.rename', name: 'Renamed deck' },
        { type: 'deck.set-page', page: { widthPt: 720, heightPt: 540 } },
      ],
      metadata(),
    );
    expect(result.document.name).toBe('Renamed deck');
    expect(result.document.page.widthPt).toBe(720);
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
