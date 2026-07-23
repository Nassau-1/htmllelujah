import type { ShapeKind } from '../types.js';
import { CIRCLE_FLAG_CATALOG_DATA } from './generated/circle-flag-catalog.js';
import { TWEMOJI_CATALOG_DATA } from './generated/twemoji-catalog.js';

export const CATALOG_IDS = ['shapes', 'local-icons', 'twemoji', 'circle-flags'] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];
export type CatalogLocale = 'en' | 'fr';
export type CatalogIconSet = 'htmllelujah-local' | 'twemoji' | 'circle-flags';

export interface ShapeCatalogInsert {
  readonly type: 'shape';
  readonly shape: ShapeKind;
}

export interface IconCatalogInsert {
  readonly type: 'icon';
  readonly iconSet: CatalogIconSet;
  readonly iconName: string;
}

export type ContentCatalogInsert = ShapeCatalogInsert | IconCatalogInsert;

export interface ContentCatalogEntry {
  readonly id: string;
  readonly catalog: CatalogId;
  readonly label: string;
  readonly localizedLabel: string;
  readonly keywords: readonly string[];
  readonly category: string;
  readonly unicode?: string | undefined;
  readonly insert: ContentCatalogInsert;
}

export interface SearchContentCatalogOptions {
  readonly catalogs?: readonly CatalogId[] | undefined;
  readonly limit?: number | undefined;
  readonly locale?: CatalogLocale | undefined;
}

export interface NormalizedCatalogIconIdentity {
  readonly iconSet: CatalogIconSet;
  readonly iconName: string;
}

const entry = (value: ContentCatalogEntry): ContentCatalogEntry =>
  Object.freeze({
    ...value,
    keywords: Object.freeze([...value.keywords]),
    insert: Object.freeze({ ...value.insert }),
  });

export const SHAPE_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  (
    [
      ['rectangle', 'Rectangle', 'Rectangle', ['box', 'card', 'square', 'carré']],
      [
        'rounded-rectangle',
        'Rounded rectangle',
        'Rectangle arrondi',
        ['box', 'card', 'round', 'arrondi'],
      ],
      ['ellipse', 'Ellipse', 'Ellipse', ['circle', 'oval', 'cercle', 'ovale']],
      ['triangle', 'Triangle', 'Triangle', ['three', 'pyramid', 'trois', 'pyramide']],
      ['diamond', 'Diamond', 'Losange', ['decision', 'rhombus', 'décision']],
      ['line', 'Line', 'Ligne', ['rule', 'divider', 'trait', 'séparateur']],
      ['arrow', 'Arrow', 'Flèche', ['direction', 'next', 'direction', 'suivant']],
    ] satisfies readonly [ShapeKind, string, string, readonly string[]][]
  ).map(([shape, label, localizedLabel, keywords]) =>
    entry({
      id: `shape:${shape}`,
      catalog: 'shapes',
      label,
      localizedLabel,
      keywords: [shape, ...keywords],
      category: 'shapes',
      insert: { type: 'shape', shape },
    }),
  ),
);

const localIconMetadata = [
  ['check', 'Check', 'Validation', ['tick', 'done', 'yes', 'validé']],
  ['plus', 'Plus', 'Plus', ['add', 'new', 'positive', 'ajouter']],
  ['minus', 'Minus', 'Moins', ['remove', 'negative', 'retirer']],
  ['close', 'Close', 'Fermer', ['cancel', 'x', 'annuler']],
  ['arrow-right', 'Right arrow', 'Flèche droite', ['next', 'forward', 'suivant']],
  ['circle', 'Circle', 'Cercle', ['round', 'dot', 'rond', 'point']],
  ['square', 'Square', 'Carré', ['box', 'rectangle', 'boîte']],
  ['triangle', 'Triangle', 'Triangle', ['pyramid', 'three', 'pyramide']],
  ['diamond', 'Diamond', 'Losange', ['decision', 'rhombus', 'décision']],
  ['star', 'Star', 'Étoile', ['favorite', 'rating', 'favori', 'note']],
  ['person', 'Person', 'Personne', ['user', 'people', 'utilisateur']],
  ['building', 'Building', 'Bâtiment', ['office', 'company', 'bureau', 'entreprise']],
] as const;

export const LOCAL_ICON_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  localIconMetadata.map(([iconName, label, localizedLabel, keywords]) =>
    entry({
      id: `htmllelujah-local:${iconName}`,
      catalog: 'local-icons',
      label,
      localizedLabel,
      keywords: [iconName, ...keywords],
      category: 'symbols',
      insert: { type: 'icon', iconSet: 'htmllelujah-local', iconName },
    }),
  ),
);

export const TWEMOJI_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  TWEMOJI_CATALOG_DATA.map(([iconName, label, localizedLabel, category, unicode, keywords]) =>
    entry({
      id: `twemoji:${iconName}`,
      catalog: 'twemoji',
      label,
      localizedLabel,
      keywords,
      category,
      unicode,
      insert: { type: 'icon', iconSet: 'twemoji', iconName },
    }),
  ),
);

export const CIRCLE_FLAG_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  CIRCLE_FLAG_CATALOG_DATA.map(([iconName, label, localizedLabel, category, unicode, keywords]) =>
    entry({
      id: `circle-flags:${iconName}`,
      catalog: 'circle-flags',
      label,
      localizedLabel,
      keywords,
      category,
      unicode,
      insert: { type: 'icon', iconSet: 'circle-flags', iconName },
    }),
  ),
);

