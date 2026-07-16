import {
  createDefaultDeck,
  DOCUMENT_LIMITS,
  elementSchema,
  validateDeck,
  type ConnectorElement,
  type RichTextDocument,
  type TextElement,
  type TextMarks,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  contentToPlainText,
  contentFromPlainText,
  createConnectorElement,
  createSlide,
  createShapeElement,
  createTextElement,
  duplicateTemplateElements,
  headingLevelOf,
  replacePlainTextPreservingStyles,
  updateRichTextPresentation,
  updateHeadingLevel,
} from '../src/renderer/editor/canonical-factories.js';

const marks = (overrides: Partial<TextMarks> = {}): TextMarks => ({
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  ...overrides,
});

describe('plain text editing with structured rich text', () => {
  it('preserves mixed inline marks and assigns inserted text to its neighbouring run', () => {
    const source: RichTextDocument = {
      blocks: [
        {
          id: '51000000-0000-4000-8000-000000000001',
          type: 'paragraph',
          alignment: 'left',
          runs: [
            { text: 'Alpha', marks: marks({ bold: true, color: '#ff0000' }) },
            { text: ' beta', marks: marks({ italic: true, color: '#0000ff' }) },
          ],
        },
      ],
    };
    const before = structuredClone(source);
    const edited = replacePlainTextPreservingStyles(source, 'AlXpha beta!');

    expect(contentToPlainText(edited)).toBe('AlXpha beta!');
    expect(edited.blocks[0]?.type).toBe('paragraph');
    const block = edited.blocks[0];
    if (block?.type === 'list' || block === undefined) throw new Error('Expected paragraph.');
    expect(block.id).toBe(source.blocks[0]?.id);
    expect(block.runs[0]).toMatchObject({
      text: 'AlXpha',
      marks: { bold: true, color: '#ff0000' },
    });
    expect(block.runs[1]).toMatchObject({
      text: ' beta!',
      marks: { italic: true, color: '#0000ff' },
    });
    expect(source).toEqual(before);
  });

  it('keeps list identity, levels, and per-item marks when lines are edited or added', () => {
    const source: RichTextDocument = {
      blocks: [
        {
          id: '52000000-0000-4000-8000-000000000001',
          type: 'list',
          ordered: false,
          items: [
            {
              id: '52000000-0000-4000-8000-000000000002',
              level: 0,
              runs: [{ text: 'One', marks: marks({ bold: true }) }],
            },
            {
              id: '52000000-0000-4000-8000-000000000003',
              level: 1,
              runs: [{ text: 'Two', marks: marks({ color: '#123456' }) }],
            },
          ],
        },
      ],
    };
    const edited = replacePlainTextPreservingStyles(source, 'One!\nTwo revised\nThree');
    const block = edited.blocks[0];
    if (block?.type !== 'list') throw new Error('Expected list.');

    expect(block.id).toBe(source.blocks[0]?.id);
    expect(block.items).toHaveLength(3);
    expect(block.items[0]).toMatchObject({
      id: '52000000-0000-4000-8000-000000000002',
      level: 0,
    });
    expect(block.items[0]?.runs[0]?.marks.bold).toBe(true);
    expect(block.items[1]).toMatchObject({
      id: '52000000-0000-4000-8000-000000000003',
      level: 1,
    });
    expect(block.items[1]?.runs[0]?.marks.color).toBe('#123456');
    expect(block.items[2]?.level).toBe(1);
    expect(block.items[2]?.runs[0]?.marks.color).toBe('#123456');
  });

  it('preserves heading and list semantics when the first character is typed', () => {
    const source: RichTextDocument = {
      blocks: [
        {
          id: '52500000-0000-4000-8000-000000000001',
          type: 'heading',
          level: 3,
          alignment: 'center',
          runs: [{ text: 'Heading', marks: marks({ bold: true }) }],
        },
        {
          id: '52500000-0000-4000-8000-000000000002',
          type: 'list',
          ordered: true,
          items: [
            {
              id: '52500000-0000-4000-8000-000000000003',
              level: 2,
              runs: [{ text: 'Item', marks: marks({ italic: true }) }],
            },
          ],
        },
      ],
    };

    const edited = replacePlainTextPreservingStyles(source, 'XHeading\nItem');
    expect(edited.blocks[0]).toMatchObject({ type: 'heading', level: 3, alignment: 'center' });
    expect(edited.blocks[1]).toMatchObject({ type: 'list', ordered: true });
    const list = edited.blocks[1];
    expect(list?.type === 'list' && list.items[0]).toMatchObject({ level: 2 });
    expect(list?.type === 'list' && list.items[0]?.runs[0]?.marks.italic).toBe(true);
  });

  it('applies explicit formatting changes without erasing unrelated inline attributes', () => {
    const source: RichTextDocument = {
      blocks: [
        {
          id: '53000000-0000-4000-8000-000000000001',
          type: 'heading',
          level: 2,
          alignment: 'left',
          runs: [
            {
              text: 'Styled',
              marks: marks({ color: '#abcdef', strikethrough: true, fontSizePt: 18 }),
            },
          ],
        },
      ],
    };
    const updated = updateRichTextPresentation(source, {
      alignment: 'center',
      marks: { bold: true, fontFamily: 'Arial' },
    });
    const block = updated.blocks[0];
    if (block?.type === 'list' || block === undefined) throw new Error('Expected heading.');

    expect(block).toMatchObject({ type: 'heading', level: 2, alignment: 'center' });
    expect(block.runs[0]?.marks).toMatchObject({
      bold: true,
      fontFamily: 'Arial',
      color: '#abcdef',
      strikethrough: true,
      fontSizePt: 18,
    });
  });

  it('creates, reads, and updates every H1 through H6 level without flattening runs', () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const content = contentFromPlainText(`Heading ${level}`, {
        kind: 'heading',
        headingLevel: level,
        alignment: 'left',
        marks: marks({ bold: level % 2 === 0 }),
      });
      expect(headingLevelOf(content)).toBe(level);
      const updated = updateHeadingLevel(
        content,
        level === 6 ? 1 : ((level + 1) as 2 | 3 | 4 | 5 | 6),
      );
      const block = updated.blocks[0];
      expect(block?.type).toBe('heading');
      expect(block?.type === 'heading' && block.runs[0]?.text).toBe(`Heading ${level}`);
      expect(block?.type === 'heading' && block.runs[0]?.marks.bold).toBe(level % 2 === 0);
    }
  });

  it('keeps 500,000-character edits within canonical block and run limits', () => {
    const longLine = 'a'.repeat(500_000);
    const content = contentFromPlainText(longLine, {
      kind: 'paragraph',
      alignment: 'left',
      marks: marks(),
    });
    const element: TextElement = { ...createTextElement(), content };
    expect(contentToPlainText(content)).toBe(longLine);
    expect(content.blocks).toHaveLength(1);
    const block = content.blocks[0];
    expect(block?.type !== 'list' && block?.runs).toHaveLength(5);
    expect(
      block?.type !== 'list' &&
        block?.runs.every((run) => run.text.length <= DOCUMENT_LIMITS.maxTextRunLength),
    ).toBe(true);
    expect(elementSchema.safeParse(element).success).toBe(true);

    const manyLines = Array.from({ length: 2_500 }, (_, index) => `line-${index}`).join('\n');
    const edited = replacePlainTextPreservingStyles(createTextElement().content, manyLines);
    expect(edited.blocks).toHaveLength(DOCUMENT_LIMITS.maxRichTextBlocks);
    expect(contentToPlainText(edited)).toBe(manyLines);
    expect(elementSchema.safeParse({ ...createTextElement(), content: edited }).success).toBe(true);
  });

  it('never splits a UTF-16 surrogate pair at the run boundary', () => {
    const text = `${'a'.repeat(DOCUMENT_LIMITS.maxTextRunLength - 1)}😀tail`;
    const content = contentFromPlainText(text, {
      kind: 'paragraph',
      alignment: 'left',
      marks: marks(),
    });
    const block = content.blocks[0];
    if (block === undefined || block.type === 'list') throw new Error('Expected paragraph.');
    expect(block.runs[0]?.text).toBe('a'.repeat(DOCUMENT_LIMITS.maxTextRunLength - 1));
    expect(block.runs[1]?.text.startsWith('😀')).toBe(true);
    expect(block.runs.map((run) => run.text).join('')).toBe(text);
  });
});

