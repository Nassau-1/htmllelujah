import {
  DOCUMENT_LIMITS,
  elementSchema,
  type Element,
  type RichTextDocument,
} from '@htmllelujah/document-core';
import { z } from 'zod';

import { duplicateElements } from './canonical-factories';

export const OBJECT_CLIPBOARD_MIME = 'application/x-htmllelujah-elements+json';
export const OBJECT_CLIPBOARD_VERSION = 1;

export interface ObjectClipboardLimits {
  readonly maxSerializedBytes: number;
  readonly maxRootElements: number;
  readonly maxElements: number;
  readonly maxGroupDepth: number;
  readonly maxPlainTextLength: number;
}

export type ObjectClipboardLimitOverrides = Partial<ObjectClipboardLimits>;

export const OBJECT_CLIPBOARD_LIMITS: Readonly<ObjectClipboardLimits> = Object.freeze({
  maxSerializedBytes: 8 * 1024 * 1024,
  maxRootElements: DOCUMENT_LIMITS.maxElementsPerContainer,
  maxElements: DOCUMENT_LIMITS.maxElements,
  maxGroupDepth: DOCUMENT_LIMITS.maxGroupDepth,
  maxPlainTextLength: 500_000,
});

export class ObjectClipboardError extends Error {
  public constructor(
    public readonly code: 'CLIPBOARD_INVALID' | 'CLIPBOARD_LIMIT_EXCEEDED',
    message: string,
  ) {
    super(message);
    this.name = 'ObjectClipboardError';
  }
}

export interface ObjectClipboardWritePayload {
  readonly serialized: string;
  readonly plainText: string;
}

export interface ObjectClipboardReadPayload {
  readonly sourceDocumentId: string;
  readonly elements: readonly Element[];
}

export type ObjectClipboardPasteCompatibility =
  | Readonly<{ compatible: true }>
  | Readonly<{
      compatible: false;
      code: 'CROSS_DOCUMENT_IMAGE_ASSET';
      message: string;
    }>;

const objectClipboardEnvelopeSchema = z
  .object({
    format: z.literal('htmllelujah-elements'),
    version: z.literal(OBJECT_CLIPBOARD_VERSION),
    sourceDocumentId: z.string().uuid(),
    elements: z.array(elementSchema).min(1).max(DOCUMENT_LIMITS.maxElementsPerContainer),
  })
  .strict();

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const limitKeys = Object.freeze(
  Object.keys(OBJECT_CLIPBOARD_LIMITS) as readonly (keyof ObjectClipboardLimits)[],
);

export const resolveObjectClipboardLimits = (
  overrides: ObjectClipboardLimitOverrides | undefined,
): Readonly<ObjectClipboardLimits> => {
  if (overrides === undefined) return OBJECT_CLIPBOARD_LIMITS;
  if (!isPlainRecord(overrides)) {
    throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard limits are invalid.');
  }
  if (
    Object.keys(overrides).some((key) => !limitKeys.includes(key as keyof ObjectClipboardLimits))
  ) {
    throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard limits contain an unknown key.');
  }
  const resolved = { ...OBJECT_CLIPBOARD_LIMITS, ...overrides };
  for (const key of limitKeys) {
    const value = resolved[key];
    const minimum = key === 'maxGroupDepth' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum || value > OBJECT_CLIPBOARD_LIMITS[key]) {
      throw new ObjectClipboardError(
        'CLIPBOARD_INVALID',
        'Clipboard limits must be bounded positive integers.',
      );
    }
  }
  if (resolved.maxRootElements > resolved.maxElements) {
    throw new ObjectClipboardError(
      'CLIPBOARD_INVALID',
      'The root clipboard element limit cannot exceed the total element limit.',
    );
  }
  return Object.freeze(resolved);
};