export const CONTENT_CATALOGS: Readonly<Record<CatalogId, readonly ContentCatalogEntry[]>> =
  Object.freeze({
    shapes: SHAPE_CATALOG,
    'local-icons': LOCAL_ICON_CATALOG,
    twemoji: TWEMOJI_CATALOG,
    'circle-flags': CIRCLE_FLAG_CATALOG,
  });

const iconEntries = [...LOCAL_ICON_CATALOG, ...TWEMOJI_CATALOG, ...CIRCLE_FLAG_CATALOG];
const iconEntriesByIdentity = new Map(
  iconEntries.map((catalogEntry) => {
    const insert = catalogEntry.insert as IconCatalogInsert;
    return [`${insert.iconSet}:${insert.iconName}`, catalogEntry] as const;
  }),
);

const normalizeText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .trim()
    .replace(/\s+/g, ' ');

const normalizeTwemojiName = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^[0-9a-f]+(?:[-_\s][0-9a-f]+)*$/i.test(trimmed)) {
    const parts = trimmed.split(/[-_\s]+/);
    const normalized = [];
    for (const part of parts) {
      const codepoint = Number.parseInt(part, 16);
      if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) return null;
      normalized.push(codepoint.toString(16));
    }
    return normalized.join('-');
  }
  const codepoints = [...trimmed].map((character) => character.codePointAt(0));
  if (codepoints.some((codepoint) => codepoint === undefined)) return null;
  return codepoints.map((codepoint) => codepoint!.toString(16)).join('-');
};

const normalizeIconSet = (iconSet: string): CatalogIconSet | null => {
  const normalized = iconSet.trim().toLocaleLowerCase('en');
  if (normalized === 'htmllelujah-local' || normalized === 'local' || normalized === 'icons') {
    return 'htmllelujah-local';
  }
  if (normalized === 'twemoji') return 'twemoji';
  if (
    normalized === 'circle-flags' ||
    normalized === 'circle-flag' ||
    normalized === 'flags' ||
    normalized === 'flag'
  ) {
    return 'circle-flags';
  }
  return null;
};

export const normalizeCatalogIconIdentity = (
  iconSet: string,
  iconName: string,
): NormalizedCatalogIconIdentity | null => {
  const normalizedSet = normalizeIconSet(iconSet);
  if (normalizedSet === null) return null;
  const normalizedName =
    normalizedSet === 'twemoji'
      ? normalizeTwemojiName(iconName)
      : iconName.trim().toLocaleLowerCase('en');
  if (normalizedName === null || !iconEntriesByIdentity.has(`${normalizedSet}:${normalizedName}`)) {
    return null;
  }
  return Object.freeze({ iconSet: normalizedSet, iconName: normalizedName });
};

export const getContentCatalogEntry = (
  iconSet: string,
  iconName: string,
): ContentCatalogEntry | undefined => {
  const identity = normalizeCatalogIconIdentity(iconSet, iconName);
  return identity === null
    ? undefined
    : iconEntriesByIdentity.get(`${identity.iconSet}:${identity.iconName}`);
};

export const isKnownCatalogIcon = (iconSet: string, iconName: string): boolean =>
  normalizeCatalogIconIdentity(iconSet, iconName) !== null;

export const getContentCatalogEntries = (catalogId: CatalogId): readonly ContentCatalogEntry[] =>
  CONTENT_CATALOGS[catalogId];

const searchScore = (
  catalogEntry: ContentCatalogEntry,
  normalizedQuery: string,
  locale: CatalogLocale,
): number | null => {
  if (normalizedQuery === '') return 0;
  const label = normalizeText(locale === 'fr' ? catalogEntry.localizedLabel : catalogEntry.label);
  const alternateLabel = normalizeText(
    locale === 'fr' ? catalogEntry.label : catalogEntry.localizedLabel,
  );
  const id = normalizeText(catalogEntry.id);
  const keywords = catalogEntry.keywords.map(normalizeText);
  const tokens = normalizedQuery.split(' ');
  const searchable = [id, label, alternateLabel, ...keywords];
  if (!tokens.every((token) => searchable.some((candidate) => candidate.includes(token)))) {
    return null;
  }
  if (id === normalizedQuery || label === normalizedQuery || alternateLabel === normalizedQuery) {
    return 0;
  }
  if (label.startsWith(normalizedQuery)) return 10;
  if (alternateLabel.startsWith(normalizedQuery)) return 20;
  if (keywords.some((keyword) => keyword === normalizedQuery)) return 30;
  if (keywords.some((keyword) => keyword.startsWith(normalizedQuery))) return 40;
  return 50 + Math.min(...searchable.map((candidate) => candidate.indexOf(tokens[0] ?? '')));
};

export const searchContentCatalog = (
  query: string,
  options: SearchContentCatalogOptions = {},
): readonly ContentCatalogEntry[] => {
  const selectedCatalogs = options.catalogs ?? CATALOG_IDS;
  const allowed = new Set(selectedCatalogs);
  const locale = options.locale ?? 'en';
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 80)));
  const normalizedQuery = normalizeText(query);
  return Object.freeze(
    CATALOG_IDS.flatMap((catalogId) => (allowed.has(catalogId) ? CONTENT_CATALOGS[catalogId] : []))
      .map((catalogEntry, index) => ({
        catalogEntry,
        index,
        score: searchScore(catalogEntry, normalizedQuery, locale),
      }))
      .filter(
        (
          result,
        ): result is {
          catalogEntry: ContentCatalogEntry;
          index: number;
          score: number;
        } => result.score !== null,
      )
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.index - right.index ||
          left.catalogEntry.id.localeCompare(right.catalogEntry.id, 'en'),
      )
      .slice(0, limit)
      .map(({ catalogEntry }) => catalogEntry),
  );
};
