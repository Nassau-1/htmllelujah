import {
  createDefaultDeck,
  createNeutralDemoDeck,
  documentCommandSchema,
  type DocumentCommand,
  type Element,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  analyzeCommandAccess,
  assetEntityKey,
  assetReferenceKey,
  DOCUMENT_COMMAND_ACCESS_CLASSIFICATION,
  elementEntityKey,
  layoutEntityKey,
  slideEntityKey,
} from '../src/index.js';

interface ZodSchemaInternals {
  readonly _def?: {
    readonly type?: string;
    readonly options?: readonly unknown[];
    readonly shape?: Readonly<Record<string, unknown>>;
    readonly values?: readonly unknown[];
  };
}

const commandTypesFromSchema = (schema: unknown): readonly string[] => {
  const definition = (schema as ZodSchemaInternals)._def;
  if (definition?.type === 'union') {
    return (definition.options ?? []).flatMap((option) => commandTypesFromSchema(option));
  }
  if (definition?.type === 'object') {
    const discriminator = definition.shape?.type as ZodSchemaInternals | undefined;
    const values = discriminator?._def?.values ?? [];
    return values.filter((value): value is string => typeof value === 'string');
  }
  throw new Error(`Unsupported document command schema node: ${definition?.type ?? 'unknown'}`);
};

const deterministicIds = (): (() => string) => {
  let sequence = 1;
  return () => `a0000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
};

describe('V2 command access classification', () => {
  it('matches every command discriminant exposed by document-core at runtime', () => {
    const schemaTypes = commandTypesFromSchema(documentCommandSchema);
    expect(schemaTypes.length).toBeGreaterThan(0);
    expect(new Set(schemaTypes).size).toBe(schemaTypes.length);
    expect(Object.keys(DOCUMENT_COMMAND_ACCESS_CLASSIFICATION).sort()).toEqual(
      [...schemaTypes].sort(),
    );
  });

  it('tracks resource references in both directions', () => {
    const deck = createNeutralDemoDeck();
    const slide = deck.slides[0]!;
    const assetId = 'a1000000-0000-4000-8000-000000000001';
    const image: Element = {
      id: 'a1000000-0000-4000-8000-000000000002',
      type: 'image',
      name: 'Image',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 100, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId,
      altText: 'Test',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const insert = analyzeCommandAccess([
      { type: 'element.insert', slideId: slide.id, element: image },
    ]);
    const remove = analyzeCommandAccess([{ type: 'asset.remove', assetId }]);

    expect(insert.readSet).toContain(assetEntityKey(assetId));
    expect(insert.writeSet).toContain(assetReferenceKey);
    expect(remove.readSet).toContain(assetReferenceKey);
  });

  it('resolves indirect slide writes for layout deletion and placeholder reset', () => {
    const deck = createDefaultDeck({ idFactory: deterministicIds() });
    const slide = deck.slides[0]!;
    const layout = deck.layouts[0]!;
    const bound = slide.elements[0]!;
    const placeholderId = bound.placeholderBinding?.placeholderId;
    expect(placeholderId).toBeDefined();

    const deleteLayout = analyzeCommandAccess(
      [{ type: 'layout.delete', layoutId: layout.id }],
      deck,
    );
    const reset = analyzeCommandAccess(
      [
        {
          type: 'slide.reset-placeholder',
          slideId: slide.id,
          placeholderId: placeholderId!,
        },
      ],
      deck,
    );

    expect(deleteLayout.writeSet).toContain(slideEntityKey(slide.id));
    expect(reset.readSet).toContain(layoutEntityKey(layout.id));
    expect(reset.writeSet).toContain(elementEntityKey(bound.id));
  });

  it('protects bound slide element trees from master and layout remapping commands', () => {
    const deck = createDefaultDeck({ idFactory: deterministicIds() });
    const slide = deck.slides[0]!;
    const bound = slide.elements[0]!;
    const master = deck.masters[0]!;
    const layout = deck.layouts[0]!;
    const commands: readonly DocumentCommand[] = [
      {
        type: 'master.update',
        masterId: master.id,
        replacement: { ...master, name: 'Updated master' },
      },
      { type: 'master.delete', masterId: master.id },
      {
        type: 'layout.update',
        layoutId: layout.id,
        replacement: { ...layout, name: 'Updated layout' },
      },
    ];

    commands.forEach((command) => {
      const access = analyzeCommandAccess([command], deck);
      expect(access.writeSet).toContain(slideEntityKey(slide.id));
      expect(access.writeSet).toContain(elementEntityKey(bound.id));
    });
  });

  it('keeps independent element commands independent while serializing table mutations', () => {
    const deck = createNeutralDemoDeck();
    const slide = deck.slides[0]!;
    const [first, second] = slide.elements;
    const firstStyle: DocumentCommand = {
      type: 'element.set-visible',
      slideId: slide.id,
      elementId: first!.id,
      visible: false,
    };
    const secondStyle: DocumentCommand = {
      type: 'element.set-locked',
      slideId: slide.id,
      elementId: second!.id,
      locked: true,
    };
    const firstAccess = analyzeCommandAccess([firstStyle], deck);
    const secondAccess = analyzeCommandAccess([secondStyle], deck);
    expect(firstAccess.writeSet).not.toContain(elementEntityKey(second!.id));
    expect(secondAccess.writeSet).not.toContain(elementEntityKey(first!.id));

    const tableSlide = deck.slides[1]!;
    const table = tableSlide.elements.find((element) => element.type === 'table');
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') throw new Error('Missing table fixture.');
    const cell = table.cells[0]!;
    const cellUpdate = analyzeCommandAccess([
      {
        type: 'table.update-cell',
        slideId: tableSlide.id,
        tableId: table.id,
        cellId: cell.id,
        style: { ...cell.style, fill: '#FFFFFF' },
      },
    ]);
    const rowDelete = analyzeCommandAccess([
      { type: 'table.delete-row', slideId: tableSlide.id, tableId: table.id, index: 0 },
    ]);
    expect(cellUpdate.writeSet).toContain(elementEntityKey(table.id));
    expect(rowDelete.writeSet).toContain(elementEntityKey(table.id));
  });
});
