import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { computeConnectorRoute } from '@htmllelujah/geometry';

import { LocalIcon } from './icons.js';
import { normalizeResolvedSlide } from './projection.js';
import type {
  AssetResolver,
  ConnectorElement,
  GroupElement,
  ImageElement,
  PathElement,
  RenderElement,
  RenderMode,
  RenderTheme,
  ResolvedSlideInput,
  RichTextDocument,
  ShapeElement,
  TableElement,
  TextElement,
  TextMarks,
  TextRun,
  TextStyle,
} from './types.js';
import {
  elementFrameStyle,
  finiteOr,
  formatNumber,
  formatPoint,
  safeAssetFromResolver,
  safeColor,
  safeDomId,
  safeOpacity,
  strokeDashArray,
} from './utils.js';

export interface SlideSurfaceProps {
  readonly slide: ResolvedSlideInput;
  readonly mode: RenderMode;
  readonly resolveAsset?: AssetResolver | undefined;
  readonly className?: string | undefined;
}

/** Effective connector geometry for editor hit-testing and overlays. */
export interface ResolvedConnectorGeometry {
  readonly connectorId: string;
  readonly startInContainer: Readonly<{ xPt: number; yPt: number }>;
  readonly endInContainer: Readonly<{ xPt: number; yPt: number }>;
  readonly startInSlide: Readonly<{ xPt: number; yPt: number }>;
  readonly endInSlide: Readonly<{ xPt: number; yPt: number }>;
  readonly boundsInSlide: Readonly<{
    xPt: number;
    yPt: number;
    widthPt: number;
    heightPt: number;
  }>;
}

