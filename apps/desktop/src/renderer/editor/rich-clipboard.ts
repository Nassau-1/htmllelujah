import {
  DOCUMENT_LIMITS,
  type RichTextDocument,
  type TextAlignment,
  type TextMarks,
  type TextRun,
} from '@htmllelujah/document-core';

import { boundedTextRuns } from './canonical-factories';

export const RICH_CLIPBOARD_LIMITS = Object.freeze({
  maxHtmlLength: 1_000_000,
  maxTextLength: 500_000,
  maxBlocks: Math.min(1_000, DOCUMENT_LIMITS.maxRichTextBlocks),
  maxRunsPerBlock: DOCUMENT_LIMITS.maxTextRunsPerBlock,
});

export class RichClipboardError extends Error {
  readonly code = 'CLIPBOARD_LIMIT_EXCEEDED';

  constructor(message: string) {
    super(message);
    this.name = 'RichClipboardError';
  }
}

type ParsedLine =
  | Readonly<{
      kind: 'paragraph';
      alignment: TextAlignment;
      runs: readonly TextRun[];
    }>
  | Readonly<{
      kind: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      alignment: TextAlignment;
      runs: readonly TextRun[];
    }>
  | Readonly<{
      kind: 'list';
      ordered: boolean;
      level: number;
      runs: readonly TextRun[];
    }>;

type MutableLine =
  | {
      kind: 'paragraph';
      alignment: TextAlignment;
      runs: TextRun[];
    }
  | {
      kind: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      alignment: TextAlignment;
      runs: TextRun[];
    }
  | {
      kind: 'list';
      ordered: boolean;
      level: number;
      runs: TextRun[];
    };

const blockedContentTags = new Set([
  'applet',
  'audio',
  'canvas',
  'embed',
  'form',
  'iframe',
  'math',
  'noscript',
  'object',
  'script',
  'style',
  'svg',
  'template',
  'video',
]);

const voidTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const entityMap: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  laquo: '«',
  lt: '<',
  mdash: '—',
  nbsp: '\u00a0',
  ndash: '–',
  quot: '"',
  raquo: '»',
});

const sameMarks = (left: TextMarks, right: TextMarks): boolean =>
  left.bold === right.bold &&
  left.italic === right.italic &&
  left.underline === right.underline &&
  left.strikethrough === right.strikethrough &&
  left.color === right.color &&
  left.fontFamily === right.fontFamily &&
  left.fontSizePt === right.fontSizePt &&
  left.fontWeight === right.fontWeight;

const cloneMarks = (marks: TextMarks): TextMarks => ({ ...marks });

const decodeEntities = (text: string): string =>
  text.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const hexadecimal = name[1]?.toLowerCase() === 'x';
      const value = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)
      ) {
        return '\uFFFD';
      }
      return String.fromCodePoint(value);
    }
    return entityMap[name.toLowerCase()] ?? entity;
  });

const findTagEnd = (html: string, start: number): number => {
  let quote = '';
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
};

const normalizedText = (text: string): string =>
  decodeEntities(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\t\r\n ]+/g, ' ');

const trimRuns = (runs: readonly TextRun[]): readonly TextRun[] => {
  const result = runs.map((run) => ({ text: run.text, marks: cloneMarks(run.marks) }));
  const first = result[0];
  if (first !== undefined) first.text = first.text.replace(/^\s+/, '');
  const last = result.at(-1);
  if (last !== undefined) last.text = last.text.replace(/\s+$/, '');
  return result.filter((run) => run.text.length > 0);
};

const toLines = (content: RichTextDocument): readonly ParsedLine[] =>
  content.blocks.flatMap((block): readonly ParsedLine[] =>
    block.type === 'list'
      ? block.items.map((item) => ({
          kind: 'list' as const,
          ordered: block.ordered,
          level: item.level,
          runs: item.runs.map((run) => ({ text: run.text, marks: cloneMarks(run.marks) })),
        }))
      : [
          block.type === 'heading'
            ? {
                kind: 'heading' as const,
                level: block.level,
                alignment: block.alignment,
                runs: block.runs.map((run) => ({ text: run.text, marks: cloneMarks(run.marks) })),
              }
            : {
                kind: 'paragraph' as const,
                alignment: block.alignment,
                runs: block.runs.map((run) => ({ text: run.text, marks: cloneMarks(run.marks) })),
              },
        ],
  );

