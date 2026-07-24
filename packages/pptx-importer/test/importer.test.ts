import { describe, expect, it } from 'vitest';

import { parsePresentationImportPreview, PresentationImportError } from '../src/index.js';
import { parseOpcArchive } from '../src/zip.js';
import { parseBoundedXml } from '../src/xml.js';
import {
  createPresentationFixture,
  createSyntheticZip,
  defaultThemeXml,
  presentationFixtureEntries,
} from './fixture-builder.js';

const expectImportCode = (
  operation: () => unknown,
  code: PresentationImportError['code'],
): void => {
  try {
    operation();
    throw new Error('Expected PresentationImportError.');
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationImportError);
    expect((error as PresentationImportError).code).toBe(code);
  }
};

describe('parsePresentationImportPreview', () => {
  it.each([0, 8] as const)(
    'imports the bounded design preview from method %s members',
    (method) => {
      const bytes = createPresentationFixture({ method });
      const sourceCopy = Uint8Array.from(bytes);
      const preview = parsePresentationImportPreview(bytes, { mode: 'design-only' });

      expect(Uint8Array.from(bytes)).toEqual(sourceCopy);
      expect(preview.mode).toBe('design-only');
      expect(preview.pageSize).toEqual({
        widthEmu: 12_192_000,
        heightEmu: 6_858_000,
        widthPt: 960,
        heightPt: 540,
      });
      expect(preview.source.entryCount).toBe(10);
      expect(preview.source.masterPartCount).toBe(1);
      expect(preview.source.layoutPartCount).toBe(1);
      expect(preview.source.themePartCount).toBe(1);
      expect(preview.source.slidePartCount).toBe(1);
      expect(preview.themes).toHaveLength(1);
      expect(preview.themes[0]).toMatchObject({
        name: 'Board theme',
        majorLatinFont: 'Aptos Display',
        minorLatinFont: 'Aptos',
      });
      expect(preview.themes[0]?.colors).toEqual([
        { role: 'dk1', color: { kind: 'system', value: '111827' } },
        { role: 'lt1', color: { kind: 'system', value: 'FFFFFF' } },
        { role: 'accent1', color: { kind: 'rgb', value: '2563EB' } },
        { role: 'accent2', color: { kind: 'rgb', value: '14B8A6' } },
      ]);
      expect(preview.masters).toHaveLength(1);
      expect(preview.masters[0]).toMatchObject({
        name: 'Executive master',
        background: { kind: 'solid', color: { kind: 'rgb', value: 'F8FAFC' } },
      });
      expect(preview.masters[0]?.layoutIds).toEqual([preview.layouts[0]?.id]);
      expect(preview.masters[0]?.placeholders).toHaveLength(2);
      expect(preview.masters[0]?.placeholders[0]?.geometry).toMatchObject({
        xEmu: 914_400,
        yEmu: 457_200,
        widthPt: 792,
        heightPt: 72,
      });
      expect(preview.masters[0]?.pageFurniture).toEqual([
        expect.objectContaining({ kind: 'footer', text: 'Confidential' }),
      ]);
      expect(preview.layouts).toHaveLength(1);
      expect(preview.layouts[0]).toMatchObject({
        name: 'Title and content',
        type: 'titleAndContent',
        background: { kind: 'inherit' },
      });
      expect(preview.layouts[0]?.masterId).toBe(preview.masters[0]?.id);
      expect(preview.fidelity).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ itemKind: 'page-size', status: 'imported' }),
          expect.objectContaining({ itemKind: 'slide-content', status: 'unsupported' }),
          expect.objectContaining({ itemKind: 'pic', status: 'unsupported' }),
        ]),
      );
      expect(preview.warnings).toEqual([expect.objectContaining({ code: 'SLIDES_NOT_SELECTED' })]);
      expect(Object.isFrozen(preview)).toBe(true);
      expect(Object.isFrozen(preview.masters)).toBe(true);
      expect(Object.isFrozen(preview.masters[0]?.placeholders)).toBe(true);
    },
  );

  it('creates stable canonical identifiers for the same unchanged source', () => {
    const bytes = createPresentationFixture();
    const first = parsePresentationImportPreview(bytes, { mode: 'design-only' });
    const second = parsePresentationImportPreview(bytes, { mode: 'design-only' });

    expect(second).toEqual(first);
    expect(first.masters[0]?.id).toMatch(/^pptx_master_[0-9a-f]{20}$/u);
    expect(first.layouts[0]?.id).toMatch(/^pptx_layout_[0-9a-f]{20}$/u);
    expect(first.themes[0]?.id).toMatch(/^pptx_theme_[0-9a-f]{20}$/u);
  });

  it('accepts the non-macro template main content type used by .potx files', () => {
    const entries = presentationFixtureEntries().map((entry) =>
      entry.name === '[Content_Types].xml'
        ? {
            ...entry,
            content: String(entry.content).replace(
              'presentationml.presentation.main+xml',
              'presentationml.template.main+xml',
            ),
          }
        : entry,
    );
    const preview = parsePresentationImportPreview(createSyntheticZip(entries), {
      mode: 'design-only',
    });
    expect(preview.masters).toHaveLength(1);
  });

  it('rejects a macro-enabled main content type even without a VBA part name', () => {
    const entries = presentationFixtureEntries().map((entry) =>
      entry.name === '[Content_Types].xml'
        ? {
            ...entry,
            content: String(entry.content).replace(
              'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
              'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
            ),
          }
        : entry,
    );
    expectImportCode(
      () =>
        parsePresentationImportPreview(createSyntheticZip(entries), {
          mode: 'design-only',
        }),
      'UNSAFE_PACKAGE',
    );
  });

  it('rejects external relationships before any design preview is returned', () => {
    const bytes = createPresentationFixture({
      extraPresentationRelationship:
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/" TargetMode="External"/>',
    });
    expectImportCode(
      () => parsePresentationImportPreview(bytes, { mode: 'design-only' }),
      'RELATIONSHIP_UNSAFE',
    );
  });

  it.each([
    'ppt/vbaProject.bin',
    'ppt/activeX/activeX1.bin',
    'ppt/embeddings/embedded.xlsx',
    'ppt/oleObject1.bin',
  ])('rejects unsafe executable or embedded part %s', (name) => {
    const bytes = createPresentationFixture({
      extraEntries: [{ name, content: new Uint8Array([1, 2, 3]) }],
    });
    expectImportCode(
      () => parsePresentationImportPreview(bytes, { mode: 'design-only' }),
      'UNSAFE_PACKAGE',
    );
  });

  it('rejects DTD/entity declarations and non-declaration processing instructions', () => {
    const unsafeTheme = defaultThemeXml.replace(
      '<a:theme ',
      '<!DOCTYPE a:theme [<!ENTITY steal SYSTEM "file:///secret">]><a:theme ',
    );
    expectImportCode(
      () =>
        parsePresentationImportPreview(createPresentationFixture({ themeXml: unsafeTheme }), {
          mode: 'design-only',
        }),
      'XML_UNSAFE',
    );
    expectImportCode(
      () =>
        parseBoundedXml(
          Buffer.from('<x xmlns="urn:test"><?office instruction?></x>', 'utf8'),
          'unsafe.xml',
        ),
      'XML_UNSAFE',
    );
  });

  it('rejects XML that exceeds the fixed namespace-aware depth budget', () => {
    const nested = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${'<a:x>'.repeat(
      70,
    )}${'</a:x>'.repeat(70)}</a:theme>`;
    expectImportCode(
      () =>
        parsePresentationImportPreview(createPresentationFixture({ themeXml: nested }), {
          mode: 'design-only',
        }),
      'XML_LIMIT_EXCEEDED',
    );
  });

  it('rejects encrypted/data-descriptor and unsupported-compression members', () => {
    const encrypted = createSyntheticZip([{ name: 'x', content: 'x', flags: 0x0001 }]);
    expectImportCode(() => parseOpcArchive(encrypted), 'ZIP_UNSUPPORTED');

    const unsupported = createSyntheticZip([{ name: 'x', content: 'x', method: 99 }]);
    expectImportCode(() => parseOpcArchive(unsupported), 'ZIP_UNSUPPORTED');
  });

  it('rejects traversal, case collisions, and compression bombs', () => {
    expectImportCode(
      () => parseOpcArchive(createSyntheticZip([{ name: '../escape', content: 'x' }])),
      'ZIP_INVALID',
    );
    expectImportCode(
      () =>
        parseOpcArchive(
          createSyntheticZip([
            { name: 'ppt/theme/theme.xml', content: 'x' },
            { name: 'PPT/THEME/THEME.XML', content: 'y' },
          ]),
        ),
      'ZIP_INVALID',
    );
    expectImportCode(
      () =>
        parseOpcArchive(
          createSyntheticZip([
            {
              name: 'bomb',
              content: new Uint8Array(1_000_000),
              method: 8,
            },
          ]),
        ),
      'ZIP_LIMIT_EXCEEDED',
    );
  });

  it('rejects an archive whose entry count exceeds the fixed budget', () => {
    const entries = Array.from({ length: 2_049 }, (_, index) => ({
      name: `entry-${index}`,
      content: '',
    }));
    expectImportCode(() => parseOpcArchive(createSyntheticZip(entries)), 'ZIP_LIMIT_EXCEEDED');
  });

  it('rejects a checksum mismatch', () => {
    const bytes = Buffer.from(createSyntheticZip([{ name: 'safe', content: 'payload' }]));
    const nameLength = bytes.readUInt16LE(26);
    bytes[30 + nameLength] = (bytes[30 + nameLength] ?? 0) ^ 0xff;
    expectImportCode(() => parseOpcArchive(bytes), 'CRC_MISMATCH');
  });

  it('rejects broken internal targets instead of silently omitting them', () => {
    const entries = presentationFixtureEntries().map((entry) =>
      entry.name === 'ppt/_rels/presentation.xml.rels'
        ? {
            ...entry,
            content: String(entry.content).replace('slides/slide1.xml', 'slides/missing.xml'),
          }
        : entry,
    );
    expectImportCode(
      () =>
        parsePresentationImportPreview(createSyntheticZip(entries), {
          mode: 'design-only',
        }),
      'MISSING_PART',
    );
  });

  it('does not claim an unimplemented slide-import mode', () => {
    expectImportCode(
      () =>
        parsePresentationImportPreview(createPresentationFixture(), {
          mode: 'slides',
        } as never),
      'UNSUPPORTED_DOCUMENT',
    );
  });
});
