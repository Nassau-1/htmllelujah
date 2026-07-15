import { ImageIcon, TableProperties } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { clamp, moveWithSmartGuides, roundGeometry } from '../editor/geometry';
import { SLIDE_HEIGHT, SLIDE_WIDTH, type SlideElement, type SmartGuides } from '../editor/model';

type SlideCanvasProps = {
  elements: SlideElement[];
  selectedIds: string[];
  editingId: string | null;
  scale: number;
  gridEnabled: boolean;
  onSelect: (ids: string[]) => void;
  onEditStart: (id: string) => void;
  onEditEnd: (id: string, value: string) => void;
  onElementsChange: (elements: SlideElement[]) => void;
};

type TokenStyle = CSSProperties & Record<`--${string}`, string | number>;
type ResizeCorner = 'north-west' | 'north-east' | 'south-west' | 'south-east';

type MoveGesture = {
  kind: 'move';
  pointerId: number;
  startX: number;
  startY: number;
  selectedIds: string[];
  primaryId: string;
  baseline: SlideElement[];
};

type ResizeGesture = {
  kind: 'resize';
  pointerId: number;
  startX: number;
  startY: number;
  corner: ResizeCorner;
  elementId: string;
  baseline: SlideElement[];
};

type Gesture = MoveGesture | ResizeGesture;

function describeElement(element: SlideElement): string {
  if (element.kind === 'text') return `Text element: ${element.text.slice(0, 80)}`;
  if (element.kind === 'shape') return `Shape element: ${element.label}`;
  if (element.kind === 'image') return `Image placeholder: ${element.label}`;
  return `Table element, ${element.rows.length} rows and ${element.rows[0]?.length ?? 0} columns`;
}

