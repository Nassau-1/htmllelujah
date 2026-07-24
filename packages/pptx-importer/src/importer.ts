import { createHash } from 'node:crypto';

import { importFailure } from './errors.js';
import { PRESENTATION_IMPORT_LIMITS } from './limits.js';
import type {
  ImportBackground,
  ImportColor,
  ImportFidelityRecord,
  ImportGeometry,
  ImportLayout,
  ImportMaster,
  ImportPageFurniture,
  ImportPageFurnitureKind,
  ImportPageSize,
  ImportPlaceholder,
  ImportTheme,
  ImportThemeColor,
  ImportWarning,
  PresentationImportOptions,
  PresentationImportPreview,
} from './model.js';
import type { OpcArchive } from './zip.js';
import { parseOpcArchive } from './zip.js';
import type { XmlElement } from './xml.js';
import { parseBoundedXml, xmlAttribute, xmlChild, xmlChildren, xmlDescendants } from './xml.js';

const NS = Object.freeze({
  contentTypes: 'http://schemas.openxmlformats.org/package/2006/content-types',
  packageRelationships: new Set([
    'http://schemas.openxmlformats.org/package/2006/relationships',
    'http://purl.oclc.org/ooxml/package/relationships',
  ]),
  presentation: new Set([
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'http://purl.oclc.org/ooxml/presentationml/main',
  ]),
  drawing: new Set([
    'http://schemas.openxmlformats.org/drawingml/2006/main',
    'http://purl.oclc.org/ooxml/drawingml/main',
  ]),
  officeRelationships: new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
  ]),
});

const PRESENTATION_MAIN_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
]);

const FORBIDDEN_PART_PATTERNS = [
  /(?:^|\/)vbaProject(?:Signature)?\.bin$/iu,
  /(?:^|\/)activeX(?:\/|$)/iu,
  /(?:^|\/)embeddings(?:\/|$)/iu,
  /(?:^|\/)oleObject/iu,
  /(?:^|\/)embeddedPackage/iu,
  /(?:^|\/)customUI(?:\/|$)/iu,
] as const;

const FORBIDDEN_CONTENT_TYPE =
  /(?:macroEnabled|vbaProject|activeX|oleObject|embeddedPackage|officedocument\.package)/iu;

interface ContentTypes {
  readonly overrides: ReadonlyMap<string, string>;
}

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

interface ParseContext {
  readonly archive: OpcArchive;
  readonly sourceSha256: string;
  readonly roots: Map<string, XmlElement>;
  readonly relationships: ReadonlyMap<string, ReadonlyMap<string, Relationship>>;
  readonly fidelity: ImportFidelityRecord[];
  readonly warnings: ImportWarning[];
}

interface ParsedPartDesign {
  readonly name: string;
  readonly background: ImportBackground;
  readonly placeholders: readonly ImportPlaceholder[];
  readonly pageFurniture: readonly ImportPageFurniture[];
}

const isNamespace = (element: XmlElement, namespaces: ReadonlySet<string>): boolean =>
  element.name.namespaceUri !== null && namespaces.has(element.name.namespaceUri);

const child = (
  element: XmlElement,
  namespaces: ReadonlySet<string>,
  localName: string,
): XmlElement | undefined =>
  element.children.find(
    (candidate) => candidate.name.localName === localName && isNamespace(candidate, namespaces),
  );

const children = (
  element: XmlElement,
  namespaces: ReadonlySet<string>,
  localName?: string,
): readonly XmlElement[] =>
  element.children.filter(
    (candidate) =>
      isNamespace(candidate, namespaces) &&
      (localName === undefined || candidate.name.localName === localName),
  );

const attributeInNamespaces = (
  element: XmlElement,
  localName: string,
  namespaces: ReadonlySet<string>,
): string | undefined =>
  element.attributes.find(
    (attribute) =>
      attribute.name.localName === localName &&
      attribute.name.namespaceUri !== null &&
      namespaces.has(attribute.name.namespaceUri),
  )?.value;

const requireAttribute = (element: XmlElement, name: string, part: string): string => {
  const value = xmlAttribute(element, name);
  if (value === undefined || value.length === 0) {
    return importFailure(
      'INVALID_PRESENTATIONML',
      'Required PresentationML attribute is missing.',
      part,
    );
  }
  return value;
};

const parseInteger = (
  value: string,
  part: string,
  options: {
    readonly minimum: number;
    readonly maximum: number;
    readonly label: string;
  },
): number => {
  if (!/^-?[0-9]+$/u.test(value)) {
    importFailure('INVALID_PRESENTATIONML', `${options.label} is not an integer.`, part);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.minimum || parsed > options.maximum) {
    importFailure(
      'INVALID_PRESENTATIONML',
      `${options.label} is outside the fixed coordinate budget.`,
      part,
    );
  }
  return parsed;
};

const emuToPoints = (value: number): number => {
  const converted = value / 12_700;
  if (!Number.isFinite(converted)) {
    importFailure('INVALID_PRESENTATIONML', 'EMU conversion produced a non-finite value.');
  }
  return Number(converted.toFixed(6));
};

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const childValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(childValue);
    }
  }
  return Object.freeze(value);
};

