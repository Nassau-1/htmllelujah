import {
  applyCommand,
  createDefaultDeck,
  type DocumentCommand,
  type PageSize,
  type TableElement,
} from '@htmllelujah/document-core';

export type TableDocumentCommand = Extract<DocumentCommand, { readonly tableId: string }>;

export type TableCommandFactory = (slideId: string, tableId: string) => TableDocumentCommand;

/**
 * Applies the document core's canonical table command semantics to a template
 * table without ever persisting a synthetic slide. The in-memory harness is
 * discarded immediately and only the validated table replacement is returned.
 */
export const applyCanonicalTableMutation = (
  table: TableElement,
  page: PageSize,
  createCommand: TableCommandFactory,
): TableElement => {
  const timestamp = '2000-01-01T00:00:00.000Z';
  const harness = createDefaultDeck({ now: () => timestamp });
  const slide = harness.slides[0];
  if (slide === undefined) throw new Error('Canonical table harness is missing its slide.');

  const { placeholderBinding, ...unboundTable } = structuredClone(table);
  const prepared = {
    ...harness,
    page: { ...page },
    masters: harness.masters.map((master) => ({ ...master, elements: [] })),
    layouts: harness.layouts.map((layout) => ({ ...layout, elements: [] })),
    slides: [{ ...slide, elements: [unboundTable] }],
  };
  const result = applyCommand(prepared, createCommand(slide.id, table.id), {
    metadata: {
      transactionId: crypto.randomUUID(),
      actorId: 'desktop-template-table-projector',
      origin: 'system',
      label: 'Project canonical table mutation',
      timestamp,
    },
  });
  const updated = result.document.slides[0]?.elements.find(
    (element): element is TableElement => element.id === table.id && element.type === 'table',
  );
  if (updated === undefined) {
    throw new Error('Canonical table mutation did not return the target table.');
  }
  return placeholderBinding === undefined ? updated : { ...updated, placeholderBinding };
};
