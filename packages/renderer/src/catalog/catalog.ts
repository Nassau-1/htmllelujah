import type { ShapeKind } from '../types.js';
import { CIRCLE_FLAG_CATALOG_DATA } from './generated/circle-flag-catalog.js';
import { TWEMOJI_CATALOG_DATA } from './generated/twemoji-catalog.js';

export const CATALOG_IDS = ['shapes', 'local-icons', 'twemoji', 'circle-flags'] as const;
export type CatalogId = (typeof CATALOG_IDS)[number];
export type CatalogLocale = 'en' | 'fr';
export type CatalogIconSet = 'htmllelujah-local' | 'twemoji' | 'circle-flags';
export const EMOJI_CATALOG_SCOPES = ['business', 'all'] as const;
export type EmojiCatalogScope = (typeof EMOJI_CATALOG_SCOPES)[number];
export const BUSINESS_EMOJI_CATEGORIES = [
  'people-teams',
  'communication',
  'status-alerts',
  'documents-tools',
  'data-technology',
  'finance',
  'travel-locations',
  'common-symbols',
] as const;
export type BusinessEmojiCategory = (typeof BUSINESS_EMOJI_CATEGORIES)[number];
export const FLAG_REGIONS = [
  'africa',
  'americas',
  'asia',
  'europe',
  'oceania',
  'international',
] as const;
export type FlagRegion = (typeof FLAG_REGIONS)[number];

export const CATALOG_PAGE_LIMIT_MAX = 144;
export const CATALOG_PAGE_LIMIT_DEFAULT = 72;

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
  readonly businessCategory?: BusinessEmojiCategory | undefined;
  readonly flagRegion?: FlagRegion | undefined;
  readonly unicode?: string | undefined;
  readonly insert: ContentCatalogInsert;
}

export interface SearchContentCatalogOptions {
  readonly catalogs?: readonly CatalogId[] | undefined;
  readonly limit?: number | undefined;
  readonly locale?: CatalogLocale | undefined;
  readonly offset?: number | undefined;
  /**
   * Applies only to Twemoji entries. `all` remains the API default so legacy callers
   * retain the complete-catalog behavior; the visual picker deliberately defaults to
   * the curated `business` scope.
   */
  readonly scope?: EmojiCatalogScope | undefined;
  readonly businessCategory?: BusinessEmojiCategory | undefined;
  /** Applies only to the circular-flag catalog. */
  readonly flagRegion?: FlagRegion | undefined;
}