const deterministicId = (sourceSha256: string, kind: string, sourceIdentity: string): string =>
  `pptx_${kind}_${createHash('sha256')
    .update(sourceSha256)
    .update('\0')
    .update(kind)
    .update('\0')
    .update(sourceIdentity)
    .digest('hex')
    .slice(0, 20)}`;

const relationshipOwner = (relationshipPart: string): string => {
  if (relationshipPart === '_rels/.rels') return '';
  const marker = '/_rels/';
  const markerIndex = relationshipPart.lastIndexOf(marker);
  if (markerIndex <= 0 || !relationshipPart.endsWith('.rels')) {
    return importFailure('RELATIONSHIP_UNSAFE', 'Relationship part path is not canonical.');
  }
  const directory = relationshipPart.slice(0, markerIndex);
  const file = relationshipPart.slice(markerIndex + marker.length, -'.rels'.length);
  if (file.length === 0 || file.includes('/')) {
    return importFailure('RELATIONSHIP_UNSAFE', 'Relationship owner path is invalid.');
  }
  return `${directory}/${file}`;
};

const resolveRelationshipTarget = (
  ownerPart: string,
  rawTarget: string,
  archive: OpcArchive,
): string => {
  if (
    rawTarget.length === 0 ||
    rawTarget !== rawTarget.trim() ||
    rawTarget.includes('\\') ||
    rawTarget.includes('\0') ||
    /[\u0000-\u001f\u007f?#]/u.test(rawTarget) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(rawTarget) ||
    rawTarget.startsWith('//') ||
    /%(?:2f|5c)/iu.test(rawTarget)
  ) {
    return importFailure('RELATIONSHIP_UNSAFE', 'Relationship target is external or unsafe.');
  }
  const segments = rawTarget.startsWith('/')
    ? []
    : ownerPart.length === 0
      ? []
      : ownerPart.split('/').slice(0, -1);
  const rawSegments = (rawTarget.startsWith('/') ? rawTarget.slice(1) : rawTarget).split('/');
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0 || rawSegment === '.') {
      return importFailure('RELATIONSHIP_UNSAFE', 'Relationship target is not canonical.');
    }
    if (rawSegment === '..') {
      if (segments.length === 0) {
        return importFailure('RELATIONSHIP_UNSAFE', 'Relationship target escapes the package.');
      }
      segments.pop();
      continue;
    }
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return importFailure('RELATIONSHIP_UNSAFE', 'Relationship target encoding is malformed.');
    }
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment !== segment.normalize('NFC') ||
      segment.includes('/') ||
      segment.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(segment)
    ) {
      return importFailure('RELATIONSHIP_UNSAFE', 'Relationship target segment is unsafe.');
    }
    segments.push(segment);
  }
  const target = segments.join('/');
  if (!archive.entries.has(target)) {
    return importFailure(
      'MISSING_PART',
      'Relationship target is missing from the package.',
      target,
    );
  }
  return target;
};

const parseRelationshipParts = (
  archive: OpcArchive,
  readXml: (part: string) => XmlElement,
): ReadonlyMap<string, ReadonlyMap<string, Relationship>> => {
  const byOwner = new Map<string, ReadonlyMap<string, Relationship>>();
  let totalRelationships = 0;
  for (const part of [...archive.entries.keys()].filter((name) => name.endsWith('.rels')).sort()) {
    const owner = relationshipOwner(part);
    if (byOwner.has(owner)) {
      importFailure('RELATIONSHIP_UNSAFE', 'Relationship owner is declared more than once.', part);
    }
    const root = readXml(part);
    if (root.name.localName !== 'Relationships' || !isNamespace(root, NS.packageRelationships)) {
      importFailure('INVALID_PRESENTATIONML', 'Relationship part root is invalid.', part);
    }
    const relationships = new Map<string, Relationship>();
    for (const node of children(root, NS.packageRelationships, 'Relationship')) {
      totalRelationships += 1;
      if (totalRelationships > PRESENTATION_IMPORT_LIMITS.maxRelationships) {
        importFailure('XML_LIMIT_EXCEEDED', 'Relationship count exceeds its fixed budget.', part);
      }
      const id = requireAttribute(node, 'Id', part);
      const type = requireAttribute(node, 'Type', part);
      const rawTarget = requireAttribute(node, 'Target', part);
      const targetMode = xmlAttribute(node, 'TargetMode');
      if (targetMode !== undefined && targetMode.toLocaleLowerCase('en-US') !== 'internal') {
        importFailure('RELATIONSHIP_UNSAFE', 'External relationships are forbidden.', part);
      }
      if (relationships.has(id)) {
        importFailure('INVALID_PRESENTATIONML', 'Relationship identifiers collide.', part);
      }
      const target = resolveRelationshipTarget(owner, rawTarget, archive);
      relationships.set(id, Object.freeze({ id, type, target }));
    }
    byOwner.set(owner, relationships);
  }
  return byOwner;
};

