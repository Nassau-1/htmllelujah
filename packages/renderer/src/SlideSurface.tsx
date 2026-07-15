import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react';

import { LocalIcon } from './icons.js';
import { normalizeResolvedSlide } from './projection.js';
import type {
  AssetResolver,
  ConnectorElement,
  GroupElement,
  ImageElement,
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

const safeFontFamily = (value: string, fallback: string): string =>
  /^[a-z0-9 ,"'-]{1,160}$/i.test(value.trim()) ? value.trim() : fallback;

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

const resolveTextStyle = (element: TextElement, theme: RenderTheme): TextStyle => {
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
        { key, className: 'hl-text-block', style: { textAlign: block.alignment } },
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
  return (
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
      }}
    />
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

const shadowFilter = (element: ShapeElement): string | undefined => {
  if (element.shadow === undefined || safeOpacity(element.shadow.opacity) === 0) return undefined;
  return `drop-shadow(${formatPoint(element.shadow.offsetXPt)} ${formatPoint(element.shadow.offsetYPt)} ${formatPoint(Math.max(0, element.shadow.blurPt))} ${safeColor(element.shadow.color, '#000000')})`;
};

const ShapeContent = ({ element }: { element: ShapeElement }): ReactElement => {
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
  if (element.shape === 'ellipse') {
    shape = <ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} {...common} />;
  } else if (element.shape === 'triangle') {
    shape = <polygon points={`${width / 2},0 ${width},${height} 0,${height}`} {...common} />;
  } else if (element.shape === 'diamond') {
    shape = (
      <polygon
        points={`${width / 2},0 ${width},${height / 2} ${width / 2},${height} 0,${height / 2}`}
        {...common}
      />
    );
  } else if (element.shape === 'line' || element.shape === 'arrow') {
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
  } else {
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
  }
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
      {element.shape === 'arrow' ? <defs>{marker(markerId, stroke, false)}</defs> : null}
      {shape}
    </svg>
  );
};

const ConnectorContent = ({
  element,
  pageWidthPt,
  pageHeightPt,
  zIndex,
}: {
  element: ConnectorElement;
  pageWidthPt: number;
  pageHeightPt: number;
  zIndex: number;
}): ReactElement => {
  const stroke = safeColor(element.stroke.color, '#000000');
  const strokeWidth = Math.max(0, finiteOr(element.stroke.widthPt, 0));
  const startId = `hl-start-${safeDomId(element.id)}`;
  const endId = `hl-end-${safeDomId(element.id)}`;
  const midpointX = (element.start.xPt + element.end.xPt) / 2;
  const path =
    element.routing === 'elbow'
      ? `M ${formatNumber(element.start.xPt)} ${formatNumber(element.start.yPt)} L ${formatNumber(midpointX)} ${formatNumber(element.start.yPt)} L ${formatNumber(midpointX)} ${formatNumber(element.end.yPt)} L ${formatNumber(element.end.xPt)} ${formatNumber(element.end.yPt)}`
      : `M ${formatNumber(element.start.xPt)} ${formatNumber(element.start.yPt)} L ${formatNumber(element.end.xPt)} ${formatNumber(element.end.yPt)}`;
  const centerX = element.frame.xPt + element.frame.widthPt / 2;
  const centerY = element.frame.yPt + element.frame.heightPt / 2;
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
        transform={`rotate(${formatNumber(element.frame.rotationDeg)} ${formatNumber(centerX)} ${formatNumber(centerY)})`}
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
}

const GroupContent = ({
  element,
  mode,
  theme,
  resolveAsset,
}: {
  element: GroupElement;
  mode: RenderMode;
  theme: RenderTheme;
  resolveAsset?: AssetResolver | undefined;
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
      />
    );
  }
  const classNames = ['hl-element', `hl-${element.type}`];
  if (element.type === 'shape') classNames.push('hl-vector-element');
  const style = elementFrameStyle(element.frame, element.opacity, zIndex);
  let content: ReactNode;
  if (element.type === 'text') content = <TextContent element={element} theme={theme} />;
  else if (element.type === 'image') {
    content = <ImageContent element={element} resolveAsset={resolveAsset} />;
  } else if (element.type === 'table') {
    content = <TableContent element={element} theme={theme} />;
  } else if (element.type === 'shape') content = <ShapeContent element={element} />;
  else if (element.type === 'icon') {
    content = (
      <LocalIcon iconSet={element.iconSet} iconName={element.iconName} color={element.color} />
    );
  } else if (element.type === 'group') {
    content = (
      <GroupContent element={element} mode={mode} theme={theme} resolveAsset={resolveAsset} />
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
        />
      ))}
    </section>
  );
};