const linesToDocument = (
  lines: readonly ParsedLine[],
  fallbackMarks: TextMarks,
): RichTextDocument => {
  const blocks: RichTextDocument['blocks'][number][] = [];
  for (const line of lines) {
    const runs =
      line.runs.length > 0 ? line.runs : [{ text: '', marks: cloneMarks(fallbackMarks) }];
    if (line.kind === 'list') {
      const previous = blocks.at(-1);
      if (previous?.type === 'list' && previous.ordered === line.ordered) {
        blocks[blocks.length - 1] = {
          ...previous,
          items: [...previous.items, { id: crypto.randomUUID(), level: line.level, runs }],
        };
      } else {
        blocks.push({
          id: crypto.randomUUID(),
          type: 'list',
          ordered: line.ordered,
          items: [{ id: crypto.randomUUID(), level: line.level, runs }],
        });
      }
    } else if (line.kind === 'heading') {
      blocks.push({
        id: crypto.randomUUID(),
        type: 'heading',
        level: line.level,
        alignment: line.alignment,
        runs,
      });
    } else {
      blocks.push({
        id: crypto.randomUUID(),
        type: 'paragraph',
        alignment: line.alignment,
        runs,
      });
    }
  }
  const document: RichTextDocument = {
    blocks:
      blocks.length > 0
        ? blocks
        : [
            {
              id: crypto.randomUUID(),
              type: 'paragraph',
              alignment: 'left',
              runs: [{ text: '', marks: cloneMarks(fallbackMarks) }],
            },
          ],
  };
  if (document.blocks.length > DOCUMENT_LIMITS.maxRichTextBlocks) {
    throw new RichClipboardError('Rich text contains too many blocks after insertion.');
  }
  for (const block of document.blocks) {
    if (block.type === 'list') {
      if (block.items.length > DOCUMENT_LIMITS.maxListItems) {
        throw new RichClipboardError('Rich text contains too many list items after insertion.');
      }
      if (block.items.some((item) => item.runs.length > DOCUMENT_LIMITS.maxTextRunsPerBlock)) {
        throw new RichClipboardError('Rich text contains too many inline runs after insertion.');
      }
    } else if (block.runs.length > DOCUMENT_LIMITS.maxTextRunsPerBlock) {
      throw new RichClipboardError('Rich text contains too many inline runs after insertion.');
    }
  }
  return document;
};

const runTextLength = (runs: readonly TextRun[]): number =>
  runs.reduce((length, run) => length + run.text.length, 0);

const splitRuns = (
  runs: readonly TextRun[],
  offset: number,
): Readonly<{ before: readonly TextRun[]; after: readonly TextRun[] }> => {
  const before: TextRun[] = [];
  const after: TextRun[] = [];
  let consumed = 0;
  for (const run of runs) {
    const split = Math.min(run.text.length, Math.max(0, offset - consumed));
    if (split > 0) before.push({ text: run.text.slice(0, split), marks: cloneMarks(run.marks) });
    if (split < run.text.length)
      after.push({ text: run.text.slice(split), marks: cloneMarks(run.marks) });
    consumed += run.text.length;
  }
  return { before, after };
};

const mergeRuns = (runs: readonly TextRun[]): readonly TextRun[] => {
  const merged: TextRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    for (const chunk of boundedTextRuns(run.text, run.marks)) {
      const previous = merged.at(-1);
      if (
        previous !== undefined &&
        sameMarks(previous.marks, chunk.marks) &&
        previous.text.length + chunk.text.length <= DOCUMENT_LIMITS.maxTextRunLength
      ) {
        merged[merged.length - 1] = { ...previous, text: previous.text + chunk.text };
      } else {
        merged.push({ text: chunk.text, marks: cloneMarks(chunk.marks) });
      }
    }
  }
  return merged;
};

const lineWithRuns = (line: ParsedLine, runs: readonly TextRun[]): ParsedLine => ({
  ...line,
  runs,
});

const locateOffset = (
  lines: readonly ParsedLine[],
  offset: number,
): Readonly<{ lineIndex: number; offsetInLine: number }> => {
  let remaining = Math.max(0, offset);
  for (let index = 0; index < lines.length; index += 1) {
    const length = runTextLength(lines[index]!.runs);
    if (remaining <= length || index === lines.length - 1) {
      return { lineIndex: index, offsetInLine: Math.min(length, remaining) };
    }
    remaining -= length + 1;
  }
  return { lineIndex: 0, offsetInLine: 0 };
};