const canonicalContentPart = (partName: string): string => {
  if (
    !partName.startsWith('/') ||
    partName.startsWith('//') ||
    partName.includes('\\') ||
    partName.includes('\0') ||
    /[\u0000-\u001f\u007f?#]/u.test(partName)
  ) {
    return importFailure('UNSAFE_PACKAGE', 'Content type part name is unsafe.');
  }
  const part = partName.slice(1);
  const segments = part.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment !== segment.normalize('NFC'),
    )
  ) {
    return importFailure('UNSAFE_PACKAGE', 'Content type part name is not canonical.');
  }
  return part;
};

const parseContentTypes = (root: XmlElement, archive: OpcArchive): ContentTypes => {
  if (root.name.namespaceUri !== NS.contentTypes || root.name.localName !== 'Types') {
    importFailure(
      'INVALID_PRESENTATIONML',
      'Content types root is invalid.',
      '[Content_Types].xml',
    );
  }
  const overrides = new Map<string, string>();
  const collisionKeys = new Set<string>();
  const defaultExtensions = new Set<string>();
  for (const override of xmlChildren(root, NS.contentTypes, 'Override')) {
    const part = canonicalContentPart(
      requireAttribute(override, 'PartName', '[Content_Types].xml'),
    );
    const contentType = requireAttribute(override, 'ContentType', '[Content_Types].xml');
    if (FORBIDDEN_CONTENT_TYPE.test(contentType)) {
      importFailure(
        'UNSAFE_PACKAGE',
        'Macro-enabled or embedded content types are forbidden.',
        part,
      );
    }
    const key = part.toLocaleLowerCase('en-US');
    if (collisionKeys.has(key)) {
      importFailure('UNSAFE_PACKAGE', 'Content type overrides collide.', '[Content_Types].xml');
    }
    collisionKeys.add(key);
    if (!archive.entries.has(part)) {
      importFailure('MISSING_PART', 'Content type override references a missing part.', part);
    }
    overrides.set(part, contentType);
  }
  for (const fallback of xmlChildren(root, NS.contentTypes, 'Default')) {
    const extension = requireAttribute(fallback, 'Extension', '[Content_Types].xml');
    if (!/^[A-Za-z0-9]{1,32}$/u.test(extension)) {
      importFailure(
        'UNSAFE_PACKAGE',
        'Default content type extension is not canonical.',
        '[Content_Types].xml',
      );
    }
    const extensionKey = extension.toLocaleLowerCase('en-US');
    if (defaultExtensions.has(extensionKey)) {
      importFailure(
        'UNSAFE_PACKAGE',
        'Default content type extensions collide.',
        '[Content_Types].xml',
      );
    }
    defaultExtensions.add(extensionKey);
    const contentType = requireAttribute(fallback, 'ContentType', '[Content_Types].xml');
    if (FORBIDDEN_CONTENT_TYPE.test(contentType)) {
      importFailure(
        'UNSAFE_PACKAGE',
        'Macro-enabled or embedded default content types are forbidden.',
        '[Content_Types].xml',
      );
    }
  }
  return { overrides };
};

const requireRelationships = (
  context: ParseContext,
  owner: string,
): ReadonlyMap<string, Relationship> =>
  context.relationships.get(owner) ?? new Map<string, Relationship>();

const relationshipById = (
  context: ParseContext,
  owner: string,
  id: string,
  requiredTypeSuffix: string,
): Relationship => {
  const relationship = requireRelationships(context, owner).get(id);
  if (
    relationship === undefined ||
    !relationship.type.toLocaleLowerCase('en-US').endsWith(requiredTypeSuffix.toLowerCase())
  ) {
    return importFailure(
      'INVALID_PRESENTATIONML',
      'Presentation relationship type or identifier is invalid.',
      owner,
    );
  }
  return relationship;
};

const relationshipByType = (
  context: ParseContext,
  owner: string,
  requiredTypeSuffix: string,
): Relationship | undefined => {
  const matches = [...requireRelationships(context, owner).values()].filter((relationship) =>
    relationship.type.toLocaleLowerCase('en-US').endsWith(requiredTypeSuffix.toLowerCase()),
  );
  if (matches.length > 1) {
    importFailure(
      'INVALID_PRESENTATIONML',
      'Presentation part has duplicate relationships.',
      owner,
    );
  }
  return matches[0];
};

const readPartRoot = (
  context: ParseContext,
  part: string,
  namespaces: ReadonlySet<string>,
  localName: string,
): XmlElement => {
  const cached = context.roots.get(part);
  const entry = context.archive.entries.get(part);
  if (entry === undefined) {
    return importFailure('MISSING_PART', 'Required package part is missing.', part);
  }
  const root = cached ?? parseBoundedXml(entry.bytes, part);
  context.roots.set(part, root);
  if (root.name.localName !== localName || !isNamespace(root, namespaces)) {
    importFailure('INVALID_PRESENTATIONML', 'PresentationML part root is invalid.', part);
  }
  return root;
};