const serializedByteLength = (serialized: string, maximum: number): number => {
  if (serialized.length > maximum) {
    throw new ObjectClipboardError(
      'CLIPBOARD_LIMIT_EXCEEDED',
      'Clipboard object data exceeds the supported size.',
    );
  }
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength > maximum) {
    throw new ObjectClipboardError(
      'CLIPBOARD_LIMIT_EXCEEDED',
      'Clipboard object data exceeds the supported size.',
    );
  }
  return byteLength;
};

const assertBoundedElementTree = (
  values: unknown,
  limits: Readonly<ObjectClipboardLimits>,
): void => {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ObjectClipboardError(
      'CLIPBOARD_INVALID',
      'Clipboard object data must contain at least one object.',
    );
  }
  if (values.length > limits.maxRootElements) {
    throw new ObjectClipboardError(
      'CLIPBOARD_LIMIT_EXCEEDED',
      'Clipboard object data contains too many selected objects.',
    );
  }
  const pending = values.map((value) => ({ value, depth: 0 }));
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    count += 1;
    if (count > limits.maxElements) {
      throw new ObjectClipboardError(
        'CLIPBOARD_LIMIT_EXCEEDED',
        'Clipboard object data contains too many objects.',
      );
    }
    if (current.depth > limits.maxGroupDepth) {
      throw new ObjectClipboardError(
        'CLIPBOARD_LIMIT_EXCEEDED',
        'Clipboard object data contains excessively nested groups.',
      );
    }
    if (!isPlainRecord(current.value) || current.value.type !== 'group') continue;
    const children = current.value.children;
    if (!Array.isArray(children)) {
      throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard group data is invalid.');
    }
    if (children.length > limits.maxRootElements) {
      throw new ObjectClipboardError(
        'CLIPBOARD_LIMIT_EXCEEDED',
        'Clipboard group data contains too many objects.',
      );
    }
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
};

const richTextIdentifiers = (content: RichTextDocument): readonly string[] =>
  content.blocks.flatMap((block) =>
    block.type === 'list' ? [block.id, ...block.items.map((item) => item.id)] : [block.id],
  );

const assertUniqueCanonicalIdentifiers = (elements: readonly Element[]): void => {
  const identifiers = new Set<string>();
  const add = (identifier: string): void => {
    if (identifiers.has(identifier)) {
      throw new ObjectClipboardError(
        'CLIPBOARD_INVALID',
        'Clipboard object data contains duplicate identifiers.',
      );
    }
    identifiers.add(identifier);
  };
  const visit = (element: Element): void => {
    add(element.id);
    if (element.type === 'text') {
      richTextIdentifiers(element.content).forEach(add);
    } else if (element.type === 'table') {
      for (const cell of element.cells) {
        add(cell.id);
        richTextIdentifiers(cell.content).forEach(add);
      }
    } else if (element.type === 'group') {
      element.children.forEach(visit);
    }
  };
  elements.forEach(visit);
};

const elementIdentifiers = (elements: readonly Element[]): ReadonlySet<string> => {
  const identifiers = new Set<string>();
  const visit = (element: Element): void => {
    identifiers.add(element.id);
    if (element.type === 'group') element.children.forEach(visit);
  };
  elements.forEach(visit);
  return identifiers;
};

const detachExternalConnectorBindings = (elements: readonly Element[]): readonly Element[] => {
  const copiedIdentifiers = elementIdentifiers(elements);
  const detach = (element: Element): Element => {
    if (element.type === 'group') {
      return { ...element, children: element.children.map(detach) };
    }
    if (element.type !== 'connector') return element;
    const endpoint = (value: typeof element.start): typeof element.start =>
      value.binding.elementId !== undefined && !copiedIdentifiers.has(value.binding.elementId)
        ? { ...value, binding: {} }
        : value;
    return {
      ...element,
      start: endpoint(element.start),
      end: endpoint(element.end),
    };
  };
  return elements.map(detach);
};

const containsImageElement = (elements: readonly Element[]): boolean => {
  const pending = [...elements];
  while (pending.length > 0) {
    const element = pending.pop();
    if (element === undefined) break;
    if (element.type === 'image') return true;
    if (element.type === 'group') pending.push(...element.children);
  }
  return false;
};

