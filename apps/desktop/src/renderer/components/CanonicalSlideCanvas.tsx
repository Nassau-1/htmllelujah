import type { DeckDocument, Element, Frame, Slide } from '@htmllelujah/document-core';
import { resolveSlide } from '@htmllelujah/document-core';
import {
  boundsForFrames,
  clampFrameToBounds,
  moveItems,
  moveItemsWithSnapping,
  resizeFrame,
  type ResizeHandle,
  type SmartGuide,
} from '@htmllelujah/geometry';
import { SlideSurface } from '@htmllelujah/renderer';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

type CanonicalSlideCanvasProps = {
  readonly document: DeckDocument;
  readonly slide: Slide;
  readonly assetUrls: Readonly<Record<string, string>>;
  readonly scale: number;
  readonly gridEnabled: boolean;
  readonly selectedIds: readonly string[];
  readonly onSelect: (ids: readonly string[]) => void;
  readonly onTransform: (
    frames: readonly { readonly elementId: string; readonly frame: Frame }[],
  ) => void;
  readonly onEditText: (elementId: string) => void;
};

type DraftFrames = Readonly<Record<string, Frame>>;

type MoveGesture = {
  readonly kind: 'move';
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly items: readonly { readonly id: string; readonly frame: Frame }[];
  readonly objects: readonly { readonly id: string; readonly frame: Frame }[];
  readonly shiftKey: boolean;
};

type ResizeGesture = {
  readonly kind: 'resize';
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly item: { readonly id: string; readonly frame: Frame };
  readonly handle: ResizeHandle;
  readonly preserveAspectRatio: boolean;
  readonly fromCenter: boolean;
};

type Gesture = MoveGesture | ResizeGesture;

const handles: readonly ResizeHandle[] = [
  'north-west',
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
];

const sameFrame = (left: Frame, right: Frame): boolean =>
  left.xPt === right.xPt &&
  left.yPt === right.yPt &&
  left.widthPt === right.widthPt &&
  left.heightPt === right.heightPt &&
  left.rotationDeg === right.rotationDeg;

const frameStyle = (frame: Frame): CSSProperties => ({
  left: `${frame.xPt}pt`,
  top: `${frame.yPt}pt`,
  width: `${frame.widthPt}pt`,
  height: `${frame.heightPt}pt`,
  transform: `rotate(${frame.rotationDeg}deg)`,
});

const pageBounds = (document: DeckDocument) => ({
  leftPt: 0,
  topPt: 0,
  rightPt: document.page.widthPt,
  bottomPt: document.page.heightPt,
  widthPt: document.page.widthPt,
  heightPt: document.page.heightPt,
  centerXPt: document.page.widthPt / 2,
  centerYPt: document.page.heightPt / 2,
});