const colorFromElement = (element: XmlElement): ImportColor | undefined => {
  if (!isNamespace(element, NS.drawing)) return undefined;
  const rawValue = xmlAttribute(element, 'val');
  switch (element.name.localName) {
    case 'srgbClr':
      return rawValue !== undefined && /^[0-9a-fA-F]{6}$/u.test(rawValue)
        ? { kind: 'rgb', value: rawValue.toUpperCase() }
        : undefined;
    case 'schemeClr':
      return rawValue !== undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(rawValue)
        ? { kind: 'scheme', value: rawValue }
        : undefined;
    case 'sysClr': {
      const lastColor = xmlAttribute(element, 'lastClr');
      const value =
        lastColor !== undefined && /^[0-9a-fA-F]{6}$/u.test(lastColor)
          ? lastColor.toUpperCase()
          : rawValue;
      return value !== undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(value)
        ? { kind: 'system', value }
        : undefined;
    }
    default:
      return undefined;
  }
};

const colorFromContainer = (container: XmlElement): ImportColor | undefined => {
  for (const candidate of container.children) {
    const color = colorFromElement(candidate);
    if (color !== undefined) return color;
  }
  return undefined;
};

const fidelityRecord = (
  context: ParseContext,
  sourcePart: string,
  itemKind: string,
  sourceIdentity: string,
  status: ImportFidelityRecord['status'],
  detail: string,
): void => {
  context.fidelity.push({
    id: deterministicId(context.sourceSha256, 'fidelity', `${sourcePart}\0${sourceIdentity}`),
    sourcePart,
    itemKind,
    status,
    detail,
  });
};

const parseBackground = (
  context: ParseContext,
  part: string,
  commonSlideData: XmlElement | undefined,
): ImportBackground => {
  const background =
    commonSlideData === undefined ? undefined : child(commonSlideData, NS.presentation, 'bg');
  if (background === undefined) {
    fidelityRecord(context, part, 'background', 'background', 'imported', 'Background inherits.');
    return { kind: 'inherit' };
  }
  const properties = child(background, NS.presentation, 'bgPr');
  if (properties !== undefined) {
    const solidFill = child(properties, NS.drawing, 'solidFill');
    const color = solidFill === undefined ? undefined : colorFromContainer(solidFill);
    if (color !== undefined) {
      const colorNode = solidFill?.children.find(
        (candidate) => colorFromElement(candidate) !== undefined,
      );
      const transformed = (colorNode?.children.length ?? 0) > 0;
      fidelityRecord(
        context,
        part,
        'background',
        'background',
        transformed ? 'substituted' : 'imported',
        transformed
          ? 'Solid background imported without DrawingML color transforms.'
          : 'Solid background imported.',
      );
      return { kind: 'solid', color };
    }
    fidelityRecord(
      context,
      part,
      'background',
      'background',
      'unsupported',
      'Only solid DrawingML backgrounds are supported in phase 1.',
    );
    return { kind: 'inherit' };
  }
  const reference = child(background, NS.presentation, 'bgRef');
  if (reference !== undefined) {
    const index = parseInteger(requireAttribute(reference, 'idx', part), part, {
      minimum: 0,
      maximum: 4_294_967_295,
      label: 'Background reference index',
    });
    const color = colorFromContainer(reference);
    fidelityRecord(
      context,
      part,
      'background',
      'background',
      'imported',
      'Theme background reference imported.',
    );
    return { kind: 'theme-reference', index, color };
  }
  fidelityRecord(
    context,
    part,
    'background',
    'background',
    'unsupported',
    'Background representation is unsupported.',
  );
  return { kind: 'inherit' };
};

const parseGeometry = (shape: XmlElement, part: string): ImportGeometry | undefined => {
  const properties = child(shape, NS.presentation, 'spPr');
  const transform = properties === undefined ? undefined : child(properties, NS.drawing, 'xfrm');
  if (transform === undefined) return undefined;
  const offset = child(transform, NS.drawing, 'off');
  const extent = child(transform, NS.drawing, 'ext');
  if (offset === undefined || extent === undefined) {
    return importFailure('INVALID_PRESENTATIONML', 'Shape transform is incomplete.', part);
  }
  const xEmu = parseInteger(requireAttribute(offset, 'x', part), part, {
    minimum: -PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    maximum: PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    label: 'Shape x coordinate',
  });
  const yEmu = parseInteger(requireAttribute(offset, 'y', part), part, {
    minimum: -PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    maximum: PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    label: 'Shape y coordinate',
  });
  const widthEmu = parseInteger(requireAttribute(extent, 'cx', part), part, {
    minimum: 0,
    maximum: PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    label: 'Shape width',
  });
  const heightEmu = parseInteger(requireAttribute(extent, 'cy', part), part, {
    minimum: 0,
    maximum: PRESENTATION_IMPORT_LIMITS.maxCoordinateEmu,
    label: 'Shape height',
  });
  return {
    xEmu,
    yEmu,
    widthEmu,
    heightEmu,
    xPt: emuToPoints(xEmu),
    yPt: emuToPoints(yEmu),
    widthPt: emuToPoints(widthEmu),
    heightPt: emuToPoints(heightEmu),
  };
};

const pageFurnitureKind = (placeholderType: string): ImportPageFurnitureKind | undefined => {
  switch (placeholderType) {
    case 'dt':
      return 'date';
    case 'ftr':
      return 'footer';
    case 'sldNum':
      return 'page-number';
    case 'hdr':
      return 'header';
    default:
      return undefined;
  }
};

