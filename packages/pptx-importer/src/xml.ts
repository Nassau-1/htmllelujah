import { importFailure } from './errors.js';
import { PRESENTATION_IMPORT_LIMITS } from './limits.js';

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/u;

export interface XmlExpandedName {
  readonly namespaceUri: string | null;
  readonly localName: string;
  readonly prefix: string | null;
}

export interface XmlAttribute {
  readonly name: XmlExpandedName;
  readonly value: string;
}

export interface XmlElement {
  readonly name: XmlExpandedName;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlElement[];
  readonly text: string;
}

interface MutableElement {
  readonly rawName: string;
  readonly name: XmlExpandedName;
  readonly attributes: XmlAttribute[];
  readonly children: MutableElement[];
  readonly textParts: string[];
}

interface StackEntry {
  readonly element: MutableElement;
  readonly namespaces: ReadonlyMap<string, string>;
}

interface RawAttribute {
  readonly name: string;
  readonly value: string;
}

const splitName = (rawName: string): { readonly prefix: string | null; readonly local: string } => {
  if (!NAME_PATTERN.test(rawName)) importFailure('XML_INVALID', 'XML name is malformed.');
  const colon = rawName.indexOf(':');
  return colon < 0
    ? { prefix: null, local: rawName }
    : { prefix: rawName.slice(0, colon), local: rawName.slice(colon + 1) };
};

const decodeXmlValue = (value: string): string =>
  value.replace(/&([^;]+);/gu, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'apos':
        return "'";
      case 'gt':
        return '>';
      case 'lt':
        return '<';
      case 'quot':
        return '"';
      default: {
        const hex = /^#x([0-9a-fA-F]+)$/u.exec(entity);
        const decimal = /^#([0-9]+)$/u.exec(entity);
        const valueNumber =
          hex?.[1] !== undefined
            ? Number.parseInt(hex[1], 16)
            : decimal?.[1] !== undefined
              ? Number.parseInt(decimal[1], 10)
              : Number.NaN;
        if (
          !Number.isSafeInteger(valueNumber) ||
          valueNumber <= 0 ||
          valueNumber > 0x10ffff ||
          (valueNumber >= 0xd800 && valueNumber <= 0xdfff)
        ) {
          return importFailure('XML_UNSAFE', 'Declared or malformed XML entities are forbidden.');
        }
        return String.fromCodePoint(valueNumber);
      }
    }
  });

const parseRawTag = (
  raw: string,
): { readonly name: string; readonly attributes: RawAttribute[] } => {
  let cursor = 0;
  const skipWhitespace = (): void => {
    while (cursor < raw.length && /\s/u.test(raw[cursor] ?? '')) cursor += 1;
  };
  skipWhitespace();
  const nameStart = cursor;
  while (cursor < raw.length && !/\s/u.test(raw[cursor] ?? '')) cursor += 1;
  const name = raw.slice(nameStart, cursor);
  splitName(name);
  const attributes: RawAttribute[] = [];
  const rawNames = new Set<string>();
  while (cursor < raw.length) {
    skipWhitespace();
    if (cursor >= raw.length) break;
    const attributeStart = cursor;
    while (cursor < raw.length && !/\s/u.test(raw[cursor] ?? '') && raw[cursor] !== '=') {
      cursor += 1;
    }
    const attributeName = raw.slice(attributeStart, cursor);
    splitName(attributeName);
    skipWhitespace();
    if (raw[cursor] !== '=') importFailure('XML_INVALID', 'XML attribute is missing "=".');
    cursor += 1;
    skipWhitespace();
    const quote = raw[cursor];
    if (quote !== '"' && quote !== "'") {
      importFailure('XML_INVALID', 'XML attribute value must be quoted.');
    }
    cursor += 1;
    const valueStart = cursor;
    while (cursor < raw.length && raw[cursor] !== quote) {
      if (raw[cursor] === '<') {
        importFailure('XML_INVALID', 'XML attribute contains a forbidden delimiter.');
      }
      cursor += 1;
    }
    if (cursor >= raw.length) importFailure('XML_INVALID', 'XML attribute is unterminated.');
    const value = decodeXmlValue(raw.slice(valueStart, cursor));
    cursor += 1;
    if (rawNames.has(attributeName)) {
      importFailure('XML_INVALID', 'XML element contains duplicate attributes.');
    }
    rawNames.add(attributeName);
    attributes.push({ name: attributeName, value });
    if (attributes.length > PRESENTATION_IMPORT_LIMITS.maxXmlAttributesPerElement) {
      importFailure('XML_LIMIT_EXCEEDED', 'XML attribute count exceeds its fixed budget.');
    }
  }
  return { name, attributes };
};

