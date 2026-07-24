import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BUSINESS_EMOJI_CATEGORIES,
  CATALOG_PAGE_LIMIT_MAX,
  CATALOG_IDS,
  CIRCLE_FLAG_CATALOG,
  FLAG_REGIONS,
  getContentCatalogEntries,
  getContentCatalogEntry,
  isKnownCatalogIcon,
  LOCAL_ICON_CATALOG,
  LOCAL_ICON_PATHS,
  LocalIcon,
  normalizeCatalogIconIdentity,
  queryContentCatalog,
  searchContentCatalog,
  SHAPE_CATALOG,
  TWEMOJI_CATALOG,
  type CatalogId,
  type ContentCatalogEntry,
  type EmojiCatalogScope,
  type FlagRegion,
} from '../src/index.js';

const collectCatalogPages = (
  catalog: CatalogId,
  scope: EmojiCatalogScope = 'all',
): readonly ContentCatalogEntry[] => {
  const collected: ContentCatalogEntry[] = [];
  let offset = 0;
  for (;;) {
    const page = queryContentCatalog('', { catalogs: [catalog], limit: 72, offset, scope });
    collected.push(...page.items);
    if (!page.hasMore) {
      expect(page.total).toBe(collected.length);
      return collected;
    }
    offset += page.limit;
    expect(offset).toBeLessThanOrEqual(page.total);
  }
};