const parsePartDesign = (
  context: ParseContext,
  part: string,
  root: XmlElement,
): ParsedPartDesign => {
  const commonSlideData = child(root, NS.presentation, 'cSld');
  const name =
    (commonSlideData === undefined ? undefined : xmlAttribute(commonSlideData, 'name')) ??
    xmlAttribute(root, 'name') ??
    '';
  const placeholders: ImportPlaceholder[] = [];
  const pageFurniture: ImportPageFurniture[] = [];
  const shapeTree =
    commonSlideData === undefined ? undefined : child(commonSlideData, NS.presentation, 'spTree');
  const shapes = shapeTree === undefined ? [] : children(shapeTree, NS.presentation, 'sp');
  let placeholderOrder = 0;
  for (const shape of shapes) {
    const nonVisual = child(shape, NS.presentation, 'nvSpPr');
    const nonVisualProperties =
      nonVisual === undefined ? undefined : child(nonVisual, NS.presentation, 'nvPr');
    const placeholder =
      nonVisualProperties === undefined
        ? undefined
        : child(nonVisualProperties, NS.presentation, 'ph');
    const coreProperties =
      nonVisual === undefined ? undefined : child(nonVisual, NS.presentation, 'cNvPr');
    const shapeName =
      coreProperties === undefined ? undefined : xmlAttribute(coreProperties, 'name');
    const coreId = coreProperties === undefined ? undefined : xmlAttribute(coreProperties, 'id');
    if (placeholder === undefined) {
      fidelityRecord(
        context,
        part,
        'page-furniture-shape',
        `shape:${coreId ?? placeholderOrder}`,
        'unsupported',
        'Non-placeholder master/layout shapes are reported but not modeled in phase 1.',
      );
      continue;
    }
    if (placeholderOrder >= PRESENTATION_IMPORT_LIMITS.maxPlaceholderCountPerPart) {
      importFailure('XML_LIMIT_EXCEEDED', 'Placeholder count exceeds its fixed budget.', part);
    }
    const type = xmlAttribute(placeholder, 'type') ?? 'object';
    const rawIndex = xmlAttribute(placeholder, 'idx');
    const index =
      rawIndex === undefined
        ? undefined
        : parseInteger(rawIndex, part, {
            minimum: 0,
            maximum: 4_294_967_295,
            label: 'Placeholder index',
          });
    const textRuns = xmlDescendants(
      shape,
      (candidate) => candidate.name.localName === 't' && isNamespace(candidate, NS.drawing),
    )
      .map((run) => run.text)
      .join('');
    const identity = `${coreId ?? ''}:${index ?? ''}:${type}:${placeholderOrder}`;
    const placeholderId = deterministicId(
      context.sourceSha256,
      'placeholder',
      `${part}\0${identity}`,
    );
    const parsed: ImportPlaceholder = {
      id: placeholderId,
      sourcePart: part,
      name: shapeName ?? `Placeholder ${placeholderOrder + 1}`,
      type,
      index,
      orientation: xmlAttribute(placeholder, 'orient'),
      size: xmlAttribute(placeholder, 'sz'),
      geometry: parseGeometry(shape, part),
      text: textRuns.length > 0 ? textRuns : undefined,
    };
    placeholders.push(parsed);
    fidelityRecord(
      context,
      part,
      'placeholder',
      identity,
      'imported',
      'Placeholder semantics and bounded geometry imported.',
    );
    const furnitureKind = pageFurnitureKind(type);
    if (furnitureKind !== undefined) {
      pageFurniture.push({
        id: deterministicId(context.sourceSha256, 'furniture', `${part}\0${identity}`),
        kind: furnitureKind,
        placeholderId,
        text: parsed.text,
      });
      fidelityRecord(
        context,
        part,
        'page-furniture',
        `furniture:${identity}`,
        'imported',
        `${furnitureKind} placeholder imported as page furniture.`,
      );
    }
    placeholderOrder += 1;
  }
  if (shapeTree !== undefined) {
    const ignoredShapeTreeNames = new Set(['nvGrpSpPr', 'grpSpPr', 'sp']);
    for (const unsupported of shapeTree.children.filter(
      (candidate) =>
        isNamespace(candidate, NS.presentation) &&
        !ignoredShapeTreeNames.has(candidate.name.localName),
    )) {
      fidelityRecord(
        context,
        part,
        unsupported.name.localName,
        `unsupported:${unsupported.name.localName}`,
        'unsupported',
        'This design-layer drawing construct is not modeled in phase 1.',
      );
    }
  }
  const unsupportedDesignNames = new Set([
    'blipFill',
    'effectDag',
    'effectLst',
    'extLst',
    'gradFill',
    'pattFill',
    'scene3d',
    'sp3d',
    'timing',
    'transition',
  ]);
  const unsupportedDesignNodes = xmlDescendants(root, (candidate) =>
    unsupportedDesignNames.has(candidate.name.localName),
  );
  unsupportedDesignNodes.forEach((unsupported, index) => {
    fidelityRecord(
      context,
      part,
      unsupported.name.localName,
      `unsupported-design:${unsupported.name.localName}:${index}`,
      'unsupported',
      'This DrawingML effect or extension is inventoried but not modeled in phase 1.',
    );
  });
  return {
    name,
    background: parseBackground(context, part, commonSlideData),
    placeholders,
    pageFurniture,
  };
};

