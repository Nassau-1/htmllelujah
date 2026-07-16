import type { ConnectorElement, DeckDocument, Element, Frame } from './model.js';

export const CONNECTOR_GEOMETRY_VERSION = 2 as const;

export interface ConnectorGeometryBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

interface Point {
  readonly xPt: number;
  readonly yPt: number;
}

interface AffineTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

type ConnectorAnchor = NonNullable<ConnectorElement['start']['binding']['anchor']>;
type AnchorPoints = Readonly<Record<ConnectorAnchor, Point>>;

export interface ResolvedDocumentConnectorGeometry {
  readonly connectorId: string;
  readonly startInContainer: Point;
  readonly endInContainer: Point;
  readonly startInDocument: Point;
  readonly endInDocument: Point;
  readonly boundsInContainer: ConnectorGeometryBounds;
  readonly boundsInDocument: ConnectorGeometryBounds;
}

const IDENTITY_TRANSFORM: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

const normalizedCoordinate = (value: number): number => {
  const rounded = Math.round(value * 1e10) / 1e10;
  return Math.abs(rounded) < 1e-10 ? 0 : rounded;
};

const normalizedPoint = (point: Point): Point => ({
  xPt: normalizedCoordinate(point.xPt),
  yPt: normalizedCoordinate(point.yPt),
});

const composeTransforms = (outer: AffineTransform, inner: AffineTransform): AffineTransform => ({
  a: outer.a * inner.a + outer.c * inner.b,
  b: outer.b * inner.a + outer.d * inner.b,
  c: outer.a * inner.c + outer.c * inner.d,
  d: outer.b * inner.c + outer.d * inner.d,
  e: outer.a * inner.e + outer.c * inner.f + outer.e,
  f: outer.b * inner.e + outer.d * inner.f + outer.f,
});

const applyTransform = (transform: AffineTransform, point: Point): Point => ({
  xPt: transform.a * point.xPt + transform.c * point.yPt + transform.e,
  yPt: transform.b * point.xPt + transform.d * point.yPt + transform.f,
});

const frameTransform = (frame: Frame): AffineTransform => {
  const radians = (frame.rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = frame.widthPt / 2;
  const centerY = frame.heightPt / 2;
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: frame.xPt + centerX - cosine * centerX + sine * centerY,
    f: frame.yPt + centerY - sine * centerX - cosine * centerY,
  };
};

const scaleTransform = (scaleX: number, scaleY: number): AffineTransform => ({
  a: scaleX,
  b: 0,
  c: 0,
  d: scaleY,
  e: 0,
  f: 0,
});

const inverseTransform = (transform: AffineTransform): AffineTransform | undefined => {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || determinant === 0) return undefined;
  const inverse = {
    a: transform.d / determinant,
    b: -transform.b / determinant,
    c: -transform.c / determinant,
    d: transform.a / determinant,
    e: (transform.c * transform.f - transform.d * transform.e) / determinant,
    f: (transform.b * transform.e - transform.a * transform.f) / determinant,
  };
  return Object.values(inverse).every(Number.isFinite) ? inverse : undefined;
};

const childContainerToDocument = (
  group: Extract<Element, { readonly type: 'group' }>,
  containerToDocument: AffineTransform,
): AffineTransform => {
  const coordinateWidth = Math.max(0.001, group.coordinateSpace.widthPt);
  const coordinateHeight = Math.max(0.001, group.coordinateSpace.heightPt);
  return composeTransforms(
    containerToDocument,
    composeTransforms(
      frameTransform(group.frame),
      scaleTransform(
        Math.max(0, group.frame.widthPt) / coordinateWidth,
        Math.max(0, group.frame.heightPt) / coordinateHeight,
      ),
    ),
  );
};

const anchorPointsForElement = (
  element: Element,
  containerToDocument: AffineTransform,
): AnchorPoints => {
  const elementToDocument = composeTransforms(containerToDocument, frameTransform(element.frame));
  return {
    top: applyTransform(elementToDocument, { xPt: element.frame.widthPt / 2, yPt: 0 }),
    right: applyTransform(elementToDocument, {
      xPt: element.frame.widthPt,
      yPt: element.frame.heightPt / 2,
    }),
    bottom: applyTransform(elementToDocument, {
      xPt: element.frame.widthPt / 2,
      yPt: element.frame.heightPt,
    }),
    left: applyTransform(elementToDocument, { xPt: 0, yPt: element.frame.heightPt / 2 }),
    center: applyTransform(elementToDocument, {
      xPt: element.frame.widthPt / 2,
      yPt: element.frame.heightPt / 2,
    }),
  };
};

const buildAnchorIndex = (elements: readonly Element[]): ReadonlyMap<string, AnchorPoints> => {
  const anchors = new Map<string, AnchorPoints>();
  const visit = (current: readonly Element[], containerToDocument: AffineTransform): void => {
    for (const element of current) {
      anchors.set(element.id, anchorPointsForElement(element, containerToDocument));
      if (element.type === 'group') {
        visit(element.children, childContainerToDocument(element, containerToDocument));
      }
    }
  };
  visit(elements, IDENTITY_TRANSFORM);
  return anchors;
};