/**
 * Converts clipboard HTML to the closed rich-text model. No attribute is read,
 * no URL is retained, and active/embedded content subtrees are discarded.
 */
export const sanitizeClipboardHtml = (
  html: string,
  options: Readonly<{
    fallbackMarks: TextMarks;
    alignment?: TextAlignment;
  }>,
): RichTextDocument => {
  if (html.length > RICH_CLIPBOARD_LIMITS.maxHtmlLength) {
    throw new RichClipboardError('Clipboard HTML exceeds the supported size.');
  }

  const lines: ParsedLine[] = [];
  const listStack: boolean[] = [];
  const activeMarkTags: string[] = [];
  const suppressedTags: string[] = [];
  let current: MutableLine | null = null;
  let textLength = 0;

  const currentMarks = (): TextMarks => ({
    ...options.fallbackMarks,
    bold:
      options.fallbackMarks.bold || activeMarkTags.some((tag) => tag === 'b' || tag === 'strong'),
    italic:
      options.fallbackMarks.italic || activeMarkTags.some((tag) => tag === 'em' || tag === 'i'),
    underline: options.fallbackMarks.underline || activeMarkTags.includes('u'),
    strikethrough:
      options.fallbackMarks.strikethrough ||
      activeMarkTags.some((tag) => tag === 'del' || tag === 's' || tag === 'strike'),
  });

  const flush = (): void => {
    if (current === null) return;
    const runs = trimRuns(current.runs);
    if (runs.length > 0) lines.push({ ...current, runs } as ParsedLine);
    current = null;
    if (lines.length > RICH_CLIPBOARD_LIMITS.maxBlocks) {
      throw new RichClipboardError('Clipboard HTML contains too many text blocks.');
    }
  };

  const ensureLine = (): MutableLine => {
    current ??= {
      kind: 'paragraph',
      alignment: options.alignment ?? 'left',
      runs: [],
    };
    return current;
  };

  const appendText = (raw: string): void => {
    const text = normalizedText(raw);
    if (text === '') return;
    textLength += text.length;
    if (textLength > RICH_CLIPBOARD_LIMITS.maxTextLength) {
      throw new RichClipboardError('Clipboard text exceeds the supported size.');
    }
    const line = ensureLine();
    const marks = currentMarks();
    const previous = line.runs.at(-1);
    if (previous !== undefined && sameMarks(previous.marks, marks)) {
      const joined = previous.text + text;
      if (joined.length <= DOCUMENT_LIMITS.maxTextRunLength) {
        line.runs[line.runs.length - 1] = { ...previous, text: joined };
        return;
      }
    }
    for (const run of boundedTextRuns(text, marks)) {
      line.runs.push({ text: run.text, marks: cloneMarks(run.marks) });
      if (line.runs.length > RICH_CLIPBOARD_LIMITS.maxRunsPerBlock) {
        throw new RichClipboardError('Clipboard HTML contains too many inline runs.');
      }
    }
  };

  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) {
      if (suppressedTags.length === 0) appendText(html.slice(cursor));
      break;
    }
    if (tagStart > cursor && suppressedTags.length === 0) appendText(html.slice(cursor, tagStart));
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      cursor = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findTagEnd(html, tagStart);
    if (tagEnd < 0) {
      if (suppressedTags.length === 0) appendText(html.slice(tagStart));
      break;
    }
    const rawTag = html.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;
    const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(rawTag);
    if (match === null) continue;
    const closing = match[1] === '/';
    const tag = match[2]!.toLowerCase();
    const selfClosing = /\/\s*>$/.test(rawTag) || voidTags.has(tag);

    if (suppressedTags.length > 0) {
      if (!closing && blockedContentTags.has(tag) && !selfClosing) suppressedTags.push(tag);
      else if (closing && suppressedTags.at(-1) === tag) suppressedTags.pop();
      continue;
    }
    if (!closing && blockedContentTags.has(tag)) {
      if (!selfClosing) suppressedTags.push(tag);
      continue;
    }
    if (tag === 'img' || tag === 'input' || tag === 'link' || tag === 'meta') continue;

    if (!closing && (tag === 'ul' || tag === 'ol')) {
      flush();
      listStack.push(tag === 'ol');
    } else if (closing && (tag === 'ul' || tag === 'ol')) {
      flush();
      listStack.pop();
    } else if (!closing && tag === 'li') {
      flush();
      current = {
        kind: 'list',
        ordered: listStack.at(-1) ?? false,
        level: Math.min(DOCUMENT_LIMITS.maxListLevel, Math.max(0, listStack.length - 1)),
        runs: [],
      };
    } else if (closing && tag === 'li') {
      flush();
    } else if (!closing && /^h[1-6]$/.test(tag)) {
      flush();
      current = {
        kind: 'heading',
        level: Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6,
        alignment: options.alignment ?? 'left',
        runs: [],
      };
    } else if (closing && /^h[1-6]$/.test(tag)) {
      flush();
    } else if (!closing && (tag === 'p' || tag === 'div')) {
      flush();
      current = { kind: 'paragraph', alignment: options.alignment ?? 'left', runs: [] };
    } else if (closing && (tag === 'p' || tag === 'div')) {
      flush();
    } else if (!closing && tag === 'br') {
      flush();
      current = { kind: 'paragraph', alignment: options.alignment ?? 'left', runs: [] };
    } else if (['b', 'strong', 'em', 'i', 'u', 'del', 's', 'strike'].includes(tag)) {
      if (closing) {
        const index = activeMarkTags.lastIndexOf(tag);
        if (index >= 0) activeMarkTags.splice(index, 1);
      } else if (!selfClosing) {
        activeMarkTags.push(tag);
      }
    }
  }
  flush();
  return linesToDocument(lines, options.fallbackMarks);
};

