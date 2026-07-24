import type {
  ConnectorElement,
  DeckDocument,
  Element,
  Frame,
  ImageCrop,
  ImageElement,
  PathCommand,
  PathElement,
  ResolvedElementSource,
  ResolvedSlide,
  ShapeElement,
  Slide,
  TextAlignment,
  TextElement,
} from '@htmllelujah/document-core';
import { resolveSlide } from '@htmllelujah/document-core';
import {
  boundsForFrames,
  clampFrameToBounds,
  moveItems,
  moveItemsWithSnapping,
  resizeFrame,
  rotationFromPointer,
  type ResizeHandle,
  type SmartGuide,
} from '@htmllelujah/geometry';
import {
  resolveConnectorGeometries,
  SlideSurface,
  type ResolvedConnectorGeometry,
} from '@htmllelujah/renderer';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { inlineTextEditorKeyAction, rotationFrameForKeyboard } from '../editor/editor-interactions';
import {
  beginImageCropDrag,
  imageCropFromDrag,
  IMAGE_CROP_HANDLES,
  type ImageCropDrag,
  type ImageCropHandle,
} from '../editor/image-crop-tools';
import {
  appendDistinctCanvasPoint,
  canFinishFreeform,
  clampCanvasPoint,
  connectorAnchorCandidates,
  pathPointHandles,
  slidePointToFrameLocal,
  snapConnectorEndpoint,
  updatePathPoint,
  type CanvasPoint,
  type CanvasVectorTool,
  type ConnectorAnchorCandidate,
  type PathPointRole,
} from '../editor/vector-canvas-tools';

export type InlineTextCanvasEditor = Readonly<{
  elementId: string;
  value: string;
  disabled: boolean;
  pending: boolean;
  conflict: boolean;
  maxLength: number;
  fontFamily: string;
  fontSizePt: number;
  fontWeight: number;
  italic: boolean;
  color: string;
  lineHeight: number;
  letterSpacingPt: number;
  alignment: TextAlignment;
  locale: string;
  shapeText?: boolean | undefined;
  verticalAlignment?: 'top' | 'middle' | 'bottom' | undefined;
  margins?:
    | Readonly<{
        topPt: number;
        rightPt: number;
        bottomPt: number;
        leftPt: number;
      }>
    | undefined;
}>;

type CanonicalSlideCanvasProps = {
  readonly document: DeckDocument;
  readonly slide: Slide;
  readonly assetUrls: Readonly<Record<string, string>>;
  readonly scale: number;
  readonly gridEnabled: boolean;
  readonly editableElements?: readonly Element[] | undefined;
  readonly editableSource?: 'slide' | 'layout' | 'master' | undefined;
  readonly includeTemplatePlaceholders?: boolean | undefined;
  readonly inlineTextEditor?: InlineTextCanvasEditor | null | undefined;
  readonly imageCropElementId?: string | null | undefined;
  readonly selectedIds: readonly string[];
  readonly onSelect: (ids: readonly string[]) => boolean | Promise<boolean>;
  readonly onTransform: (
    frames: readonly { readonly elementId: string; readonly frame: Frame }[],
  ) => void;
  readonly vectorTool?: CanvasVectorTool | undefined;
  readonly onCreatePath?:
    ((points: readonly CanvasPoint[], closed: boolean) => void | Promise<void>) | undefined;
  readonly onUpdatePathCommands?:
    ((elementId: string, commands: readonly PathCommand[]) => void | Promise<void>) | undefined;
  readonly onUpdateConnectorEndpoint?:
    | ((
        connectorId: string,
        endpoint: 'start' | 'end',
        value: ConnectorElement['start'],
      ) => void | Promise<void>)
    | undefined;
  readonly onVectorToolDone?: (() => void) | undefined;
  readonly onEditText: (elementId: string) => void;
  readonly onEditShapeText?: ((elementId: string) => void) | undefined;
  readonly onEditImageCrop?: ((elementId: string) => void) | undefined;
  readonly onUpdateImageCrop?:
    ((elementId: string, crop: ImageCrop) => void | Promise<void>) | undefined;
  readonly onImageCropDone?: (() => void) | undefined;
  readonly onContextMenu?:
    | ((elementId: string, position: Readonly<{ clientX: number; clientY: number }>) => void)
    | undefined;
  readonly onInlineTextChange?: ((value: string) => void) | undefined;
  readonly onInlineTextPaste?:
    ((event: ReactClipboardEvent<HTMLTextAreaElement>) => void) | undefined;
  readonly onInlineTextCommit?:
    | ((
        target: HTMLTextAreaElement,
        confirmConflict: boolean,
        relatedTarget: EventTarget | null,
      ) => void)
    | undefined;
  readonly onInlineTextCancel?: (() => void) | undefined;
  readonly onInlineTextFocus?: (() => void) | undefined;
};

type DraftFrames = Readonly<Record<string, Frame>>;

export type CanvasEditableElementProjection = Readonly<{
  localElement: Element;
  effectiveElement: Element;
}>;

const CONNECTOR_INTERACTION_MINIMUM_PT = 12;

const connectorInteractionFrame = (
  bounds: Readonly<{ xPt: number; yPt: number; widthPt: number; heightPt: number }>,
): Frame => {
  const widthPt = Math.max(CONNECTOR_INTERACTION_MINIMUM_PT, bounds.widthPt);
  const heightPt = Math.max(CONNECTOR_INTERACTION_MINIMUM_PT, bounds.heightPt);
  return {
    xPt: bounds.xPt - (widthPt - bounds.widthPt) / 2,
    yPt: bounds.yPt - (heightPt - bounds.heightPt) / 2,
    widthPt,
    heightPt,
    rotationDeg: 0,
  };
};

/**
 * Keeps local identities as the write target while using the fully resolved element for
 * hit-testing. This matters for slide elements whose frame or visibility is inherited from a
 * layout/master placeholder: their stored frame is intentionally not their on-canvas frame.
 */