function renderElementContent(
  element: SlideElement,
  editing: boolean,
  onTextBlur: (value: string) => void,
) {
  if (element.kind === 'text') {
    return (
      <div
        className={`text-content text-role-${element.role}`}
        style={
          {
            '--element-font-size': `${element.fontSize}px`,
            '--element-font-weight': element.fontWeight,
            '--element-text-align': element.align,
          } as TokenStyle
        }
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={editing}
        role={editing ? 'textbox' : undefined}
        aria-label={editing ? 'Edit text content' : undefined}
        aria-multiline={editing ? true : undefined}
        onBlur={(event) => onTextBlur(event.currentTarget.textContent ?? '')}
        onKeyDown={(event) => {
          if (editing && event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onPointerDown={(event) => {
          if (editing) event.stopPropagation();
        }}
      >
        {element.text}
      </div>
    );
  }

  if (element.kind === 'shape') {
    return <div className="shape-content">{element.label}</div>;
  }

  if (element.kind === 'image') {
    return (
      <div className="image-content">
        <span className="image-placeholder-icon">
          <ImageIcon aria-hidden="true" />
        </span>
        <strong>{element.label}</strong>
        <span>{element.caption}</span>
      </div>
    );
  }

  return (
    <div className="table-content">
      <span className="sr-only">
        <TableProperties aria-hidden="true" />
        Table
      </span>
      <table>
        <tbody>
          {element.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => {
                const Cell = rowIndex === 0 ? 'th' : 'td';
                return <Cell key={`${rowIndex}-${columnIndex}`}>{cell}</Cell>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SlideCanvas({
  elements,
  selectedIds,
  editingId,
  scale,
  gridEnabled,
  onSelect,
  onEditStart,
  onEditEnd,
  onElementsChange,
}: SlideCanvasProps) {
  const gesture = useRef<Gesture | null>(null);
  const [guides, setGuides] = useState<SmartGuides>({ vertical: [], horizontal: [] });

  useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      const dx = (event.clientX - active.startX) / scale;
      const dy = (event.clientY - active.startY) / scale;

      if (active.kind === 'move') {
        const primary = active.baseline.find((element) => element.id === active.primaryId);
        if (!primary) return;
        const siblings = active.baseline.filter(
          (element) => !active.selectedIds.includes(element.id),
        );
        const snapped = moveWithSmartGuides(
          primary,
          primary.x + dx,
          primary.y + dy,
          siblings,
          6 / Math.max(scale, 0.25),
          gridEnabled,
        );
        const appliedDx = snapped.x - primary.x;
        const appliedDy = snapped.y - primary.y;
        const next = active.baseline.map((element) => {
          if (!active.selectedIds.includes(element.id)) return element;
          return {
            ...element,
            x: roundGeometry(clamp(element.x + appliedDx, 0, SLIDE_WIDTH - element.width)),
            y: roundGeometry(clamp(element.y + appliedDy, 0, SLIDE_HEIGHT - element.height)),
          };
        });
        setGuides(snapped.guides);
        onElementsChange(next);
        return;
      }

      const source = active.baseline.find((element) => element.id === active.elementId);
      if (!source) return;
      const fromLeft = active.corner.includes('west');
      const fromTop = active.corner.includes('north');
      let x = fromLeft ? source.x + dx : source.x;
      let y = fromTop ? source.y + dy : source.y;
      let width = fromLeft ? source.width - dx : source.width + dx;
      let height = fromTop ? source.height - dy : source.height + dy;
      const minimumWidth = source.kind === 'text' ? 72 : 36;
      const minimumHeight = source.kind === 'text' ? 28 : 24;

      if (width < minimumWidth) {
        if (fromLeft) x -= minimumWidth - width;
        width = minimumWidth;
      }
      if (height < minimumHeight) {
        if (fromTop) y -= minimumHeight - height;
        height = minimumHeight;
      }

      x = clamp(x, 0, source.x + source.width - minimumWidth);
      y = clamp(y, 0, source.y + source.height - minimumHeight);
      width = clamp(width, minimumWidth, SLIDE_WIDTH - x);
      height = clamp(height, minimumHeight, SLIDE_HEIGHT - y);

      onElementsChange(
        active.baseline.map((element) =>
          element.id === source.id
            ? {
                ...element,
                x: roundGeometry(x),
                y: roundGeometry(y),
                width: roundGeometry(width),
                height: roundGeometry(height),
              }
            : element,
        ),
      );
    };

    const handleUp = (event: PointerEvent) => {
      if (gesture.current?.pointerId !== event.pointerId) return;
      gesture.current = null;
      setGuides({ vertical: [], horizontal: [] });
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [gridEnabled, onElementsChange, scale]);

  const beginMove = (event: ReactPointerEvent, element: SlideElement) => {
    if (event.button !== 0 || editingId === element.id) return;
    event.stopPropagation();
    let nextSelection: string[];
    if (event.shiftKey) {
      nextSelection = selectedIds.includes(element.id)
        ? selectedIds.filter((id) => id !== element.id)
        : [...selectedIds, element.id];
    } else {
      nextSelection = selectedIds.includes(element.id) ? selectedIds : [element.id];
    }
    if (nextSelection.length === 0) nextSelection = [element.id];
    onSelect(nextSelection);
    gesture.current = {
      kind: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      selectedIds: nextSelection,
      primaryId: element.id,
      baseline: elements,
    };
  };

  const beginResize = (event: ReactPointerEvent, element: SlideElement, corner: ResizeCorner) => {
    event.stopPropagation();
    gesture.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      corner,
      elementId: element.id,
      baseline: elements,
    };
  };

  const wrapperStyle: TokenStyle = {
    '--canvas-scale': scale,
    '--canvas-width': `${SLIDE_WIDTH * scale}px`,
    '--canvas-height': `${SLIDE_HEIGHT * scale}px`,
  };

  return (
    <div className="slide-canvas-wrapper" style={wrapperStyle}>
      <div
        className={`slide-canvas ${gridEnabled ? 'has-grid' : ''}`}
        role="region"
        aria-label="Slide canvas"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onSelect([]);
        }}
      >
        {elements.map((element) => {
          const selected = selectedIds.includes(element.id);
          const primary = selectedIds.at(-1) === element.id;
          const style: TokenStyle = {
            '--element-x': `${element.x}px`,
            '--element-y': `${element.y}px`,
            '--element-width': `${element.width}px`,
            '--element-height': `${element.height}px`,
            '--element-rotation': `${element.rotation}deg`,
          };
          return (
            <div
              key={element.id}
              className={`canvas-element element-${element.kind} fill-${element.fill} ${selected ? 'is-selected' : ''}`}
              style={style}
              role={editingId === element.id ? undefined : 'button'}
              tabIndex={editingId === element.id ? -1 : 0}
              aria-label={editingId === element.id ? undefined : describeElement(element)}
              aria-pressed={editingId === element.id ? undefined : selected}
              onFocus={(event) => {
                if (event.target === event.currentTarget) onSelect([element.id]);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSelect([element.id]);
                  if (element.kind === 'text') onEditStart(element.id);
                } else if (event.key === ' ') {
                  event.preventDefault();
                  onSelect([element.id]);
                }
              }}
              onPointerDown={(event) => beginMove(event, element)}
              onDoubleClick={(event) => {
                if (element.kind !== 'text') return;
                event.stopPropagation();
                onSelect([element.id]);
                onEditStart(element.id);
              }}
              data-element-id={element.id}
            >
              {renderElementContent(element, editingId === element.id, (value) =>
                onEditEnd(element.id, value),
              )}
              {selected && primary && editingId !== element.id
                ? (['north-west', 'north-east', 'south-west', 'south-east'] as const).map(
                    (corner) => (
                      <button
                        type="button"
                        key={corner}
                        className={`resize-handle handle-${corner}`}
                        tabIndex={-1}
                        aria-hidden="true"
                        onPointerDown={(event) => beginResize(event, element, corner)}
                      />
                    ),
                  )
                : null}
            </div>
          );
        })}

        {guides.vertical.map((position) => (
          <div
            key={`vertical-${position}`}
            className="smart-guide is-vertical"
            style={{ '--guide-position': `${position}px` } as TokenStyle}
          />
        ))}
        {guides.horizontal.map((position) => (
          <div
            key={`horizontal-${position}`}
            className="smart-guide is-horizontal"
            style={{ '--guide-position': `${position}px` } as TokenStyle}
          />
        ))}
      </div>
    </div>
  );
}