const boundsForPoints = (start: Point, end: Point): ConnectorGeometryBounds => ({
  left: Math.min(start.xPt, end.xPt),
  top: Math.min(start.yPt, end.yPt),
  right: Math.max(start.xPt, end.xPt),
  bottom: Math.max(start.yPt, end.yPt),
});

/**
 * Stamps the explicit invariant on pre-marker V2 files. At the compatibility
 * boundary those files already stored final container-space endpoint points;
 * applying frame.rotationDeg again here would be a destructive double rotation.
 */
export const canonicalizeConnectorGeometry = (connector: ConnectorElement): ConnectorElement => {
  if (connector.geometryVersion === CONNECTOR_GEOMETRY_VERSION) return connector;
  return {
    ...connector,
    geometryVersion: CONNECTOR_GEOMETRY_VERSION,
  };
};

export const canonicalizeElementConnectorGeometry = (element: Element): Element => {
  if (element.type === 'connector') return canonicalizeConnectorGeometry(element);
  if (element.type !== 'group') return element;
  let changed = false;
  const children = element.children.map((child) => {
    const canonical = canonicalizeElementConnectorGeometry(child);
    if (canonical !== child) changed = true;
    return canonical;
  });
  return changed ? { ...element, children } : element;
};

export const canonicalizeElementsConnectorGeometry = (
  elements: readonly Element[],
): readonly Element[] => {
  let changed = false;
  const canonical = elements.map((element) => {
    const next = canonicalizeElementConnectorGeometry(element);
    if (next !== element) changed = true;
    return next;
  });
  return changed ? canonical : elements;
};

/** Migrates connectors in masters, layouts, and slides during every open boundary. */
export const canonicalizeDeckConnectorGeometry = (document: DeckDocument): DeckDocument => {
  let changed = false;
  const masters = document.masters.map((master) => {
    const elements = canonicalizeElementsConnectorGeometry(master.elements);
    if (elements === master.elements) return master;
    changed = true;
    return { ...master, elements };
  });
  const layouts = document.layouts.map((layout) => {
    const elements = canonicalizeElementsConnectorGeometry(layout.elements);
    if (elements === layout.elements) return layout;
    changed = true;
    return { ...layout, elements };
  });
  const slides = document.slides.map((slide) => {
    const elements = canonicalizeElementsConnectorGeometry(slide.elements);
    if (elements === slide.elements) return slide;
    changed = true;
    return { ...slide, elements };
  });
  return changed ? { ...document, masters, layouts, slides } : document;
};

/**
 * Resolves binding anchors and nested group transforms while retaining each
 * connector's immediate-container coordinates. Document commands use this
 * same effective geometry that the renderer paints.
 */
export const resolveDocumentConnectorGeometries = (
  elements: readonly Element[],
): ReadonlyMap<string, ResolvedDocumentConnectorGeometry> => {
  const anchors = buildAnchorIndex(elements);
  const geometries = new Map<string, ResolvedDocumentConnectorGeometry>();
  const visit = (current: readonly Element[], containerToDocument: AffineTransform): void => {
    for (const input of current) {
      if (input.type === 'connector') {
        const connector = canonicalizeConnectorGeometry(input);
        const inverse = inverseTransform(containerToDocument);
        const resolveEndpoint = (endpoint: ConnectorElement['start']): Point => {
          const targetId = endpoint.binding.elementId;
          const target = targetId === undefined ? undefined : anchors.get(targetId);
          if (target === undefined || inverse === undefined) return normalizedPoint(endpoint);
          return normalizedPoint(
            applyTransform(inverse, target[endpoint.binding.anchor ?? 'center']),
          );
        };
        const startInContainer = resolveEndpoint(connector.start);
        const endInContainer = resolveEndpoint(connector.end);
        const startInDocument = normalizedPoint(
          applyTransform(containerToDocument, startInContainer),
        );
        const endInDocument = normalizedPoint(applyTransform(containerToDocument, endInContainer));
        geometries.set(connector.id, {
          connectorId: connector.id,
          startInContainer,
          endInContainer,
          startInDocument,
          endInDocument,
          boundsInContainer: boundsForPoints(startInContainer, endInContainer),
          boundsInDocument: boundsForPoints(startInDocument, endInDocument),
        });
      }
      if (input.type === 'group') {
        visit(input.children, childContainerToDocument(input, containerToDocument));
      }
    }
  };
  visit(elements, IDENTITY_TRANSFORM);
  return geometries;
};

export const connectorFallbackBounds = (input: ConnectorElement): ConnectorGeometryBounds => {
  const connector = canonicalizeConnectorGeometry(input);
  return {
    left: Math.min(connector.start.xPt, connector.end.xPt),
    top: Math.min(connector.start.yPt, connector.end.yPt),
    right: Math.max(connector.start.xPt, connector.end.xPt),
    bottom: Math.max(connector.start.yPt, connector.end.yPt),
  };
};