describe('template object duplication', () => {
  it('freshens identifiers and connector bindings without moving or renaming objects', () => {
    const shape = createShapeElement();
    const connector: ConnectorElement = {
      ...createConnectorElement(),
      start: { xPt: 180, yPt: 250, binding: { elementId: shape.id, anchor: 'center' } },
    };
    expect(connector.geometryVersion).toBe(2);
    const copies = duplicateTemplateElements([shape, connector]);
    const shapeCopy = copies[0];
    const connectorCopy = copies[1];
    expect(shapeCopy).toMatchObject({ name: shape.name, frame: shape.frame });
    expect(connectorCopy).toMatchObject({ name: connector.name, frame: connector.frame });
    expect(shapeCopy?.id).not.toBe(shape.id);
    expect(connectorCopy?.id).not.toBe(connector.id);
    expect(connectorCopy?.type === 'connector' && connectorCopy.start.binding.elementId).toBe(
      shapeCopy?.id,
    );
  });
});

describe('layout-aware slide creation', () => {
  it('instantiates master and layout text placeholders with inherited frames and bindings', () => {
    const source = createDefaultDeck({ name: 'Quarterly review' });
    const layout = source.layouts[0]!;
    const master = source.masters[0]!;
    const footerPlaceholder = {
      ...layout.elements[0]!,
      id: '54000000-0000-4000-8000-000000000001',
      name: 'Footer placeholder',
      role: 'footer' as const,
      prompt: 'Add footer',
      frame: { xPt: 90, yPt: 500, widthPt: 700, heightPt: 20, rotationDeg: 0 },
    };
    const document = {
      ...source,
      masters: [{ ...master, elements: [footerPlaceholder] }],
    };

    const slide = createSlide(document, layout.id, 4);
    const titlePlaceholder = layout.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'title',
    );
    const bodyPlaceholder = layout.elements.find(
      (element) => element.type === 'placeholder' && element.role === 'body',
    );
    const title = slide.elements.find(
      (element) => element.placeholderBinding?.placeholderId === titlePlaceholder?.id,
    );
    const body = slide.elements.find(
      (element) => element.placeholderBinding?.placeholderId === bodyPlaceholder?.id,
    );
    const footer = slide.elements.find(
      (element) => element.placeholderBinding?.placeholderId === footerPlaceholder.id,
    );

    expect(slide).toMatchObject({ name: 'Slide 5', layoutId: layout.id, hidden: false });
    expect(title).toMatchObject({
      type: 'text',
      styleRole: 'title',
      frame: titlePlaceholder?.frame,
      placeholderBinding: { placeholderId: titlePlaceholder?.id, overrides: [] },
    });
    expect(body).toMatchObject({
      type: 'text',
      styleRole: 'body',
      frame: bodyPlaceholder?.frame,
      placeholderBinding: { placeholderId: bodyPlaceholder?.id, overrides: [] },
    });
    expect(footer).toMatchObject({
      type: 'text',
      styleRole: 'caption',
      frame: footerPlaceholder.frame,
      placeholderBinding: { placeholderId: footerPlaceholder.id, overrides: [] },
    });
    expect(contentToPlainText((footer as TextElement).content)).toBe('Quarterly review');
    expect(validateDeck({ ...document, slides: [...document.slides, slide] }).success).toBe(true);
  });

  it('creates a valid empty slide for a layout without text-compatible placeholders', () => {
    const source = createDefaultDeck();
    const layout = source.layouts[0]!;
    const mediaOnly = {
      ...layout,
      elements: layout.elements.map((element) =>
        element.type === 'placeholder'
          ? { ...element, accepts: ['image'] as const, role: 'media' as const }
          : element,
      ),
    };
    const document = { ...source, layouts: [mediaOnly] };
    const slide = createSlide(document, mediaOnly.id, 1);

    expect(slide.elements).toEqual([]);
    expect(validateDeck({ ...document, slides: [slide] }).success).toBe(true);
  });

  it('refuses a missing layout instead of producing an invalid slide reference', () => {
    const source = createDefaultDeck();
    expect(() => createSlide(source, '54000000-0000-4000-8000-000000000099', 1)).toThrow(
      'layout 54000000-0000-4000-8000-000000000099 is missing',
    );
  });
});