export const resolveCanvasEditableElements = (
  projection: ResolvedSlide,
  editableSource: ResolvedElementSource,
  localElements: readonly Element[],
): readonly CanvasEditableElementProjection[] => {
  const renderedElements = projection.elements.map((entry) => entry.element);
  const connectorGeometries = resolveConnectorGeometries(renderedElements);
  const effectiveById = new Map(
    projection.elements
      .filter((entry) => entry.source === editableSource)
      .map((entry) => [entry.element.id, entry.element] as const),
  );
  return localElements.map((localElement) => {
    const effectiveElement = effectiveById.get(localElement.id) ?? localElement;
    if (effectiveElement.type !== 'connector') return { localElement, effectiveElement };
    const geometry = connectorGeometries.get(effectiveElement.id);
    return {
      localElement,
      effectiveElement:
        geometry === undefined
          ? effectiveElement
          : { ...effectiveElement, frame: connectorInteractionFrame(geometry.boundsInSlide) },
    };
  });
};

export const MINIMUM_ROTATION_TOUCH_TARGET_PX = 44;
const CANVAS_POINT_TO_CSS_PIXEL_SCALE = 0.75;
const ROTATION_CONTROL_GAP_PX = 6;
const ROTATION_CONTROL_STEM_PX = 28;
const ROTATION_CONTROL_DOT_PX = 10;
const ROTATION_CONTROL_LINE_PX = 1.5;

export type RotationControlMetrics = Readonly<{
  canvasTransformScale: number;
  targetSizeCssPx: number;
  targetHalfCssPx: number;
  gapCssPx: number;
  stemLengthCssPx: number;
  dotSizeCssPx: number;
  dotHalfCssPx: number;
  lineWidthCssPx: number;
  lineHalfCssPx: number;
}>;

const normalizedEditorScale = (scale: number): number =>
  Number.isFinite(scale) && scale > 0 ? scale : 1;

/** Converts fixed screen-pixel controls into pre-transform CSS dimensions. */
export const rotationControlMetrics = (scale: number): RotationControlMetrics => {
  const canvasTransformScale = normalizedEditorScale(scale) * CANVAS_POINT_TO_CSS_PIXEL_SCALE;
  const toCssPixels = (screenPixels: number): number => screenPixels / canvasTransformScale;
  return {
    canvasTransformScale,
    targetSizeCssPx: toCssPixels(MINIMUM_ROTATION_TOUCH_TARGET_PX),
    targetHalfCssPx: toCssPixels(MINIMUM_ROTATION_TOUCH_TARGET_PX / 2),
    gapCssPx: toCssPixels(ROTATION_CONTROL_GAP_PX),
    stemLengthCssPx: toCssPixels(ROTATION_CONTROL_STEM_PX),
    dotSizeCssPx: toCssPixels(ROTATION_CONTROL_DOT_PX),
    dotHalfCssPx: toCssPixels(ROTATION_CONTROL_DOT_PX / 2),
    lineWidthCssPx: toCssPixels(ROTATION_CONTROL_LINE_PX),
    lineHalfCssPx: toCssPixels(ROTATION_CONTROL_LINE_PX / 2),
  };
};

export type RotationControlPlacement = 'above' | 'inside-top';

/** Keeps the whole 44 px target inside the canvas when an element touches the top edge. */
export const rotationControlPlacement = (frame: Frame, scale: number): RotationControlPlacement =>
  frame.yPt * normalizedEditorScale(scale) >=
  MINIMUM_ROTATION_TOUCH_TARGET_PX + ROTATION_CONTROL_GAP_PX
    ? 'above'
    : 'inside-top';

