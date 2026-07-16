import { contentToPlainText, emptyMarks } from '../src/renderer/editor/canonical-factories.js';
import {
  replaceRichTextRange,
  RICH_CLIPBOARD_LIMITS,
  RichClipboardError,
  sanitizeClipboardHtml,
} from '../src/renderer/editor/rich-clipboard.js';
import { describe, expect, it } from 'vitest';

const sanitize = (html: string) =>
  sanitizeClipboardHtml(html, { fallbackMarks: emptyMarks(), alignment: 'left' });

describe('allowlisted rich clipboard normalization', () => {
  it('preserves H1 through H6, nested lists, and semantic inline marks', () => {
    const content = sanitize(
      '<h1>One</h1><h2><strong>Two</strong></h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>' +
        '<ul><li>A<ul><li><em>B</em></li></ul></li></ul>',
    );

    expect(
      content.blocks.slice(0, 6).map((block) => (block.type === 'heading' ? block.level : 0)),
    ).toEqual([1, 2, 3, 4, 5, 6]);
    expect(content.blocks[1]?.type === 'heading' && content.blocks[1].runs[0]?.marks.bold).toBe(
      true,
    );
    const lists = content.blocks.filter((block) => block.type === 'list');
    expect(lists.flatMap((block) => block.items.map((item) => item.level))).toEqual([0, 1]);
    expect(lists[0]?.type === 'list' && lists[0].items[1]?.runs[0]?.marks.italic).toBe(true);
  });

  it('drops active subtrees, remote images, attributes, and unsupported styling', () => {
    const content = sanitize(
      '<p style="color:red" onclick="evil()"><span style="font-size:9999px">Safe</span>' +
        '<script>SECRET_SCRIPT()</script><style>SECRET_STYLE</style>' +
        '<img src="https://invalid.example/secret.png"><iframe srcdoc="SECRET_FRAME"></iframe>' +
        '<a href="javascript:evil()"><u> link</u></a></p>',
    );
    const serialized = JSON.stringify(content);

    expect(contentToPlainText(content)).toBe('Safe link');
    expect(serialized).not.toMatch(/SECRET|https:|javascript:|onclick|font-size|color:red/i);
    const block = content.blocks[0];
    expect(block?.type === 'paragraph' && block.runs.at(-1)?.marks.underline).toBe(true);
  });

  it('decodes bounded entities without retaining malformed executable markup', () => {
    const content = sanitize(
      '<p>&lt;b&gt;literal&lt;/b&gt; &amp; &#x1F600; &#xD800;</p><script>alert(1)',
    );
    expect(contentToPlainText(content)).toBe('<b>literal</b> & 😀 �');
    expect(JSON.stringify(content)).not.toContain('alert');
  });

  it('rejects oversized clipboard payloads before parsing', () => {
    expect(() => sanitize('x'.repeat(RICH_CLIPBOARD_LIMITS.maxHtmlLength + 1))).toThrowError(
      RichClipboardError,
    );
  });

  it('inserts inline marks without flattening the surrounding block', () => {
    const source = sanitize('<h3>Hello world</h3>');
    const pasted = sanitize('<strong>safe</strong>');
    const result = replaceRichTextRange(source, 6, 11, pasted, emptyMarks());
    const block = result.blocks[0];

    expect(contentToPlainText(result)).toBe('Hello safe');
    expect(block?.type === 'heading' && block.level).toBe(3);
    expect(block?.type === 'heading' && block.runs.at(-1)?.marks.bold).toBe(true);
  });

  it('keeps pasted heading/list boundaries and removes the selected range atomically', () => {
    const source = sanitize('<p>Before DELETE after</p>');
    const pasted = sanitize('<h2>Heading</h2><ol><li>First</li><li>Second</li></ol>');
    const result = replaceRichTextRange(source, 7, 13, pasted, emptyMarks());

    expect(contentToPlainText(result)).toBe('Before \nHeading\nFirst\nSecond\n after');
    expect(result.blocks.some((block) => block.type === 'heading' && block.level === 2)).toBe(true);
    expect(result.blocks.some((block) => block.type === 'list' && block.ordered)).toBe(true);
  });

  it('rejects a bounded paste when the combined editor text would exceed the V1 limit', () => {
    const source = sanitize(`<p>${'a'.repeat(RICH_CLIPBOARD_LIMITS.maxTextLength - 2)}</p>`);
    const pasted = sanitize('<strong>four</strong>');
    expect(() =>
      replaceRichTextRange(
        source,
        RICH_CLIPBOARD_LIMITS.maxTextLength - 2,
        RICH_CLIPBOARD_LIMITS.maxTextLength - 2,
        pasted,
        emptyMarks(),
      ),
    ).toThrowError(RichClipboardError);
  });

  it('rejects a merge that would exceed canonical block limits', () => {
    const paragraph = sanitize('<p>a</p>').blocks[0]!;
    const source = {
      blocks: Array.from({ length: 1_500 }, (_, index) => ({
        ...paragraph,
        id: `f3000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    };
    const pasted = {
      blocks: Array.from({ length: 600 }, (_, index) => ({
        ...paragraph,
        id: `f4000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    };
    expect(() => replaceRichTextRange(source, 0, 0, pasted, emptyMarks())).toThrowError(
      RichClipboardError,
    );
  });
});