const parseTheme = (context: ParseContext, part: string): ImportTheme => {
  const root = readPartRoot(context, part, NS.drawing, 'theme');
  const id = deterministicId(context.sourceSha256, 'theme', part);
  const themeElements = child(root, NS.drawing, 'themeElements');
  const colorScheme =
    themeElements === undefined ? undefined : child(themeElements, NS.drawing, 'clrScheme');
  const colors: ImportThemeColor[] = [];
  if (colorScheme !== undefined) {
    for (const roleNode of children(colorScheme, NS.drawing)) {
      const color = colorFromContainer(roleNode);
      if (color === undefined) {
        fidelityRecord(
          context,
          part,
          'theme-color',
          `color:${roleNode.name.localName}`,
          'unsupported',
          `Theme color ${roleNode.name.localName} has an unsupported color source.`,
        );
        continue;
      }
      colors.push({ role: roleNode.name.localName, color });
      fidelityRecord(
        context,
        part,
        'theme-color',
        `color:${roleNode.name.localName}`,
        'imported',
        `Theme color ${roleNode.name.localName} imported.`,
      );
    }
  }
  const fontScheme =
    themeElements === undefined ? undefined : child(themeElements, NS.drawing, 'fontScheme');
  const majorFont =
    fontScheme === undefined ? undefined : child(fontScheme, NS.drawing, 'majorFont');
  const minorFont =
    fontScheme === undefined ? undefined : child(fontScheme, NS.drawing, 'minorFont');
  const majorLatin = majorFont === undefined ? undefined : child(majorFont, NS.drawing, 'latin');
  const minorLatin = minorFont === undefined ? undefined : child(minorFont, NS.drawing, 'latin');
  const majorTypeface = majorLatin === undefined ? undefined : xmlAttribute(majorLatin, 'typeface');
  const minorTypeface = minorLatin === undefined ? undefined : xmlAttribute(minorLatin, 'typeface');
  fidelityRecord(
    context,
    part,
    'theme',
    'theme',
    'imported',
    'Theme colors and Latin major/minor fonts imported.',
  );
  if (themeElements !== undefined && child(themeElements, NS.drawing, 'fmtScheme') !== undefined) {
    fidelityRecord(
      context,
      part,
      'theme-format-scheme',
      'format-scheme',
      'unsupported',
      'DrawingML fill, line, and effect style matrices are inventoried but not modeled in phase 1.',
    );
  }
  return {
    id,
    sourcePart: part,
    name: xmlAttribute(root, 'name') ?? 'Imported theme',
    colors,
    majorLatinFont: majorTypeface === '' ? undefined : majorTypeface,
    minorLatinFont: minorTypeface === '' ? undefined : minorTypeface,
  };
};

const parsePageSize = (presentation: XmlElement, part: string): ImportPageSize => {
  const size = child(presentation, NS.presentation, 'sldSz');
  if (size === undefined) {
    return importFailure('INVALID_PRESENTATIONML', 'Presentation page size is missing.', part);
  }
  const widthEmu = parseInteger(requireAttribute(size, 'cx', part), part, {
    minimum: 1,
    maximum: PRESENTATION_IMPORT_LIMITS.maxPageEmu,
    label: 'Page width',
  });
  const heightEmu = parseInteger(requireAttribute(size, 'cy', part), part, {
    minimum: 1,
    maximum: PRESENTATION_IMPORT_LIMITS.maxPageEmu,
    label: 'Page height',
  });
  return {
    widthEmu,
    heightEmu,
    widthPt: emuToPoints(widthEmu),
    heightPt: emuToPoints(heightEmu),
  };
};

