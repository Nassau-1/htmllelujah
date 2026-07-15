import type { ReactElement } from 'react';

import type { Frame, PageSize } from './types.js';
import { finiteOr, formatNumber, safeDomId } from './utils.js';

export interface OverlaySelection {
  readonly id: string;
  readonly frame: Frame;
  readonly primary?: boolean | undefined;
}

export interface AxisOverlayGuide {
  readonly axis: 'x' | 'y';
  readonly positionPt: number;
}

export interface DocumentOverlayGuide {
  readonly id?: string | undefined;
  readonly orientation: 'horizontal' | 'vertical';
  readonly positionPt: number;
}

export type OverlayGuide = AxisOverlayGuide | DocumentOverlayGuide;

export interface EditorOverlayProps {
  readonly page: PageSize;
  readonly selections: readonly OverlaySelection[];
  readonly guides?: readonly OverlayGuide[] | undefined;
  readonly handleSizePt?: number | undefined;
}

const selectionHandles = (frame: Frame): readonly Readonly<{ x: number; y: number }>[] => {
  const left = finiteOr(frame.xPt, 0);
  const top = finiteOr(frame.yPt, 0);
  const right = left + Math.max(0, finiteOr(frame.widthPt, 0));
  const bottom = top + Math.max(0, finiteOr(frame.heightPt, 0));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return [
    { x: left, y: top },
    { x: centerX, y: top },
    { x: right, y: top },
    { x: right, y: centerY },
    { x: right, y: bottom },
    { x: centerX, y: bottom },
    { x: left, y: bottom },
    { x: left, y: centerY },
  ];
};

export const EditorOverlay = ({
  page,
  selections,
  guides = [],
  handleSizePt = 6,
}: EditorOverlayProps): ReactElement => {
  const width = Math.max(0.001, finiteOr(page.widthPt, 0.001));
  const height = Math.max(0.001, finiteOr(page.heightPt, 0.001));
  const handleSize = Math.max(1, finiteOr(handleSizePt, 6));
  return (
    <svg
      className="hl-editor-overlay"
      data-editor-overlay="true"
      viewBox={`0 0 ${formatNumber(width)} ${formatNumber(height)}`}
      aria-hidden="true"
      focusable="false"
    >
      {guides.map((guide, index) => {
        const position = finiteOr(guide.positionPt, 0);
        const axis = 'axis' in guide ? guide.axis : guide.orientation === 'vertical' ? 'x' : 'y';
        const key = 'id' in guide && guide.id !== undefined ? guide.id : `${axis}-${index}`;
        return axis === 'x' ? (
          <line
            key={`guide-${key}`}
            className="hl-smart-guide"
            data-guide-axis="x"
            x1={formatNumber(position)}
            x2={formatNumber(position)}
            y1="0"
            y2={formatNumber(height)}
          />
        ) : (
          <line
            key={`guide-${key}`}
            className="hl-smart-guide"
            data-guide-axis="y"
            x1="0"
            x2={formatNumber(width)}
            y1={formatNumber(position)}
            y2={formatNumber(position)}
          />
        );
      })}
      {selections.map((selection) => {
        const frame = selection.frame;
        const x = finiteOr(frame.xPt, 0);
        const y = finiteOr(frame.yPt, 0);
        const frameWidth = Math.max(0, finiteOr(frame.widthPt, 0));
        const frameHeight = Math.max(0, finiteOr(frame.heightPt, 0));
        const centerX = x + frameWidth / 2;
        const centerY = y + frameHeight / 2;
        const transform = `rotate(${formatNumber(frame.rotationDeg)} ${formatNumber(centerX)} ${formatNumber(centerY)})`;
        return (
          <g
            key={selection.id}
            data-selection-id={selection.id}
            data-selection-primary={selection.primary === true ? 'true' : undefined}
            transform={transform}
          >
            <rect
              id={`hl-selection-${safeDomId(selection.id)}`}
              className="hl-selection-outline"
              x={formatNumber(x)}
              y={formatNumber(y)}
              width={formatNumber(frameWidth)}
              height={formatNumber(frameHeight)}
              strokeWidth="1"
            />
            {selection.primary === true
              ? selectionHandles(frame).map((handle, index) => (
                  <rect
                    key={`handle-${index}`}
                    className="hl-selection-handle"
                    data-handle-index={index}
                    x={formatNumber(handle.x - handleSize / 2)}
                    y={formatNumber(handle.y - handleSize / 2)}
                    width={formatNumber(handleSize)}
                    height={formatNumber(handleSize)}
                    rx={formatNumber(Math.min(1.5, handleSize / 4))}
                    strokeWidth="1"
                  />
                ))
              : null}
          </g>
        );
      })}
    </svg>
  );
};