type MoveGesture = {
  readonly kind: 'move';
  readonly selectionAuthorized: Promise<boolean>;
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

type RotateGesture = {
  readonly kind: 'rotate';
  readonly pointerId: number;
  readonly startPointer: { readonly xPt: number; readonly yPt: number };
  readonly item: { readonly id: string; readonly frame: Frame };
  readonly snapToIncrement: boolean;
};

type Gesture = MoveGesture | ResizeGesture | RotateGesture;

type PathPointGesture = {
  readonly kind: 'path-point';
  readonly pointerId: number;
  readonly element: PathElement;
  readonly commandIndex: number;
  readonly role: PathPointRole;
};

type ConnectorEndpointGesture = {
  readonly kind: 'connector-endpoint';
  readonly pointerId: number;
  readonly connectorId: string;
  readonly endpoint: 'start' | 'end';
  readonly candidates: readonly ConnectorAnchorCandidate[];
};

type ImageCropGesture = {
  readonly kind: 'image-crop';
  readonly pointerId: number;
  readonly elementId: string;
  readonly drag: ImageCropDrag;
};

type DirectGesture = PathPointGesture | ConnectorEndpointGesture | ImageCropGesture;

type DraftPath = Readonly<{
  elementId: string;
  commands: readonly PathCommand[];
}>;

type DraftConnectorEndpoint = Readonly<{
  connectorId: string;
  endpoint: 'start' | 'end';
  value: ConnectorElement['start'];
  snap?: ConnectorAnchorCandidate | undefined;
}>;

type DraftImageCrop = Readonly<{
  elementId: string;
  crop: ImageCrop;
}>;

export const sameCanvasSelection = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

export type CanvasTransform = Readonly<{ elementId: string; frame: Frame }>;

export const commitCanvasTransformsWhenAuthorized = async (
  authorization: Promise<boolean>,
  transforms: readonly CanvasTransform[],
  onTransform: (frames: readonly CanvasTransform[]) => void,
): Promise<boolean> => {
  try {
    if (!(await authorization) || transforms.length === 0) return false;
    onTransform(transforms);
    return true;
  } catch {
    return false;
  }
};

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

const rotatePoint = (
  point: Readonly<{ xPt: number; yPt: number }>,
  center: Readonly<{ xPt: number; yPt: number }>,
  rotationDeg: number,
): Readonly<{ xPt: number; yPt: number }> => {
  if (rotationDeg === 0) return point;
  const radians = (rotationDeg * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const deltaX = point.xPt - center.xPt;
  const deltaY = point.yPt - center.yPt;
  return {
    xPt: center.xPt + deltaX * cosine - deltaY * sine,
    yPt: center.yPt + deltaX * sine + deltaY * cosine,
  };
};

const frameCenter = (frame: Frame): Readonly<{ xPt: number; yPt: number }> => ({
  xPt: frame.xPt + frame.widthPt / 2,
  yPt: frame.yPt + frame.heightPt / 2,
});

/** Applies the editor's frame-to-frame gesture affine transform to an absolute point. */
export const pointAfterInteractionFrameTransform = (
  point: Readonly<{ xPt: number; yPt: number }>,
  previousFrame: Frame,
  nextFrame: Frame,
): Readonly<{ xPt: number; yPt: number }> => {
  const previousCenter = frameCenter(previousFrame);
  const nextCenter = frameCenter(nextFrame);
  const unrotated = rotatePoint(point, previousCenter, -previousFrame.rotationDeg);
  const normalizedX = (unrotated.xPt - previousFrame.xPt) / previousFrame.widthPt;
  const normalizedY = (unrotated.yPt - previousFrame.yPt) / previousFrame.heightPt;
  return rotatePoint(
    {
      xPt: nextFrame.xPt + normalizedX * nextFrame.widthPt,
      yPt: nextFrame.yPt + normalizedY * nextFrame.heightPt,
    },
    nextCenter,
    nextFrame.rotationDeg,
  );
};

/** Preview the same materialize-detach-transform operation committed by document-core. */
export const connectorAfterInteractionFrameTransform = (
  connector: Extract<Element, { readonly type: 'connector' }>,
  geometry: Pick<ResolvedConnectorGeometry, 'startInContainer' | 'endInContainer'>,
  previousLocalFrame: Frame,
  nextLocalFrame: Frame,
): Extract<Element, { readonly type: 'connector' }> => ({
  ...connector,
  geometryVersion: 2,
  frame: nextLocalFrame,
  start: {
    ...connector.start,
    ...pointAfterInteractionFrameTransform(
      geometry.startInContainer,
      previousLocalFrame,
      nextLocalFrame,
    ),
    binding: {},
  },
  end: {
    ...connector.end,
    ...pointAfterInteractionFrameTransform(
      geometry.endInContainer,
      previousLocalFrame,
      nextLocalFrame,
    ),
    binding: {},
  },
});

const localConnectorFrameAfterInteraction = (
  localFrame: Frame,
  previousInteractionFrame: Frame,
  nextInteractionFrame: Frame,
): Frame => {
  const center = pointAfterInteractionFrameTransform(
    frameCenter(localFrame),
    previousInteractionFrame,
    nextInteractionFrame,
  );
  const widthPt =
    localFrame.widthPt * (nextInteractionFrame.widthPt / previousInteractionFrame.widthPt);
  const heightPt =
    localFrame.heightPt * (nextInteractionFrame.heightPt / previousInteractionFrame.heightPt);
  return {
    xPt: center.xPt - widthPt / 2,
    yPt: center.yPt - heightPt / 2,
    widthPt,
    heightPt,
    rotationDeg:
      localFrame.rotationDeg +
      nextInteractionFrame.rotationDeg -
      previousInteractionFrame.rotationDeg,
  };
};

export const canvasTransformsToCommit = (
  draftFrames: Readonly<Record<string, Frame>>,
  startingItems: readonly { readonly id: string; readonly frame: Frame }[],
  localElements: ReadonlyMap<string, Element>,
): readonly { readonly elementId: string; readonly frame: Frame }[] => {
  const startingById = new Map(startingItems.map((item) => [item.id, item.frame] as const));
  return Object.entries(draftFrames)
    .map(([elementId, frame]) => ({ elementId, frame }))
    .filter(({ elementId, frame }) => {
      const startingFrame = startingById.get(elementId);
      return (
        localElements.has(elementId) &&
        startingFrame !== undefined &&
        !sameFrame(startingFrame, frame)
      );
    })
    .map(({ elementId, frame }) => {
      const localElement = localElements.get(elementId);
      const startingFrame = startingById.get(elementId);
      return {
        elementId,
        frame:
          localElement?.type === 'connector' && startingFrame !== undefined
            ? localConnectorFrameAfterInteraction(localElement.frame, startingFrame, frame)
            : frame,
      };
    });
};

/** Converts an absolute local connector rotation shortcut into a hitbox-relative delta. */
export const canvasKeyboardRotationFrame = (
  localElement: Element,
  effectiveFrame: Frame,
  key: string,
  shiftKey: boolean,
): Frame | null => {
  if (localElement.type !== 'connector') {
    return rotationFrameForKeyboard(effectiveFrame, key, shiftKey);
  }
  const localRotationFrame = rotationFrameForKeyboard(
    { ...effectiveFrame, rotationDeg: localElement.frame.rotationDeg },
    key,
    shiftKey,
  );
  if (localRotationFrame === null) return null;
  return {
    ...effectiveFrame,
    rotationDeg: localRotationFrame.rotationDeg - localElement.frame.rotationDeg,
  };
};

const frameStyle = (frame: Frame): CSSProperties => ({
  left: `${frame.xPt}pt`,
  top: `${frame.yPt}pt`,
  width: `${frame.widthPt}pt`,
  height: `${frame.heightPt}pt`,
  transform: `rotate(${frame.rotationDeg}deg)`,
});

export function InlineTextCanvasEditorOverlay({
  element,
  editor,
  onChange,
  onPaste,
  onCommit,
  onCancel,
  onFocus,
}: Readonly<{
  element: TextElement | ShapeElement;
  editor: InlineTextCanvasEditor;
  onChange: (value: string) => void;
  onPaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  onCommit: (
    target: HTMLTextAreaElement,
    confirmConflict: boolean,
    relatedTarget: EventTarget | null,
  ) => void;
  onCancel: () => void;
  onFocus: () => void;
}>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editor.disabled) textareaRef.current?.focus();
  }, [editor.disabled]);

  const conflictId = `inline-text-conflict-${element.id}`;
  const helpId = `inline-text-help-${element.id}`;
  const margins = editor.margins;
  const shapeEditorStyle: CSSProperties | undefined = editor.shapeText
    ? {
        alignItems:
          editor.verticalAlignment === 'bottom'
            ? 'flex-end'
            : editor.verticalAlignment === 'middle'
              ? 'center'
              : 'flex-start',
        padding:
          margins === undefined
            ? undefined
            : `${margins.topPt}pt ${margins.rightPt}pt ${margins.bottomPt}pt ${margins.leftPt}pt`,
      }
    : undefined;
  return (
    <div
      className={`canonical-inline-text-editor${editor.shapeText ? ' is-shape-text' : ''}${editor.conflict ? ' has-conflict' : ''}`}
      style={{ ...frameStyle(element.frame), ...shapeEditorStyle }}
      data-inline-text-element-id={element.id}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={textareaRef}
        autoFocus={!editor.disabled}
        aria-label={`Edit ${element.name} on canvas`}
        aria-describedby={`${helpId}${editor.conflict ? ` ${conflictId}` : ''}`}
        aria-invalid={editor.conflict || undefined}
        aria-busy={editor.pending || undefined}
        className="canonical-inline-text-input"
        disabled={editor.disabled}
        lang={editor.locale}
        maxLength={editor.maxLength}
        spellCheck
        value={editor.value}
        style={{
          color: editor.color,
          fontFamily: editor.fontFamily,
          fontSize: `${editor.fontSizePt}pt`,
          fontStyle: editor.italic ? 'italic' : 'normal',
          fontWeight: editor.fontWeight,
          letterSpacing: `${editor.letterSpacingPt}pt`,
          lineHeight: editor.lineHeight,
          textAlign: editor.alignment,
          ...(editor.shapeText
            ? { height: 'auto', minHeight: `${editor.fontSizePt * 1.5}pt` }
            : {}),
        }}
        onBlur={(event) => onCommit(event.currentTarget, false, event.relatedTarget)}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={onFocus}
        onPaste={onPaste}
        onKeyDown={(event) => {
          const action = inlineTextEditorKeyAction(event.key, {
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            isComposing: event.nativeEvent.isComposing,
          });
          if (action === 'none') return;
          event.preventDefault();
          event.stopPropagation();
          if (action === 'commit') onCommit(event.currentTarget, true, null);
          else onCancel();
        }}
      />
      <span id={helpId} className="sr-only">
        Press Control Enter to apply. Press Escape to cancel.
      </span>
      {editor.conflict ? (
        <span id={conflictId} className="canonical-inline-text-conflict" role="alert">
          Remote change detected. Your draft is preserved and will not overwrite it automatically.
        </span>
      ) : null}
    </div>
  );
}

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
  editableElements,
  editableSource = 'slide',
  includeTemplatePlaceholders = false,
  inlineTextEditor,
  imageCropElementId,
  selectedIds,
  onSelect,
  onTransform,
  vectorTool = { kind: 'select' },
  onCreatePath,
  onUpdatePathCommands,
  onUpdateConnectorEndpoint,
  onVectorToolDone,
  onEditText,
  onEditShapeText,
  onEditImageCrop,
  onUpdateImageCrop,
  onImageCropDone,
  onContextMenu,
  onInlineTextChange,
  onInlineTextPaste,
  onInlineTextCommit,
  onInlineTextCancel,
  onInlineTextFocus,
}: CanonicalSlideCanvasProps) {
  const gesture = useRef<Gesture | null>(null);
  const directGesture = useRef<DirectGesture | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const draftFramesRef = useRef<DraftFrames>({});
  const draftPathRef = useRef<DraftPath | null>(null);
  const draftConnectorEndpointRef = useRef<DraftConnectorEndpoint | null>(null);
  const draftImageCropRef = useRef<DraftImageCrop | null>(null);
  const freeformPointsRef = useRef<readonly CanvasPoint[]>([]);
  const [draftFrames, setDraftFrames] = useState<DraftFrames>({});
  const [draftPath, setDraftPath] = useState<DraftPath | null>(null);
  const [draftConnectorEndpoint, setDraftConnectorEndpoint] =
    useState<DraftConnectorEndpoint | null>(null);
  const [draftImageCrop, setDraftImageCrop] = useState<DraftImageCrop | null>(null);
  const [connectorAnchorPreview, setConnectorAnchorPreview] = useState<
    readonly ConnectorAnchorCandidate[]
  >([]);
  const [freeformPoints, setFreeformPoints] = useState<readonly CanvasPoint[]>([]);
  const [smartGuides, setSmartGuides] = useState<readonly SmartGuide[]>([]);
  const requestSelection = (ids: readonly string[]): Promise<boolean> =>
    Promise.resolve(onSelect(ids)).catch(() => false);
  const localElements = editableElements ?? slide.elements;
  const localById = useMemo(
    () => new Map(localElements.map((element) => [element.id, element])),
    [localElements],
  );
  const baseProjection = useMemo(
    () =>
      resolveSlide(document, slide.id, {
        includePlaceholders: includeTemplatePlaceholders,
      }),
    [document, includeTemplatePlaceholders, slide.id],
  );
  const projection = useMemo(() => {
    if (Object.keys(draftFrames).length === 0) return baseProjection;
    const connectorGeometries = resolveConnectorGeometries(
      baseProjection.elements.map((entry) => entry.element),
    );
    const startingFrames = new Map(
      resolveCanvasEditableElements(baseProjection, editableSource, localElements).map((entry) => [
        entry.localElement.id,
        entry.effectiveElement.frame,
      ]),
    );
    return {
      ...baseProjection,
      elements: baseProjection.elements.map((entry) => {
        const nextFrame =
          entry.source === editableSource ? draftFrames[entry.element.id] : undefined;
        if (nextFrame === undefined) return entry;
        if (entry.element.type !== 'connector') {
          return { ...entry, element: { ...entry.element, frame: nextFrame } };
        }
        const previousFrame = startingFrames.get(entry.element.id);
        if (previousFrame === undefined) {
          return { ...entry, element: { ...entry.element, frame: nextFrame } };
        }
        const geometry = connectorGeometries.get(entry.element.id);
        if (geometry === undefined) {
          return { ...entry, element: { ...entry.element, frame: nextFrame } };
        }
        const localElement = localById.get(entry.element.id);
        if (localElement?.type !== 'connector') {
          return { ...entry, element: { ...entry.element, frame: nextFrame } };
        }
        const nextLocalFrame = localConnectorFrameAfterInteraction(
          localElement.frame,
          previousFrame,
          nextFrame,
        );
        return {
          ...entry,
          element: connectorAfterInteractionFrameTransform(
            entry.element,
            geometry,
            localElement.frame,
            nextLocalFrame,
          ),
        };
      }),
    };
  }, [baseProjection, draftFrames, editableSource, localById, localElements]);
  const interactiveProjection = useMemo(() => {
    if (draftPath === null && draftConnectorEndpoint === null && draftImageCrop === null)
      return projection;
    return {
      ...projection,
      elements: projection.elements.map((entry) => {
        if (
          draftPath !== null &&
          entry.element.id === draftPath.elementId &&
          entry.element.type === 'path'
        ) {
          return { ...entry, element: { ...entry.element, commands: draftPath.commands } };
        }
        if (
          draftConnectorEndpoint !== null &&
          entry.element.id === draftConnectorEndpoint.connectorId &&
          entry.element.type === 'connector'
        ) {
          return {
            ...entry,
            element: {
              ...entry.element,
              [draftConnectorEndpoint.endpoint]: draftConnectorEndpoint.value,
            },
          };
        }
        if (
          draftImageCrop !== null &&
          entry.element.id === draftImageCrop.elementId &&
          entry.element.type === 'image'
        ) {
          return {
            ...entry,
            element: {
              ...entry.element,
              crop: draftImageCrop.crop,
            },
          };
        }
        return entry;
      }),
    };
  }, [draftConnectorEndpoint, draftImageCrop, draftPath, projection]);
  const editableProjection = useMemo(
    () => resolveCanvasEditableElements(interactiveProjection, editableSource, localElements),
    [editableSource, interactiveProjection, localElements],
  );
  const editableProjectionByLocalId = useMemo(
    () => new Map(editableProjection.map((entry) => [entry.localElement.id, entry] as const)),
    [editableProjection],
  );

  const updateDraftFrames = (next: DraftFrames): void => {
    draftFramesRef.current = next;
    setDraftFrames(next);
  };

  const updateDraftPath = (next: DraftPath | null): void => {
    draftPathRef.current = next;
    setDraftPath(next);
  };

  const updateDraftConnectorEndpoint = (next: DraftConnectorEndpoint | null): void => {
    draftConnectorEndpointRef.current = next;
    setDraftConnectorEndpoint(next);
  };

  const updateDraftImageCrop = (next: DraftImageCrop | null): void => {
    draftImageCropRef.current = next;
    setDraftImageCrop(next);
  };

  const updateFreeformPoints = (next: readonly CanvasPoint[]): void => {
    freeformPointsRef.current = next;
    setFreeformPoints(next);
  };

  const pointFromClient = (clientX: number, clientY: number) => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    return {
      xPt: bounds === undefined ? 0 : (clientX - bounds.left) / Math.max(scale, 0.01),
      yPt: bounds === undefined ? 0 : (clientY - bounds.top) / Math.max(scale, 0.01),
    };
  };

  useEffect(() => {
    updateFreeformPoints([]);
    updateDraftPath(null);
    updateDraftConnectorEndpoint(null);
    updateDraftImageCrop(null);
    setConnectorAnchorPreview([]);
    directGesture.current = null;
  }, [
    imageCropElementId,
    slide.id,
    vectorTool.kind,
    vectorTool.kind === 'freeform' ? vectorTool.closed : undefined,
    vectorTool.kind === 'edit-path' ? vectorTool.elementId : undefined,
  ]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const active = directGesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      if (active.kind === 'image-crop') {
        updateDraftImageCrop({
          elementId: active.elementId,
          crop: imageCropFromDrag(active.drag, {
            xPx: event.clientX,
            yPx: event.clientY,
          }),
        });
        return;
      }
      const slidePoint = clampCanvasPoint(
        pointFromClient(event.clientX, event.clientY),
        document.page,
      );
      if (active.kind === 'path-point') {
        updateDraftPath({
          elementId: active.element.id,
          commands: updatePathPoint(
            active.element,
            active.commandIndex,
            active.role,
            slidePointToFrameLocal(slidePoint, active.element.frame),
          ),
        });
        return;
      }
      const snapped = snapConnectorEndpoint(
        slidePoint,
        active.candidates,
        12 / Math.max(scale, 0.25),
      );
      updateDraftConnectorEndpoint({
        connectorId: active.connectorId,
        endpoint: active.endpoint,
        value: snapped.endpoint,
        snap: snapped.candidate,
      });
    };

    const finish = (event: PointerEvent, commit: boolean): void => {
      const active = directGesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      const pathDraft = draftPathRef.current;
      const connectorDraft = draftConnectorEndpointRef.current;
      const imageCropDraft = draftImageCropRef.current;
      directGesture.current = null;
      updateDraftPath(null);
      updateDraftConnectorEndpoint(null);
      updateDraftImageCrop(null);
      setConnectorAnchorPreview([]);
      if (!commit) return;
      if (
        active.kind === 'path-point' &&
        pathDraft !== null &&
        pathDraft.elementId === active.element.id
      ) {
        void onUpdatePathCommands?.(pathDraft.elementId, pathDraft.commands);
      } else if (
        active.kind === 'connector-endpoint' &&
        connectorDraft !== null &&
        connectorDraft.connectorId === active.connectorId &&
        connectorDraft.endpoint === active.endpoint
      ) {
        void onUpdateConnectorEndpoint?.(
          connectorDraft.connectorId,
          connectorDraft.endpoint,
          connectorDraft.value,
        );
      } else if (
        active.kind === 'image-crop' &&
        imageCropDraft !== null &&
        imageCropDraft.elementId === active.elementId
      ) {
        void onUpdateImageCrop?.(imageCropDraft.elementId, imageCropDraft.crop);
      }
    };

    const onUp = (event: PointerEvent): void => finish(event, true);
    const onCancel = (event: PointerEvent): void => finish(event, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [document.page, onUpdateConnectorEndpoint, onUpdateImageCrop, onUpdatePathCommands, scale]);

  useEffect(() => {
    if (vectorTool.kind !== 'freeform') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))
      ) {
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        updateFreeformPoints([]);
        onVectorToolDone?.();
      } else if (event.key === 'Enter' && canFinishFreeform(freeformPoints, vectorTool.closed)) {
        event.preventDefault();
        const points = freeformPoints;
        updateFreeformPoints([]);
        void onCreatePath?.(points, vectorTool.closed);
        onVectorToolDone?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [freeformPoints, onCreatePath, onVectorToolDone, vectorTool]);

  useEffect(() => {
    if (imageCropElementId === null || imageCropElementId === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        (event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))
      )
        return;
      if (event.key !== 'Escape' && event.key !== 'Enter') return;
      event.preventDefault();
      updateDraftImageCrop(null);
      directGesture.current = null;
      onImageCropDone?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imageCropElementId, onImageCropDone]);

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const active = gesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      if (active.kind === 'rotate') {
        const rotationDeg = rotationFromPointer(
          active.item.frame,
          active.startPointer,
          pointFromClient(event.clientX, event.clientY),
          active.item.frame.rotationDeg,
          event.shiftKey || active.snapToIncrement ? { snapIncrementDeg: 15 } : {},
        );
        updateDraftFrames({ [active.item.id]: { ...active.item.frame, rotationDeg } });
        return;
      }
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
        updateDraftFrames(Object.fromEntries(items.map((item) => [item.id, item.frame])));
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
      updateDraftFrames({ [active.item.id]: next });
    };

    const finishGesture = (event: PointerEvent, commit: boolean): void => {
      const active = gesture.current;
      if (active === null || event.pointerId !== active.pointerId) return;
      const startingItems = active.kind === 'move' ? active.items : [active.item];
      const transforms = commit
        ? canvasTransformsToCommit(draftFramesRef.current, startingItems, localById)
        : [];
      gesture.current = null;
      setSmartGuides([]);
      updateDraftFrames({});
      if (transforms.length === 0) return;
      if (active.kind !== 'move') {
        onTransform(transforms);
        return;
      }
      void commitCanvasTransformsWhenAuthorized(
        active.selectionAuthorized,
        transforms,
        onTransform,
      );
    };
    const onUp = (event: PointerEvent): void => finishGesture(event, true);
    const onCancel = (event: PointerEvent): void => finishGesture(event, false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [document, gridEnabled, localById, onTransform, projection.guides, scale]);

  const beginMove = (event: ReactPointerEvent, editable: CanvasEditableElementProjection): void => {
    const { localElement } = editable;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const nextSelection = event.shiftKey
      ? selectedIds.includes(localElement.id)
        ? selectedIds.filter((id) => id !== localElement.id)
        : [...selectedIds, localElement.id]
      : selectedIds.includes(localElement.id)
        ? selectedIds
        : [localElement.id];
    const stableSelection = nextSelection.length === 0 ? [localElement.id] : nextSelection;
    const selectionAuthorized = requestSelection(stableSelection);
    if (localElement.locked) {
      void selectionAuthorized;
      return;
    }
    const items = editableProjection
      .filter(
        (candidate) =>
          stableSelection.includes(candidate.localElement.id) && !candidate.localElement.locked,
      )
      .map((candidate) => ({
        id: candidate.localElement.id,
        frame: candidate.effectiveElement.frame,
      }));
    const objects = editableProjection
      .filter((candidate) => !stableSelection.includes(candidate.localElement.id))
      .map((candidate) => ({
        id: candidate.localElement.id,
        frame: candidate.effectiveElement.frame,
      }));
    gesture.current = {
      kind: 'move',
      selectionAuthorized,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      items,
      objects,
      shiftKey: event.shiftKey,
    };
  };

  const beginResize = (
    event: ReactPointerEvent,
    editable: CanvasEditableElementProjection,
    handle: ResizeHandle,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (editable.localElement.locked) return;
    gesture.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      item: { id: editable.localElement.id, frame: editable.effectiveElement.frame },
      handle,
      preserveAspectRatio: event.shiftKey,
      fromCenter: event.altKey,
    };
  };

  const beginRotate = (
    event: ReactPointerEvent,
    editable: CanvasEditableElementProjection,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (editable.localElement.locked) return;
    gesture.current = {
      kind: 'rotate',
      pointerId: event.pointerId,
      startPointer: pointFromClient(event.clientX, event.clientY),
      item: { id: editable.localElement.id, frame: editable.effectiveElement.frame },
      snapToIncrement: event.shiftKey,
    };
  };

  const rotateWithKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    editable: CanvasEditableElementProjection,
  ): void => {
    const frame = canvasKeyboardRotationFrame(
      editable.localElement,
      editable.effectiveElement.frame,
      event.key,
      event.shiftKey,
    );
    if (frame === null) return;
    event.preventDefault();
    event.stopPropagation();
    const transforms = canvasTransformsToCommit(
      { [editable.localElement.id]: frame },
      [{ id: editable.localElement.id, frame: editable.effectiveElement.frame }],
      localById,
    );
    if (transforms.length > 0) onTransform(transforms);
  };

  const beginPathPoint = (
    event: ReactPointerEvent<HTMLButtonElement>,
    element: PathElement,
    commandIndex: number,
    role: PathPointRole,
  ): void => {
    if (event.button !== 0 || element.locked) return;
    event.preventDefault();
    event.stopPropagation();
    directGesture.current = {
      kind: 'path-point',
      pointerId: event.pointerId,
      element,
      commandIndex,
      role,
    };
  };

  const beginConnectorEndpoint = (
    event: ReactPointerEvent<HTMLButtonElement>,
    connector: ConnectorElement,
    endpoint: 'start' | 'end',
  ): void => {
    if (event.button !== 0 || connector.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const candidates = connectorAnchorCandidates(
      editableProjection.map((entry) => entry.effectiveElement),
      connector.id,
    );
    setConnectorAnchorPreview(candidates);
    directGesture.current = {
      kind: 'connector-endpoint',
      pointerId: event.pointerId,
      connectorId: connector.id,
      endpoint,
      candidates,
    };
  };

  const beginImageCrop = (
    event: ReactPointerEvent<HTMLButtonElement>,
    image: ImageElement,
    handle: ImageCropHandle,
  ): void => {
    if (event.button !== 0 || image.locked) return;
    event.preventDefault();
    event.stopPropagation();
    directGesture.current = {
      kind: 'image-crop',
      pointerId: event.pointerId,
      elementId: image.id,
      drag: beginImageCropDrag(
        image,
        handle,
        { xPx: event.clientX, yPx: event.clientY },
        { canvasScale: scale },
      ),
    };
  };

  const addFreeformPoint = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (vectorTool.kind !== 'freeform' || event.button !== 0) return;
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const point = clampCanvasPoint(pointFromClient(event.clientX, event.clientY), document.page);
    const next = appendDistinctCanvasPoint(freeformPoints, point, 2 / Math.max(scale, 0.25));
    updateFreeformPoints(next);
  };

  const finishFreeformFromDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (vectorTool.kind !== 'freeform' || event.target !== event.currentTarget) return;
    event.preventDefault();
    event.stopPropagation();
    const points = freeformPointsRef.current;
    if (!canFinishFreeform(points, vectorTool.closed)) return;
    updateFreeformPoints([]);
    void onCreatePath?.(points, vectorTool.closed);
    onVectorToolDone?.();
  };

  const connectorGeometries = useMemo(
    () => resolveConnectorGeometries(interactiveProjection.elements.map((entry) => entry.element)),
    [interactiveProjection],
  );
  const primaryEditable = editableProjectionByLocalId.get(selectedIds.at(-1) ?? '');
  const editablePath =
    vectorTool.kind === 'edit-path'
      ? editableProjectionByLocalId.get(vectorTool.elementId)
      : undefined;
  const effectivePath =
    editablePath?.localElement.type === 'path' && editablePath.effectiveElement.type === 'path'
      ? editablePath.effectiveElement
      : undefined;
  const effectiveConnector =
    primaryEditable?.localElement.type === 'connector' &&
    primaryEditable.effectiveElement.type === 'connector'
      ? primaryEditable.effectiveElement
      : undefined;
  const connectorGeometry =
    effectiveConnector === undefined ? undefined : connectorGeometries.get(effectiveConnector.id);
  const cropEditable =
    imageCropElementId === null || imageCropElementId === undefined
      ? undefined
      : editableProjectionByLocalId.get(imageCropElementId);
  const effectiveCropImage =
    cropEditable?.localElement.type === 'image' && cropEditable.effectiveElement.type === 'image'
      ? cropEditable.effectiveElement
      : undefined;

  const wrapperStyle = {
    width: `${document.page.widthPt * scale}px`,
    height: `${document.page.heightPt * scale}px`,
  } as CSSProperties;
  const rotationMetrics = rotationControlMetrics(scale);
  const scaledStyle = {
    width: `${document.page.widthPt}pt`,
    height: `${document.page.heightPt}pt`,
    transform: `scale(${scale * 0.75})`,
    '--canvas-rotation-target-size': `${rotationMetrics.targetSizeCssPx}px`,
    '--canvas-rotation-target-half': `${rotationMetrics.targetHalfCssPx}px`,
    '--canvas-rotation-gap': `${rotationMetrics.gapCssPx}px`,
    '--canvas-rotation-stem-length': `${rotationMetrics.stemLengthCssPx}px`,
    '--canvas-rotation-dot-size': `${rotationMetrics.dotSizeCssPx}px`,
    '--canvas-rotation-dot-half': `${rotationMetrics.dotHalfCssPx}px`,
    '--canvas-rotation-line-width': `${rotationMetrics.lineWidthCssPx}px`,
    '--canvas-rotation-line-half': `${rotationMetrics.lineHalfCssPx}px`,
  } as CSSProperties;

  return (
    <div
      ref={wrapperRef}
      className="canonical-canvas-wrapper"
      style={wrapperStyle}
      data-testid="editor-canvas-root"
    >
      <div
        className={`canonical-canvas-scaled${gridEnabled ? ' has-grid' : ''}`}
        style={scaledStyle}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) void requestSelection([]);
        }}
      >
        <SlideSurface
          slide={interactiveProjection}
          mode="editor"
          resolveAsset={(assetId) => assetUrls[assetId] ?? null}
          className="canonical-slide-surface"
        />
        <div
          className={`canvas-hit-layer${vectorTool.kind === 'freeform' ? ' is-drawing-freeform' : ''}`}
          aria-label={
            vectorTool.kind === 'freeform'
              ? `Draw ${vectorTool.closed ? 'closed' : 'open'} freeform`
              : 'Editable slide objects'
          }
          onPointerDown={addFreeformPoint}
          onDoubleClick={finishFreeformFromDoubleClick}
        >
          {editableProjection
            .filter((editable) => editable.effectiveElement.visible)
            .map((editable) => {
              const { localElement, effectiveElement } = editable;
              const frame = draftFrames[localElement.id] ?? effectiveElement.frame;
              const selected = selectedIds.includes(localElement.id);
              const primary = selectedIds.at(-1) === localElement.id;
              const rotationPlacement = rotationControlPlacement(frame, scale);
              return (
                <div
                  key={localElement.id}
                  className={`canonical-hitbox${selected ? ' is-selected' : ''}${localElement.locked ? ' is-locked' : ''}`}
                  style={frameStyle(frame)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${effectiveElement.name}, ${effectiveElement.type}${localElement.locked ? ', locked' : ''}`}
                  aria-pressed={selected}
                  data-canvas-element-id={localElement.id}
                  onPointerDown={(event) => beginMove(event, editable)}
                  onContextMenu={(event) => {
                    if (
                      event.target instanceof HTMLElement &&
                      event.target.closest('[contenteditable="true"], input, textarea') !== null
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const open = (): void =>
                      onContextMenu?.(localElement.id, {
                        clientX: event.clientX,
                        clientY: event.clientY,
                      });
                    if (selectedIds.includes(localElement.id)) open();
                    else {
                      void requestSelection([localElement.id]).then((authorized) => {
                        if (authorized) open();
                      });
                    }
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    if (localElement.type === 'text') onEditText(localElement.id);
                    else if (localElement.type === 'shape') onEditShapeText?.(localElement.id);
                    else if (localElement.type === 'image') onEditImageCrop?.(localElement.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void requestSelection([localElement.id]).then((authorized) => {
                        if (!authorized) return;
                        if (localElement.type === 'text') onEditText(localElement.id);
                        else if (localElement.type === 'shape') onEditShapeText?.(localElement.id);
                        else if (localElement.type === 'image') onEditImageCrop?.(localElement.id);
                      });
                    } else if (event.key === ' ') {
                      event.preventDefault();
                      void requestSelection([localElement.id]);
                    } else if (
                      event.key === 'ContextMenu' ||
                      (event.key === 'F10' && event.shiftKey)
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const bounds = event.currentTarget.getBoundingClientRect();
                      void requestSelection([localElement.id]).then((authorized) => {
                        if (authorized) {
                          onContextMenu?.(localElement.id, {
                            clientX: bounds.left + bounds.width / 2,
                            clientY: bounds.top + bounds.height / 2,
                          });
                        }
                      });
                    }
                  }}
                >
                  {selected &&
                  primary &&
                  !localElement.locked &&
                  !(vectorTool.kind === 'edit-path' && vectorTool.elementId === localElement.id) &&
                  imageCropElementId !== localElement.id
                    ? [
                        <span
                          key="rotation-stem"
                          className={`canonical-rotation-stem placement-${rotationPlacement}`}
                          aria-hidden="true"
                        />,
                        <button
                          key="rotation"
                          type="button"
                          className={`canonical-rotation-handle placement-${rotationPlacement}`}
                          aria-label={`Rotate ${effectiveElement.name}`}
                          title="Rotate. Hold Shift to snap to 15 degrees; use Left or Right arrow for keyboard rotation."
                          data-rotation-placement={rotationPlacement}
                          onPointerDown={(event) => beginRotate(event, editable)}
                          onKeyDown={(event) => rotateWithKeyboard(event, editable)}
                        />,
                        ...handles.map((handle) => (
                          <button
                            key={handle}
                            type="button"
                            tabIndex={-1}
                            aria-hidden="true"
                            className={`canonical-resize-handle handle-${handle}`}
                            onPointerDown={(event) => beginResize(event, editable, handle)}
                          />
                        )),
                      ]
                    : null}
                </div>
              );
            })}
          {effectiveCropImage !== undefined && !effectiveCropImage.locked ? (
            <div
              className="image-crop-overlay"
              style={frameStyle(effectiveCropImage.frame)}
              data-image-crop-id={effectiveCropImage.id}
              aria-label={`Crop ${effectiveCropImage.name}`}
            >
              {IMAGE_CROP_HANDLES.map((handle) => (
                <button
                  key={handle}
                  type="button"
                  className={`image-crop-handle crop-${handle}`}
                  aria-label={`Crop ${handle.replace('-', ' ')}`}
                  onPointerDown={(event) => beginImageCrop(event, effectiveCropImage, handle)}
                />
              ))}
              <span className="image-crop-help">
                Drag black handles to crop · Enter or Esc to finish
              </span>
            </div>
          ) : null}
          {effectivePath !== undefined && !effectivePath.locked ? (
            <div
              className="path-point-overlay"
              style={frameStyle(effectivePath.frame)}
              data-path-editing-id={effectivePath.id}
            >
              {pathPointHandles(effectivePath).map((handle) => (
                <button
                  key={`${handle.commandIndex}-${handle.role}`}
                  type="button"
                  className={`path-point-handle role-${handle.role}`}
                  style={{
                    left: `${handle.point.xPt}pt`,
                    top: `${handle.point.yPt}pt`,
                  }}
                  aria-label={`Move ${handle.role === 'anchor' ? 'path point' : `${handle.role.replace('control', 'control point ')}`} ${handle.commandIndex + 1}`}
                  onPointerDown={(event) =>
                    beginPathPoint(event, effectivePath, handle.commandIndex, handle.role)
                  }
                />
              ))}
            </div>
          ) : null}
          {vectorTool.kind !== 'freeform' &&
          effectiveConnector !== undefined &&
          connectorGeometry !== undefined &&
          !effectiveConnector.locked ? (
            <>
              {(['start', 'end'] as const).map((endpoint) => {
                const point =
                  endpoint === 'start'
                    ? connectorGeometry.startInSlide
                    : connectorGeometry.endInSlide;
                const bound = effectiveConnector[endpoint].binding.elementId !== undefined;
                return (
                  <button
                    key={endpoint}
                    type="button"
                    className={`connector-endpoint-handle endpoint-${endpoint}${bound ? ' is-bound' : ''}`}
                    style={{ left: `${point.xPt}pt`, top: `${point.yPt}pt` }}
                    aria-label={`Move connector ${endpoint} endpoint${bound ? ', currently attached' : ''}`}
                    onPointerDown={(event) =>
                      beginConnectorEndpoint(event, effectiveConnector, endpoint)
                    }
                  />
                );
              })}
            </>
          ) : null}
          {connectorAnchorPreview.map((candidate) => {
            const active =
              draftConnectorEndpoint?.snap?.elementId === candidate.elementId &&
              draftConnectorEndpoint.snap.anchor === candidate.anchor;
            return (
              <span
                key={`${candidate.elementId}-${candidate.anchor}`}
                className={`connector-anchor-target${active ? ' is-active' : ''}`}
                style={{
                  left: `${candidate.point.xPt}pt`,
                  top: `${candidate.point.yPt}pt`,
                }}
                title={`${candidate.elementName}: ${candidate.anchor}`}
                aria-hidden="true"
              />
            );
          })}
          {vectorTool.kind === 'freeform' ? (
            <div className="freeform-draft-overlay" aria-hidden="true">
              {freeformPoints.length > 0 ? (
                <svg
                  viewBox={`0 0 ${document.page.widthPt} ${document.page.heightPt}`}
                  preserveAspectRatio="none"
                >
                  <polyline
                    points={freeformPoints.map((point) => `${point.xPt},${point.yPt}`).join(' ')}
                  />
                </svg>
              ) : null}
              {freeformPoints.map((point, index) => (
                <span
                  key={`${point.xPt}-${point.yPt}-${index}`}
                  className="freeform-draft-point"
                  style={{ left: `${point.xPt}pt`, top: `${point.yPt}pt` }}
                />
              ))}
              <span className="freeform-draft-help">
                Click to add points · {vectorTool.closed ? '3 points minimum' : '2 points minimum'}{' '}
                · Enter or double-click to finish · Esc to cancel
              </span>
            </div>
          ) : null}
          {inlineTextEditor !== null && inlineTextEditor !== undefined
            ? (() => {
                const editable = editableProjectionByLocalId.get(inlineTextEditor.elementId);
                return (editable?.localElement.type === 'text' ||
                  editable?.localElement.type === 'shape') &&
                  (editable.effectiveElement.type === 'text' ||
                    editable.effectiveElement.type === 'shape') &&
                  editable.localElement.type === editable.effectiveElement.type &&
                  onInlineTextChange !== undefined &&
                  onInlineTextPaste !== undefined &&
                  onInlineTextCommit !== undefined &&
                  onInlineTextCancel !== undefined &&
                  onInlineTextFocus !== undefined ? (
                  <InlineTextCanvasEditorOverlay
                    element={editable.effectiveElement}
                    editor={inlineTextEditor}
                    onChange={onInlineTextChange}
                    onPaste={onInlineTextPaste}
                    onCommit={onInlineTextCommit}
                    onCancel={onInlineTextCancel}
                    onFocus={onInlineTextFocus}
                  />
                ) : null;
              })()
            : null}
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
