import {
  applyTransaction,
  createDefaultDeck,
  validateDeck,
  type TransactionOptions,
} from '@htmllelujah/document-core';
import type { PresentationImportPreview } from '@htmllelujah/pptx-importer';
import { describe, expect, it } from 'vitest';

import {
  PresentationDesignPlanError,
  planPresentationDesignImport,
} from '../src/renderer/editor/presentation-design-plan.js';

const idFactory = (namespace: string): (() => string) => {
  let count = 0;
  return () => {
    count += 1;
    return `${namespace.repeat(8)}-0000-4000-8000-${count.toString(16).padStart(12, '0')}`;
  };
};

const preview: PresentationImportPreview = {
  schemaVersion: 1,
  mode: 'design-only',
  source: {
    sha256: 'a'.repeat(64),
    archiveBytes: 10_000,
    expandedBytes: 40_000,
    entryCount: 10,
    presentationPart: 'ppt/presentation.xml',
    masterPartCount: 1,
    layoutPartCount: 1,
    themePartCount: 1,
    slidePartCount: 3,
    mediaPartCount: 0,
    unsupportedPartCount: 0,
  },
  pageSize: {
    widthEmu: 12_192_000,
    heightEmu: 6_858_000,
    widthPt: 960,
    heightPt: 540,
  },
  themes: [
    {
      id: 'pptx_theme_1',
      sourcePart: 'ppt/theme/theme1.xml',
      name: 'Board theme',
      colors: [
        { role: 'dk1', color: { kind: 'system', value: '111827' } },
        { role: 'lt1', color: { kind: 'system', value: 'FFFFFF' } },
        { role: 'accent1', color: { kind: 'rgb', value: '2563EB' } },
      ],
      majorLatinFont: 'Aptos Display',
      minorLatinFont: 'Aptos',
    },
  ],
  masters: [
    {
      id: 'pptx_master_1',
      sourcePart: 'ppt/slideMasters/slideMaster1.xml',
      name: 'Executive master',
      themeId: 'pptx_theme_1',
      layoutIds: ['pptx_layout_1'],
      background: { kind: 'solid', color: { kind: 'rgb', value: 'F8FAFC' } },
      placeholders: [
        {
          id: 'master-footer',
          sourcePart: 'ppt/slideMasters/slideMaster1.xml',
          name: 'Footer',
          type: 'ftr',
          index: 10,
          orientation: undefined,
          size: undefined,
          geometry: {
            xEmu: 457_200,
            yEmu: 6_172_200,
            widthEmu: 4_572_000,
            heightEmu: 228_600,
            xPt: 36,
            yPt: 486,
            widthPt: 360,
            heightPt: 18,
          },
          text: 'Confidential',
        },
      ],
      pageFurniture: [
        {
          id: 'master-footer-field',
          kind: 'footer',
          placeholderId: 'master-footer',
          text: 'Confidential',
        },
      ],
    },
  ],
  layouts: [
    {
      id: 'pptx_layout_1',
      sourcePart: 'ppt/slideLayouts/slideLayout1.xml',
      masterId: 'pptx_master_1',
      name: 'Title and content',
      type: 'titleAndContent',
      background: { kind: 'inherit' },
      placeholders: [
        {
          id: 'layout-title',
          sourcePart: 'ppt/slideLayouts/slideLayout1.xml',
          name: 'Title',
          type: 'title',
          index: 0,
          orientation: undefined,
          size: undefined,
          geometry: {
            xEmu: 914_400,
            yEmu: 457_200,
            widthEmu: 10_058_400,
            heightEmu: 914_400,
            xPt: 72,
            yPt: 36,
            widthPt: 792,
            heightPt: 72,
          },
          text: undefined,
        },
        {
          id: 'layout-body',
          sourcePart: 'ppt/slideLayouts/slideLayout1.xml',
          name: 'Content',
          type: 'body',
          index: 1,
          orientation: undefined,
          size: undefined,
          geometry: undefined,
          text: undefined,
        },
      ],
      pageFurniture: [],
    },
  ],
  fidelity: [
    {
      id: 'page-size',
      sourcePart: 'ppt/presentation.xml',
      itemKind: 'page-size',
      status: 'imported',
      detail: 'Imported.',
    },
  ],
  warnings: [{ code: 'SLIDES_NOT_SELECTED', message: 'Design-only import.' }],
};

const metadata: TransactionOptions = {
  metadata: {
    transactionId: 'eeeeeeee-eeee-4eee-8eee-000000000001',
    actorId: 'desktop-test',
    origin: 'import',
    label: 'Import presentation design',
    timestamp: '2026-07-24T12:00:00.000Z',
  },
};

describe('planPresentationDesignImport', () => {
  it('maps a bounded preview to native, atomic design commands without mutating the preview', () => {
    const sourceCopy = structuredClone(preview);
    const document = createDefaultDeck({
      idFactory: idFactory('a'),
      now: () => '2026-07-24T11:00:00.000Z',
    });
    const plan = planPresentationDesignImport(document, preview, {
      idFactory: idFactory('b'),
    });

    expect(preview).toEqual(sourceCopy);
    expect(plan.page).toEqual({ widthPt: 960, heightPt: 540 });
    expect(plan.themes).toHaveLength(1);
    expect(plan.themes[0]).toMatchObject({
      name: 'Board theme',
      headingFontFamily: 'Aptos Display',
      bodyFontFamily: 'Aptos',
      colors: { background: '#FFFFFF', text: '#111827', accent: '#2563EB' },
    });
    expect(plan.masters[0]?.elements[0]).toMatchObject({
      type: 'text',
      locked: true,
      name: 'Footer',
    });
    expect(plan.layouts[0]?.elements.map(({ type }) => type)).toEqual([
      'placeholder',
      'placeholder',
    ]);
    expect(plan.commands.map(({ type }) => type)).toEqual([
      'deck.set-page',
      'theme.create',
      'master.create',
      'layout.create',
    ]);

    const applied = applyTransaction(document, plan.commands, metadata);
    expect(validateDeck(applied.document)).toMatchObject({ success: true });
    expect(applied.document.page).toEqual(plan.page);
    expect(applied.document.themes).toHaveLength(2);
    expect(applied.document.masters).toHaveLength(2);
    expect(applied.document.layouts).toHaveLength(2);
    expect(applied.document.slides).toHaveLength(document.slides.length);
  });

  it('rejects an incomplete design before producing any command', () => {
    const document = createDefaultDeck({
      idFactory: idFactory('c'),
      now: () => '2026-07-24T11:00:00.000Z',
    });
    expect(() =>
      planPresentationDesignImport(
        document,
        { ...preview, layouts: [] },
        { idFactory: idFactory('d') },
      ),
    ).toThrow(PresentationDesignPlanError);
    expect(() =>
      planPresentationDesignImport(
        document,
        {
          ...preview,
          pageSize: { ...preview.pageSize, widthPt: 20_001 },
        },
        { idFactory: idFactory('e') },
      ),
    ).toThrow(PresentationDesignPlanError);
    expect(() =>
      planPresentationDesignImport(
        document,
        {
          ...preview,
          layouts: Array.from({ length: 98 }, (_, index) => ({
            ...preview.layouts[0]!,
            id: `layout-${index}`,
            name: `Layout ${index}`,
          })),
        },
        { idFactory: idFactory('f') },
      ),
    ).toThrow('atomic import limit');
  });
});
