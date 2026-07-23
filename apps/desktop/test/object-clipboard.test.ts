import {
  createDefaultDeck,
  type Element,
  type GroupElement,
  type RichTextDocument,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  contentFromPlainText,
  createConnectorElement,
  createImageElement,
  createShapeElement,
  createTableElement,
  createTextElement,
  emptyMarks,
} from '../src/renderer/editor/canonical-factories.js';
import {
  deserializeObjectClipboard,
  OBJECT_CLIPBOARD_LIMITS,
  OBJECT_CLIPBOARD_MIME,
  OBJECT_CLIPBOARD_VERSION,
  ObjectClipboardError,
  resolveObjectClipboardLimits,
  serializeObjectClipboard,
  validateObjectClipboardPaste,
} from '../src/renderer/editor/object-clipboard.js';

const collectRichTextIds = (content: RichTextDocument, output: Set<string>): void => {
  for (const block of content.blocks) {
    output.add(block.id);
    if (block.type === 'list') block.items.forEach((item) => output.add(item.id));
  }
};

const collectCanonicalIds = (elements: readonly Element[]): ReadonlySet<string> => {
  const output = new Set<string>();
  const visit = (element: Element): void => {
    output.add(element.id);
    if (element.type === 'text') collectRichTextIds(element.content, output);
    else if (element.type === 'table') {
      for (const cell of element.cells) {
        output.add(cell.id);
        collectRichTextIds(cell.content, output);
      }
    } else if (element.type === 'group') element.children.forEach(visit);
  };
  elements.forEach(visit);
  return output;
};

