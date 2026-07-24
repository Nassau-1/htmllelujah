import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ContentCatalogPicker,
  getNextCatalogResultIndex,
} from '../src/renderer/components/ContentCatalogPicker.js';

describe('ContentCatalogPicker', () => {
  it('renders an accessible offline picker with the four bounded catalogs', () => {
    const markup = renderToStaticMarkup(
      <ContentCatalogPicker onDismiss={vi.fn()} onSelect={vi.fn()} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('type="search"');
    expect(markup.match(/role="tab"/gu)).toHaveLength(4);
    expect(markup).toMatch(/aria-selected="true"[^>]*>Shapes/u);
    expect(markup).toContain('>Icons<');
    expect(markup).toContain('>Emoji<');
    expect(markup).toContain('>Circle flags<');
    expect(markup).toContain('aria-label="Rectangle"');
    expect(markup).not.toMatch(/(?:href|src)="https?:\/\//u);
    expect(markup).not.toContain('<script');
  });

  it('uses localized labels and exposes an explicit searchable empty state', () => {
    const markup = renderToStaticMarkup(
      <ContentCatalogPicker
        initialCatalog="circle-flags"
        initialQuery="aucun-resultat-impossible"
        locale="fr"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup).toContain('Insérer un visuel');
    expect(markup).toMatch(/aria-selected="true"[^>]*>Drapeaux ronds/u);
    expect(markup).toContain('0 résultat');
    expect(markup).toContain('Aucun contenu ne correspond à cette recherche.');
  });

  it('limits visible catalogs and falls back to the first allowed catalog', () => {
    const markup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji', 'circle-flags']}
        initialCatalog="shapes"
        initialQuery="aucun-resultat-impossible"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup.match(/role="tab"/gu)).toHaveLength(2);
    expect(markup).toMatch(/aria-selected="true"[^>]*>Emoji/u);
    expect(markup).toContain('>Circle flags<');
    expect(markup).not.toContain('>Shapes<');
    expect(markup).not.toContain('>Icons<');
  });

  it('renders trusted embedded Twemoji and circle-flag previews without remote assets', () => {
    const twemojiMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji']}
        initialCatalog="twemoji"
        initialEmojiScope="all"
        initialQuery="1f600"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const flagMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['circle-flags']}
        initialCatalog="circle-flags"
        initialQuery="France"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(twemojiMarkup).toContain('data-catalog-icon="twemoji:1f600"');
    expect(flagMarkup).toContain('data-catalog-icon="circle-flags:fr"');
    expect(`${twemojiMarkup}${flagMarkup}`).not.toMatch(/(?:href|src)="https?:\/\//u);
  });

  it('offers a region filter while keeping the complete circular-flag catalog available', () => {
    const allMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['circle-flags']}
        initialCatalog="circle-flags"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const europeMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['circle-flags']}
        initialCatalog="circle-flags"
        initialFlagRegion="europe"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(allMarkup).toContain('Flag region');
    expect(allMarkup).toContain('All regions');
    expect(allMarkup).toContain('1–72 of 265 results');
    expect(europeMarkup).toContain('<option value="europe" selected="">Europe</option>');
    expect(europeMarkup).toContain('of ');
    expect(europeMarkup).toContain('results');
  });

  it('defaults emoji browsing to Business and exposes an exhaustive All scope', () => {
    const businessMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji']}
        initialCatalog="twemoji"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const allMarkup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji']}
        initialCatalog="twemoji"
        initialEmojiScope="all"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(businessMarkup).toMatch(/aria-pressed="true"[^>]*>Business/u);
    expect(businessMarkup).toContain('Business category');
    expect(businessMarkup).not.toContain('aria-label="grinning face"');
    expect(allMarkup).toMatch(/aria-pressed="true"[^>]*>All/u);
    expect(allMarkup).toContain('1–72 of 3,720 results');
    expect(allMarkup).toContain('aria-label="grinning face"');
  });

  it('renders exact bounded ranges and makes the final emoji and flag pages reachable', () => {
    const lastEmojiPage = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji']}
        initialCatalog="twemoji"
        initialEmojiScope="all"
        initialOffset={3672}
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    const lastFlagPage = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['circle-flags']}
        initialCatalog="circle-flags"
        initialOffset={216}
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(lastEmojiPage).toContain('3,673–3,720 of 3,720 results');
    expect(lastEmojiPage.match(/class="content-catalog-item"/gu)).toHaveLength(48);
    expect(lastEmojiPage).toContain('aria-posinset="3720"');
    expect(lastEmojiPage).toContain('aria-setsize="3720"');
    expect(lastFlagPage).toContain('217–265 of 265 results');
    expect(lastFlagPage.match(/class="content-catalog-item"/gu)).toHaveLength(49);
    expect(lastFlagPage).toContain('aria-posinset="265"');
    expect(lastFlagPage).toContain('aria-setsize="265"');
  });

  it('keeps each rendered page below the 144-card DOM ceiling with accessible pagination', () => {
    const markup = renderToStaticMarkup(
      <ContentCatalogPicker
        catalogs={['twemoji']}
        initialCatalog="twemoji"
        initialEmojiScope="all"
        onDismiss={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(markup.match(/class="content-catalog-item"/gu)).toHaveLength(72);
    expect(markup).toContain('aria-label="Catalog pagination"');
    expect(markup).toContain('aria-label="Previous page"');
    expect(markup).toContain('aria-label="Next page"');
    expect(markup).toContain('Page 1 of 52');
  });
});

describe('getNextCatalogResultIndex', () => {
  it('moves through a six-column result grid and clamps at every boundary', () => {
    expect(getNextCatalogResultIndex(0, 'ArrowLeft', 14)).toBe(0);
    expect(getNextCatalogResultIndex(0, 'ArrowRight', 14)).toBe(1);
    expect(getNextCatalogResultIndex(1, 'ArrowDown', 14)).toBe(7);
    expect(getNextCatalogResultIndex(7, 'ArrowUp', 14)).toBe(1);
    expect(getNextCatalogResultIndex(13, 'ArrowDown', 14)).toBe(13);
    expect(getNextCatalogResultIndex(4, 'Home', 14)).toBe(0);
    expect(getNextCatalogResultIndex(4, 'End', 14)).toBe(13);
  });

  it('handles empty catalogs and a defensive custom column count', () => {
    expect(getNextCatalogResultIndex(0, 'ArrowDown', 0)).toBe(-1);
    expect(getNextCatalogResultIndex(1, 'ArrowDown', 4, 0)).toBe(2);
  });
});
