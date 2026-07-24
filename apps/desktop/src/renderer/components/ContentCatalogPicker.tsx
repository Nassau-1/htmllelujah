import {
  BUSINESS_EMOJI_CATEGORIES,
  FLAG_REGIONS,
  LocalIcon,
  queryContentCatalog,
  type BusinessEmojiCategory,
  type CatalogId,
  type CatalogLocale,
  type ContentCatalogEntry,
  type EmojiCatalogScope,
  type FlagRegion,
  type ShapeKind,
} from '@htmllelujah/renderer';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';

const RESULT_PAGE_LIMIT = 72;
const RESULT_COLUMNS = 6;

const CATALOG_TABS: readonly {
  readonly id: CatalogId;
  readonly label: Readonly<Record<CatalogLocale, string>>;
}[] = [
  { id: 'shapes', label: { en: 'Shapes', fr: 'Formes' } },
  { id: 'local-icons', label: { en: 'Icons', fr: 'Icônes' } },
  { id: 'twemoji', label: { en: 'Emoji', fr: 'Emoji' } },
  { id: 'circle-flags', label: { en: 'Circle flags', fr: 'Drapeaux ronds' } },
];

const BUSINESS_CATEGORY_LABELS: Readonly<
  Record<BusinessEmojiCategory, Readonly<Record<CatalogLocale, string>>>
> = {
  'people-teams': { en: 'People & teams', fr: 'Personnes et équipes' },
  communication: { en: 'Communication', fr: 'Communication' },
  'status-alerts': { en: 'Status & alerts', fr: 'Statuts et alertes' },
  'documents-tools': { en: 'Documents & tools', fr: 'Documents et outils' },
  'data-technology': { en: 'Data & technology', fr: 'Données et technologie' },
  finance: { en: 'Finance', fr: 'Finance' },
  'travel-locations': { en: 'Travel & locations', fr: 'Voyages et lieux' },
  'common-symbols': { en: 'Common symbols', fr: 'Symboles courants' },
};

const FLAG_REGION_LABELS: Readonly<Record<FlagRegion, Readonly<Record<CatalogLocale, string>>>> = {
  africa: { en: 'Africa', fr: 'Afrique' },
  americas: { en: 'Americas', fr: 'Amériques' },
  asia: { en: 'Asia', fr: 'Asie' },
  europe: { en: 'Europe', fr: 'Europe' },
  oceania: { en: 'Oceania', fr: 'Océanie' },
  international: { en: 'International & other', fr: 'International et autres' },
};

const COPY = {
  en: {
    allBusinessCategories: 'All business categories',
    allEmoji: 'All',
    businessEmoji: 'Business',
    close: 'Close content picker',
    count: (start: number, end: number, total: number): string =>
      total === 0
        ? '0 results'
        : `${start.toLocaleString('en')}–${end.toLocaleString('en')} of ${total.toLocaleString('en')} results`,
    emojiCategory: 'Business category',
    emojiScope: 'Emoji scope',
    empty: 'No content matches this search.',
    flagRegion: 'Flag region',
    allFlagRegions: 'All regions',
    next: 'Next page',
    page: (current: number, total: number): string => `Page ${current} of ${total}`,
    pagination: 'Catalog pagination',
    previous: 'Previous page',
    results: 'Catalog results',
    search: 'Search shapes, icons, emoji, and flags',
    title: 'Insert visual',
  },
  fr: {
    allBusinessCategories: 'Toutes les catégories professionnelles',
    allEmoji: 'Tout',
    businessEmoji: 'Professionnel',
    close: 'Fermer le sélecteur de contenu',
    count: (start: number, end: number, total: number): string =>
      total === 0
        ? '0 résultat'
        : `${start.toLocaleString('fr')}–${end.toLocaleString('fr')} sur ${total.toLocaleString('fr')} résultats`,
    emojiCategory: 'Catégorie professionnelle',
    emojiScope: 'Périmètre des emoji',
    empty: 'Aucun contenu ne correspond à cette recherche.',
    flagRegion: 'Région des drapeaux',
    allFlagRegions: 'Toutes les régions',
    next: 'Page suivante',
    page: (current: number, total: number): string => `Page ${current} sur ${total}`,
    pagination: 'Pagination du catalogue',
    previous: 'Page précédente',
    results: 'Résultats du catalogue',
    search: 'Rechercher des formes, icônes, emoji et drapeaux',
    title: 'Insérer un visuel',
  },
} as const;