describe('offline content catalogs', () => {
  it('exposes complete pinned Twemoji and two-letter circular-flag catalogs', () => {
    expect(TWEMOJI_CATALOG).toHaveLength(3720);
    expect(CIRCLE_FLAG_CATALOG).toHaveLength(265);
    expect(getContentCatalogEntries('shapes')).toBe(SHAPE_CATALOG);
    expect(CATALOG_IDS).toEqual(['shapes', 'local-icons', 'twemoji', 'circle-flags']);
    expect(SHAPE_CATALOG.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'shape:right-triangle',
        'shape:parallelogram',
        'shape:trapezoid',
        'shape:pentagon',
        'shape:hexagon',
        'shape:octagon',
        'shape:chevron',
        'shape:left-bracket',
        'shape:right-bracket',
        'shape:arc',
      ]),
    );
    expect(
      LOCAL_ICON_CATALOG.map((catalogEntry) =>
        catalogEntry.insert.type === 'icon' ? catalogEntry.insert.iconName : '',
      ),
    ).toEqual(Object.keys(LOCAL_ICON_PATHS));
  });

  it('groups every circular flag into one searchable region without hiding entries', () => {
    expect(CIRCLE_FLAG_CATALOG.every(({ flagRegion }) => flagRegion !== undefined)).toBe(true);
    const grouped = FLAG_REGIONS.flatMap((flagRegion) => {
      const page = queryContentCatalog('', {
        catalogs: ['circle-flags'],
        flagRegion,
        limit: CATALOG_PAGE_LIMIT_MAX,
      });
      expect(page.total).toBeGreaterThan(0);
      return Array.from({ length: Math.ceil(page.total / page.limit) }, (_, index) =>
        queryContentCatalog('', {
          catalogs: ['circle-flags'],
          flagRegion,
          limit: page.limit,
          offset: index * page.limit,
        }),
      ).flatMap(({ items }) => items);
    });
    expect(grouped).toHaveLength(265);
    expect(new Set(grouped.map(({ id }) => id)).size).toBe(265);

    const europe = queryContentCatalog('France', {
      catalogs: ['circle-flags'],
      flagRegion: 'europe' satisfies FlagRegion,
      limit: 10,
    });
    expect(europe.items.map(({ id }) => id)).toContain('circle-flags:fr');
  });

  it('searches deterministically across canonical and localized metadata', () => {
    expect(
      searchContentCatalog('visage rieur', {
        catalogs: ['twemoji'],
        locale: 'fr',
        limit: 3,
      })[0],
    ).toMatchObject({
      id: 'twemoji:1f600',
      insert: { type: 'icon', iconSet: 'twemoji', iconName: '1f600' },
    });
    expect(
      searchContentCatalog('France', {
        catalogs: ['circle-flags'],
        locale: 'fr',
        limit: 1,
      })[0],
    ).toMatchObject({
      id: 'circle-flags:fr',
      insert: { type: 'icon', iconSet: 'circle-flags', iconName: 'fr' },
    });
    expect(searchContentCatalog('rounded', { catalogs: ['shapes'], limit: 1 })[0]).toMatchObject({
      insert: { type: 'shape', shape: 'rounded-rectangle' },
    });
    expect(searchContentCatalog('', { catalogs: ['local-icons'], limit: 4 })).toHaveLength(4);
    expect(searchContentCatalog('face', { catalogs: [], limit: 20 })).toEqual([]);
  });

  it('paginates the complete Twemoji and circular-flag catalogs with exact totals', () => {
    const firstEmojiPage = queryContentCatalog('', {
      catalogs: ['twemoji'],
      limit: 72,
      scope: 'all',
    });
    expect(firstEmojiPage).toMatchObject({
      total: 3720,
      offset: 0,
      limit: 72,
      hasMore: true,
    });
    expect(firstEmojiPage.items).toHaveLength(72);

    const emoji = collectCatalogPages('twemoji');
    const flags = collectCatalogPages('circle-flags');
    expect(emoji).toHaveLength(3720);
    expect(flags).toHaveLength(265);
    expect(new Set(emoji.map(({ id }) => id)).size).toBe(3720);
    expect(new Set(flags.map(({ id }) => id)).size).toBe(265);
    expect(emoji.map(({ id }) => id)).toEqual(TWEMOJI_CATALOG.map(({ id }) => id));
    expect(flags.map(({ id }) => id)).toEqual(CIRCLE_FLAG_CATALOG.map(({ id }) => id));

    const bounded = queryContentCatalog('', {
      catalogs: ['twemoji'],
      limit: Number.MAX_SAFE_INTEGER,
      scope: 'all',
    });
    expect(bounded.limit).toBe(CATALOG_PAGE_LIMIT_MAX);
    expect(bounded.items).toHaveLength(CATALOG_PAGE_LIMIT_MAX);
  });

  it('defaults the legacy API to the complete scope and preserves its array contract', () => {
    const legacy = searchContentCatalog('', { catalogs: ['twemoji'], limit: 200 });
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy).toHaveLength(200);
    expect(legacy[0]).toBe(TWEMOJI_CATALOG[0]);
  });

  it('offers a curated business scope without faces, animals, food, or sport', () => {
    const business = collectCatalogPages('twemoji', 'business');
    expect(business.length).toBeGreaterThan(500);
    expect(business.every(({ businessCategory }) => businessCategory !== undefined)).toBe(true);
    expect(
      business.every(
        ({ category }) =>
          category !== 'animals-nature' && category !== 'food-drink' && category !== 'activities',
      ),
    ).toBe(true);
    expect(business.some(({ label }) => /\bface\b/iu.test(label))).toBe(false);
    expect(business.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'twemoji:1f465',
        'twemoji:1f4ac',
        'twemoji:1f4ca',
        'twemoji:26a0',
        'twemoji:2708',
      ]),
    );
    expect(new Set(business.map(({ businessCategory }) => businessCategory))).toEqual(
      new Set(BUSINESS_EMOJI_CATEGORIES),
    );
  });

  it('filters useful business categories and normalizes exhaustive stable searches', () => {
    const finance = queryContentCatalog('', {
      businessCategory: 'finance',
      catalogs: ['twemoji'],
      limit: 144,
      scope: 'business',
    });
    expect(finance.total).toBeGreaterThan(0);
    expect(finance.items.every(({ businessCategory }) => businessCategory === 'finance')).toBe(
      true,
    );

    const byStableId = queryContentCatalog('circle_flags:FR', {
      catalogs: ['circle-flags'],
      limit: 10,
    });
    expect(byStableId.items[0]?.id).toBe('circle-flags:fr');

    const accented = queryContentCatalog("cote d'ivoire", {
      catalogs: ['circle-flags'],
      locale: 'fr',
      limit: 10,
    });
    expect(accented.items.some(({ id }) => id === 'circle-flags:ci')).toBe(true);

    const unicode = queryContentCatalog('😀', {
      catalogs: ['twemoji'],
      limit: 10,
      scope: 'all',
    });
    expect(unicode.items[0]?.id).toBe('twemoji:1f600');
    expect(
      queryContentCatalog('VISAGE RIEUR', {
        catalogs: ['twemoji'],
        locale: 'fr',
        limit: 10,
        scope: 'all',
      }).items.map(({ id }) => id),
    ).toEqual(
      queryContentCatalog('visage rieur', {
        catalogs: ['twemoji'],
        locale: 'fr',
        limit: 10,
        scope: 'all',
      }).items.map(({ id }) => id),
    );
  });

  it('normalizes stable Unicode and legacy flag identities without accepting unknown content', () => {
    expect(normalizeCatalogIconIdentity('twemoji', '😀')).toEqual({
      iconSet: 'twemoji',
      iconName: '1f600',
    });
    expect(normalizeCatalogIconIdentity('TWEMOJI', '01F600')).toEqual({
      iconSet: 'twemoji',
      iconName: '1f600',
    });
    expect(normalizeCatalogIconIdentity('flags', 'FR')).toEqual({
      iconSet: 'circle-flags',
      iconName: 'fr',
    });
    expect(getContentCatalogEntry('flag', 'fr')?.label).toBe('France');
    expect(isKnownCatalogIcon('twemoji', '1f600')).toBe(true);
    expect(isKnownCatalogIcon('remote', '<svg onload=alert(1)>')).toBe(false);
    expect(getContentCatalogEntry('twemoji', 'not-a-codepoint')).toBeUndefined();
  });

  it('renders only compiled trusted vectors and keeps unknown identities inert', () => {
    const twemoji = renderToStaticMarkup(
      <LocalIcon iconSet="twemoji" iconName="😀" color="#000000" />,
    );
    const flag = renderToStaticMarkup(<LocalIcon iconSet="flags" iconName="FR" color="#000000" />);
    const unknown = renderToStaticMarkup(
      <LocalIcon
        iconSet="twemoji"
        iconName={'"><script>globalThis.compromised=true</script>'}
        color="#000000"
      />,
    );

    expect(twemoji).toContain('data-catalog-icon="twemoji:1f600"');
    expect(twemoji).toContain('viewBox="0 0 36 36"');
    expect(flag).toContain('data-catalog-icon="circle-flags:fr"');
    expect(flag).toContain('viewBox="0 0 512 512"');
    for (const markup of [twemoji, flag]) {
      expect(markup).not.toMatch(/https?:\/\//i);
      expect(markup).not.toMatch(/\son[a-z]+=/i);
      expect(markup).not.toContain('<script');
      expect(markup).not.toContain('<foreignObject');
    }
    expect(unknown).toContain('data-render-warning="ICON_UNKNOWN"');
    expect(unknown).not.toContain('<script>');
    expect(unknown).not.toContain('globalThis.compromised=true</script>');
  });
});
