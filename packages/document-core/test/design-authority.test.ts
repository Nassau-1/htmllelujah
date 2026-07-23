import { describe, expect, it } from 'vitest';

import {
  applyCommand,
  createBlankTheme,
  createBoundedPageSize,
  createDynamicFieldValues,
  createNeutralDemoDeck,
  createRevisionToken,
  DEFAULT_BLANK_THEME_NAME,
  DOCUMENT_LIMITS,
  documentCommandSchema,
  enforceThemeAcrossDeck,
  resetElementThemeStyles,
  resolveDynamicFieldText,
  resolveElementDynamicFields,
  resolveSlide,
  undoTransaction,
  validateDeck,
  type DeckDocument,
  type Element,
  type RichTextDocument,
  type TextElement,
  type Theme,
} from '../src/index.js';

const idFactory = (): (() => string) => {
  let count = 0;
  return () => {
    count += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${count.toString(16).padStart(12, '0')}`;
  };
};

const richText = (
  id: string,
  text: string,
  overrides: Readonly<{ color?: string; fontFamily?: string }> = {},
): RichTextDocument => ({
  blocks: [
    {
      id,
      type: 'paragraph',
      alignment: 'left',
      runs: [
        {
          text,
          marks: {
            bold: true,
            italic: false,
            underline: false,
            strikethrough: false,
            fontSizePt: 14,
            ...overrides,
          },
        },
      ],
    },
  ],
});

const textValue = (element: Element): string => {
  if (element.type !== 'text') return '';
  return element.content.blocks
    .flatMap((block) =>
      block.type === 'list' ? block.items.flatMap((item) => item.runs) : block.runs,
    )
    .map((run) => run.text)
    .join('');
};

const targetTheme = (): Theme => {
  const theme = createBlankTheme(idFactory(), 'Enforced');
  return {
    ...theme,
    colors: {
      background: '#101112',
      surface: '#202122',
      text: '#F0F1F2',
      mutedText: '#A0A1A2',
      accent: '#00AACC',
    },
    headingFontFamily: 'Target Heading',
    bodyFontFamily: 'Target Body',
    textStyles: theme.textStyles.map((style) => ({
      ...style,
      fontFamily: style.role === 'title' ? 'Target Heading' : 'Target Body',
      color: style.role === 'subtitle' ? '#A0A1A2' : '#F0F1F2',
    })),
  };
};

describe('design authority helpers', () => {
  it('creates a valid independent blank theme with fresh IDs and a normalized name', () => {
    const named = createBlankTheme(idFactory(), '  Client theme  ');
    const unnamed = createBlankTheme(idFactory(), '   ');

    expect(named.name).toBe('Client theme');
    expect(unnamed.name).toBe(DEFAULT_BLANK_THEME_NAME);
    expect(new Set(named.textStyles.map((style) => style.role))).toEqual(
      new Set(['title', 'subtitle', 'body', 'caption', 'label', 'quote']),
    );
    expect(new Set([named.id, ...named.textStyles.map((style) => style.id)]).size).toBe(7);
    expect(named.colors).not.toBe(unnamed.colors);
  });

  it('bounds custom page dimensions and rejects non-finite input', () => {
    expect(createBoundedPageSize(123.45, 678.9)).toEqual({
      widthPt: 123.45,
      heightPt: 678.9,
    });
    expect(createBoundedPageSize(0, DOCUMENT_LIMITS.maxPageDimensionPt + 1)).toEqual({
      widthPt: 1,
      heightPt: DOCUMENT_LIMITS.maxPageDimensionPt,
    });
    expect(() => createBoundedPageSize(Number.NaN, 540)).toThrow(RangeError);
    expect(() => createBoundedPageSize(960, Number.POSITIVE_INFINITY)).toThrow(RangeError);

    const source = createNeutralDemoDeck();
    expect(validateDeck({ ...source, page: createBoundedPageSize(-50, 100_000) })).toMatchObject({
      success: true,
    });
  });

  it('enforces one theme across every design layer without mutating content or assets', () => {
    const source = createNeutralDemoDeck();
    const theme = targetTheme();
    const imageAssetId = 'eeeeeeee-eeee-4eee-8eee-000000000001';
    const text: TextElement = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000002',
      name: 'Styled text',
      type: 'text',
      frame: { xPt: 20, yPt: 20, widthPt: 200, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: true,
      styleRole: 'body',
      verticalAlignment: 'middle',
      style: {
        fontFamily: 'Legacy Font',
        color: '#123456',
        fontSizePt: 17,
        lineHeight: 1.4,
      },
      content: richText('eeeeeeee-eeee-4eee-8eee-000000000003', 'Keep me', {
        color: '#654321',
        fontFamily: 'Run Font',
      }),
    };
    const placeholder: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000004',
      name: 'Styled placeholder',
      type: 'placeholder',
      frame: { xPt: 20, yPt: 80, widthPt: 200, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      role: 'footer',
      accepts: ['text'],
      prompt: 'Footer',
      defaultTextStyle: {
        fontFamily: 'Legacy Font',
        color: '#123456',
        fontSizePt: 10,
      },
    };
    const shape: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000005',
      name: 'Styled shape',
      type: 'shape',
      frame: { xPt: 250, yPt: 20, widthPt: 100, heightPt: 80, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      shape: 'rectangle',
      fill: '#CC0000',
      stroke: { color: '#00CC00', widthPt: 2, dash: 'dash' },
      cornerRadiusPt: 0,
      shadow: {
        color: '#0000CC',
        blurPt: 4,
        offsetXPt: 1,
        offsetYPt: 2,
        opacity: 0.5,
      },
    };
    const connector: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000006',
      name: 'Styled connector',
      type: 'connector',
      geometryVersion: 2,
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 10, yPt: 10, binding: {} },
      end: { xPt: 90, yPt: 90, binding: {} },
      routing: 'straight',
      stroke: { color: '#AA0000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };
    const icon: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000007',
      name: 'Styled icon',
      type: 'icon',
      frame: { xPt: 400, yPt: 20, widthPt: 50, heightPt: 50, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      iconSet: 'lucide',
      iconName: 'star',
      color: '#AA00AA',
    };
    const image: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000008',
      name: 'Image',
      type: 'image',
      frame: { xPt: 500, yPt: 20, widthPt: 80, heightPt: 80, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId: imageAssetId,
      altText: 'Preserved',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const group: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000009',
      name: 'Nested design',
      type: 'group',
      frame: { xPt: 20, yPt: 150, widthPt: 300, heightPt: 120, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 300, heightPt: 120 },
      children: [
        {
          ...shape,
          id: 'eeeeeeee-eeee-4eee-8eee-00000000000a',
          name: 'Nested shape',
        },
        {
          ...shape,
          id: 'eeeeeeee-eeee-4eee-8eee-00000000000b',
          name: 'Nested transparent shape',
          fill: null,
        },
      ],
    };

    const tableSlide = source.slides[1]!;
    const originalTable = tableSlide.elements.find((element) => element.type === 'table');
    if (originalTable?.type !== 'table') throw new Error('Missing table fixture.');
    const table: Element = {
      ...originalTable,
      style: {
        fill: '#EFEFEF',
        headerFill: '#111111',
        bandedRows: true,
      },
      cells: originalTable.cells.map((cell) => ({
        ...cell,
        content: richText(
          cell.content.blocks[0]?.id ?? 'eeeeeeee-eeee-4eee-8eee-00000000000c',
          'Cell',
          { color: '#111111', fontFamily: 'Cell Font' },
        ),
      })),
    };
    const deck: DeckDocument = {
      ...source,
      themes: [...source.themes, theme],
      assets: [
        ...source.assets,
        {
          id: imageAssetId,
          kind: 'image',
          hash: 'a'.repeat(64),
          mediaType: 'image/png',
          fileName: 'image.png',
          byteLength: 100,
          widthPx: 10,
          heightPx: 10,
        },
      ],
      settings: {
        ...source.settings,
        defaultBackground: { type: 'solid', color: '#ABCDEF' },
      },
      masters: source.masters.map((master, index) =>
        index === 0
          ? {
              ...master,
              background: { type: 'solid', color: '#ABCDEF' },
              elements: [text, placeholder, shape, image],
            }
          : master,
      ),
      layouts: source.layouts.map((layout, index) =>
        index === 0
          ? {
              ...layout,
              background: { type: 'solid', color: '#FEDCBA' },
              elements: [...layout.elements, connector],
            }
          : layout,
      ),
      slides: source.slides.map((slide, index) => {
        if (index === 0) {
          return {
            ...slide,
            background: {
              type: 'image',
              assetId: imageAssetId,
              fit: 'cover',
              opacity: 0.4,
            },
            elements: [...slide.elements, icon, group],
          };
        }
        if (index === 1) {
          return {
            ...slide,
            elements: slide.elements.map((element) =>
              element.id === originalTable.id ? table : element,
            ),
          };
        }
        return slide;
      }),
    };
    const validation = validateDeck(deck);
    if (!validation.success) {
      throw new Error(JSON.stringify(validation.issues, null, 2));
    }
    const before = structuredClone(deck);

    const enforced = enforceThemeAcrossDeck(deck, theme.id);

    expect(deck).toEqual(before);
    expect(enforced.masters.every((master) => master.themeId === theme.id)).toBe(true);
    expect(enforced.settings.defaultBackground).toEqual({ type: 'theme' });
    expect(enforced.masters[0]?.background).toEqual({ type: 'theme' });
    expect(enforced.layouts[0]?.background).toEqual({ type: 'theme' });
    expect(enforced.slides[0]?.background).toEqual(deck.slides[0]?.background);

    const masterText = enforced.masters[0]?.elements.find((element) => element.id === text.id);
    if (masterText?.type !== 'text') throw new Error('Missing enforced text.');
    expect(masterText.style).toEqual({ fontSizePt: 17, lineHeight: 1.4 });
    expect(
      masterText.content.blocks[0]?.type === 'paragraph'
        ? masterText.content.blocks[0].runs[0]?.marks
        : undefined,
    ).toEqual({
      bold: true,
      italic: false,
      underline: false,
      strikethrough: false,
      fontSizePt: 14,
    });
    expect(textValue(masterText)).toBe('Keep me');

    const masterPlaceholder = enforced.masters[0]?.elements.find(
      (element) => element.id === placeholder.id,
    );
    expect(
      masterPlaceholder?.type === 'placeholder' ? masterPlaceholder.defaultTextStyle : undefined,
    ).toEqual({ fontSizePt: 10 });

    const masterShape = enforced.masters[0]?.elements.find((element) => element.id === shape.id);
    if (masterShape?.type !== 'shape') throw new Error('Missing enforced shape.');
    expect(masterShape.fill).toBe(theme.colors.surface);
    expect(masterShape.stroke.color).toBe(theme.colors.accent);
    expect(masterShape.shadow?.color).toBe(theme.colors.mutedText);

    const layoutConnector = enforced.layouts[0]?.elements.find(
      (element) => element.id === connector.id,
    );
    expect(layoutConnector?.type === 'connector' ? layoutConnector.stroke.color : '').toBe(
      theme.colors.accent,
    );
    const slideIcon = enforced.slides[0]?.elements.find((element) => element.id === icon.id);
    expect(slideIcon?.type === 'icon' ? slideIcon.color : '').toBe(theme.colors.accent);
    const slideGroup = enforced.slides[0]?.elements.find((element) => element.id === group.id);
    expect(
      slideGroup?.type === 'group' && slideGroup.children[0]?.type === 'shape'
        ? slideGroup.children[0].fill
        : '',
    ).toBe(theme.colors.surface);
    expect(enforced.masters[0]?.elements.find((element) => element.id === image.id)).toEqual(image);

    const enforcedTable = enforced.slides[1]?.elements.find(
      (element) => element.id === originalTable.id,
    );
    if (enforcedTable?.type !== 'table') throw new Error('Missing enforced table.');
    expect(enforcedTable.border.color).toBe(theme.colors.mutedText);
    expect(enforcedTable.style?.fill).toBe(theme.colors.surface);
    expect(enforcedTable.style?.headerFill).toBe(theme.colors.accent);
    expect(enforcedTable.cells.every((cell) => cell.style.textColor === theme.colors.text)).toBe(
      true,
    );
    expect(enforcedTable.cells[0]?.style.fill).toBe(theme.colors.accent);
    expect(enforcedTable.cells[2]?.style.fill).toBeNull();

    expect(validateDeck(enforced)).toMatchObject({ success: true });
    expect(enforceThemeAcrossDeck(enforced, theme.id)).toEqual(enforced);
    expect(() => enforceThemeAcrossDeck(deck, 'missing-theme')).toThrow(
      'Theme missing-theme does not exist.',
    );
  });

  it('enforces a theme through one validated, idempotent, undoable command beyond 100 objects', () => {
    const source = createNeutralDemoDeck();
    const theme = source.themes[0];
    const slide = source.slides[0];
    if (theme === undefined || slide === undefined) throw new Error('Missing design fixture.');
    const styledObjects = Array.from({ length: 125 }, (_, index): Element => {
      const sequence = (index + 1).toString(16).padStart(12, '0');
      return {
        id: `f0000000-0000-4000-8000-${sequence}`,
        type: 'shape',
        name: `Styled object ${index + 1}`,
        frame: {
          xPt: (index % 10) * 20,
          yPt: Math.floor(index / 10) * 20,
          widthPt: 18,
          heightPt: 18,
          rotationDeg: 0,
        },
        opacity: 1,
        visible: true,
        locked: false,
        shape: 'rectangle',
        fill: '#AABBCC',
        stroke: { color: '#DDEEFF', widthPt: 1, dash: 'solid' },
        cornerRadiusPt: 0,
      };
    });
    const deck: DeckDocument = {
      ...source,
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? { ...candidate, elements: [...candidate.elements, ...styledObjects] }
          : candidate,
      ),
    };
    expect(validateDeck(deck)).toMatchObject({ success: true });
    const command = documentCommandSchema.parse({
      type: 'theme.enforce-deck',
      themeId: theme.id,
    });
    const transaction = applyCommand(deck, command, {
      expectedRevision: createRevisionToken(deck),
      metadata: {
        transactionId: 'f1000000-0000-4000-8000-000000000001',
        actorId: 'theme-command-test',
        origin: 'user',
        label: 'Enforce theme',
        timestamp: '2026-07-23T12:00:00.000Z',
      },
    });

    expect(transaction.commands).toEqual([command]);
    expect(transaction.previousRevision).toBe(createRevisionToken(deck));
    expect(transaction.revision).not.toBe(transaction.previousRevision);
    expect(validateDeck(transaction.document)).toMatchObject({ success: true });
    const enforcedObjects = transaction.document.slides[0]!.elements.filter((element) =>
      element.id.startsWith('f0000000-'),
    );
    expect(enforcedObjects).toHaveLength(125);
    expect(
      enforcedObjects.every(
        (element) =>
          element.type === 'shape' &&
          element.fill === theme.colors.surface &&
          element.stroke.color === theme.colors.accent,
      ),
    ).toBe(true);

    const repeated = applyCommand(transaction.document, command, {
      expectedRevision: transaction.revision,
      metadata: {
        transactionId: 'f1000000-0000-4000-8000-000000000002',
        actorId: 'theme-command-test',
        origin: 'user',
        label: 'Enforce theme again',
        timestamp: '2026-07-23T12:00:00.000Z',
      },
    });
    expect(repeated.document).toEqual(transaction.document);
    expect(undoTransaction(transaction.document, transaction)).toEqual(deck);

    expect(() =>
      applyCommand(
        deck,
        {
          type: 'theme.enforce-deck',
          themeId: 'f2000000-0000-4000-8000-000000000001',
        },
        {
          metadata: {
            transactionId: 'f1000000-0000-4000-8000-000000000003',
            actorId: 'theme-command-test',
            origin: 'user',
            label: 'Missing theme',
            timestamp: '2026-07-23T12:00:00.000Z',
          },
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(
      documentCommandSchema.safeParse({
        type: 'theme.enforce-deck',
        themeId: theme.id,
        replacementThemeId: theme.id,
      }).success,
    ).toBe(false);
  });

  it('resets one element to theme-managed fonts and colors without changing its content or frame', () => {
    const source = createNeutralDemoDeck();
    const original = source.slides[0]!.elements[0];
    if (original?.type !== 'text') throw new Error('Missing text fixture.');
    const local: TextElement = {
      ...original,
      frame: { ...original.frame, xPt: 123 },
      style: {
        fontFamily: 'Local Font',
        color: '#123456',
        fontSizePt: 19,
        italic: true,
      },
      content: richText('eeeeeeee-eeee-4eee-8eee-000000000019', 'Local content', {
        color: '#654321',
        fontFamily: 'Inline Font',
      }),
    };

    const reset = resetElementThemeStyles(local, targetTheme());

    expect(reset).toMatchObject({
      id: local.id,
      frame: local.frame,
      style: { fontSizePt: 19, italic: true },
    });
    expect(textValue(reset)).toBe('Local content');
    expect(reset.type === 'text' ? reset.content.blocks[0] : undefined).toMatchObject({
      runs: [
        {
          marks: {
            bold: true,
            italic: false,
            underline: false,
            strikethrough: false,
            fontSizePt: 14,
          },
        },
      ],
    });
  });
});

describe('dynamic fields', () => {
  it('resolves supported fields in the projection and preserves canonical source text', () => {
    const source = createNeutralDemoDeck();
    const slide = source.slides[0]!;
    const original = slide.elements[0];
    if (original?.type !== 'text') throw new Error('Missing text fixture.');
    const local: TextElement = {
      ...original,
      content: richText(
        original.content.blocks[0]?.id ?? 'eeeeeeee-eeee-4eee-8eee-000000000020',
        '{{page}} / {{ pages }} — {{title}} — {{date}} {{time}} — {{unknown}}',
      ),
    };
    const masterText: TextElement = {
      ...local,
      id: 'eeeeeeee-eeee-4eee-8eee-000000000021',
      name: 'Dynamic master footer',
      content: richText('eeeeeeee-eeee-4eee-8eee-000000000022', 'Master {{page}}/{{pages}}'),
    };
    const deck: DeckDocument = {
      ...source,
      name: 'Quarterly review',
      masters: source.masters.map((master, index) =>
        index === 0 ? { ...master, elements: [masterText] } : master,
      ),
      slides: source.slides.map((candidate) =>
        candidate.id === slide.id
          ? {
              ...candidate,
              elements: candidate.elements.map((element) =>
                element.id === original.id ? local : element,
              ),
            }
          : candidate,
      ),
    };
    const context = {
      now: '2026-01-02T03:04:00.000Z',
      locale: 'en-GB',
      timeZone: 'UTC',
    } as const;
    const values = createDynamicFieldValues(deck, slide.id, context);

    const resolved = resolveSlide(deck, slide.id, { dynamicFields: context });
    const resolvedLocal = resolved.elements.find((item) => item.element.id === local.id);
    const resolvedMaster = resolved.elements.find((item) => item.element.id === masterText.id);

    expect(textValue(resolvedLocal?.element ?? original)).toBe(
      `1 / 3 — Quarterly review — ${values.date} ${values.time} — {{unknown}}`,
    );
    expect(textValue(resolvedMaster?.element ?? original)).toBe('Master 1/3');
    expect(textValue(deck.slides[0]!.elements[0]!)).toContain('{{page}}');
    expect(resolveDynamicFieldText('{{PAGE}} {{missing}}', values)).toBe('{{PAGE}} {{missing}}');
  });

  it('recomputes numbering after reorder and can exclude hidden slides', () => {
    const source = createNeutralDemoDeck();
    const reordered: DeckDocument = {
      ...source,
      slides: [source.slides[2]!, source.slides[0]!, { ...source.slides[1]!, hidden: true }],
    };

    expect(createDynamicFieldValues(reordered, source.slides[0]!.id)).toMatchObject({
      page: '2',
      pages: '3',
    });
    expect(
      createDynamicFieldValues(reordered, source.slides[0]!.id, {
        includeHiddenSlides: false,
      }),
    ).toMatchObject({ page: '2', pages: '2' });
    expect(() =>
      createDynamicFieldValues(reordered, source.slides[1]!.id, {
        includeHiddenSlides: false,
      }),
    ).toThrow('is not part of the selected page-numbering scope');
  });

  it('resolves fields recursively in grouped text and table cells', () => {
    const source = createNeutralDemoDeck();
    const values = createDynamicFieldValues(source, source.slides[1]!.id);
    const table = source.slides[1]!.elements.find((element) => element.type === 'table');
    if (table?.type !== 'table') throw new Error('Missing table fixture.');
    const dynamicTable: Element = {
      ...table,
      cells: table.cells.map((cell, index) =>
        index === 0
          ? {
              ...cell,
              content: richText(
                cell.content.blocks[0]?.id ?? 'eeeeeeee-eeee-4eee-8eee-000000000030',
                '{{page}}/{{pages}}',
              ),
            }
          : cell,
      ),
    };
    const group: Element = {
      id: 'eeeeeeee-eeee-4eee-8eee-000000000031',
      name: 'Dynamic group',
      type: 'group',
      frame: { xPt: 0, yPt: 0, widthPt: 512, heightPt: 250, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 512, heightPt: 250 },
      children: [dynamicTable],
    };

    const resolved = resolveElementDynamicFields(group, values);
    const cell =
      resolved.type === 'group' && resolved.children[0]?.type === 'table'
        ? resolved.children[0].cells[0]
        : undefined;
    const block = cell?.content.blocks[0];
    expect(block?.type === 'paragraph' ? block.runs[0]?.text : '').toBe('2/3');
    expect(
      dynamicTable.type === 'table' &&
        dynamicTable.cells[0]?.content.blocks[0]?.type === 'paragraph'
        ? dynamicTable.cells[0].content.blocks[0].runs[0]?.text
        : '',
    ).toBe('{{page}}/{{pages}}');
  });
});