export interface ContentCatalogPickerProps {
  readonly catalogs?: readonly CatalogId[];
  readonly initialBusinessCategory?: BusinessEmojiCategory;
  readonly initialCatalog?: CatalogId;
  readonly initialEmojiScope?: EmojiCatalogScope;
  readonly initialFlagRegion?: FlagRegion;
  readonly initialOffset?: number;
  readonly initialQuery?: string;
  readonly locale?: CatalogLocale;
  readonly onDismiss: () => void;
  readonly onSelect: (entry: ContentCatalogEntry) => void;
  readonly title?: string;
}

export type CatalogResultNavigationKey =
  'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'End' | 'Home';

export const getNextCatalogResultIndex = (
  currentIndex: number,
  key: CatalogResultNavigationKey,
  resultCount: number,
  columnCount = RESULT_COLUMNS,
): number => {
  if (resultCount <= 0) return -1;
  const current = Math.min(Math.max(0, currentIndex), resultCount - 1);
  const columns = Math.max(1, Math.trunc(columnCount));
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, current - 1);
    case 'ArrowRight':
      return Math.min(resultCount - 1, current + 1);
    case 'ArrowUp':
      return Math.max(0, current - columns);
    case 'ArrowDown':
      return Math.min(resultCount - 1, current + columns);
    case 'Home':
      return 0;
    case 'End':
      return resultCount - 1;
  }
};

const isCatalogResultNavigationKey = (value: string): value is CatalogResultNavigationKey =>
  value === 'ArrowDown' ||
  value === 'ArrowLeft' ||
  value === 'ArrowRight' ||
  value === 'ArrowUp' ||
  value === 'End' ||
  value === 'Home';

const catalogEntryLabel = (entry: ContentCatalogEntry, locale: CatalogLocale): string =>
  locale === 'fr' && entry.localizedLabel.trim() !== '' ? entry.localizedLabel : entry.label;

const ShapeCatalogPreview = ({ shape }: { readonly shape: ShapeKind }): ReactElement => {
  const commonProps = {
    className: 'content-catalog-shape-fill',
    vectorEffect: 'non-scaling-stroke' as const,
  };
  const strokeProps = {
    className: 'content-catalog-shape-stroke',
    vectorEffect: 'non-scaling-stroke' as const,
  };
  let content: ReactElement;
  switch (shape) {
    case 'rectangle':
      content = <rect {...commonProps} x="6" y="7" width="36" height="22" />;
      break;
    case 'rounded-rectangle':
      content = <rect {...commonProps} x="6" y="7" width="36" height="22" rx="5" />;
      break;
    case 'ellipse':
      content = <ellipse {...commonProps} cx="24" cy="18" rx="18" ry="11" />;
      break;
    case 'triangle':
      content = <path {...commonProps} d="M24 5 43 30H5Z" />;
      break;
    case 'right-triangle':
      content = <path {...commonProps} d="M7 6 41 30H7Z" />;
      break;
    case 'diamond':
      content = <path {...commonProps} d="m24 4 19 14-19 14L5 18Z" />;
      break;
    case 'parallelogram':
      content = <path {...commonProps} d="M14 6h29l-9 24H5Z" />;
      break;
    case 'trapezoid':
      content = <path {...commonProps} d="M14 6h20l9 24H5Z" />;
      break;
    case 'pentagon':
      content = <path {...commonProps} d="m24 4 19 13-7 15H12L5 17Z" />;
      break;
    case 'hexagon':
      content = <path {...commonProps} d="M14 5h20l10 13-10 13H14L4 18Z" />;
      break;
    case 'octagon':
      content = <path {...commonProps} d="m14 4 20 0 10 9v10l-10 9H14L4 23V13Z" />;
      break;
    case 'chevron':
      content = <path {...commonProps} d="M5 5h24l14 13-14 13H5l14-13Z" />;
      break;
    case 'cross':
      content = <path {...commonProps} d="M18 4h12v8h9v12h-9v8H18v-8H9V12h9Z" />;
      break;
    case 'donut':
      content = (
        <path
          {...commonProps}
          d="M24 4a14 14 0 1 1 0 28 14 14 0 0 1 0-28Zm0 8a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"
          fillRule="evenodd"
        />
      );
      break;
    case 'left-bracket':
      content = <path {...strokeProps} d="M30 5H16v26h14" fill="none" />;
      break;
    case 'right-bracket':
      content = <path {...strokeProps} d="M18 5h14v26H18" fill="none" />;
      break;
    case 'arc':
      content = <path {...strokeProps} d="M7 28A18 18 0 0 1 41 8" fill="none" />;
      break;
    case 'line':
      content = <path {...strokeProps} d="M7 28 41 8" />;
      break;
    case 'arrow':
      content = (
        <g {...strokeProps}>
          <path d="M6 18h34" />
          <path d="m31 9 9 9-9 9" />
        </g>
      );
      break;
  }
  return (
    <svg viewBox="0 0 48 36" aria-hidden="true" focusable="false">
      {content}
    </svg>
  );
};