export function CanonicalSlideCanvas({
  document,
  slide,
  assetUrls,
  scale,
  gridEnabled,
  selectedIds,
  onSelect,
  onTransform,
  onEditText,
}: CanonicalSlideCanvasProps) {
  const gesture = useRef<Gesture | null>(null);
  const [draftFrames, setDraftFrames] = useState<DraftFrames>({});
  const [smartGuides, setSmartGuides] = useState<readonly SmartGuide[]>([]);
  const localElements = slide.elements;
  const localById = useMemo(
    () => new Map(localElements.map((element) => [element.id, element])),
    [localElements],
  );
  const projection = useMemo(() => {
    const resolved = resolveSlide(document, slide.id);
    if (Object.keys(draftFrames).length === 0) return resolved;
    return {
      ...resolved,
      elements: resolved.elements.map((entry) => {
        const frame = entry.source === 'slide' ? draftFrames[entry.element.id] : undefined;
        return frame === undefined ? entry : { ...entry, element: { ...entry.element, frame } };
      }),
    };
  }, [document, draftFrames, slide.id]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const active = gesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      const dxPt = (event.clientX - active.startX) / Math.max(scale, 0.01);
      const dyPt = (event.clientY - active.startY) / Math.max(scale, 0.01);
      if (active.kind === 'move') {
        const snapped = moveItemsWithSnapping(
          active.items,
          { dxPt, dyPt },
          {
            constraint: event.shiftKey || active.shiftKey ? 'dominant-axis' : 'none',
            tolerancePt: 6 / Math.max(scale, 0.25),
            grid: {
              enabled: gridEnabled && document.settings.grid.snapToGrid,
              spacingPt: document.settings.grid.spacingPt,
              tolerancePt: 6 / Math.max(scale, 0.25),
            },
            verticalGuides: projection.guides
              .filter((guide) => guide.orientation === 'vertical')
              .map((guide) => ({ id: guide.id, positionPt: guide.positionPt })),
            horizontalGuides: projection.guides
              .filter((guide) => guide.orientation === 'horizontal')
              .map((guide) => ({ id: guide.id, positionPt: guide.positionPt })),
            objects: document.settings.grid.snapToObjects ? active.objects : [],
          },
        );
        let items = snapped.items;
        const bounds = boundsForFrames(items.map((item) => item.frame));
        if (bounds !== null) {
          let correctionX = 0;
          let correctionY = 0;
          if (bounds.leftPt < 0) correctionX = -bounds.leftPt;
          else if (bounds.rightPt > document.page.widthPt)
            correctionX = document.page.widthPt - bounds.rightPt;
          if (bounds.topPt < 0) correctionY = -bounds.topPt;
          else if (bounds.bottomPt > document.page.heightPt)
            correctionY = document.page.heightPt - bounds.bottomPt;
          if (correctionX !== 0 || correctionY !== 0) {
            items = moveItems(items, { dxPt: correctionX, dyPt: correctionY });
          }
        }
        setDraftFrames(Object.fromEntries(items.map((item) => [item.id, item.frame])));
        setSmartGuides(snapped.guides);
        return;
      }
      const next = clampFrameToBounds(
        resizeFrame(
          active.item.frame,
          active.handle,
          { dxPt, dyPt },
          {
            preserveAspectRatio: event.shiftKey || active.preserveAspectRatio,
            fromCenter: event.altKey || active.fromCenter,
            minimumWidthPt: 12,
            minimumHeightPt: 12,
          },
        ),
        pageBounds(document),
      );
      setDraftFrames({ [active.item.id]: next });
    };

    const onUp = (event: PointerEvent): void => {
      const active = gesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      const transforms = Object.entries(draftFrames)
        .map(([elementId, frame]) => ({ elementId, frame }))
        .filter(({ elementId, frame }) => {
          const original = localById.get(elementId);
          return original !== undefined && !sameFrame(original.frame, frame);
        });
      gesture.current = null;
      setSmartGuides([]);
      setDraftFrames({});
      if (transforms.length > 0) onTransform(transforms);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [document, draftFrames, gridEnabled, localById, onTransform, projection.guides, scale]);

  const beginMove = (event: ReactPointerEvent, element: Element): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const nextSelection = event.shiftKey
      ? selectedIds.includes(element.id)
        ? selectedIds.filter((id) => id !== element.id)
        : [...selectedIds, element.id]
      : selectedIds.includes(element.id)
        ? selectedIds
        : [element.id];
    const stableSelection = nextSelection.length === 0 ? [element.id] : nextSelection;
    onSelect(stableSelection);
    if (element.locked) return;
    const items = localElements
      .filter((candidate) => stableSelection.includes(candidate.id) && !candidate.locked)
      .map((candidate) => ({ id: candidate.id, frame: candidate.frame }));
    const objects = localElements
      .filter((candidate) => !stableSelection.includes(candidate.id))
      .map((candidate) => ({ id: candidate.id, frame: candidate.frame }));
    gesture.current = {
      kind: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      items,
      objects,
      shiftKey: event.shiftKey,
    };
  };

  const beginResize = (event: ReactPointerEvent, element: Element, handle: ResizeHandle): void => {
    event.preventDefault();
    event.stopPropagation();
    if (element.locked) return;
    gesture.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      item: { id: element.id, frame: element.frame },
      handle,
      preserveAspectRatio: event.shiftKey,
      fromCenter: event.altKey,
    };
  };

  const wrapperStyle = {
    width: `${document.page.widthPt * scale}px`,
    height: `${document.page.heightPt * scale}px`,
  } as CSSProperties;
  const scaledStyle = {
    width: `${document.page.widthPt}pt`,
    height: `${document.page.heightPt}pt`,
    transform: `scale(${scale * 0.75})`,
  } as CSSProperties;

  return (
    <div className="canonical-canvas-wrapper" style={wrapperStyle} data-testid="editor-canvas-root">
      <div
        className={`canonical-canvas-scaled${gridEnabled ? ' has-grid' : ''}`}
        style={scaledStyle}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onSelect([]);
        }}
      >
        <SlideSurface
          slide={projection}
          mode="editor"
          resolveAsset={(assetId) => assetUrls[assetId] ?? null}
          className="canonical-slide-surface"
        />
        <div className="canvas-hit-layer" aria-label="Editable slide objects">
          {localElements
            .filter((element) => element.visible)
            .map((element) => {
              const frame = draftFrames[element.id] ?? element.frame;
              const selected = selectedIds.includes(element.id);
              const primary = selectedIds.at(-1) === element.id;
              return (
                <div
                  key={element.id}
                  className={`canonical-hitbox${selected ? ' is-selected' : ''}${element.locked ? ' is-locked' : ''}`}
                  style={frameStyle(frame)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${element.name}, ${element.type}${element.locked ? ', locked' : ''}`}
                  aria-pressed={selected}
                  data-canvas-element-id={element.id}
                  onPointerDown={(event) => beginMove(event, element)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (element.type === 'text') onEditText(element.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      onSelect([element.id]);
                      if (element.type === 'text') onEditText(element.id);
                    } else if (event.key === ' ') {
                      event.preventDefault();
                      onSelect([element.id]);
                    }
                  }}
                >
                  {selected && primary && !element.locked
                    ? handles.map((handle) => (
                        <button
                          key={handle}
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          className={`canonical-resize-handle handle-${handle}`}
                          onPointerDown={(event) => beginResize(event, element, handle)}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          {smartGuides.map((guide, index) => (
            <span
              key={`${guide.axis}-${guide.positionPt}-${index}`}
              className={`canonical-smart-guide guide-${guide.axis}`}
              style={
                guide.axis === 'x'
                  ? { left: `${guide.positionPt}pt` }
                  : { top: `${guide.positionPt}pt` }
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
