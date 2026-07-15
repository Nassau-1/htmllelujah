import { DOCUMENT_LIMITS } from './limits.js';

export class TsvParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TsvParseError';
  }
}

/** Parses spreadsheet TSV, including quoted tabs, newlines, and escaped quotes. */
export const parseTsv = (input: string): readonly (readonly string[])[] => {
  if (input.length === 0) throw new TsvParseError('TSV content is empty.');
  if (input.length > DOCUMENT_LIMITS.maxTsvLength) {
    throw new TsvParseError(`TSV content exceeds ${DOCUMENT_LIMITS.maxTsvLength} characters.`);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let justClosedQuote = false;

  const pushCell = (): void => {
    row.push(cell);
    cell = '';
    justClosedQuote = false;
  };
  const pushRow = (): void => {
    pushCell();
    if (row.length > DOCUMENT_LIMITS.maxTableColumns) {
      throw new TsvParseError(`TSV contains more than ${DOCUMENT_LIMITS.maxTableColumns} columns.`);
    }
    rows.push(row);
    row = [];
    if (rows.length > DOCUMENT_LIMITS.maxTableRows) {
      throw new TsvParseError(`TSV contains more than ${DOCUMENT_LIMITS.maxTableRows} rows.`);
    }
  };

  for (let position = 0; position < input.length; position += 1) {
    const character = input[position];
    if (quoted) {
      if (character === '"') {
        if (input[position + 1] === '"') {
          cell += '"';
          position += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (justClosedQuote && character !== '\t' && character !== '\r' && character !== '\n') {
      throw new TsvParseError('Unexpected character after a closing quote.');
    }
    if (character === '"') {
      if (cell.length > 0) throw new TsvParseError('A quoted field must start with a quote.');
      quoted = true;
    } else if (character === '\t') {
      pushCell();
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && input[position + 1] === '\n') position += 1;
      pushRow();
    } else {
      cell += character;
    }
  }

  if (quoted) throw new TsvParseError('TSV contains an unterminated quoted field.');
  if (row.length > 0 || cell.length > 0 || input.endsWith('\t')) pushRow();
  if (rows.length > 1) {
    const finalRow = rows.at(-1);
    if (finalRow?.length === 1 && finalRow[0] === '' && /(?:\r\n|\r|\n)$/.test(input)) rows.pop();
  }
  if (rows.length === 0) return [['']];

  const width = rows[0]?.length ?? 0;
  if (rows.some((candidate) => candidate.length !== width)) {
    throw new TsvParseError('Every TSV row must contain the same number of columns.');
  }
  return rows;
};
