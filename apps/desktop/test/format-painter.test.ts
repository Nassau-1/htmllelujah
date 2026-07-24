import {
  type Element,
  type PathElement,
  type ShapeElement,
  type TableElement,
  type TextElement,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  createImageElement,
  createShapeElement,
  createTableElement,
  createTextElement,
} from '../src/renderer/editor/canonical-factories.js';
import {
  applyElementFormat,
  captureElementFormat,
  inspectElementFormatCompatibility,
  type ElementFormat,
} from '../src/renderer/editor/format-painter.js';
import { createPathElementFromCanvasPoints } from '../src/renderer/editor/vector-canvas-tools.js';

const captured = (element: Element): ElementFormat => {
  const result = captureElementFormat(element);
  if (!result.ok) throw new Error(result.message);
  return result.format;
};

const painted = (format: ElementFormat, target: Element): Element => {
  const result = applyElementFormat(format, target);
  if (!result.ok) throw new Error(result.message);
  return result.element;
};

const textWithPresentation = (element: TextElement, text: string, id: string): TextElement => ({
  ...element,
  id,
  name: `${id}-name`,
  opacity: 0.42,
  styleRole: 'quote',
  verticalAlignment: 'bottom',
  style: {
    fontFamily: 'Aptos',
    fontSizePt: 26,
    fontWeight: 650,
    italic: true,
    color: '#123456',
    alignment: 'right',
    lineHeight: 1.35,
    letterSpacingPt: 0.5,
  },
  locale: 'fr-FR',
  content: {
    blocks: [
      {
        id: `${id}-block`,
        type: 'paragraph',
        alignment: 'center',
        runs: [
          {
            text,
            marks: {
              bold: true,
              italic: true,
              underline: true,
              strikethrough: false,
              color: '#654321',
              fontFamily: 'Georgia',
              fontSizePt: 19,
              fontWeight: 700,
            },
          },
        ],
      },
    ],
  },
});

const pathElement = (id: string): PathElement => ({
  ...createPathElementFromCanvasPoints(
    [
      { xPt: 10, yPt: 20 },
      { xPt: 130, yPt: 20 },
      { xPt: 80, yPt: 100 },
    ],
    true,
    id,
  ),
  name: `${id}-path`,
  fill: '#abcdef',
  stroke: { color: '#123456', widthPt: 4, dash: 'dash' },
  fillRule: 'evenodd',
  shadow: {
    color: '#010203',
    blurPt: 8,
    offsetXPt: 3,
    offsetYPt: 5,
    opacity: 0.4,
  },
});