const parsePresentationDesign = (
  context: ParseContext,
  presentationPart: string,
): {
  readonly pageSize: ImportPageSize;
  readonly themes: readonly ImportTheme[];
  readonly masters: readonly ImportMaster[];
  readonly layouts: readonly ImportLayout[];
} => {
  const presentation = readPartRoot(context, presentationPart, NS.presentation, 'presentation');
  const pageSize = parsePageSize(presentation, presentationPart);
  fidelityRecord(
    context,
    presentationPart,
    'page-size',
    'page-size',
    'imported',
    'Presentation page size imported with deterministic EMU-to-point conversion.',
  );
  const masterList = child(presentation, NS.presentation, 'sldMasterIdLst');
  const masterRefs =
    masterList === undefined ? [] : children(masterList, NS.presentation, 'sldMasterId');
  if (masterRefs.length === 0) {
    importFailure('INVALID_PRESENTATIONML', 'Presentation has no slide master.', presentationPart);
  }
  if (masterRefs.length > PRESENTATION_IMPORT_LIMITS.maxMasterCount) {
    importFailure('XML_LIMIT_EXCEEDED', 'Slide master count exceeds its fixed budget.');
  }

  const themes = new Map<string, ImportTheme>();
  const layouts = new Map<string, ImportLayout>();
  const masters: ImportMaster[] = [];
  const claimedLayoutParts = new Set<string>();
  for (let masterIndex = 0; masterIndex < masterRefs.length; masterIndex += 1) {
    const masterRef = masterRefs[masterIndex];
    if (masterRef === undefined) continue;
    const relationshipId = attributeInNamespaces(masterRef, 'id', NS.officeRelationships);
    if (relationshipId === undefined) {
      return importFailure(
        'INVALID_PRESENTATIONML',
        'Slide master reference has no relationship.',
        presentationPart,
      );
    }
    const relationship = relationshipById(
      context,
      presentationPart,
      relationshipId,
      '/slideMaster',
    );
    const masterPart = relationship.target;
    const masterRoot = readPartRoot(context, masterPart, NS.presentation, 'sldMaster');
    const masterId = deterministicId(context.sourceSha256, 'master', masterPart);
    const masterDesign = parsePartDesign(context, masterPart, masterRoot);
    const themeRelationship = relationshipByType(context, masterPart, '/theme');
    let themeId: string | undefined;
    if (themeRelationship !== undefined) {
      let theme = themes.get(themeRelationship.target);
      if (theme === undefined) {
        if (themes.size >= PRESENTATION_IMPORT_LIMITS.maxThemeCount) {
          importFailure('XML_LIMIT_EXCEEDED', 'Theme count exceeds its fixed budget.');
        }
        theme = parseTheme(context, themeRelationship.target);
        themes.set(themeRelationship.target, theme);
      }
      themeId = theme.id;
    } else {
      context.warnings.push({
        code: 'MASTER_THEME_MISSING',
        message: 'A slide master does not reference a theme.',
        sourcePart: masterPart,
      });
    }

    const layoutList = child(masterRoot, NS.presentation, 'sldLayoutIdLst');
    const layoutRefs =
      layoutList === undefined ? [] : children(layoutList, NS.presentation, 'sldLayoutId');
    if (layoutRefs.length + layouts.size > PRESENTATION_IMPORT_LIMITS.maxLayoutCount) {
      importFailure('XML_LIMIT_EXCEEDED', 'Slide layout count exceeds its fixed budget.');
    }
    const layoutIds: string[] = [];
    for (let layoutIndex = 0; layoutIndex < layoutRefs.length; layoutIndex += 1) {
      const layoutRef = layoutRefs[layoutIndex];
      if (layoutRef === undefined) continue;
      const layoutRelationshipId = attributeInNamespaces(layoutRef, 'id', NS.officeRelationships);
      if (layoutRelationshipId === undefined) {
        return importFailure(
          'INVALID_PRESENTATIONML',
          'Slide layout reference has no relationship.',
          masterPart,
        );
      }
      const layoutRelationship = relationshipById(
        context,
        masterPart,
        layoutRelationshipId,
        '/slideLayout',
      );
      const layoutPart = layoutRelationship.target;
      if (claimedLayoutParts.has(layoutPart)) {
        importFailure(
          'INVALID_PRESENTATIONML',
          'A slide layout is claimed by more than one master.',
          layoutPart,
        );
      }
      claimedLayoutParts.add(layoutPart);
      const layoutRoot = readPartRoot(context, layoutPart, NS.presentation, 'sldLayout');
      const backlink = relationshipByType(context, layoutPart, '/slideMaster');
      if (backlink === undefined || backlink.target !== masterPart) {
        importFailure(
          'INVALID_PRESENTATIONML',
          'Slide layout and master relationships are not reciprocal.',
          layoutPart,
        );
      }
      const design = parsePartDesign(context, layoutPart, layoutRoot);
      const layoutId = deterministicId(context.sourceSha256, 'layout', layoutPart);
      const layout: ImportLayout = {
        id: layoutId,
        sourcePart: layoutPart,
        masterId,
        name: design.name || `Layout ${layoutIndex + 1}`,
        type: xmlAttribute(layoutRoot, 'type'),
        background: design.background,
        placeholders: design.placeholders,
        pageFurniture: design.pageFurniture,
      };
      layouts.set(layoutPart, layout);
      layoutIds.push(layoutId);
      fidelityRecord(
        context,
        layoutPart,
        'layout',
        'layout',
        'imported',
        'Layout relationship, placeholders, and basic background imported.',
      );
    }
    masters.push({
      id: masterId,
      sourcePart: masterPart,
      name: masterDesign.name || `Master ${masterIndex + 1}`,
      themeId,
      layoutIds,
      background: masterDesign.background,
      placeholders: masterDesign.placeholders,
      pageFurniture: masterDesign.pageFurniture,
    });
    fidelityRecord(
      context,
      masterPart,
      'master',
      'master',
      'imported',
      'Master relationship, placeholders, and basic background imported.',
    );
  }
  return {
    pageSize,
    themes: [...themes.values()],
    masters,
    layouts: [...layouts.values()],
  };
};