const nestedFixture = (): GroupElement => {
  const shape = createShapeElement('ellipse');
  const connector = {
    ...createConnectorElement(),
    start: {
      ...createConnectorElement().start,
      binding: { elementId: shape.id, anchor: 'center' as const },
    },
  };
  return {
    id: crypto.randomUUID(),
    type: 'group',
    name: 'Nested group',
    frame: { xPt: 80, yPt: 100, widthPt: 400, heightPt: 220, rotationDeg: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    coordinateSpace: { widthPt: 400, heightPt: 220 },
    children: [shape, connector],
  };
};

describe('bounded object clipboard envelope', () => {
  it('round-trips selected objects with fresh nested IDs, detached placeholders, and bindings', () => {
    const document = createDefaultDeck();
    const boundText = document.slides[0]?.elements.find(
      (element) => element.type === 'text' && element.placeholderBinding !== undefined,
    );
    if (boundText?.type !== 'text') throw new Error('Missing bound text fixture.');
    const listText = {
      ...createTextElement('body'),
      content: contentFromPlainText('First\nSecond', {
        kind: 'bullets',
        alignment: 'left',
        marks: emptyMarks(),
      }),
    };
    const group = nestedFixture();
    const source = [boundText, listText, createTableElement(2, 2), group] as const;
    const before = structuredClone(source);

    const written = serializeObjectClipboard(document.id, source);
    const firstRead = deserializeObjectClipboard(written.serialized);
    const secondRead = deserializeObjectClipboard(written.serialized);

    expect(OBJECT_CLIPBOARD_MIME).toBe('application/x-htmllelujah-elements+json');
    expect(JSON.parse(written.serialized)).toMatchObject({
      format: 'htmllelujah-elements',
      version: OBJECT_CLIPBOARD_VERSION,
      sourceDocumentId: document.id,
    });
    expect(written.plainText).toContain('First');
    expect(firstRead.sourceDocumentId).toBe(document.id);
    expect(source).toEqual(before);

    const sourceIds = collectCanonicalIds(source);
    const firstIds = collectCanonicalIds(firstRead.elements);
    const secondIds = collectCanonicalIds(secondRead.elements);
    expect([...firstIds].every((identifier) => !sourceIds.has(identifier))).toBe(true);
    expect([...secondIds].every((identifier) => !sourceIds.has(identifier))).toBe(true);
    expect([...secondIds].every((identifier) => !firstIds.has(identifier))).toBe(true);

    const copiedBoundText = firstRead.elements[0];
    expect(copiedBoundText?.type).toBe('text');
    expect(copiedBoundText?.placeholderBinding).toBeUndefined();
    expect(copiedBoundText?.frame).toEqual({
      ...boundText.frame,
      xPt: boundText.frame.xPt + 18,
      yPt: boundText.frame.yPt + 18,
    });

    const copiedGroup = firstRead.elements.find(
      (element): element is GroupElement => element.type === 'group',
    );
    const copiedShape = copiedGroup?.children.find((element) => element.type === 'shape');
    const copiedConnector = copiedGroup?.children.find((element) => element.type === 'connector');
    expect(
      copiedConnector?.type === 'connector' ? copiedConnector.start.binding.elementId : undefined,
    ).toBe(copiedShape?.id);
  });

  it('detaches both endpoints when a connector is copied without its bound objects', () => {
    const document = createDefaultDeck();
    const firstShape = createShapeElement();
    const secondShape = createShapeElement('ellipse');
    const connector = {
      ...createConnectorElement(),
      start: {
        ...createConnectorElement().start,
        binding: { elementId: firstShape.id, anchor: 'right' as const },
      },
      end: {
        ...createConnectorElement().end,
        binding: { elementId: secondShape.id, anchor: 'left' as const },
      },
    };

    const copied = deserializeObjectClipboard(
      serializeObjectClipboard(document.id, [connector]).serialized,
    ).elements[0];

    expect(copied?.type).toBe('connector');
    if (copied?.type !== 'connector') throw new Error('Missing copied connector fixture.');
    expect(copied.start.binding).toEqual({});
    expect(copied.end.binding).toEqual({});
  });

  it('preserves and remaps connector endpoints when all bound objects are copied', () => {
    const document = createDefaultDeck();
    const firstShape = createShapeElement();
    const secondShape = createShapeElement('ellipse');
    const connector = {
      ...createConnectorElement(),
      start: {
        ...createConnectorElement().start,
        binding: { elementId: firstShape.id, anchor: 'right' as const },
      },
      end: {
        ...createConnectorElement().end,
        binding: { elementId: secondShape.id, anchor: 'left' as const },
      },
    };

    const copied = deserializeObjectClipboard(
      serializeObjectClipboard(document.id, [firstShape, connector, secondShape]).serialized,
    ).elements;
    const copiedFirstShape = copied[0];
    const copiedConnector = copied[1];
    const copiedSecondShape = copied[2];
    expect(copiedFirstShape?.type).toBe('shape');
    expect(copiedConnector?.type).toBe('connector');
    expect(copiedSecondShape?.type).toBe('shape');
    if (copiedConnector?.type !== 'connector') {
      throw new Error('Missing copied connector fixture.');
    }
    expect(copiedConnector.start.binding).toEqual({
      elementId: copiedFirstShape?.id,
      anchor: 'right',
    });
    expect(copiedConnector.end.binding).toEqual({
      elementId: copiedSecondShape?.id,
      anchor: 'left',
    });
    expect(copiedConnector.start.binding.elementId).not.toBe(firstShape.id);
    expect(copiedConnector.end.binding.elementId).not.toBe(secondShape.id);
  });

  it('blocks nested image references across documents while preserving same-document paste', () => {
    const sourceDocument = createDefaultDeck();
    const nestedImage = createImageElement(crypto.randomUUID());
    const innerGroup: GroupElement = {
      id: crypto.randomUUID(),
      type: 'group',
      name: 'Inner group',
      frame: { xPt: 0, yPt: 0, widthPt: 320, heightPt: 180, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 320, heightPt: 180 },
      children: [nestedImage, createShapeElement()],
    };
    const outerGroup: GroupElement = {
      id: crypto.randomUUID(),
      type: 'group',
      name: 'Outer group',
      frame: { xPt: 80, yPt: 100, widthPt: 400, heightPt: 220, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: { widthPt: 400, heightPt: 220 },
      children: [innerGroup, createShapeElement('ellipse')],
    };
    const payload = deserializeObjectClipboard(
      serializeObjectClipboard(sourceDocument.id, [outerGroup]).serialized,
    );

    expect(validateObjectClipboardPaste(payload, sourceDocument.id)).toEqual({
      compatible: true,
    });
    expect(validateObjectClipboardPaste(payload, crypto.randomUUID())).toEqual({
      compatible: false,
      code: 'CROSS_DOCUMENT_IMAGE_ASSET',
      message:
        'Images cannot be pasted between presentations yet because their local assets are not included. Import the image into this presentation first.',
    });
  });

  it('allows portable non-image objects to be pasted across documents', () => {
    const sourceDocument = createDefaultDeck();
    const payload = deserializeObjectClipboard(
      serializeObjectClipboard(sourceDocument.id, [createShapeElement()]).serialized,
    );

    expect(validateObjectClipboardPaste(payload, crypto.randomUUID())).toEqual({
      compatible: true,
    });
  });

  it('rejects malformed, oversized, duplicate-ID, and excessively nested payloads', () => {
    expect(() => deserializeObjectClipboard('{')).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({ code: 'CLIPBOARD_INVALID' }),
    );

    const document = createDefaultDeck();
    const shape = createShapeElement();
    const duplicateIdentifier = JSON.stringify({
      format: 'htmllelujah-elements',
      version: OBJECT_CLIPBOARD_VERSION,
      sourceDocumentId: document.id,
      elements: [shape, { ...shape, name: 'Duplicate identifier' }],
    });
    expect(() => deserializeObjectClipboard(duplicateIdentifier)).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({ code: 'CLIPBOARD_INVALID' }),
    );

    const written = serializeObjectClipboard(document.id, [shape]);
    expect(() =>
      deserializeObjectClipboard(written.serialized, {
        maxSerializedBytes: written.serialized.length - 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({
        code: 'CLIPBOARD_LIMIT_EXCEEDED',
      }),
    );
    expect(() =>
      serializeObjectClipboard(document.id, [nestedFixture()], { maxGroupDepth: 0 }),
    ).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({
        code: 'CLIPBOARD_LIMIT_EXCEEDED',
      }),
    );
  });

  it('allows callers to lower but never raise the canonical clipboard budgets', () => {
    expect(resolveObjectClipboardLimits({ maxRootElements: 2 }).maxRootElements).toBe(2);
    expect(() =>
      resolveObjectClipboardLimits({
        maxSerializedBytes: OBJECT_CLIPBOARD_LIMITS.maxSerializedBytes + 1,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({ code: 'CLIPBOARD_INVALID' }),
    );
    expect(() => resolveObjectClipboardLimits({ unknown: 1 } as never)).toThrowError(
      expect.objectContaining<Partial<ObjectClipboardError>>({ code: 'CLIPBOARD_INVALID' }),
    );
  });

  it('bounds the plain-text fallback without splitting a surrogate pair', () => {
    const document = createDefaultDeck();
    const text = {
      ...createTextElement('body'),
      content: contentFromPlainText('abc😀tail', {
        kind: 'paragraph',
        alignment: 'left',
        marks: emptyMarks(),
      }),
    };
    const written = serializeObjectClipboard(document.id, [text], { maxPlainTextLength: 5 });
    expect(written.plainText).toBe('abc…');
  });
});