/**
 * Inserts typed clipboard content at textarea offsets. Inline paragraphs merge
 * with the current block; block content (headings/lists/multiple blocks) keeps
 * its semantic boundaries. The result contains fresh block/item IDs only.
 */
export const replaceRichTextRange = (
  source: RichTextDocument,
  startOffset: number,
  endOffset: number,
  pasted: RichTextDocument,
  fallbackMarks: TextMarks,
): RichTextDocument => {
  const sourceLines = toLines(source);
  const pastedLines = toLines(pasted);
  if (sourceLines.length === 0) return linesToDocument(pastedLines, fallbackMarks);
  const sourceLength = sourceLines.reduce(
    (length, line, index) => length + runTextLength(line.runs) + (index === 0 ? 0 : 1),
    0,
  );
  const start = Math.min(sourceLength, Math.max(0, Math.min(startOffset, endOffset)));
  const end = Math.min(sourceLength, Math.max(start, Math.max(startOffset, endOffset)));
  const pastedLength = pastedLines.reduce(
    (length, line, index) => length + runTextLength(line.runs) + (index === 0 ? 0 : 1),
    0,
  );
  if (sourceLength - (end - start) + pastedLength > RICH_CLIPBOARD_LIMITS.maxTextLength) {
    throw new RichClipboardError('Rich text exceeds the supported size after insertion.');
  }
  if (start === 0 && end === sourceLength) return linesToDocument(pastedLines, fallbackMarks);

  const startLocation = locateOffset(sourceLines, start);
  const endLocation = locateOffset(sourceLines, end);
  const startLine = sourceLines[startLocation.lineIndex]!;
  const endLine = sourceLines[endLocation.lineIndex]!;
  const prefixRuns = splitRuns(startLine.runs, startLocation.offsetInLine).before;
  const suffixRuns = splitRuns(endLine.runs, endLocation.offsetInLine).after;
  const before = sourceLines.slice(0, startLocation.lineIndex);
  const after = sourceLines.slice(endLocation.lineIndex + 1);

  const inlineLine = pastedLines.length === 1 ? pastedLines[0] : undefined;
  if (inlineLine?.kind === 'paragraph') {
    return linesToDocument(
      [
        ...before,
        lineWithRuns(startLine, mergeRuns([...prefixRuns, ...inlineLine.runs, ...suffixRuns])),
        ...after,
      ],
      fallbackMarks,
    );
  }

  const result: ParsedLine[] = [...before];
  if (runTextLength(prefixRuns) > 0) result.push(lineWithRuns(startLine, prefixRuns));
  result.push(...pastedLines);
  if (runTextLength(suffixRuns) > 0) result.push(lineWithRuns(endLine, suffixRuns));
  result.push(...after);
  return linesToDocument(result, fallbackMarks);
};
