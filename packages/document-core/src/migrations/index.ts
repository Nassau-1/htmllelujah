import type { DeckDocument, DeckDocumentV1 } from '../model.js';

export const CURRENT_DOCUMENT_SCHEMA_VERSION = 2 as const;
export const DETERMINISTIC_MIGRATION_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  readonly name: string;
}

export interface MigrationResult {
  readonly document: DeckDocument;
  readonly steps: readonly MigrationStep[];
}

export interface V1MigrationOptions {
  readonly timestamp?: string | undefined;
  readonly locale?: string | undefined;
}

export const migrateDeckV1ToV2 = (
  source: DeckDocumentV1,
  options: V1MigrationOptions = {},
): DeckDocument => {
  const cloned = structuredClone(source);
  const timestamp = options.timestamp ?? DETERMINISTIC_MIGRATION_TIMESTAMP;
  return {
    ...cloned,
    schemaVersion: 2,
    metadata: {
      createdAt: timestamp,
      modifiedAt: timestamp,
      locale: options.locale ?? 'en-US',
      iconCatalogVersion: 'lucide-v1',
      flagCatalogVersion: 'round-flags-v1',
    },
    settings: {
      grid: { enabled: true, spacingPt: 12, snapToGrid: true, snapToObjects: true },
      defaultBackground: { type: 'theme' },
      includeHiddenSlidesInExport: false,
    },
  };
};

export const migrateParsedDeckToCurrent = (
  source: DeckDocumentV1 | DeckDocument,
  options: V1MigrationOptions = {},
): MigrationResult => {
  if (source.schemaVersion === 2) {
    return { document: structuredClone(source), steps: [] };
  }
  return {
    document: migrateDeckV1ToV2(source, options),
    steps: [{ from: 1, to: 2, name: 'document-v1-to-v2' }],
  };
};