export interface ContentCatalogPage {
  readonly items: readonly ContentCatalogEntry[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

export interface NormalizedCatalogIconIdentity {
  readonly iconSet: CatalogIconSet;
  readonly iconName: string;
}

const normalizeText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[\u2018\u2019\u201a\u201b\u2032'`´]/gu, ' ')
    .replace(/[-_:/.\\]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');

interface CatalogSearchDocument {
  readonly id: string;
  readonly label: string;
  readonly localizedLabel: string;
  readonly keywords: readonly string[];
  readonly searchable: readonly string[];
}

const catalogSearchDocuments = new WeakMap<ContentCatalogEntry, CatalogSearchDocument>();

const createCatalogSearchDocument = (catalogEntry: ContentCatalogEntry): CatalogSearchDocument => {
  const id = normalizeText(catalogEntry.id);
  const label = normalizeText(catalogEntry.label);
  const localizedLabel = normalizeText(catalogEntry.localizedLabel);
  const keywords = Object.freeze(catalogEntry.keywords.map(normalizeText));
  const insertIdentity =
    catalogEntry.insert.type === 'shape'
      ? normalizeText(catalogEntry.insert.shape)
      : normalizeText(`${catalogEntry.insert.iconSet} ${catalogEntry.insert.iconName}`);
  return Object.freeze({
    id,
    label,
    localizedLabel,
    keywords,
    searchable: Object.freeze(
      [
        id,
        label,
        localizedLabel,
        normalizeText(catalogEntry.unicode ?? ''),
        normalizeText(catalogEntry.category),
        normalizeText(catalogEntry.businessCategory ?? ''),
        normalizeText(catalogEntry.flagRegion ?? ''),
        insertIdentity,
        ...keywords,
      ].filter((candidate) => candidate !== ''),
    ),
  });
};

const entry = (value: ContentCatalogEntry): ContentCatalogEntry => {
  const catalogEntry = Object.freeze({
    ...value,
    keywords: Object.freeze([...value.keywords]),
    insert: Object.freeze({ ...value.insert }),
  });
  catalogSearchDocuments.set(catalogEntry, createCatalogSearchDocument(catalogEntry));
  return catalogEntry;
};

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
      [
        'right-triangle',
        'Right triangle',
        'Triangle rectangle',
        ['angle', 'corner', 'angle droit'],
      ],
      ['diamond', 'Diamond', 'Losange', ['decision', 'rhombus', 'décision']],
      [
        'parallelogram',
        'Parallelogram',
        'Parallélogramme',
        ['process', 'input', 'output', 'saisie', 'sortie'],
      ],
      ['trapezoid', 'Trapezoid', 'Trapèze', ['process', 'funnel', 'entonnoir']],
      ['pentagon', 'Pentagon', 'Pentagone', ['five', 'cinq']],
      ['hexagon', 'Hexagon', 'Hexagone', ['six', 'honeycomb', 'nid abeille']],
      ['octagon', 'Octagon', 'Octogone', ['eight', 'stop', 'huit']],
      ['chevron', 'Chevron', 'Chevron', ['process', 'next', 'direction', 'étape']],
      ['cross', 'Cross', 'Croix', ['plus', 'add', 'medical', 'ajouter']],
      ['donut', 'Donut', 'Anneau', ['ring', 'cycle', 'cercle']],
      ['left-bracket', 'Left bracket', 'Crochet gauche', ['brace', 'group', 'crochet']],
      ['right-bracket', 'Right bracket', 'Crochet droit', ['brace', 'group', 'crochet']],
      ['arc', 'Arc', 'Arc', ['curve', 'curved line', 'courbe']],
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

const BUSINESS_EMOJI_OVERRIDES = new Map<string, BusinessEmojiCategory>([
  ['1f464', 'people-teams'],
  ['1f465', 'people-teams'],
  ['1f91d', 'people-teams'],
  ['1f9d1-200d-1f4bc', 'people-teams'],
  ['1f468-200d-1f4bc', 'people-teams'],
  ['1f469-200d-1f4bc', 'people-teams'],
  ['1f4ac', 'communication'],
  ['1f4ad', 'communication'],
  ['1f5e3', 'communication'],
  ['1f5e8', 'communication'],
  ['1f5ef', 'communication'],
]);

const includesAny = (value: string, terms: readonly string[]): boolean =>
  terms.some((term) => value.includes(term));

const businessEmojiCategory = (
  iconName: string,
  label: string,
  localizedLabel: string,
  category: string,
  keywords: readonly string[],
): BusinessEmojiCategory | undefined => {
  const override = BUSINESS_EMOJI_OVERRIDES.get(iconName);
  if (override !== undefined) return override;

  if (category !== 'travel-places' && category !== 'objects' && category !== 'symbols') {
    return undefined;
  }
  const searchable = normalizeText([label, localizedLabel, ...keywords].join(' '));
  if (normalizeText(label).split(' ').includes('face')) return undefined;
  if (category === 'travel-places') {
    return includesAny(searchable, [
      'atm',
      'bank',
      'bureau de change',
      'currency exchange',
      'exchange',
    ])
      ? 'finance'
      : 'travel-locations';
  }
  if (category === 'objects') {
    if (
      includesAny(searchable, [
        'antenna',
        'email',
        'envelope',
        'fax',
        'inbox',
        'loudspeaker',
        'mail',
        'mailbox',
        'megaphone',
        'microphone',
        'mobile phone',
        'outbox',
        'pager',
        'postal',
        'radio',
        'speaker',
        'telephone',
      ])
    ) {
      return 'communication';
    }
    if (
      includesAny(searchable, [
        'banknote',
        'briefcase',
        'chart',
        'coin',
        'credit card',
        'currency',
        'dollar',
        'euro',
        'money',
        'pound',
        'receipt',
        'yen',
      ])
    ) {
      return 'finance';
    }
    if (
      includesAny(searchable, [
        'battery',
        'camera',
        'computer',
        'disc',
        'disk',
        'electric',
        'gear',
        'keyboard',
        'laptop',
        'mouse',
        'plug',
        'printer',
        'robot',
        'satellite',
        'technology',
        'telescope',
        'television',
        'video',
      ])
    ) {
      return 'data-technology';
    }
    if (
      includesAny(searchable, [
        'alarm',
        'bell',
        'emergency',
        'extinguisher',
        'locked',
        'siren',
        'unlocked',
      ])
    ) {
      return 'status-alerts';
    }
    return 'documents-tools';
  }
  if (category === 'symbols') {
    if (includesAny(searchable, ['currency', 'dollar', 'euro', 'percent', 'pound', 'yen'])) {
      return 'finance';
    }
    if (
      includesAny(searchable, [
        'alert',
        'check',
        'cross mark',
        'exclamation',
        'information',
        'no entry',
        'prohibited',
        'question',
        'stop',
        'warning',
      ])
    ) {
      return 'status-alerts';
    }
    return 'common-symbols';
  }
  return undefined;
};

export const TWEMOJI_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  TWEMOJI_CATALOG_DATA.map(([iconName, label, localizedLabel, category, unicode, keywords]) =>
    entry({
      id: `twemoji:${iconName}`,
      catalog: 'twemoji',
      label,
      localizedLabel,
      keywords,
      category,
      businessCategory: businessEmojiCategory(iconName, label, localizedLabel, category, keywords),
      unicode,
      insert: { type: 'icon', iconSet: 'twemoji', iconName },
    }),
  ),
);

const flagRegionCodes: Readonly<Record<Exclude<FlagRegion, 'international'>, ReadonlySet<string>>> =
  Object.freeze({
    africa: new Set(
      'ac ao bf bi bj bw cd cf cg ci cm cv dj dz ea eg eh er et ga gh gm gn gq gw ic ke km lr ls ly ma mg ml mr mu mw mz na ne ng re rw sc sd sh sl sn so ss st sz ta td tg tn tz ug yt za zm zw'.split(
        ' ',
      ),
    ),
    americas: new Set(
      'ag ai an ar aw bb bl bm bo bq br bs bz ca cl co cp cr cu cw dm do ec fk gd gf gl gp gt gy hn ht jm kn ky lc mf mq ms mx ni pa pe pm pr py sr sv sx tc tt us uy vc ve vg vi'.split(
        ' ',
      ),
    ),
    asia: new Set(
      'ae af am az bd bh bn bt cn cy dg ge hk id il in io iq ir jo jp kg kh kp kr kw kz la lb lk mm mn mo mv my np om ph pk ps qa sa sg sy th tj tl tm tr tw uz vn ye'.split(
        ' ',
      ),
    ),
    europe: new Set(
      'ad al at ax ba be bg by ch cz de dk ee es eu fi fo fr fx gb gg gi gr hr hu ie im is it je li lt lu lv mc md me mk mt nl no pl pt ro rs ru se si sj sk sm su ua uk va xk yu'.split(
        ' ',
      ),
    ),
    oceania: new Set(
      'as au cc ck cx fj fm gu hm ki mh mp nc nf nr nu nz pf pg pn pw sb tk to tv um vu wf ws'.split(
        ' ',
      ),
    ),
  });

export const flagRegionForCode = (value: string): FlagRegion => {
  const code = value.trim().toLocaleLowerCase('en');
  for (const region of FLAG_REGIONS) {
    if (region !== 'international' && flagRegionCodes[region].has(code)) return region;
  }
  return 'international';
};

export const CIRCLE_FLAG_CATALOG: readonly ContentCatalogEntry[] = Object.freeze(
  CIRCLE_FLAG_CATALOG_DATA.map(([iconName, label, localizedLabel, category, unicode, keywords]) =>
    entry({
      id: `circle-flags:${iconName}`,
      catalog: 'circle-flags',
      label,
      localizedLabel,
      keywords,
      category,
      flagRegion: flagRegionForCode(iconName),
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
  const searchDocument =
    catalogSearchDocuments.get(catalogEntry) ?? createCatalogSearchDocument(catalogEntry);
  const label = locale === 'fr' ? searchDocument.localizedLabel : searchDocument.label;
  const alternateLabel = locale === 'fr' ? searchDocument.label : searchDocument.localizedLabel;
  const { id, keywords, searchable } = searchDocument;
  const tokens = normalizedQuery.split(' ');
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
  const firstToken = tokens[0] ?? '';
  const positions = searchable
    .map((candidate) => candidate.indexOf(firstToken))
    .filter((position) => position >= 0);
  return 50 + (positions.length === 0 ? 0 : Math.min(...positions));
};

interface RankedCatalogEntry {
  readonly catalogEntry: ContentCatalogEntry;
  readonly index: number;
  readonly score: number;
}

const catalogMatchesScope = (
  catalogEntry: ContentCatalogEntry,
  scope: EmojiCatalogScope,
  businessCategoryFilter: BusinessEmojiCategory | undefined,
  flagRegionFilter: FlagRegion | undefined,
): boolean => {
  if (
    catalogEntry.catalog === 'circle-flags' &&
    flagRegionFilter !== undefined &&
    catalogEntry.flagRegion !== flagRegionFilter
  ) {
    return false;
  }
  if (catalogEntry.catalog !== 'twemoji' || scope === 'all') return true;
  if (catalogEntry.businessCategory === undefined) return false;
  return (
    businessCategoryFilter === undefined || catalogEntry.businessCategory === businessCategoryFilter
  );
};

const rankedContentCatalog = (
  query: string,
  options: SearchContentCatalogOptions,
): readonly RankedCatalogEntry[] => {
  const selectedCatalogs = options.catalogs ?? CATALOG_IDS;
  const allowed = new Set(selectedCatalogs);
  const locale = options.locale ?? 'en';
  const scope = options.scope ?? 'all';
  const normalizedQuery = normalizeText(query);
  return CATALOG_IDS.flatMap((catalogId) =>
    allowed.has(catalogId) ? CONTENT_CATALOGS[catalogId] : [],
  )
    .filter((catalogEntry) =>
      catalogMatchesScope(catalogEntry, scope, options.businessCategory, options.flagRegion),
    )
    .map((catalogEntry, index) => ({
      catalogEntry,
      index,
      score: searchScore(catalogEntry, normalizedQuery, locale),
    }))
    .filter((result): result is RankedCatalogEntry => result.score !== null)
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.index - right.index ||
        left.catalogEntry.id.localeCompare(right.catalogEntry.id, 'en'),
    );
};

const boundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const candidate = value === undefined || !Number.isFinite(value) ? fallback : Math.trunc(value);
  return Math.min(maximum, Math.max(minimum, candidate));
};

/**
 * Returns one bounded catalog page plus the exact total. The complete ranked result is
 * evaluated before slicing, so every item remains reachable without mounting the full
 * Twemoji or flag collection.
 */
export const queryContentCatalog = (
  query: string,
  options: SearchContentCatalogOptions = {},
): ContentCatalogPage => {
  const limit = boundedInteger(
    options.limit,
    CATALOG_PAGE_LIMIT_DEFAULT,
    1,
    CATALOG_PAGE_LIMIT_MAX,
  );
  const ranked = rankedContentCatalog(query, options);
  const total = ranked.length;
  const requestedOffset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const offset = Math.min(requestedOffset, total);
  const items = Object.freeze(
    ranked.slice(offset, offset + limit).map(({ catalogEntry }) => catalogEntry),
  );
  return Object.freeze({
    items,
    total,
    offset,
    limit,
    hasMore: offset + items.length < total,
  });
};

/**
 * Legacy array-returning search retained for existing callers. New browse surfaces
 * should use `queryContentCatalog` so they can expose the exact total and pagination.
 */
export const searchContentCatalog = (
  query: string,
  options: SearchContentCatalogOptions = {},
): readonly ContentCatalogEntry[] => {
  const limit = boundedInteger(options.limit, 80, 1, 200);
  const ranked = rankedContentCatalog(query, options);
  const requestedOffset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const offset = Math.min(requestedOffset, ranked.length);
  return Object.freeze(
    ranked.slice(offset, offset + limit).map(({ catalogEntry }) => catalogEntry),
  );
};
