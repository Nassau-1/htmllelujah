import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  CATALOG_IDS,
  CIRCLE_FLAG_CATALOG,
  getContentCatalogEntries,
  getContentCatalogEntry,
  isKnownCatalogIcon,
  LOCAL_ICON_CATALOG,
  LOCAL_ICON_PATHS,
  LocalIcon,
  normalizeCatalogIconIdentity,
  searchContentCatalog,
  SHAPE_CATALOG,
  TWEMOJI_CATALOG,
} from '../src/index.js';

describe('offline content catalogs', () => {
  it('exposes complete pinned Twemoji and two-letter circular-flag catalogs', () => {
    expect(TWEMOJI_CATALOG).toHaveLength(3720);
    expect(CIRCLE_FLAG_CATALOG).toHaveLength(265);
    expect(getContentCatalogEntries('shapes')).toBe(SHAPE_CATALOG);
    expect(CATALOG_IDS).toEqual(['shapes', 'local-icons', 'twemoji', 'circle-flags']);
    expect(
      LOCAL_ICON_CATALOG.map((catalogEntry) =>
        catalogEntry.insert.type === 'icon' ? catalogEntry.insert.iconName : '',
      ),
    ).toEqual(Object.keys(LOCAL_ICON_PATHS));
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
