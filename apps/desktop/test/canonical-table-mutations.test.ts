import { DocumentCommandError, STANDARD_PAGE_SIZES } from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import { createTableElement, plainParagraph } from '../src/renderer/editor/canonical-factories';
import { applyCanonicalTableMutation } from '../src/renderer/editor/canonical-table-mutations';

describe('canonical template table mutations', () => {
  it('uses the document-core row insertion semantics without persisting a synthetic slide', () => {
    const source = createTableElement(2, 2);
    const cells = Array.from({ length: source.columnCount }, (_, column) => ({
      id: crypto.randomUUID(),
      row: source.rowCount,
      column,
      rowSpan: 1,
      columnSpan: 1,
      content: plainParagraph(`new ${column}`),
      style: {
        fill: null,
        textColor: '#172033',
        horizontalAlignment: 'left' as const,
        verticalAlignment: 'middle' as const,
        paddingPt: 8,
      },
    }));

    const updated = applyCanonicalTableMutation(
      source,
      STANDARD_PAGE_SIZES.widescreen,
      (slideId, tableId) => ({
        type: 'table.insert-row',
        slideId,
        tableId,
        index: source.rowCount,
        heightPt: 42,
        cells,
      }),
    );

    expect(updated.id).toBe(source.id);
    expect(updated.rowCount).toBe(3);
    expect(updated.cells.filter((cell) => cell.row === 2)).toHaveLength(2);
    expect(source.rowCount).toBe(2);
  });

  it('preserves a template binding around the canonical mutation projection', () => {
    const source = {
      ...createTableElement(2, 2),
      placeholderBinding: {
        placeholderId: crypto.randomUUID(),
        overrides: ['style'] as const,
      },
    };

    const updated = applyCanonicalTableMutation(
      source,
      STANDARD_PAGE_SIZES.widescreen,
      (slideId, tableId) => ({
        type: 'table.update-style',
        slideId,
        tableId,
        border: { ...source.border, color: '#ff0000' },
      }),
    );

    expect(updated.border.color).toBe('#ff0000');
    expect(updated.placeholderBinding).toEqual(source.placeholderBinding);
  });

  it('retains canonical locked-object rejection', () => {
    const source = { ...createTableElement(2, 2), locked: true };

    expect(() =>
      applyCanonicalTableMutation(source, STANDARD_PAGE_SIZES.widescreen, (slideId, tableId) => ({
        type: 'table.delete-row',
        slideId,
        tableId,
        index: 1,
      })),
    ).toThrowError(DocumentCommandError);
  });
});
