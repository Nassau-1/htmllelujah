import type { ImportFidelityRecord, PresentationImportPreview } from '@htmllelujah/pptx-importer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  countImportFidelity,
  fidelityRecordsByStatus,
  PresentationImportDialog,
} from '../src/renderer/components/PresentationImportDialog.js';

const preview = (
  overrides: Partial<PresentationImportPreview> = {},
): PresentationImportPreview => ({
  schemaVersion: 1,
  mode: 'design-only',
  source: {
    sha256: 'a'.repeat(64),
    archiveBytes: 1_572_864,
    expandedBytes: 4_000_000,
    entryCount: 18,
    presentationPart: 'ppt/presentation.xml',
    masterPartCount: 2,
    layoutPartCount: 3,
    themePartCount: 1,
    slidePartCount: 7,
    mediaPartCount: 2,
    unsupportedPartCount: 1,
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
      name: 'Executive theme',
      colors: [],
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
      background: { kind: 'inherit' },
      placeholders: [],
      pageFurniture: [],
    },
    {
      id: 'pptx_master_2',
      sourcePart: 'ppt/slideMasters/slideMaster2.xml',
      name: 'Secondary master',
      themeId: 'pptx_theme_1',
      layoutIds: [],
      background: { kind: 'inherit' },
      placeholders: [],
      pageFurniture: [],
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
      placeholders: [],
      pageFurniture: [],
    },
    {
      id: 'pptx_layout_2',
      sourcePart: 'ppt/slideLayouts/slideLayout2.xml',
      masterId: 'pptx_master_1',
      name: 'Title',
      type: 'titleOnly',
      background: { kind: 'inherit' },
      placeholders: [],
      pageFurniture: [],
    },
    {
      id: 'pptx_layout_3',
      sourcePart: 'ppt/slideLayouts/slideLayout3.xml',
      masterId: 'pptx_master_1',
      name: 'Blank',
      type: 'blank',
      background: { kind: 'inherit' },
      placeholders: [],
      pageFurniture: [],
    },
  ],
  fidelity: [
    {
      id: 'fidelity-page',
      sourcePart: 'ppt/presentation.xml',
      itemKind: 'page-size',
      status: 'imported',
      detail: 'Page size can be imported natively.',
    },
    {
      id: 'fidelity-font',
      sourcePart: 'ppt/theme/theme1.xml',
      itemKind: 'font',
      status: 'substituted',
      detail: 'Unavailable font will use the configured fallback.',
    },
    {
      id: 'fidelity-picture',
      sourcePart: 'ppt/media/image1.png',
      itemKind: 'picture',
      status: 'rasterized',
      detail: 'Picture remains pixel-based.',
    },
    {
      id: 'fidelity-slides',
      sourcePart: 'ppt/slides/slide1.xml',
      itemKind: 'slide-content',
      status: 'unsupported',
      detail: 'Slide content is outside design-only import.',
    },
  ],
  warnings: [
    {
      code: 'SLIDES_NOT_SELECTED',
      message: 'Seven slide parts remain unchanged.',
      sourcePart: 'ppt/presentation.xml',
    },
  ],
  ...overrides,
});

describe('PresentationImportDialog', () => {
  it('renders a preview-first accessible design-only summary and full fidelity taxonomy', () => {
    const markup = renderToStaticMarkup(
      <PresentationImportDialog
        preview={preview()}
        sourceName="Board template.potx"
        onCancel={vi.fn()}
        onImportDesign={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('Import design from Board template.potx');
    expect(markup).toContain('Design-only, preview first');
    expect(markup).toContain('Slide content is not imported.');
    expect(markup).toContain('source file is read-only');
    expect(markup).toContain('remains unchanged');
    expect(markup).toContain('960 × 540 pt');
    expect(markup).toMatch(/Themes<\/dt><dd>1<\/dd>/u);
    expect(markup).toMatch(/Masters<\/dt><dd>2<\/dd>/u);
    expect(markup).toMatch(/Layouts<\/dt><dd>3<\/dd>/u);
    expect(markup).toContain('aria-label="Fidelity status counts"');
    expect(markup).toContain('>Imported<');
    expect(markup).toContain('>Substituted<');
    expect(markup).toContain('>Rasterized<');
    expect(markup).toContain('>Unsupported<');
    expect(markup).toContain('Page size can be imported natively.');
    expect(markup).toContain('SLIDES_NOT_SELECTED');
    expect(markup).toContain('Seven slide parts remain unchanged.');
    expect(markup).toContain('>Cancel<');
    expect(markup).toContain('>Import design only<');
  });

  it('announces and disables both actions while an import is busy', () => {
    const markup = renderToStaticMarkup(
      <PresentationImportDialog
        preview={preview()}
        busy
        onCancel={vi.fn()}
        onImportDesign={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Importing design…');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Importing design. Please wait.');
    expect(markup.match(/<button[^>]*disabled=""/gu)).toHaveLength(2);
  });

  it('renders an associated alert while keeping retry and cancellation available', () => {
    const markup = renderToStaticMarkup(
      <PresentationImportDialog
        preview={preview({ warnings: [] })}
        error="The selected master exceeds the current document limit."
        onCancel={vi.fn()}
        onImportDesign={vi.fn()}
      />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The selected master exceeds the current document limit.');
    expect(markup).not.toContain('presentation-import-warnings');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toMatch(/aria-describedby="[^"]+ [^"]+"/u);
  });
});

describe('presentation import fidelity helpers', () => {
  it('counts all four statuses without relying on display order', () => {
    expect(countImportFidelity(preview().fidelity)).toEqual({
      imported: 1,
      substituted: 1,
      rasterized: 1,
      unsupported: 1,
    });
  });

  it('bounds detailed records while preserving the complete status count', () => {
    const records: ImportFidelityRecord[] = Array.from({ length: 12 }, (_, index) => ({
      id: `record-${index}`,
      sourcePart: `ppt/theme/item-${index}.xml`,
      itemKind: 'theme-item',
      status: 'imported',
      detail: `Imported item ${index}.`,
    }));

    expect(countImportFidelity(records).imported).toBe(12);
    expect(fidelityRecordsByStatus(records, 'imported')).toHaveLength(8);
    expect(fidelityRecordsByStatus(records, 'unsupported')).toEqual([]);
  });
});
