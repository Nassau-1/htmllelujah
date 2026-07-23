import {
  LocalIcon,
  searchContentCatalog,
  type CatalogId,
  type CatalogLocale,
  type ContentCatalogEntry,
  type ShapeKind,
} from '@htmllelujah/renderer';
import { Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';

const RESULT_LIMIT = 72;
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

const COPY = {
  en: {
    close: 'Close content picker',
    count: (count: number): string => `${count} result${count === 1 ? '' : 's'}`,
    empty: 'No content matches this search.',
    search: 'Search shapes, icons, emoji, and flags',
    title: 'Insert visual',
  },
  fr: {
    close: 'Fermer le sélecteur de contenu',
    count: (count: number): string => `${count} résultat${count === 1 ? '' : 's'}`,
    empty: 'Aucun contenu ne correspond à cette recherche.',
    search: 'Rechercher des formes, icônes, emoji et drapeaux',
    title: 'Insérer un visuel',
  },
} as const;

export interface ContentCatalogPickerProps {
  readonly catalogs?: readonly CatalogId[];
  readonly initialCatalog?: CatalogId;
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
    case 'diamond':
      content = <path {...commonProps} d="m24 4 19 14-19 14L5 18Z" />;
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
  initialCatalog = 'shapes',
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
  const [activeResultIndex, setActiveResultIndex] = useState(0);

  const entries = useMemo(
    () =>
      searchContentCatalog(query, {
        catalogs: [activeCatalog],
        limit: RESULT_LIMIT,
        locale,
      }),
    [activeCatalog, locale, query],
  );

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveResultIndex(0);
    resultRefs.current = [];
  }, [activeCatalog, query]);

  useEffect(() => {
    if (availableTabs.some((tab) => tab.id === activeCatalog)) return;
    setActiveCatalog(availableTabs[0]?.id ?? 'shapes');
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
    tabRefs.current[tabIndex]?.focus();
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
        'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
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
            onChange={(event) => setQuery(event.currentTarget.value)}
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
              onClick={() => setActiveCatalog(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, tabIndex)}
            >
              {tab.label[locale]}
            </button>
          ))}
        </div>

        <div className="content-catalog-result-summary" role="status" aria-live="polite">
          {copy.count(entries.length)}
        </div>

        <div
          id={resultsId}
          className="content-catalog-results"
          role="tabpanel"
          aria-labelledby={`${resultsId}-${activeCatalog}-tab`}
          tabIndex={entries.length === 0 ? 0 : -1}
        >
          {entries.length === 0 ? (
            <p className="content-catalog-empty">{copy.empty}</p>
          ) : (
            <ul className="content-catalog-grid">
              {entries.map((entry, index) => {
                const label = catalogEntryLabel(entry, locale);
                return (
                  <li key={entry.id}>
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
      </div>
    </div>
  );
}