/**
 * Cross-document object payloads do not carry local image asset bytes. Callers
 * must reject that paste before dispatching document commands; same-document
 * image paste remains safe because the asset is already present in the deck.
 */
export const validateObjectClipboardPaste = (
  payload: ObjectClipboardReadPayload,
  targetDocumentId: string,
): ObjectClipboardPasteCompatibility => {
  if (payload.sourceDocumentId !== targetDocumentId && containsImageElement(payload.elements)) {
    return Object.freeze({
      compatible: false,
      code: 'CROSS_DOCUMENT_IMAGE_ASSET',
      message:
        'Images cannot be pasted between presentations yet because their local assets are not included. Import the image into this presentation first.',
    });
  }
  return Object.freeze({ compatible: true });
};

const richTextToPlainText = (content: RichTextDocument): string =>
  content.blocks
    .flatMap((block) =>
      block.type === 'list'
        ? block.items.map((item) => item.runs.map((run) => run.text).join(''))
        : [block.runs.map((run) => run.text).join('')],
    )
    .join('\n');

const elementPlainText = (element: Element): string => {
  if (element.type === 'text') return richTextToPlainText(element.content);
  if (element.type === 'table') {
    return [...element.cells]
      .sort((left, right) => left.row - right.row || left.column - right.column)
      .map((cell) => richTextToPlainText(cell.content))
      .join('\t');
  }
  if (element.type === 'image') return element.altText.trim() || element.name;
  if (element.type === 'group') return element.children.map(elementPlainText).join('\n');
  return element.name;
};

const truncatePlainText = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  if (maximum === 1) return '…';
  let end = maximum - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? '') && /[\uDC00-\uDFFF]/u.test(value[end] ?? '')) {
    end -= 1;
  }
  return `${value.slice(0, end)}…`;
};

const plainTextFallback = (
  elements: readonly Element[],
  limits: Readonly<ObjectClipboardLimits>,
): string =>
  truncatePlainText(
    elements
      .map(elementPlainText)
      .filter((value) => value !== '')
      .join('\n'),
    limits.maxPlainTextLength,
  );

const parseEnvelope = (
  value: unknown,
  limits: Readonly<ObjectClipboardLimits>,
): z.infer<typeof objectClipboardEnvelopeSchema> => {
  if (!isPlainRecord(value)) {
    throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard object data is invalid.');
  }
  assertBoundedElementTree(value.elements, limits);
  const parsed = objectClipboardEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard object data is invalid.');
  }
  assertUniqueCanonicalIdentifiers(parsed.data.elements);
  return parsed.data;
};

export const serializeObjectClipboard = (
  sourceDocumentId: string,
  elements: readonly Element[],
  limitOverrides?: ObjectClipboardLimitOverrides,
): ObjectClipboardWritePayload => {
  const limits = resolveObjectClipboardLimits(limitOverrides);
  const envelope = parseEnvelope(
    {
      format: 'htmllelujah-elements',
      version: OBJECT_CLIPBOARD_VERSION,
      sourceDocumentId,
      elements,
    },
    limits,
  );
  const serialized = JSON.stringify(envelope);
  serializedByteLength(serialized, limits.maxSerializedBytes);
  return Object.freeze({
    serialized,
    plainText: plainTextFallback(envelope.elements, limits),
  });
};

export const deserializeObjectClipboard = (
  serialized: string,
  limitOverrides?: ObjectClipboardLimitOverrides,
): ObjectClipboardReadPayload => {
  const limits = resolveObjectClipboardLimits(limitOverrides);
  serializedByteLength(serialized, limits.maxSerializedBytes);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new ObjectClipboardError('CLIPBOARD_INVALID', 'Clipboard object data is not valid JSON.');
  }
  const envelope = parseEnvelope(value, limits);
  return Object.freeze({
    sourceDocumentId: envelope.sourceDocumentId,
    elements: duplicateElements(detachExternalConnectorBindings(envelope.elements)),
  });
};