const safeFontFamily = (value: string, fallback: string): string =>
  /^[a-z0-9 ,"'-]{1,160}$/i.test(value.trim()) ? value.trim() : fallback;

type ConnectorAnchor = NonNullable<ConnectorElement['start']['binding']['anchor']>;

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

type AnchorPoints = Readonly<Record<ConnectorAnchor, Point>>;

const IDENTITY_TRANSFORM: AffineTransform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

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

const normalizeGeometryCoordinate = (value: number): number => {
  const rounded = Math.round(finiteOr(value, 0) * 1e10) / 1e10;
  return Math.abs(rounded) < 1e-10 ? 0 : rounded;
};

const normalizeGeometryPoint = (point: Point): Point => ({
  xPt: normalizeGeometryCoordinate(point.xPt),
  yPt: normalizeGeometryCoordinate(point.yPt),
});

const frameTransform = (frame: RenderElement['frame']): AffineTransform => {
  const radians = (finiteOr(frame.rotationDeg, 0) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const xPt = finiteOr(frame.xPt, 0);
  const yPt = finiteOr(frame.yPt, 0);
  const centerX = Math.max(0, finiteOr(frame.widthPt, 0)) / 2;
  const centerY = Math.max(0, finiteOr(frame.heightPt, 0)) / 2;
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: xPt + centerX - cosine * centerX + sine * centerY,
    f: yPt + centerY - sine * centerX - cosine * centerY,
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

const anchorPointsForElement = (
  element: RenderElement,
  containerToSlide: AffineTransform,
): AnchorPoints => {
  const elementToSlide = composeTransforms(containerToSlide, frameTransform(element.frame));
  const width = Math.max(0, finiteOr(element.frame.widthPt, 0));
  const height = Math.max(0, finiteOr(element.frame.heightPt, 0));
  return {
    top: applyTransform(elementToSlide, { xPt: width / 2, yPt: 0 }),
    right: applyTransform(elementToSlide, { xPt: width, yPt: height / 2 }),
    bottom: applyTransform(elementToSlide, { xPt: width / 2, yPt: height }),
    left: applyTransform(elementToSlide, { xPt: 0, yPt: height / 2 }),
    center: applyTransform(elementToSlide, { xPt: width / 2, yPt: height / 2 }),
  };
};

const childContainerToSlide = (
  group: GroupElement,
  containerToSlide: AffineTransform,
): AffineTransform => {
  const coordinateWidth = Math.max(0.001, finiteOr(group.coordinateSpace.widthPt, 0.001));
  const coordinateHeight = Math.max(0.001, finiteOr(group.coordinateSpace.heightPt, 0.001));
  const frameWidth = Math.max(0, finiteOr(group.frame.widthPt, 0));
  const frameHeight = Math.max(0, finiteOr(group.frame.heightPt, 0));
  const groupToContainer = composeTransforms(
    frameTransform(group.frame),
    scaleTransform(frameWidth / coordinateWidth, frameHeight / coordinateHeight),
  );
  return composeTransforms(containerToSlide, groupToContainer);
};

const buildAnchorIndex = (
  elements: readonly RenderElement[],
): ReadonlyMap<string, AnchorPoints> => {
  const anchors = new Map<string, AnchorPoints>();
  const visit = (current: readonly RenderElement[], containerToSlide: AffineTransform): void => {
    for (const element of current) {
      anchors.set(element.id, anchorPointsForElement(element, containerToSlide));
      if (element.type === 'group') {
        visit(element.children, childContainerToSlide(element, containerToSlide));
      }
    }
  };
  visit(elements, IDENTITY_TRANSFORM);
  return anchors;
};

const resolveConnectorEndpoint = (
  endpoint: ConnectorElement['start'],
  anchors: ReadonlyMap<string, AnchorPoints>,
  containerToSlide: AffineTransform,
): Point => {
  const targetId = endpoint.binding.elementId;
  if (targetId === undefined) return endpoint;
  const target = anchors.get(targetId);
  const inverse = inverseTransform(containerToSlide);
  if (target === undefined || inverse === undefined) return endpoint;
  return applyTransform(inverse, target[endpoint.binding.anchor ?? 'center']);
};

const buildConnectorGeometryIndex = (
  elements: readonly RenderElement[],
  anchors = buildAnchorIndex(elements),
): ReadonlyMap<string, ResolvedConnectorGeometry> => {
  const geometries = new Map<string, ResolvedConnectorGeometry>();
  const visit = (current: readonly RenderElement[], containerToSlide: AffineTransform): void => {
    for (const element of current) {
      if (element.type === 'connector') {
        const startInContainer = normalizeGeometryPoint(
          resolveConnectorEndpoint(element.start, anchors, containerToSlide),
        );
        const endInContainer = normalizeGeometryPoint(
          resolveConnectorEndpoint(element.end, anchors, containerToSlide),
        );
        const startInSlide = normalizeGeometryPoint(
          applyTransform(containerToSlide, startInContainer),
        );
        const endInSlide = normalizeGeometryPoint(applyTransform(containerToSlide, endInContainer));
        geometries.set(element.id, {
          connectorId: element.id,
          startInContainer,
          endInContainer,
          startInSlide,
          endInSlide,
          boundsInSlide: {
            xPt: Math.min(startInSlide.xPt, endInSlide.xPt),
            yPt: Math.min(startInSlide.yPt, endInSlide.yPt),
            widthPt: Math.abs(endInSlide.xPt - startInSlide.xPt),
            heightPt: Math.abs(endInSlide.yPt - startInSlide.yPt),
          },
        });
      }
      if (element.type === 'group') {
        visit(element.children, childContainerToSlide(element, containerToSlide));
      }
    }
  };
  visit(elements, IDENTITY_TRANSFORM);
  return geometries;
};

/** Resolves every connector in one traversal, sharing the same anchor index. */
export const resolveConnectorGeometries = (
  elements: readonly RenderElement[],
): ReadonlyMap<string, ResolvedConnectorGeometry> => buildConnectorGeometryIndex(elements);

/** Compatibility helper for callers resolving a single connector. */
export const resolveConnectorGeometry = (
  elements: readonly RenderElement[],
  connectorId: string,
): ResolvedConnectorGeometry | undefined => resolveConnectorGeometries(elements).get(connectorId);

const defaultTextStyle = (role: TextElement['styleRole'], theme: RenderTheme): TextStyle => ({
  role,
  fontFamily:
    role === 'title' || role === 'subtitle' ? theme.headingFontFamily : theme.bodyFontFamily,
  fontSizePt: role === 'title' ? 32 : role === 'subtitle' ? 22 : role === 'caption' ? 10 : 16,
  fontWeight: role === 'title' ? 700 : role === 'subtitle' ? 600 : 400,
  italic: false,
  color: role === 'caption' ? theme.colors.mutedText : theme.colors.text,
  alignment: 'left',
  lineHeight: 1.2,
  letterSpacingPt: 0,
});

type TextStyleSource = Pick<TextElement, 'styleRole' | 'style'>;

const resolveTextStyle = (element: TextStyleSource, theme: RenderTheme): TextStyle => {
  const inherited =
    theme.textStyles.find((candidate) => candidate.role === element.styleRole) ??
    defaultTextStyle(element.styleRole, theme);
  return {
    role: element.styleRole,
    fontFamily: safeFontFamily(
      element.style?.fontFamily ?? inherited.fontFamily,
      safeFontFamily(theme.bodyFontFamily, 'sans-serif'),
    ),
    fontSizePt: Math.max(1, finiteOr(element.style?.fontSizePt ?? inherited.fontSizePt, 16)),
    fontWeight: Math.min(
      1_000,
      Math.max(1, Math.round(finiteOr(element.style?.fontWeight ?? inherited.fontWeight, 400))),
    ),
    italic: element.style?.italic ?? inherited.italic,
    color: safeColor(element.style?.color ?? inherited.color, theme.colors.text),
    alignment: element.style?.alignment ?? inherited.alignment,
    lineHeight: Math.max(0.5, finiteOr(element.style?.lineHeight ?? inherited.lineHeight, 1.2)),
    letterSpacingPt: finiteOr(element.style?.letterSpacingPt ?? inherited.letterSpacingPt ?? 0, 0),
  };
};

const marksStyle = (marks: TextMarks): CSSProperties => {
  const decorations = [
    marks.underline ? 'underline' : '',
    marks.strikethrough ? 'line-through' : '',
  ].filter(Boolean);
  return {
    fontFamily:
      marks.fontFamily === undefined ? undefined : safeFontFamily(marks.fontFamily, 'inherit'),
    fontSize:
      marks.fontSizePt === undefined
        ? undefined
        : formatPoint(Math.max(1, finiteOr(marks.fontSizePt, 1))),
    fontWeight:
      marks.fontWeight === undefined
        ? marks.bold
          ? 700
          : undefined
        : Math.min(1_000, Math.max(1, Math.round(finiteOr(marks.fontWeight, 400)))),
    fontStyle: marks.italic ? 'italic' : undefined,
    color: marks.color === undefined ? undefined : safeColor(marks.color, 'inherit'),
    textDecoration: decorations.length === 0 ? undefined : decorations.join(' '),
  };
};

const renderRuns = (runs: readonly TextRun[], keyPrefix: string): ReactNode =>
  runs.map((run, index) => (
    <span key={`${keyPrefix}-run-${index}`} style={marksStyle(run.marks)}>
      {run.text}
    </span>
  ));

const semanticHeadingStyle = (textAlign: TextStyle['alignment']): CSSProperties => ({
  // Keep the semantic heading level in the accessibility tree without letting
  // the browser's h1-h6 user-agent stylesheet change slide geometry.
  fontFamily: 'inherit',
  fontSize: 'inherit',
  fontStyle: 'inherit',
  fontWeight: 'inherit',
  letterSpacing: 'inherit',
  lineHeight: 'inherit',
  margin: '0 0 0.35em',
  textAlign,
});

const renderRichText = (
  content: RichTextDocument,
  keyPrefix: string,
  defaultAlignment: TextStyle['alignment'],
): ReactNode =>
  content.blocks.map((block, blockIndex) => {
    const key = `${keyPrefix}-block-${block.id || blockIndex}`;
    if (block.type === 'paragraph') {
      return (
        <p key={key} className="hl-text-block" style={{ textAlign: block.alignment }}>
          {renderRuns(block.runs, key)}
        </p>
      );
    }
    if (block.type === 'heading') {
      return createElement(
        `h${block.level}`,
        { key, className: 'hl-text-block', style: semanticHeadingStyle(block.alignment) },
        renderRuns(block.runs, key),
      );
    }
    const List = block.ordered ? 'ol' : 'ul';
    return (
      <List key={key} className="hl-list" style={{ textAlign: defaultAlignment }}>
        {block.items.map((listItem, itemIndex) => (
          <li
            key={`${key}-item-${listItem.id || itemIndex}`}
            className="hl-list-item"
            style={{
              marginInlineStart: `${Math.min(20, Math.max(0, finiteOr(listItem.level, 0))) * 1.15}em`,
            }}
          >
            {renderRuns(listItem.runs, `${key}-item-${itemIndex}`)}
          </li>
        ))}
      </List>
    );
  });

const TextContent = ({
  element,
  theme,
}: {
  element: TextElement;
  theme: RenderTheme;
}): ReactElement => {
  const textStyle = resolveTextStyle(element, theme);
  const verticalAlignment =
    element.verticalAlignment === 'middle'
      ? 'center'
      : element.verticalAlignment === 'bottom'
        ? 'flex-end'
        : 'flex-start';
  return (
    <div
      className="hl-text-content"
      lang={element.locale}
      style={{
        alignSelf: verticalAlignment,
        fontFamily: textStyle.fontFamily,
        fontSize: formatPoint(textStyle.fontSizePt),
        fontWeight: textStyle.fontWeight,
        fontStyle: (element.style?.italic ?? textStyle.italic) ? 'italic' : 'normal',
        color: textStyle.color,
        lineHeight: textStyle.lineHeight,
        letterSpacing: formatPoint(textStyle.letterSpacingPt ?? 0),
        textAlign: textStyle.alignment,
      }}
    >
      {renderRichText(element.content, element.id, textStyle.alignment)}
    </div>
  );
};

const ImageContent = ({
  element,
  resolveAsset,
}: {
  element: ImageElement;
  resolveAsset?: AssetResolver | undefined;
}): ReactElement => {
  const source = safeAssetFromResolver(resolveAsset, element.assetId);
  if (source === null) {
    return (
      <span className="hl-missing-asset" data-render-warning="ASSET_UNAVAILABLE">
        Image unavailable
      </span>
    );
  }
  const normalizeCropAxis = (
    startInput: number,
    endInput: number,
  ): Readonly<{ start: number; remaining: number }> => {
    let start = Math.min(0.99, Math.max(0, finiteOr(startInput, 0)));
    let end = Math.min(0.99, Math.max(0, finiteOr(endInput, 0)));
    const total = start + end;
    if (total > 0.99) {
      const ratio = 0.99 / total;
      start *= ratio;
      end *= ratio;
    }
    return { start, remaining: 1 - start - end };
  };
  const horizontalCrop = normalizeCropAxis(element.crop.left, element.crop.right);
  const verticalCrop = normalizeCropAxis(element.crop.top, element.crop.bottom);
  const colorKeyFilterId =
    element.colorKey === undefined ? undefined : `hl-color-key-${safeDomId(element.id)}`;
  const tolerance =
    element.colorKey === undefined
      ? 0
      : Math.min(255, Math.max(0, finiteOr(element.colorKey.tolerance, 0))) / 255;
  const maskSlope = 255 / 4;
  const maskIntercept = -tolerance * maskSlope;
  return (
    <>
      {element.colorKey === undefined || colorKeyFilterId === undefined ? null : (
        <svg
          width="0"
          height="0"
          aria-hidden="true"
          focusable="false"
          style={{ position: 'absolute' }}
        >
          <defs>
            <filter id={colorKeyFilterId} colorInterpolationFilters="sRGB">
              <feFlood
                floodColor={safeColor(element.colorKey.color, '#ffffff')}
                result="key-color"
              />
              <feComposite
                in="SourceGraphic"
                in2="key-color"
                operator="arithmetic"
                k2="1"
                k3="-1"
                result="positive-difference"
              />
              <feComposite
                in="key-color"
                in2="SourceGraphic"
                operator="arithmetic"
                k2="1"
                k3="-1"
                result="negative-difference"
              />
              <feBlend
                in="positive-difference"
                in2="negative-difference"
                mode="lighten"
                result="absolute-difference"
              />
              <feColorMatrix
                in="absolute-difference"
                type="matrix"
                values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.333333 0.333333 0.333333 0 0"
                result="distance-mask"
              />
              <feComponentTransfer in="distance-mask" result="threshold-mask">
                <feFuncA
                  type="linear"
                  slope={formatNumber(maskSlope)}
                  intercept={formatNumber(maskIntercept)}
                />
              </feComponentTransfer>
              <feComposite in="SourceGraphic" in2="threshold-mask" operator="in" />
            </filter>
          </defs>
        </svg>
      )}
      <img
        src={source}
        alt={element.altText}
        draggable={false}
        decoding="async"
        style={{
          position: 'absolute',
          left: `${formatNumber((-horizontalCrop.start / horizontalCrop.remaining) * 100)}%`,
          top: `${formatNumber((-verticalCrop.start / verticalCrop.remaining) * 100)}%`,
          width: `${formatNumber(100 / horizontalCrop.remaining)}%`,
          height: `${formatNumber(100 / verticalCrop.remaining)}%`,
          objectFit: element.fit,
          objectPosition: 'center center',
          filter: colorKeyFilterId === undefined ? undefined : `url(#${colorKeyFilterId})`,
        }}
      />
    </>
  );
};

const tableCellBackground = (
  element: TableElement,
  row: number,
  ownFill: string | null,
): string => {
  if (ownFill !== null) return safeColor(ownFill);
  if (row === 0 && element.style?.headerFill !== undefined && element.style.headerFill !== null) {
    return safeColor(element.style.headerFill);
  }
  if ((element.style?.bandedRows ?? false) && row % 2 === 1) return 'rgb(0 0 0 / 4%)';
  return safeColor(element.style?.fill, 'transparent');
};

const TableContent = ({
  element,
  theme,
}: {
  element: TableElement;
  theme: RenderTheme;
}): ReactElement => {
  const bodyStyle =
    theme.textStyles.find((style) => style.role === 'body') ?? defaultTextStyle('body', theme);
  return (
    <table
      aria-label={element.name}
      style={{
        fontFamily: safeFontFamily(bodyStyle.fontFamily, 'sans-serif'),
        fontSize: formatPoint(Math.max(1, finiteOr(bodyStyle.fontSizePt, 16))),
        fontWeight: Math.min(1_000, Math.max(1, finiteOr(bodyStyle.fontWeight, 400))),
        fontStyle: bodyStyle.italic ? 'italic' : 'normal',
        lineHeight: Math.max(0.5, finiteOr(bodyStyle.lineHeight, 1.2)),
      }}
    >
      <colgroup>
        {element.columnWidthsPt.map((widthPt, index) => (
          <col key={`column-${index}`} style={{ width: formatPoint(Math.max(0, widthPt)) }} />
        ))}
      </colgroup>
      <tbody>
        {Array.from({ length: Math.max(0, element.rowCount) }, (_, row) => (
          <tr
            key={`row-${row}`}
            style={{ height: formatPoint(Math.max(0, element.rowHeightsPt[row] ?? 0)) }}
          >
            {element.cells
              .filter((cell) => cell.row === row)
              .toSorted((left, right) => {
                const columnOrder = left.column - right.column;
                if (columnOrder !== 0) return columnOrder;
                return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
              })
              .map((cell) => {
                const Cell = row === 0 ? 'th' : 'td';
                const paddingPt = cell.style.paddingPt ?? element.style?.cellPaddingPt ?? 4;
                return (
                  <Cell
                    key={cell.id}
                    scope={row === 0 ? 'col' : undefined}
                    rowSpan={Math.max(1, cell.rowSpan)}
                    colSpan={Math.max(1, cell.columnSpan)}
                    style={{
                      padding: formatPoint(Math.max(0, paddingPt)),
                      border: `${formatPoint(Math.max(0, element.border.widthPt))} solid ${safeColor(element.border.color, '#000000')}`,
                      background: tableCellBackground(element, row, cell.style.fill),
                      color: safeColor(cell.style.textColor, '#172033'),
                      textAlign: cell.style.horizontalAlignment,
                      verticalAlign: cell.style.verticalAlignment,
                    }}
                  >
                    {renderRichText(cell.content, cell.id, cell.style.horizontalAlignment)}
                  </Cell>
                );
              })}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const marker = (id: string, color: string, reverse: boolean): ReactElement => (
  <marker
    id={id}
    viewBox="0 0 10 10"
    refX="9"
    refY="5"
    markerWidth="6"
    markerHeight="6"
    orient={reverse ? 'auto-start-reverse' : 'auto'}
  >
    <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
  </marker>
);

const colorWithOpacity = (value: string, opacity: number): string => {
  const color = safeColor(value, '#000000');
  const alpha = safeOpacity(opacity);
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return `${color}${Math.round(alpha * 255)
      .toString(16)
      .padStart(2, '0')}`;
  }
  if (/^#[0-9a-f]{8}$/i.test(color)) {
    const existing = Number.parseInt(color.slice(7, 9), 16) / 255;
    return `${color.slice(0, 7)}${Math.round(existing * alpha * 255)
      .toString(16)
      .padStart(2, '0')}`;
  }
  return color;
};

const shadowFilter = (element: ShapeElement | PathElement): string | undefined => {
  if (element.shadow === undefined || safeOpacity(element.shadow.opacity) === 0) return undefined;
  return `drop-shadow(${formatPoint(element.shadow.offsetXPt)} ${formatPoint(element.shadow.offsetYPt)} ${formatPoint(Math.max(0, element.shadow.blurPt))} ${colorWithOpacity(element.shadow.color, element.shadow.opacity)})`;
};

const polygonPoints = (points: readonly (readonly [number, number])[]): string =>
  points.map(([xPt, yPt]) => `${formatNumber(xPt)},${formatNumber(yPt)}`).join(' ');

const MAX_RENDERED_SHAPE_TEXT_MARGIN_PT = 1_000;

const shapeCanRenderText = (element: ShapeElement): boolean =>
  element.text !== undefined && !['line', 'arrow', 'arc'].includes(element.shape);

const renderedShapeTextMargin = (value: number): number =>
  Math.min(MAX_RENDERED_SHAPE_TEXT_MARGIN_PT, Math.max(0, finiteOr(value, 0)));

const ShapeTextContent = ({
  element,
  theme,
}: {
  element: ShapeElement;
  theme: RenderTheme;
}): ReactElement | null => {
  if (!shapeCanRenderText(element) || element.text === undefined) return null;
  const shapeText = element.text;
  const textStyle = resolveTextStyle(shapeText, theme);
  const justifyContent =
    shapeText.verticalAlignment === 'middle'
      ? 'center'
      : shapeText.verticalAlignment === 'bottom'
        ? 'flex-end'
        : 'flex-start';
  return (
    <div
      className="hl-shape-text"
      lang={shapeText.locale}
      style={{
        justifyContent,
        padding: `${formatPoint(renderedShapeTextMargin(shapeText.margins.topPt))} ${formatPoint(renderedShapeTextMargin(shapeText.margins.rightPt))} ${formatPoint(renderedShapeTextMargin(shapeText.margins.bottomPt))} ${formatPoint(renderedShapeTextMargin(shapeText.margins.leftPt))}`,
        fontFamily: textStyle.fontFamily,
        fontSize: formatPoint(textStyle.fontSizePt),
        fontWeight: textStyle.fontWeight,
        fontStyle: textStyle.italic ? 'italic' : 'normal',
        color: textStyle.color,
        lineHeight: textStyle.lineHeight,
        letterSpacing: formatPoint(textStyle.letterSpacingPt ?? 0),
        textAlign: textStyle.alignment,
      }}
    >
      <div className="hl-text-content hl-shape-text-content">
        {renderRichText(shapeText.content, `${element.id}-text`, textStyle.alignment)}
      </div>
    </div>
  );
};

const ShapeContent = ({
  element,
  theme,
}: {
  element: ShapeElement;
  theme: RenderTheme;
}): ReactElement => {
  const width = Math.max(0.001, finiteOr(element.frame.widthPt, 0.001));
  const height = Math.max(0.001, finiteOr(element.frame.heightPt, 0.001));
  const stroke = safeColor(element.stroke.color, '#000000');
  const fill = element.fill === null ? 'none' : safeColor(element.fill);
  const strokeWidth = Math.max(0, finiteOr(element.stroke.widthPt, 0));
  const common = {
    fill,
    stroke,
    strokeWidth,
    strokeDasharray: strokeDashArray(element.stroke.dash, strokeWidth),
    vectorEffect: 'non-scaling-stroke' as const,
  };
  const markerId = `hl-arrow-${safeDomId(element.id)}`;
  let shape: ReactElement;
  switch (element.shape) {
    case 'rectangle':
    case 'rounded-rectangle':
      shape = (
        <rect
          x="0"
          y="0"
          width={width}
          height={height}
          rx={element.shape === 'rounded-rectangle' ? Math.max(0, element.cornerRadiusPt) : 0}
          {...common}
        />
      );
      break;
    case 'ellipse':
      shape = <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} {...common} />;
      break;
    case 'triangle':
      shape = (
        <polygon
          points={polygonPoints([
            [width / 2, 0],
            [width, height],
            [0, height],
          ])}
          {...common}
        />
      );
      break;
    case 'right-triangle':
      shape = (
        <polygon
          points={polygonPoints([
            [0, 0],
            [width, height],
            [0, height],
          ])}
          {...common}
        />
      );
      break;
    case 'diamond':
      shape = (
        <polygon
          points={polygonPoints([
            [width / 2, 0],
            [width, height / 2],
            [width / 2, height],
            [0, height / 2],
          ])}
          {...common}
        />
      );
      break;
    case 'parallelogram':
      shape = (
        <polygon
          points={polygonPoints([
            [width * 0.2, 0],
            [width, 0],
            [width * 0.8, height],
            [0, height],
          ])}
          {...common}
        />
      );
      break;
    case 'trapezoid':
      shape = (
        <polygon
          points={polygonPoints([
            [width * 0.2, 0],
            [width * 0.8, 0],
            [width, height],
            [0, height],
          ])}
          {...common}
        />
      );
      break;
    case 'pentagon':
      shape = (
        <polygon
          points={polygonPoints([
            [width * 0.5, 0],
            [width, height * 0.38],
            [width * 0.82, height],
            [width * 0.18, height],
            [0, height * 0.38],
          ])}
          {...common}
        />
      );
      break;
    case 'hexagon':
      shape = (
        <polygon
          points={polygonPoints([
            [width * 0.25, 0],
            [width * 0.75, 0],
            [width, height * 0.5],
            [width * 0.75, height],
            [width * 0.25, height],
            [0, height * 0.5],
          ])}
          {...common}
        />
      );
      break;
    case 'octagon':
      shape = (
        <polygon
          points={polygonPoints([
            [width * 0.292893, 0],
            [width * 0.707107, 0],
            [width, height * 0.292893],
            [width, height * 0.707107],
            [width * 0.707107, height],
            [width * 0.292893, height],
            [0, height * 0.707107],
            [0, height * 0.292893],
          ])}
          {...common}
        />
      );
      break;
    case 'chevron':
      shape = (
        <polygon
          points={polygonPoints([
            [0, 0],
            [width * 0.65, 0],
            [width, height * 0.5],
            [width * 0.65, height],
            [0, height],
            [width * 0.35, height * 0.5],
          ])}
          {...common}
        />
      );
      break;
    case 'cross':
      shape = (
        <polygon
          points={polygonPoints([
            [width / 3, 0],
            [(width * 2) / 3, 0],
            [(width * 2) / 3, height / 3],
            [width, height / 3],
            [width, (height * 2) / 3],
            [(width * 2) / 3, (height * 2) / 3],
            [(width * 2) / 3, height],
            [width / 3, height],
            [width / 3, (height * 2) / 3],
            [0, (height * 2) / 3],
            [0, height / 3],
            [width / 3, height / 3],
          ])}
          {...common}
        />
      );
      break;
    case 'donut': {
      const outer = [
        `M ${formatNumber(width)} ${formatNumber(height / 2)}`,
        `A ${formatNumber(width / 2)} ${formatNumber(height / 2)} 0 1 1 0 ${formatNumber(height / 2)}`,
        `A ${formatNumber(width / 2)} ${formatNumber(height / 2)} 0 1 1 ${formatNumber(width)} ${formatNumber(height / 2)}`,
        'Z',
      ];
      const inner = [
        `M ${formatNumber(width * 0.75)} ${formatNumber(height / 2)}`,
        `A ${formatNumber(width / 4)} ${formatNumber(height / 4)} 0 1 0 ${formatNumber(width * 0.25)} ${formatNumber(height / 2)}`,
        `A ${formatNumber(width / 4)} ${formatNumber(height / 4)} 0 1 0 ${formatNumber(width * 0.75)} ${formatNumber(height / 2)}`,
        'Z',
      ];
      shape = <path d={[...outer, ...inner].join(' ')} fillRule="evenodd" {...common} />;
      break;
    }
    case 'left-bracket':
      shape = (
        <path
          d={`M ${formatNumber(width)} 0 L 0 0 L 0 ${formatNumber(height)} L ${formatNumber(width)} ${formatNumber(height)}`}
          {...common}
          fill="none"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      );
      break;
    case 'right-bracket':
      shape = (
        <path
          d={`M 0 0 L ${formatNumber(width)} 0 L ${formatNumber(width)} ${formatNumber(height)} L 0 ${formatNumber(height)}`}
          {...common}
          fill="none"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      );
      break;
    case 'arc':
      shape = (
        <path
          d={`M 0 ${formatNumber(height)} A ${formatNumber(width / 2)} ${formatNumber(height)} 0 0 1 ${formatNumber(width)} ${formatNumber(height)}`}
          {...common}
          fill="none"
          strokeLinecap="round"
        />
      );
      break;
    case 'line':
    case 'arrow':
      shape = (
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          {...common}
          fill="none"
          markerEnd={element.shape === 'arrow' ? `url(#${markerId})` : undefined}
        />
      );
      break;
  }
  const hasText = shapeCanRenderText(element);
  return (
    <>
      <svg
        className="hl-vector hl-shape-geometry"
        viewBox={`0 0 ${formatNumber(width)} ${formatNumber(height)}`}
        width="100%"
        height="100%"
        aria-label={hasText ? undefined : element.name}
        aria-hidden={hasText ? true : undefined}
        role={hasText ? undefined : 'img'}
        style={{ filter: shadowFilter(element) }}
      >
        {element.shape === 'arrow' ? <defs>{marker(markerId, stroke, false)}</defs> : null}
        {shape}
      </svg>
      <ShapeTextContent element={element} theme={theme} />
    </>
  );
};

const MAX_RENDERED_PATH_COMMANDS = 4_096;

const PathContent = ({ element }: { element: PathElement }): ReactElement => {
  const width = Math.max(0.001, finiteOr(element.frame.widthPt, 0.001));
  const height = Math.max(0.001, finiteOr(element.frame.heightPt, 0.001));
  const coordinate = (value: number, maximum: number): string =>
    formatNumber(Math.min(maximum, Math.max(0, finiteOr(value, 0))));
  const commands = element.commands.slice(0, MAX_RENDERED_PATH_COMMANDS);
  const data = commands
    .map((command): string => {
      switch (command.type) {
        case 'move':
          return `M ${coordinate(command.xPt, width)} ${coordinate(command.yPt, height)}`;
        case 'line':
          return `L ${coordinate(command.xPt, width)} ${coordinate(command.yPt, height)}`;
        case 'cubic':
          return `C ${coordinate(command.control1XPt, width)} ${coordinate(command.control1YPt, height)} ${coordinate(command.control2XPt, width)} ${coordinate(command.control2YPt, height)} ${coordinate(command.xPt, width)} ${coordinate(command.yPt, height)}`;
        case 'close':
          return 'Z';
      }
    })
    .join(' ');
  const strokeWidth = Math.max(0, finiteOr(element.stroke.widthPt, 0));
  return (
    <svg
      className="hl-vector"
      viewBox={`0 0 ${formatNumber(width)} ${formatNumber(height)}`}
      width="100%"
      height="100%"
      aria-label={element.name}
      role="img"
      style={{ filter: shadowFilter(element) }}
    >
      <path
        d={data}
        fill={element.fill === null ? 'none' : safeColor(element.fill)}
        fillRule={element.fillRule}
        stroke={safeColor(element.stroke.color, '#000000')}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDashArray(element.stroke.dash, strokeWidth)}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

const ConnectorContent = ({
  element,
  pageWidthPt,
  pageHeightPt,
  zIndex,
  geometry,
}: {
  element: ConnectorElement;
  pageWidthPt: number;
  pageHeightPt: number;
  zIndex: number;
  geometry: ResolvedConnectorGeometry | undefined;
}): ReactElement => {
  const stroke = safeColor(element.stroke.color, '#000000');
  const strokeWidth = Math.max(0, finiteOr(element.stroke.widthPt, 0));
  const startId = `hl-start-${safeDomId(element.id)}`;
  const endId = `hl-end-${safeDomId(element.id)}`;
  const start = geometry?.startInContainer ?? element.start;
  const end = geometry?.endInContainer ?? element.end;
  const route = computeConnectorRoute({
    routing: element.routing,
    start: {
      xPt: start.xPt,
      yPt: start.yPt,
      binding: element.start.binding,
    },
    end: {
      xPt: end.xPt,
      yPt: end.yPt,
      binding: element.end.binding,
    },
  });
  const path = route.ok
    ? route.route.pathData
    : `M ${formatNumber(start.xPt)} ${formatNumber(start.yPt)} L ${formatNumber(end.xPt)} ${formatNumber(end.yPt)}`;
  return (
    <svg
      className="hl-element hl-connector"
      data-element-id={element.id}
      data-element-type="connector"
      viewBox={`0 0 ${formatNumber(pageWidthPt)} ${formatNumber(pageHeightPt)}`}
      width={formatPoint(pageWidthPt)}
      height={formatPoint(pageHeightPt)}
      style={{ position: 'absolute', inset: 0, opacity: safeOpacity(element.opacity), zIndex }}
      role="img"
      aria-label={element.name}
    >
      <defs>
        {element.startCap === 'arrow' ? marker(startId, stroke, true) : null}
        {element.endCap === 'arrow' ? marker(endId, stroke, false) : null}
      </defs>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDashArray(element.stroke.dash, strokeWidth)}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerStart={element.startCap === 'arrow' ? `url(#${startId})` : undefined}
        markerEnd={element.endCap === 'arrow' ? `url(#${endId})` : undefined}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

interface ElementRendererProps {
  readonly element: RenderElement;
  readonly mode: RenderMode;
  readonly theme: RenderTheme;
  readonly resolveAsset?: AssetResolver | undefined;
  readonly pageWidthPt: number;
  readonly pageHeightPt: number;
  readonly zIndex: number;
  readonly connectorGeometries: ReadonlyMap<string, ResolvedConnectorGeometry>;
  readonly containerToSlide: AffineTransform;
}

const GroupContent = ({
  element,
  mode,
  theme,
  resolveAsset,
  connectorGeometries,
  containerToSlide,
}: {
  element: GroupElement;
  mode: RenderMode;
  theme: RenderTheme;
  resolveAsset?: AssetResolver | undefined;
  connectorGeometries: ReadonlyMap<string, ResolvedConnectorGeometry>;
  containerToSlide: AffineTransform;
}): ReactElement => {
  const coordinateWidth = Math.max(0.001, finiteOr(element.coordinateSpace.widthPt, 0.001));
  const coordinateHeight = Math.max(0.001, finiteOr(element.coordinateSpace.heightPt, 0.001));
  const scaleX = Math.max(0, finiteOr(element.frame.widthPt, 0)) / coordinateWidth;
  const scaleY = Math.max(0, finiteOr(element.frame.heightPt, 0)) / coordinateHeight;
  return (
    <div
      className="hl-group-space"
      style={{
        width: formatPoint(coordinateWidth),
        height: formatPoint(coordinateHeight),
        transform: `scale(${formatNumber(scaleX)}, ${formatNumber(scaleY)})`,
      }}
    >
      {element.children.map((child, index) => (
        <ElementRenderer
          key={child.id}
          element={child}
          mode={mode}
          theme={theme}
          resolveAsset={resolveAsset}
          pageWidthPt={coordinateWidth}
          pageHeightPt={coordinateHeight}
          zIndex={index}
          connectorGeometries={connectorGeometries}
          containerToSlide={childContainerToSlide(element, containerToSlide)}
        />
      ))}
    </div>
  );
};

const ElementRenderer = ({
  element,
  mode,
  theme,
  resolveAsset,
  pageWidthPt,
  pageHeightPt,
  zIndex,
  connectorGeometries,
  containerToSlide,
}: ElementRendererProps): ReactElement | null => {
  if (!element.visible) return null;
  if (element.type === 'placeholder' && mode !== 'editor') return null;
  if (element.type === 'connector') {
    return (
      <ConnectorContent
        element={element}
        pageWidthPt={pageWidthPt}
        pageHeightPt={pageHeightPt}
        zIndex={zIndex}
        geometry={connectorGeometries.get(element.id)}
      />
    );
  }
  const classNames = ['hl-element', `hl-${element.type}`];
  if (element.type === 'shape' || element.type === 'path') classNames.push('hl-vector-element');
  const style = elementFrameStyle(element.frame, element.opacity, zIndex);
  let content: ReactNode;
  if (element.type === 'text') content = <TextContent element={element} theme={theme} />;
  else if (element.type === 'image') {
    content = <ImageContent element={element} resolveAsset={resolveAsset} />;
  } else if (element.type === 'table') {
    content = <TableContent element={element} theme={theme} />;
  } else if (element.type === 'shape') {
    content = <ShapeContent element={element} theme={theme} />;
  } else if (element.type === 'path') content = <PathContent element={element} />;
  else if (element.type === 'icon') {
    content = (
      <LocalIcon iconSet={element.iconSet} iconName={element.iconName} color={element.color} />
    );
  } else if (element.type === 'group') {
    content = (
      <GroupContent
        element={element}
        mode={mode}
        theme={theme}
        resolveAsset={resolveAsset}
        connectorGeometries={connectorGeometries}
        containerToSlide={containerToSlide}
      />
    );
  } else {
    content = (
      <span>
        {element.prompt}
        {element.accepts.length > 0 ? ` (${element.accepts.join(', ')})` : ''}
      </span>
    );
  }
  return (
    <div
      className={classNames.join(' ')}
      data-element-id={element.id}
      data-element-type={element.type}
      data-locked={mode === 'editor' && element.locked ? 'true' : undefined}
      style={style}
    >
      {content}
    </div>
  );
};

export const SlideSurface = ({
  slide: inputSlide,
  mode,
  resolveAsset,
  className,
}: SlideSurfaceProps): ReactElement => {
  const slide = normalizeResolvedSlide(inputSlide);
  const connectorGeometries = resolveConnectorGeometries(slide.elements);
  const pageWidthPt = Math.max(0.001, finiteOr(slide.page.widthPt, 0.001));
  const pageHeightPt = Math.max(0.001, finiteOr(slide.page.heightPt, 0.001));
  const backgroundSource =
    slide.background.type === 'image'
      ? safeAssetFromResolver(resolveAsset, slide.background.assetId)
      : null;
  const backgroundColor =
    slide.background.type === 'solid'
      ? safeColor(slide.background.color, slide.theme.colors.background)
      : safeColor(slide.theme.colors.background, '#ffffff');
  const surfaceStyle = {
    '--hl-slide-background': backgroundColor,
    '--hl-slide-text': safeColor(slide.theme.colors.text, '#172033'),
    width: formatPoint(pageWidthPt),
    height: formatPoint(pageHeightPt),
  } as CSSProperties;
  return (
    <section
      className={`hl-slide-surface hl-mode-${mode}${className ? ` ${className}` : ''}`}
      data-render-mode={mode}
      data-slide-id={slide.id}
      data-page-width-pt={formatNumber(pageWidthPt)}
      data-page-height-pt={formatNumber(pageHeightPt)}
      data-render-warning={
        slide.background.type === 'image' && backgroundSource === null
          ? 'ASSET_UNAVAILABLE'
          : undefined
      }
      aria-label={slide.name}
      style={surfaceStyle}
    >
      {backgroundSource !== null ? (
        <img
          className="hl-slide-background-image"
          src={backgroundSource}
          alt=""
          aria-hidden="true"
          draggable={false}
          decoding="async"
          style={{
            objectFit: slide.background.type === 'image' ? slide.background.fit : 'cover',
            opacity:
              slide.background.type === 'image' ? safeOpacity(slide.background.opacity) : undefined,
          }}
        />
      ) : null}
      {slide.elements.map((element, index) => (
        <ElementRenderer
          key={element.id}
          element={element}
          mode={mode}
          theme={slide.theme}
          resolveAsset={resolveAsset}
          pageWidthPt={pageWidthPt}
          pageHeightPt={pageHeightPt}
          zIndex={index}
          connectorGeometries={connectorGeometries}
          containerToSlide={IDENTITY_TRANSFORM}
        />
      ))}
    </section>
  );
};