const contentTypeCount = (contentTypes: ContentTypes, fragment: string): number =>
  [...contentTypes.overrides.values()].filter((contentType) =>
    contentType.toLocaleLowerCase('en-US').includes(fragment.toLocaleLowerCase('en-US')),
  ).length;

const isUnsupportedPart = (name: string): boolean =>
  /^(?:ppt\/(?:charts|diagrams|notesMasters|handoutMasters|comments|commentAuthors|tags|audio|video)\/)/iu.test(
    name,
  );

const validatePackageSafety = (archive: OpcArchive): void => {
  for (const name of archive.entries.keys()) {
    if (FORBIDDEN_PART_PATTERNS.some((pattern) => pattern.test(name))) {
      importFailure(
        'UNSAFE_PACKAGE',
        'Macros, ActiveX, embedded packages, and OLE objects are forbidden.',
        name,
      );
    }
  }
};

/**
 * Parses hostile `.pptx`/`.potx` bytes into an immutable, design-only preview.
 *
 * The function performs no filesystem, network, Office automation, or document mutation.
 * Unsupported content is represented in `fidelity`; a successful return is still only a
 * proposal for a later explicit import transaction.
 */
export const parsePresentationImportPreview = (
  bytes: Uint8Array,
  options: PresentationImportOptions,
): PresentationImportPreview => {
  if (options?.mode !== 'design-only') {
    importFailure(
      'UNSUPPORTED_DOCUMENT',
      'Only the explicit design-only PresentationML preview mode is supported.',
    );
  }
  const archive = parseOpcArchive(bytes);
  validatePackageSafety(archive);
  const roots = new Map<string, XmlElement>();
  const readXml = (part: string): XmlElement => {
    const cached = roots.get(part);
    if (cached !== undefined) return cached;
    const entry = archive.entries.get(part);
    if (entry === undefined) {
      return importFailure('MISSING_PART', 'Required XML part is missing.', part);
    }
    const parsed = parseBoundedXml(entry.bytes, part);
    roots.set(part, parsed);
    return parsed;
  };
  const contentTypesEntry = archive.entries.get('[Content_Types].xml');
  if (contentTypesEntry === undefined) {
    return importFailure('MISSING_PART', 'Presentation package has no content types part.');
  }
  const contentTypesRoot = parseBoundedXml(contentTypesEntry.bytes, '[Content_Types].xml');
  const contentTypes = parseContentTypes(contentTypesRoot, archive);
  roots.set('[Content_Types].xml', contentTypesRoot);
  const presentationCandidates = [...contentTypes.overrides.entries()].filter(([, contentType]) =>
    PRESENTATION_MAIN_TYPES.has(contentType),
  );
  if (presentationCandidates.length !== 1) {
    importFailure(
      'UNSUPPORTED_DOCUMENT',
      'Package must contain exactly one non-macro presentation or template main part.',
    );
  }
  const presentationPart = presentationCandidates[0]?.[0];
  if (presentationPart === undefined) {
    return importFailure('MISSING_PART', 'Presentation main part is missing.');
  }
  const relationships = parseRelationshipParts(archive, readXml);
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  const fidelity: ImportFidelityRecord[] = [];
  const warnings: ImportWarning[] = [];
  const context: ParseContext = {
    archive,
    sourceSha256,
    roots,
    relationships,
    fidelity,
    warnings,
  };
  const design = parsePresentationDesign(context, presentationPart);
  const slidePartCount = contentTypeCount(contentTypes, 'presentationml.slide+xml');
  if (slidePartCount > 0) {
    warnings.push({
      code: 'SLIDES_NOT_SELECTED',
      message: `${slidePartCount} slide part(s) were intentionally left unchanged by design-only preview.`,
    });
    fidelityRecord(
      context,
      presentationPart,
      'slide-content',
      'design-only-slide-content',
      'unsupported',
      'Slide content is outside the selected design-only phase; no source part was mutated.',
    );
  }
  const unsupportedParts = [...archive.entries.keys()].filter(isUnsupportedPart).sort();
  for (const part of unsupportedParts) {
    fidelityRecord(
      context,
      part,
      'package-part',
      `unsupported-part:${part}`,
      'unsupported',
      'This package part is inventoried but unsupported by the phase-1 design importer.',
    );
  }

  const preview: PresentationImportPreview = {
    schemaVersion: 1,
    mode: 'design-only',
    source: {
      sha256: sourceSha256,
      archiveBytes: archive.archiveBytes,
      expandedBytes: archive.expandedBytes,
      entryCount: archive.entries.size,
      presentationPart,
      masterPartCount: contentTypeCount(contentTypes, 'presentationml.slideMaster+xml'),
      layoutPartCount: contentTypeCount(contentTypes, 'presentationml.slideLayout+xml'),
      themePartCount: contentTypeCount(contentTypes, 'officedocument.theme+xml'),
      slidePartCount,
      mediaPartCount: [...archive.entries.keys()].filter((name) => name.startsWith('ppt/media/'))
        .length,
      unsupportedPartCount: unsupportedParts.length,
    },
    pageSize: design.pageSize,
    themes: design.themes,
    masters: design.masters,
    layouts: design.layouts,
    fidelity,
    warnings,
  };
  return deepFreeze(preview);
};