const CatalogEntryPreview = ({ entry }: { readonly entry: ContentCatalogEntry }): ReactElement => {
  if (entry.insert.type === 'shape') {
    return <ShapeCatalogPreview shape={entry.insert.shape} />;
  }
  return (
    <LocalIcon
      iconSet={entry.insert.iconSet}
      iconName={entry.insert.iconName}
      color="currentColor"
    />
  );
};

export function ContentCatalogPicker({
  catalogs,
  initialBusinessCategory,
  initialCatalog = 'shapes',
  initialEmojiScope = 'business',
  initialFlagRegion,
  initialOffset = 0,
  initialQuery = '',
  locale = 'en',
  onDismiss,
  onSelect,
  title,
}: ContentCatalogPickerProps): ReactElement {
  const copy = COPY[locale];
  const headingId = useId();
  const searchId = useId();
  const resultsId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingResultFocusRef = useRef<number | null>(null);
  const availableTabs = useMemo(() => {
    if (catalogs === undefined || catalogs.length === 0) return CATALOG_TABS;
    const allowedCatalogs = new Set(catalogs);
    const tabs = CATALOG_TABS.filter((tab) => allowedCatalogs.has(tab.id));
    return tabs.length === 0 ? CATALOG_TABS : tabs;
  }, [catalogs]);
  const [activeCatalog, setActiveCatalog] = useState<CatalogId>(() =>
    availableTabs.some((tab) => tab.id === initialCatalog)
      ? initialCatalog
      : (availableTabs[0]?.id ?? 'shapes'),
  );
  const [query, setQuery] = useState(initialQuery);
  const [emojiScope, setEmojiScope] = useState<EmojiCatalogScope>(initialEmojiScope);
  const [businessCategory, setBusinessCategory] = useState<BusinessEmojiCategory | undefined>(
    initialBusinessCategory,
  );
  const [flagRegion, setFlagRegion] = useState<FlagRegion | undefined>(initialFlagRegion);
  const [offset, setOffset] = useState(() =>
    Number.isFinite(initialOffset) ? Math.max(0, Math.trunc(initialOffset)) : 0,
  );
  const [activeResultIndex, setActiveResultIndex] = useState(0);

  const page = useMemo(
    () =>
      queryContentCatalog(query, {
        businessCategory: emojiScope === 'business' ? businessCategory : undefined,
        catalogs: [activeCatalog],
        flagRegion: activeCatalog === 'circle-flags' ? flagRegion : undefined,
        limit: RESULT_PAGE_LIMIT,
        locale,
        offset,
        scope: activeCatalog === 'twemoji' ? emojiScope : 'all',
      }),
    [activeCatalog, businessCategory, emojiScope, flagRegion, locale, offset, query],
  );
  const entries = page.items;
  const pageCount = Math.max(1, Math.ceil(page.total / page.limit));
  const currentPage = page.total === 0 ? 1 : Math.floor(page.offset / page.limit) + 1;
  const rangeStart = page.total === 0 ? 0 : page.offset + 1;
  const rangeEnd = page.offset + entries.length;

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveResultIndex(0);
  }, [activeCatalog, businessCategory, emojiScope, page.offset, query]);

  useEffect(() => {
    const requestedIndex = pendingResultFocusRef.current;
    if (requestedIndex === null || entries.length === 0) return;
    pendingResultFocusRef.current = null;
    const boundedIndex = Math.min(requestedIndex, entries.length - 1);
    const frame = window.requestAnimationFrame(() => {
      setActiveResultIndex(boundedIndex);
      resultRefs.current[boundedIndex]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries.length, page.offset]);

  useEffect(() => {
    if (availableTabs.some((tab) => tab.id === activeCatalog)) return;
    setActiveCatalog(availableTabs[0]?.id ?? 'shapes');
    setOffset(0);
  }, [activeCatalog, availableTabs]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onDismiss]);

  const selectCatalog = (catalogId: CatalogId, tabIndex: number): void => {
    setActiveCatalog(catalogId);
    setOffset(0);
    tabRefs.current[tabIndex]?.focus();
  };

  const moveToOffset = (nextOffset: number, focusIndex = 0): void => {
    pendingResultFocusRef.current = focusIndex;
    resultRefs.current = [];
    setActiveResultIndex(focusIndex);
    setOffset(Math.max(0, nextOffset));
  };

  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    tabIndex: number,
  ): void => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (tabIndex + 1) % availableTabs.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (tabIndex - 1 + availableTabs.length) % availableTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = availableTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const tab = availableTabs[nextIndex];
    if (tab !== undefined) selectCatalog(tab.id, nextIndex);
  };

  const handleResultKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ): void => {
    if (event.key === 'PageDown' && page.hasMore) {
      event.preventDefault();
      moveToOffset(page.offset + page.limit);
      return;
    }
    if (event.key === 'PageUp' && page.offset > 0) {
      event.preventDefault();
      moveToOffset(Math.max(0, page.offset - page.limit));
      return;
    }
    if (!isCatalogResultNavigationKey(event.key)) return;
    event.preventDefault();
    const nextIndex = getNextCatalogResultIndex(currentIndex, event.key, entries.length);
    if (nextIndex < 0) return;
    setActiveResultIndex(nextIndex);
    resultRefs.current[nextIndex]?.focus();
  };

  const trapDialogFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => !element.hasAttribute('hidden'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="modal-backdrop content-catalog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div
        ref={dialogRef}
        className="content-catalog-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={trapDialogFocus}
      >
        <header className="content-catalog-header">
          <div>
            <h2 id={headingId}>{title ?? copy.title}</h2>
            <p>{copy.search}</p>
          </div>
          <button
            type="button"
            className="content-catalog-close"
            aria-label={copy.close}
            title={copy.close}
            onClick={onDismiss}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <label className="content-catalog-search" htmlFor={searchId}>
          <Search aria-hidden="true" size={17} />
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            placeholder={copy.search}
            autoComplete="off"
            aria-controls={resultsId}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setOffset(0);
            }}
          />
        </label>

        <div className="content-catalog-tabs" role="tablist" aria-label={copy.search}>
          {availableTabs.map((tab, tabIndex) => (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tabIndex] = element;
              }}
              id={`${resultsId}-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-controls={resultsId}
              aria-selected={activeCatalog === tab.id}
              tabIndex={activeCatalog === tab.id ? 0 : -1}
              onClick={() => selectCatalog(tab.id, tabIndex)}
              onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
            >
              {tab.label[locale]}
            </button>
          ))}
        </div>

        <div className="content-catalog-controls">
          {activeCatalog === 'twemoji' ? (
            <>
              <div className="content-catalog-scope" role="group" aria-label={copy.emojiScope}>
                {(['business', 'all'] as const).map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    aria-pressed={emojiScope === scope}
                    onClick={() => {
                      setEmojiScope(scope);
                      setOffset(0);
                    }}
                  >
                    {scope === 'business' ? copy.businessEmoji : copy.allEmoji}
                  </button>
                ))}
              </div>
              {emojiScope === 'business' ? (
                <label className="content-catalog-category">
                  <span>{copy.emojiCategory}</span>
                  <select
                    value={businessCategory ?? ''}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setBusinessCategory(
                        value === '' ? undefined : (value as BusinessEmojiCategory),
                      );
                      setOffset(0);
                    }}
                  >
                    <option value="">{copy.allBusinessCategories}</option>
                    {BUSINESS_EMOJI_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {BUSINESS_CATEGORY_LABELS[category][locale]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </>
          ) : null}
          {activeCatalog === 'circle-flags' ? (
            <label className="content-catalog-category">
              <span>{copy.flagRegion}</span>
              <select
                value={flagRegion ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setFlagRegion(value === '' ? undefined : (value as FlagRegion));
                  setOffset(0);
                }}
              >
                <option value="">{copy.allFlagRegions}</option>
                {FLAG_REGIONS.map((region) => (
                  <option key={region} value={region}>
                    {FLAG_REGION_LABELS[region][locale]}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        <div className="content-catalog-result-summary" role="status" aria-live="polite">
          {copy.count(rangeStart, rangeEnd, page.total)}
        </div>

        <div
          id={resultsId}
          className="content-catalog-results"
          role="tabpanel"
          aria-labelledby={`${resultsId}-${activeCatalog}-tab`}
          aria-label={copy.results}
          tabIndex={entries.length === 0 ? 0 : -1}
        >
          {entries.length === 0 ? (
            <p className="content-catalog-empty">{copy.empty}</p>
          ) : (
            <ul className="content-catalog-grid">
              {entries.map((entry, index) => {
                const label = catalogEntryLabel(entry, locale);
                return (
                  <li
                    key={entry.id}
                    aria-posinset={page.offset + index + 1}
                    aria-setsize={page.total}
                  >
                    <button
                      ref={(element) => {
                        resultRefs.current[index] = element;
                      }}
                      type="button"
                      className="content-catalog-item"
                      tabIndex={index === activeResultIndex ? 0 : -1}
                      aria-label={label}
                      title={label}
                      onFocus={() => setActiveResultIndex(index)}
                      onKeyDown={(event) => handleResultKeyDown(event, index)}
                      onClick={() => onSelect(entry)}
                    >
                      <span className="content-catalog-preview" aria-hidden="true">
                        <CatalogEntryPreview entry={entry} />
                      </span>
                      <span className="content-catalog-item-label">{label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <nav className="content-catalog-pagination" aria-label={copy.pagination}>
          <button
            type="button"
            disabled={page.offset === 0}
            aria-label={copy.previous}
            title={copy.previous}
            onClick={() => moveToOffset(Math.max(0, page.offset - page.limit))}
          >
            <ChevronLeft aria-hidden="true" size={16} />
            <span>{copy.previous}</span>
          </button>
          <span className="content-catalog-page-position">{copy.page(currentPage, pageCount)}</span>
          <button
            type="button"
            disabled={!page.hasMore}
            aria-label={copy.next}
            title={copy.next}
            onClick={() => moveToOffset(page.offset + page.limit)}
          >
            <span>{copy.next}</span>
            <ChevronRight aria-hidden="true" size={16} />
          </button>
        </nav>
      </div>
    </div>
  );
}
