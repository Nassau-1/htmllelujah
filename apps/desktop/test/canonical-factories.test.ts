import type { RichTextDocument, TextMarks } from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  contentToPlainText,
  replacePlainTextPreservingStyles,
  updateRichTextPresentation,
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
});
