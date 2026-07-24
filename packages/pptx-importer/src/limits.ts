/**
 * Fixed parser budgets. They deliberately sit above ordinary presentation sizes while
 * preventing an imported package from turning into unbounded CPU or memory work.
 */
export const PRESENTATION_IMPORT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 2_048,
  maxNameBytes: 512,
  maxCompressedEntryBytes: 32 * 1024 * 1024,
  maxExpandedEntryBytes: 64 * 1024 * 1024,
  maxTotalExpandedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxXmlBytes: 8 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlTokens: 250_000,
  maxXmlAttributesPerElement: 64,
  maxXmlAttributeBytes: 16 * 1024,
  maxXmlTextBytes: 4 * 1024 * 1024,
  maxRelationships: 4_096,
  maxThemeCount: 128,
  maxMasterCount: 256,
  maxLayoutCount: 1_024,
  maxPlaceholderCountPerPart: 512,
  maxPageEmu: 58_521_600,
  maxCoordinateEmu: 512_000_000,
} as const);
