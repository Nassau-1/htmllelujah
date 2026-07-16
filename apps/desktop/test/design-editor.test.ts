import { createNeutralDemoDeck, resolveSlide } from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  createDesignCanvasContext,
  duplicateThemeWithFreshIds,
  rebaseEntityReplacement,
  replaceElementFrames,
  themeForSlide,
  updateThemeFontFamily,
  updateThemeRoleStyle,
} from '../src/renderer/editor/design-editor.js';

describe('canonical theme, master, and layout editor helpers', () => {
  it('duplicates a theme and every nested style identity without mutating source', () => {
    const source = createNeutralDemoDeck().themes[0]!;
    const before = structuredClone(source);
    let sequence = 0;
    const duplicate = duplicateThemeWithFreshIds(
      source,
      () => `f0000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    );

    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.textStyles.map((style) => style.id)).not.toContain(source.textStyles[0]?.id);
    expect(new Set(duplicate.textStyles.map((style) => style.id)).size).toBe(
      duplicate.textStyles.length,
    );
    expect(source).toEqual(before);
  });

  it('updates heading/body families and role styles through canonical theme values', () => {
    const source = createNeutralDemoDeck().themes[0]!;
    const heading = updateThemeFontFamily(source, 'heading', 'Georgia');
    const body = updateThemeFontFamily(heading, 'body', 'Arial');
    const styled = updateThemeRoleStyle(body, 'title', { fontSizePt: 56, fontWeight: 800 });

    expect(styled.headingFontFamily).toBe('Georgia');
    expect(styled.bodyFontFamily).toBe('Arial');
    expect(styled.textStyles.find((style) => style.role === 'title')).toMatchObject({
      fontFamily: 'Georgia',
      fontSizePt: 56,
      fontWeight: 800,
    });
    expect(styled.textStyles.find((style) => style.role === 'body')?.fontFamily).toBe('Arial');
  });

  it('updates every reusable text role, including subtitle alignment and line height', () => {
    let theme = createNeutralDemoDeck().themes[0]!;
    for (const role of ['title', 'subtitle', 'body', 'caption', 'label', 'quote'] as const) {
      theme = updateThemeRoleStyle(theme, role, {
        alignment: 'center',
        fontSizePt: 19,
        lineHeight: 1.7,
      });
      expect(theme.textStyles.find((style) => style.role === role)).toMatchObject({
        alignment: 'center',
        fontSizePt: 19,
        lineHeight: 1.7,
      });
    }
  });

  it('resolves the theme through the active slide layout and master', () => {
    const source = createNeutralDemoDeck();
    const secondTheme = {
      ...structuredClone(source.themes[0]!),
      id: 'f1000000-0000-4000-8000-000000000001',
      name: 'Second theme',
      textStyles: source.themes[0]!.textStyles.map((style, index) => ({
        ...style,
        id: `f1000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      })),
    };
    const secondMaster = {
      ...structuredClone(source.masters[0]!),
      id: 'f1000000-0000-4000-8000-000000000002',
      themeId: secondTheme.id,
    };
    const secondLayout = {
      ...structuredClone(source.layouts[0]!),
      id: 'f1000000-0000-4000-8000-000000000003',
      masterId: secondMaster.id,
    };
    const slide = { ...source.slides[0]!, layoutId: secondLayout.id };
    const document = {
      ...source,
      themes: [...source.themes, secondTheme],
      masters: [...source.masters, secondMaster],
      layouts: [...source.layouts, secondLayout],
      slides: [slide],
    };
    expect(themeForSlide(document, slide)?.id).toBe(secondTheme.id);
  });

  it('rebases only the requested fields over the latest queued entity state', () => {
    const baseline = {
      name: 'Original',
      background: { type: 'solid', color: '#111111' },
      elements: [{ id: 'one', x: 1 }],
    } as const;
    const requested = { ...baseline, name: 'Renamed' };
    const latest = {
      ...baseline,
      background: { type: 'solid', color: '#222222' },
      elements: [{ id: 'one', x: 2 }],
    } as const;

    expect(rebaseEntityReplacement(baseline, requested, latest)).toEqual({
      ...latest,
      name: 'Renamed',
    });
  });

  it('merges rapid additions to different stable-ID array entries without losing either', () => {
    const baseline = { guides: [{ id: 'base', positionPt: 10 }] };
    const firstCommitted = {
      guides: [...baseline.guides, { id: 'first', positionPt: 20 }],
    };
    const secondRequested = {
      guides: [...baseline.guides, { id: 'second', positionPt: 30 }],
    };
    expect(rebaseEntityReplacement(baseline, secondRequested, firstCommitted).guides).toEqual([
      { id: 'base', positionPt: 10 },
      { id: 'first', positionPt: 20 },
      { id: 'second', positionPt: 30 },
    ]);
  });

  it('derives editable master/layout previews without mutating the deck or creating a write path', () => {
    const deck = createNeutralDemoDeck();
    const slide = deck.slides[0]!;
    const layout = deck.layouts[0]!;
    const master = deck.masters[0]!;
    const before = structuredClone(deck);
    const layoutContext = createDesignCanvasContext(deck, slide, 'layout', layout, master);
    const masterContext = createDesignCanvasContext(deck, slide, 'master', layout, master);

    expect(layoutContext.editableElements).toBe(layout.elements);
    expect(layoutContext.slide.elements).toEqual([]);
    expect(
      resolveSlide(layoutContext.document, layoutContext.slide.id, { includePlaceholders: true })
        .elements,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'layout' })]));
    expect(masterContext.editableElements).toBe(master.elements);
    expect(masterContext.document.layouts).toHaveLength(1);
    expect(deck).toEqual(before);
  });

  it('replaces only requested top-level frames and keeps inputs immutable', () => {
    const element = createNeutralDemoDeck().layouts[0]!.elements[0]!;
    const before = structuredClone(element);
    const frame = { ...element.frame, xPt: element.frame.xPt + 25, rotationDeg: 45 };
    const result = replaceElementFrames([element], [{ elementId: element.id, frame }]);

    expect(result[0]?.frame).toEqual(frame);
    expect(result[0]).not.toBe(element);
    expect(element).toEqual(before);
  });
});