const expandedName = (
  rawName: string,
  namespaces: ReadonlyMap<string, string>,
  attribute: boolean,
): XmlExpandedName => {
  const { prefix, local } = splitName(rawName);
  if (prefix === 'xmlns' || (prefix === null && rawName === 'xmlns')) {
    return { namespaceUri: XMLNS_NAMESPACE, localName: local, prefix };
  }
  if (prefix === 'xml') return { namespaceUri: XML_NAMESPACE, localName: local, prefix };
  if (prefix === null) {
    return {
      namespaceUri: attribute ? null : (namespaces.get('') ?? null),
      localName: local,
      prefix: null,
    };
  }
  const namespaceUri = namespaces.get(prefix);
  if (namespaceUri === undefined) {
    return importFailure('XML_INVALID', 'XML prefix is not declared.');
  }
  return { namespaceUri, localName: local, prefix };
};

const findTagEnd = (xml: string, start: number): number => {
  let quote: '"' | "'" | null = null;
  for (let cursor = start; cursor < xml.length; cursor += 1) {
    const character = xml[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor;
    }
  }
  return importFailure('XML_INVALID', 'XML start tag is unterminated.');
};

const freezeElement = (element: MutableElement): XmlElement =>
  Object.freeze({
    name: Object.freeze({ ...element.name }),
    attributes: Object.freeze(
      element.attributes.map((attribute) =>
        Object.freeze({
          name: Object.freeze({ ...attribute.name }),
          value: attribute.value,
        }),
      ),
    ),
    children: Object.freeze(element.children.map(freezeElement)),
    text: element.textParts.join(''),
  });