describe('format painter capture', () => {
  it('rejects unsupported source types without throwing', () => {
    const connector: Extract<Element, { type: 'connector' }> = {
      id: 'connector',
      name: 'Connector',
      type: 'connector',
      frame: { xPt: 0, yPt: 0, widthPt: 100, heightPt: 20, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      start: { xPt: 0, yPt: 10, binding: {} },
      end: { xPt: 100, yPt: 10, binding: {} },
      routing: 'straight',
      stroke: { color: '#000000', widthPt: 1, dash: 'solid' },
      startCap: 'none',
      endCap: 'arrow',
    };

    expect(captureElementFormat(connector)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_SOURCE',
      message: 'Format painter does not support connector objects.',
    });
  });

  it('captures text presentation without content, IDs, locale, name, or geometry', () => {
    const source = textWithPresentation(createTextElement(), 'DO-NOT-COPY-TEXT', 'DO-NOT-COPY-ID');
    const format = captured(source);
    const serialized = JSON.stringify(format);

    expect(format.kind).toBe('text');
    expect(serialized).not.toContain('DO-NOT-COPY-TEXT');
    expect(serialized).not.toContain('DO-NOT-COPY-ID');
    expect(serialized).not.toContain('fr-FR');
    expect(serialized).not.toContain('"frame"');
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"name"');
  });

  it('captures vector, image and table formats without their content or spatial geometry', () => {
    const vector = {
      ...pathElement('PATH-SECRET-ID'),
      name: 'PATH-SECRET-NAME',
    };
    const image = {
      ...createImageElement('ASSET-SECRET'),
      id: 'IMAGE-SECRET-ID',
      name: 'IMAGE-SECRET-NAME',
      altText: 'ALT-SECRET',
      crop: { top: 0.1, right: 0.2, bottom: 0.3, left: 0.4 },
      colorKey: { color: '#ffffff', tolerance: 12 },
    };
    const table = {
      ...createTableElement(1, 1),
      id: 'TABLE-SECRET-ID',
      cells: [
        {
          ...createTableElement(1, 1).cells[0]!,
          id: 'CELL-SECRET-ID',
          content: {
            blocks: [
              {
                id: 'BLOCK-SECRET-ID',
                type: 'paragraph' as const,
                alignment: 'left' as const,
                runs: [
                  {
                    text: 'CELL-SECRET-CONTENT',
                    marks: {
                      bold: false,
                      italic: false,
                      underline: false,
                      strikethrough: false,
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const serialized = [
      JSON.stringify(captured(vector)),
      JSON.stringify(captured(image)),
      JSON.stringify(captured(table)),
    ].join('\n');

    for (const secret of [
      'PATH-SECRET-ID',
      'PATH-SECRET-NAME',
      'ASSET-SECRET',
      'IMAGE-SECRET-ID',
      'IMAGE-SECRET-NAME',
      'ALT-SECRET',
      'TABLE-SECRET-ID',
      'CELL-SECRET-ID',
      'BLOCK-SECRET-ID',
      'CELL-SECRET-CONTENT',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('"frame"');
    expect(serialized).not.toContain('"commands"');
    expect(serialized).not.toContain('"crop"');
    expect(serialized).not.toContain('"rowHeightsPt"');
    expect(serialized).not.toContain('"columnWidthsPt"');
    expect(serialized).not.toContain('"rowSpan"');
    expect(serialized).not.toContain('"columnSpan"');
  });
});

describe('text format application', () => {
  it('copies representative text and paragraph formatting while preserving target content and identity', () => {
    const source = textWithPresentation(createTextElement(), 'source', 'source-id');
    const targetBase = createTextElement('body', 'target words');
    const target: TextElement = {
      ...targetBase,
      id: 'target-id',
      name: 'Target name',
      frame: { xPt: 250, yPt: 210, widthPt: 320, heightPt: 85, rotationDeg: 17 },
      locale: 'de-DE',
      content: {
        blocks: [
          {
            id: 'target-paragraph',
            type: 'paragraph',
            alignment: 'left',
            runs: [
              {
                text: 'target ',
                marks: {
                  bold: false,
                  italic: false,
                  underline: false,
                  strikethrough: false,
                },
              },
              {
                text: 'words',
                marks: {
                  bold: false,
                  italic: false,
                  underline: false,
                  strikethrough: true,
                  color: '#ff0000',
                },
              },
            ],
          },
        ],
      },
    };
    const original = structuredClone(target);
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'text') return;
    expect(result.element).toMatchObject({
      id: 'target-id',
      name: 'Target name',
      frame: target.frame,
      locale: 'de-DE',
      opacity: 0.42,
      styleRole: 'quote',
      verticalAlignment: 'bottom',
      style: source.style,
    });
    expect(result.element.content.blocks[0]).toMatchObject({
      id: 'target-paragraph',
      alignment: 'center',
      runs: [
        {
          text: 'target ',
          marks:
            source.content.blocks[0]?.type === 'paragraph'
              ? source.content.blocks[0].runs[0]?.marks
              : undefined,
        },
        {
          text: 'words',
          marks:
            source.content.blocks[0]?.type === 'paragraph'
              ? source.content.blocks[0].runs[0]?.marks
              : undefined,
        },
      ],
    });
    expect(result.appliedFields).toContain('rich-text-marks');
    expect(result.appliedFields).toContain('paragraph-alignment');
    expect(target).toEqual(original);
    expect(result.element.content).not.toBe(target.content);
  });

  it('preserves target inline marks and alignment when the source has no representative values', () => {
    const source: TextElement = {
      ...createTextElement(),
      content: {
        blocks: [
          {
            id: 'empty-list',
            type: 'list',
            ordered: false,
            items: [],
          },
        ],
      },
    };
    const target = textWithPresentation(createTextElement(), 'keep me', 'target');
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'text') return;
    expect(result.element.content).toEqual(target.content);
    expect(result.appliedFields).not.toContain('rich-text-marks');
    expect(result.appliedFields).not.toContain('paragraph-alignment');
  });

  it('clears a target style override when the source is theme-bound', () => {
    const source: TextElement = { ...createTextElement(), style: undefined };
    const target = textWithPresentation(createTextElement(), 'target', 'target');
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'text') return;
    expect(result.element.style).toBeUndefined();
  });
});

describe('vector format application', () => {
  it('paints shape visuals and hosted text without replacing geometry or target text', () => {
    const sourceBase = createShapeElement('rounded-rectangle', 'SOURCE-TEXT');
    const source: ShapeElement = {
      ...sourceBase,
      opacity: 0.55,
      fill: '#112233',
      stroke: { color: '#445566', widthPt: 6, dash: 'dot' },
      shadow: {
        color: '#010101',
        blurPt: 9,
        offsetXPt: 2,
        offsetYPt: 3,
        opacity: 0.3,
      },
      text:
        sourceBase.text === undefined
          ? undefined
          : {
              ...sourceBase.text,
              styleRole: 'label',
              verticalAlignment: 'bottom',
              style: { fontFamily: 'Georgia', fontSizePt: 21, color: '#ffffff' },
              locale: 'fr-FR',
              margins: { topPt: 11, rightPt: 12, bottomPt: 13, leftPt: 14 },
              content: textWithPresentation(createTextElement(), 'SOURCE-TEXT', 'shape-source')
                .content,
            },
    };
    const targetBase = createShapeElement('triangle', 'TARGET-TEXT');
    const target: ShapeElement = {
      ...targetBase,
      id: 'target-shape',
      frame: { xPt: 300, yPt: 200, widthPt: 210, heightPt: 160, rotationDeg: 23 },
      cornerRadiusPt: 37,
      text:
        targetBase.text === undefined
          ? undefined
          : {
              ...targetBase.text,
              locale: 'de-DE',
              margins: { topPt: 1, rightPt: 2, bottomPt: 3, leftPt: 4 },
            },
    };
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'shape') return;
    expect(result.element).toMatchObject({
      id: 'target-shape',
      shape: 'triangle',
      frame: target.frame,
      cornerRadiusPt: 37,
      opacity: 0.55,
      fill: '#112233',
      stroke: source.stroke,
      shadow: source.shadow,
    });
    expect(result.element.text?.content.blocks[0]).toMatchObject({
      id: target.text?.content.blocks[0]?.id,
      runs: [{ text: 'TARGET-TEXT' }],
    });
    expect(result.element.text).toMatchObject({
      styleRole: 'label',
      verticalAlignment: 'bottom',
      style: source.text?.style,
      locale: 'de-DE',
      margins: target.text?.margins,
    });
    expect(result.appliedFields).toContain('shape-text');
    expect(result.skippedFields).toEqual([]);
  });

  it('supports shape-to-path painting and reports shape text as intentionally skipped', () => {
    const source = createShapeElement('rectangle', 'Shape text');
    const target = pathElement('target-path');
    const originalCommands = structuredClone(target.commands);
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'path') return;
    expect(result.element.commands).toEqual(originalCommands);
    expect(result.element.fillRule).toBe('evenodd');
    expect(result.element.fill).toBe(source.fill);
    expect(result.element.stroke).toEqual(source.stroke);
    expect(result.skippedFields).toEqual(['shape-text']);
  });

  it('supports path-to-shape painting without changing shape kind, corner radius, or text', () => {
    const source = pathElement('source-path');
    const target = createShapeElement('rounded-rectangle', 'Keep this text');
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'shape') return;
    expect(result.element.shape).toBe('rounded-rectangle');
    expect(result.element.cornerRadiusPt).toBe(target.cornerRadiusPt);
    expect(result.element.text).toEqual(target.text);
    expect(result.element.fill).toBe(source.fill);
    expect(result.element.stroke).toEqual(source.stroke);
  });

  it('does not invent hosted text on an empty shape', () => {
    const source = createShapeElement('rectangle', 'Source text');
    const target = createShapeElement('ellipse');
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'shape') return;
    expect(result.element.text).toBeUndefined();
    expect(result.skippedFields).toEqual(['shape-text']);
  });

  it('clears an existing shadow when the source has none', () => {
    const source = createShapeElement();
    const target: ShapeElement = {
      ...createShapeElement(),
      shadow: {
        color: '#000000',
        blurPt: 10,
        offsetXPt: 4,
        offsetYPt: 4,
        opacity: 0.5,
      },
    };
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'shape') return;
    expect(result.element.shadow).toBeUndefined();
  });
});

describe('image format application', () => {
  it('copies only opacity and color-key while preserving image content and composition', () => {
    const source = {
      ...createImageElement('source-asset'),
      opacity: 0.7,
      fit: 'contain' as const,
      crop: { top: 0.2, right: 0.1, bottom: 0.3, left: 0 },
      colorKey: { color: '#fafafa', tolerance: 33 },
    };
    const target = {
      ...createImageElement('target-asset'),
      id: 'target-image',
      altText: 'Target alt',
      fit: 'fill' as const,
      crop: { top: 0.05, right: 0.06, bottom: 0.07, left: 0.08 },
    };
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'image') return;
    expect(result.element).toMatchObject({
      id: 'target-image',
      assetId: 'target-asset',
      altText: 'Target alt',
      fit: 'fill',
      crop: target.crop,
      opacity: 0.7,
      colorKey: source.colorKey,
    });
  });

  it('clears a target color-key when the source has no image effect', () => {
    const source = createImageElement('source-asset');
    const target = {
      ...createImageElement('target-asset'),
      colorKey: { color: '#000000', tolerance: 20 },
    };
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'image') return;
    expect(result.element.colorKey).toBeUndefined();
  });
});

describe('table format application', () => {
  const sourceTable = (): TableElement => {
    const source = createTableElement(2, 2);
    return {
      ...source,
      opacity: 0.6,
      border: { color: '#112233', widthPt: 3 },
      style: {
        fill: '#ffffff',
        headerFill: '#000000',
        bandedRows: false,
        cellPaddingPt: 12,
      },
      cells: source.cells.map((cell) => ({
        ...cell,
        style: {
          fill: cell.row === 0 ? '#ddeeff' : '#ffffff',
          textColor: cell.column === 0 ? '#111111' : '#222222',
          horizontalAlignment: cell.column === 0 ? 'left' : 'right',
          verticalAlignment: cell.row === 0 ? 'top' : 'bottom',
          paddingPt: 4 + cell.row + cell.column,
        },
      })),
    };
  };

  it('copies table and per-coordinate cell styles while preserving all structure and content', () => {
    const source = sourceTable();
    const targetBase = createTableElement(2, 2);
    const target: TableElement = {
      ...targetBase,
      id: 'target-table',
      frame: { xPt: 200, yPt: 250, widthPt: 600, heightPt: 220, rotationDeg: 4 },
      rowHeightsPt: [75, 145],
      columnWidthsPt: [180, 420],
      cells: targetBase.cells.map((cell, index) => ({
        ...cell,
        id: `target-cell-${index}`,
        content: textWithPresentation(
          createTextElement(),
          `target content ${index}`,
          `cell-text-${index}`,
        ).content,
      })),
    };
    const originalContents = target.cells.map((cell) => structuredClone(cell.content));
    const result = applyElementFormat(captured(source), target);

    expect(result.ok).toBe(true);
    if (!result.ok || result.element.type !== 'table') return;
    expect(result.element).toMatchObject({
      id: 'target-table',
      frame: target.frame,
      rowCount: 2,
      columnCount: 2,
      rowHeightsPt: [75, 145],
      columnWidthsPt: [180, 420],
      opacity: 0.6,
      border: source.border,
      style: source.style,
    });
    expect(result.element.cells.map((cell) => cell.id)).toEqual(
      target.cells.map((cell) => cell.id),
    );
    expect(result.element.cells.map((cell) => cell.content)).toEqual(originalContents);
    expect(result.element.cells.map((cell) => cell.style)).toEqual(
      source.cells.map((cell) => cell.style),
    );
  });

  it('rejects a different logical cell structure without partially applying the format', () => {
    const format = captured(sourceTable());
    const target = createTableElement(3, 2);

    expect(inspectElementFormatCompatibility(format, target)).toEqual({
      compatible: false,
      code: 'TABLE_STRUCTURE_MISMATCH',
      message: 'Table cell formatting requires the same logical cell coordinates.',
    });
    expect(applyElementFormat(format, target)).toEqual({
      ok: false,
      code: 'TABLE_STRUCTURE_MISMATCH',
      message: 'Table cell formatting requires the same logical cell coordinates.',
    });
  });
});

describe('format painter compatibility', () => {
  it('rejects incompatible categories and locked targets explicitly', () => {
    const textFormat = captured(createTextElement());
    const shape = createShapeElement();

    expect(inspectElementFormatCompatibility(textFormat, shape)).toMatchObject({
      compatible: false,
      code: 'INCOMPATIBLE_TARGET',
    });
    expect(applyElementFormat(textFormat, shape)).toMatchObject({
      ok: false,
      code: 'INCOMPATIBLE_TARGET',
    });

    const locked = { ...createTextElement(), locked: true };
    expect(inspectElementFormatCompatibility(textFormat, locked)).toEqual({
      compatible: false,
      code: 'LOCKED_TARGET',
      message: 'Unlock the target object before applying formatting.',
    });
  });

  it('returns detached format and result objects instead of sharing mutable style references', () => {
    const source = pathElement('source');
    const target = pathElement('target');
    const format = captured(source);
    const result = applyElementFormat(format, target);

    expect(format.kind).toBe('vector');
    if (format.kind !== 'vector' || !result.ok || result.element.type !== 'path') return;
    expect(format.stroke).not.toBe(source.stroke);
    expect(format.shadow).not.toBe(source.shadow);
    expect(result.element.stroke).not.toBe(format.stroke);
    expect(result.element.shadow).not.toBe(format.shadow);
    expect(result.element.frame).toBe(target.frame);
    expect(painted(format, target)).toEqual(result.element);
  });
});