export const parseBoundedXml = (bytes: Uint8Array, part: string): XmlElement => {
  if (bytes.byteLength > PRESENTATION_IMPORT_LIMITS.maxXmlBytes) {
    importFailure('XML_LIMIT_EXCEEDED', 'XML part exceeds its fixed byte budget.', part);
  }
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    return importFailure('XML_INVALID', 'XML part is not valid UTF-8.', part);
  }
  if (xml.startsWith('\uFEFF')) xml = xml.slice(1);
  if (xml.includes('\0')) importFailure('XML_INVALID', 'XML part contains NUL bytes.', part);

  const roots: MutableElement[] = [];
  const stack: StackEntry[] = [];
  let cursor = 0;
  let tokens = 0;
  let textBytes = 0;
  let declarationSeen = false;

  const countToken = (): void => {
    tokens += 1;
    if (tokens > PRESENTATION_IMPORT_LIMITS.maxXmlTokens) {
      importFailure('XML_LIMIT_EXCEEDED', 'XML token count exceeds its fixed budget.', part);
    }
  };

  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const next = xml.indexOf('<', cursor);
      const end = next < 0 ? xml.length : next;
      const rawText = xml.slice(cursor, end);
      const text = decodeXmlValue(rawText);
      if (stack.length === 0) {
        if (text.trim().length > 0) {
          importFailure('XML_INVALID', 'XML contains text outside its root element.', part);
        }
      } else if (text.length > 0) {
        countToken();
        textBytes += Buffer.byteLength(text, 'utf8');
        if (textBytes > PRESENTATION_IMPORT_LIMITS.maxXmlTextBytes) {
          importFailure('XML_LIMIT_EXCEEDED', 'XML text exceeds its fixed budget.', part);
        }
        stack.at(-1)?.element.textParts.push(text);
      }
      cursor = end;
      continue;
    }

    if (xml.startsWith('<!--', cursor)) {
      const end = xml.indexOf('-->', cursor + 4);
      if (end < 0 || xml.slice(cursor + 4, end).includes('--')) {
        importFailure('XML_INVALID', 'XML comment is malformed.', part);
      }
      countToken();
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      const end = xml.indexOf('?>', cursor + 2);
      if (
        end < 0 ||
        cursor !== 0 ||
        declarationSeen ||
        !/^<\?xml(?:\s|\?)/u.test(xml.slice(cursor, Math.min(xml.length, cursor + 8)))
      ) {
        importFailure('XML_UNSAFE', 'Only one leading XML declaration is allowed.', part);
      }
      declarationSeen = true;
      countToken();
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', cursor)) {
      importFailure(
        'XML_UNSAFE',
        'DOCTYPE, ENTITY, CDATA, and other XML declarations are forbidden.',
        part,
      );
    }
    if (xml.startsWith('</', cursor)) {
      const end = xml.indexOf('>', cursor + 2);
      if (end < 0) importFailure('XML_INVALID', 'XML closing tag is unterminated.', part);
      const rawName = xml.slice(cursor + 2, end).trim();
      splitName(rawName);
      const current = stack.pop();
      if (current === undefined || current.element.rawName !== rawName) {
        importFailure('XML_INVALID', 'XML closing tag does not match its opening tag.', part);
      }
      countToken();
      cursor = end + 1;
      continue;
    }

    const end = findTagEnd(xml, cursor + 1);
    let rawTag = xml.slice(cursor + 1, end);
    const selfClosing = /\/\s*$/u.test(rawTag);
    if (selfClosing) rawTag = rawTag.replace(/\/\s*$/u, '');
    const parsed = parseRawTag(rawTag);
    const parentNamespaces = stack.at(-1)?.namespaces;
    const namespaces = new Map(parentNamespaces ?? [['xml', XML_NAMESPACE]]);
    let attributeBytes = 0;
    for (const attribute of parsed.attributes) {
      if (attribute.name === 'xmlns') {
        if (attribute.value.length === 0) namespaces.delete('');
        else namespaces.set('', attribute.value);
      } else if (attribute.name.startsWith('xmlns:')) {
        const prefix = attribute.name.slice(6);
        if (prefix === 'xml' || prefix === 'xmlns' || attribute.value.length === 0) {
          importFailure('XML_INVALID', 'XML namespace declaration is invalid.', part);
        }
        namespaces.set(prefix, attribute.value);
      }
      attributeBytes += Buffer.byteLength(attribute.name, 'utf8');
      attributeBytes += Buffer.byteLength(attribute.value, 'utf8');
    }
    if (attributeBytes > PRESENTATION_IMPORT_LIMITS.maxXmlAttributeBytes) {
      importFailure('XML_LIMIT_EXCEEDED', 'XML attributes exceed their fixed byte budget.', part);
    }
    const attributes: XmlAttribute[] = [];
    const expandedAttributeNames = new Set<string>();
    for (const attribute of parsed.attributes) {
      const name = expandedName(attribute.name, namespaces, true);
      if (name.namespaceUri === XMLNS_NAMESPACE) continue;
      const collisionKey = `${name.namespaceUri ?? ''}\u0000${name.localName}`;
      if (expandedAttributeNames.has(collisionKey)) {
        importFailure('XML_INVALID', 'XML attributes collide after namespace expansion.', part);
      }
      expandedAttributeNames.add(collisionKey);
      attributes.push({ name, value: attribute.value });
    }
    const element: MutableElement = {
      rawName: parsed.name,
      name: expandedName(parsed.name, namespaces, false),
      attributes,
      children: [],
      textParts: [],
    };
    const parent = stack.at(-1)?.element;
    if (parent === undefined) roots.push(element);
    else parent.children.push(element);
    countToken();
    if (!selfClosing) {
      stack.push({ element, namespaces });
      if (stack.length > PRESENTATION_IMPORT_LIMITS.maxXmlDepth) {
        importFailure('XML_LIMIT_EXCEEDED', 'XML depth exceeds its fixed budget.', part);
      }
    }
    cursor = end + 1;
  }

  if (stack.length !== 0) importFailure('XML_INVALID', 'XML contains unclosed elements.', part);
  if (roots.length !== 1) importFailure('XML_INVALID', 'XML must contain exactly one root.', part);
  const root = roots[0];
  if (root === undefined) {
    return importFailure('XML_INVALID', 'XML root element is missing.', part);
  }
  return freezeElement(root);
};

export const xmlAttribute = (
  element: XmlElement,
  localName: string,
  namespaceUri: string | null = null,
): string | undefined =>
  element.attributes.find(
    (attribute) =>
      attribute.name.localName === localName && attribute.name.namespaceUri === namespaceUri,
  )?.value;

export const xmlChildren = (
  element: XmlElement,
  namespaceUri: string,
  localName?: string,
): readonly XmlElement[] =>
  element.children.filter(
    (child) =>
      child.name.namespaceUri === namespaceUri &&
      (localName === undefined || child.name.localName === localName),
  );

export const xmlChild = (
  element: XmlElement,
  namespaceUri: string,
  localName: string,
): XmlElement | undefined =>
  element.children.find(
    (child) => child.name.namespaceUri === namespaceUri && child.name.localName === localName,
  );

export const xmlDescendants = (
  element: XmlElement,
  predicate: (candidate: XmlElement) => boolean,
): readonly XmlElement[] => {
  const result: XmlElement[] = [];
  const visit = (candidate: XmlElement): void => {
    for (const child of candidate.children) {
      if (predicate(child)) result.push(child);
      visit(child);
    }
  };
  visit(element);
  return result;
};
