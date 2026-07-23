import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignStartHorizontal,
  AlignStartVertical,
  ArrowDown,
  ArrowUp,
  Bold,
  BringToFront,
  Check,
  ChevronDown,
  ClipboardPaste,
  Code2,
  Columns3,
  Copy,
  Download,
  Eye,
  EyeOff,
  Flag,
  FolderOpen,
  Grid3X3,
  Group,
  Image,
  Italic,
  Layers3,
  Link2,
  List,
  ListOrdered,
  Lock,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Palette,
  Play,
  Plus,
  Redo2,
  Rows3,
  Save,
  Scissors,
  SendToBack,
  Share2,
  SlidersHorizontal,
  Smile,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Type,
  Underline,
  Undo2,
  Ungroup,
  Unlock,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  createBlankTheme,
  createBoundedPageSize,
  createDuplicateSlide,
  resetElementThemeStyles,
  resolveSlide,
  resolveSlideFromValidatedDocument,
  STANDARD_PAGE_SIZES,
  type DeckDocument,
  type DocumentCommand,
  type Element,
  type Frame,
  type Guide,
  type ImageElement,
  type ConnectorElement,
  type Layout,
  type Master,
  type PlaceholderElement,
  type RichTextDocument,
  type Slide,
  type TableElement,
  type TextStyle,
  type TextAlignment,
  type TextElement,
  type TextMarks,
  type TextStyleRole,
  type Theme,
} from '@htmllelujah/document-core';
import { alignItems, distributeItems } from '@htmllelujah/geometry';
import { SlideSurface, type CatalogId, type ContentCatalogEntry } from '@htmllelujah/renderer';
import type { RecoveryCandidate } from '@htmllelujah/document-runtime';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type {
  CollaborationStatus,
  CollaborationTextLeaseInput,
  CollaborationTextLeaseStatus,
  DesktopResult,
  McpStatus,
  SessionView,
} from '../shared/desktop-api';
import htmllelujahAppIcon from '../../assets/htmllelujah-app-icon.svg';
import { reconcileHostAddressSelection } from './collaboration-host-address';
import { EditorButton } from './components/EditorButton';
import { CanonicalSlideCanvas, sameCanvasSelection } from './components/CanonicalSlideCanvas';
import { CollaborationParticipants } from './components/CollaborationParticipants';
import { ContentCatalogPicker } from './components/ContentCatalogPicker';
import {
  applyCanonicalTableMutation,
  type TableCommandFactory,
} from './editor/canonical-table-mutations';
import {
  contentFromPlainText,
  contentToPlainText,
  createConnectorElement,
  createIconElement,
  createShapeElement,
  createSlide,
  createTableElement,
  createTextElement,
  duplicateElements,
  duplicateTemplateElements,
  emptyMarks,
  headingLevelOf,
  plainParagraph,
  replacePlainTextPreservingStyles,
  updateRichTextPresentation,
  updateHeadingLevel,
  type HeadingLevel,
} from './editor/canonical-factories';
import {
  createDesignCanvasContext,
  duplicateThemeWithFreshIds,
  rebaseEntityReplacement,
  retainExistingCanvasSelection,
  replaceElementFrames,
  themeForSlide,
  themeRoleStyle,
  updateThemeFontFamily,
  updateThemeRoleStyle,
  type DesignSurface,
} from './editor/design-editor';
import {
  activeElementNeedsBlurCommit,
  adjacentSlideIndex,
  BlurCommitBarrier,
  canAutoCommitInlineText,
  closeExecutionMayStart,
  CorrelatedCloseSeal,
  CloseExecutionBarrier,
  consumeInlineTextBlurSuppression,
  inlineTextCanCloseWithoutApply,
  retainInlineTextEditingTarget,
  runInlineTextCommitOnce,
  settleBooleanBeforeDeadline,
  shouldPreserveDetachedTextDraft,
  textDraftAutosaveMayAttempt,
  textDraftTargetHasChanged,
} from './editor/editor-interactions';
import {
  calculateFitScale,
  clampManualZoomPercent,
  effectiveZoomPercent,
  MANUAL_ZOOM_MAX_PERCENT,
  MANUAL_ZOOM_MIN_PERCENT,
  resolveCanvasScale,
  stepCanvasZoom,
  type CanvasZoom,
} from './editor/editor-viewport';
import {
  replaceRichTextRange,
  RICH_CLIPBOARD_LIMITS,
  RichClipboardError,
  sanitizeClipboardHtml,
} from './editor/rich-clipboard';
import {
  deserializeObjectClipboard,
  OBJECT_CLIPBOARD_MIME,
  serializeObjectClipboard,
  validateObjectClipboardPaste,
} from './editor/object-clipboard';

const menuItems = ['File', 'Edit', 'View', 'Insert', 'Arrange', 'Help'] as const;
const themeTextStyleRoles: readonly TextStyleRole[] = [
  'title',
  'subtitle',
  'body',
  'caption',
  'label',
  'quote',
];
type MenuItem = (typeof menuItems)[number];
type InspectorTab = 'properties' | 'design';
type Toast = { readonly kind: 'success' | 'error' | 'info'; readonly message: string };
type ObjectContextMenu = Readonly<{ x: number; y: number; elementId: string }>;
type ContentPickerState = Readonly<{
  initialCatalog: CatalogId;
  catalogs: readonly CatalogId[];
  replaceElementId?: string | undefined;
}>;
type MutableTextMarksPatch = {
  -readonly [Key in keyof TextMarks]?: TextMarks[Key];
};

const sameTextLeaseRequest = (
  left: CollaborationTextLeaseInput | null,
  right: CollaborationTextLeaseInput | null,
): boolean =>
  left !== null &&
  right !== null &&
  left.sessionId === right.sessionId &&
  left.slideId === right.slideId &&
  left.elementId === right.elementId;

type TextDraft = {
  readonly text: string;
  readonly kind: 'paragraph' | 'heading' | 'bullets' | 'numbered';
  readonly headingLevel: HeadingLevel;
  readonly contentOverride: RichTextDocument | null;
  readonly role: TextStyleRole;
  readonly alignment: TextAlignment;
  readonly fontFamily: string;
  readonly fontSizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  readonly color: string;
  readonly lineHeight: number;
  readonly letterSpacingPt: number;
  readonly listLevel: number;
};

type CommandSource =
  readonly DocumentCommand[] | ((document: DeckDocument) => readonly DocumentCommand[]);

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

const firstMarks = (content: RichTextDocument): TextMarks => {
  const block = content.blocks[0];
  const run = block?.type === 'list' ? block.items[0]?.runs[0] : block?.runs[0];
  return run?.marks ?? emptyMarks();
};

const textKind = (content: RichTextDocument): TextDraft['kind'] => {
  const block = content.blocks[0];
  if (block?.type === 'heading') return 'heading';
  if (block?.type === 'list') return block.ordered ? 'numbered' : 'bullets';
  return 'paragraph';
};

const textAlignment = (element: TextElement): TextAlignment => {
  const block = element.content.blocks[0];
  if (block !== undefined && block.type !== 'list') return block.alignment;
  return element.style?.alignment ?? 'left';
};

const initialTextDraft = (element: TextElement, theme: Theme | undefined): TextDraft => {
  const marks = firstMarks(element.content);
  const firstBlock = element.content.blocks[0];
  const roleStyle = theme?.textStyles.find((style) => style.role === element.styleRole);
  return {
    text: contentToPlainText(element.content),
    kind: textKind(element.content),
    headingLevel: headingLevelOf(element.content),
    contentOverride: null,
    role: element.styleRole,
    alignment: textAlignment(element),
    fontFamily:
      element.style?.fontFamily ?? roleStyle?.fontFamily ?? theme?.bodyFontFamily ?? 'Arial',
    fontSizePt: element.style?.fontSizePt ?? roleStyle?.fontSizePt ?? 16,
    bold:
      marks.bold ||
      (marks.fontWeight ?? element.style?.fontWeight ?? roleStyle?.fontWeight ?? 400) >= 600,
    italic: marks.italic || (element.style?.italic ?? false),
    underline: marks.underline,
    strikethrough: marks.strikethrough,
    color:
      marks.color ?? element.style?.color ?? roleStyle?.color ?? theme?.colors.text ?? '#172033',
    lineHeight: element.style?.lineHeight ?? roleStyle?.lineHeight ?? 1.25,
    letterSpacingPt: element.style?.letterSpacingPt ?? 0,
    listLevel: firstBlock?.type === 'list' ? (firstBlock.items[0]?.level ?? 0) : 0,
  };
};

const textEditingFingerprint = (element: TextElement, theme: Theme | undefined): string =>
  JSON.stringify({
    locked: element.locked,
    styleRole: element.styleRole,
    verticalAlignment: element.verticalAlignment,
    content: element.content,
    style: element.style,
    resolvedDraft: initialTextDraft(element, theme),
  });

type AuthoringSurfaceReference =
  | Readonly<{ surface: 'slide'; id: string }>
  | Readonly<{ surface: 'layout'; id: string }>
  | Readonly<{ surface: 'master'; id: string }>;

const elementsForAuthoringSurface = (
  document: DeckDocument,
  reference: AuthoringSurfaceReference,
): readonly Element[] =>
  reference.surface === 'slide'
    ? (document.slides.find((slide) => slide.id === reference.id)?.elements ?? [])
    : reference.surface === 'layout'
      ? (document.layouts.find((layout) => layout.id === reference.id)?.elements ?? [])
      : (document.masters.find((master) => master.id === reference.id)?.elements ?? []);

const themeForAuthoringSurface = (
  document: DeckDocument,
  reference: AuthoringSurfaceReference,
): Theme | undefined => {
  if (reference.surface === 'slide') {
    const slide = document.slides.find((candidate) => candidate.id === reference.id);
    return slide === undefined ? document.themes[0] : themeForSlide(document, slide);
  }
  const master =
    reference.surface === 'master'
      ? document.masters.find((candidate) => candidate.id === reference.id)
      : document.masters.find(
          (candidate) =>
            candidate.id ===
            document.layouts.find((layout) => layout.id === reference.id)?.masterId,
        );
  return (
    document.themes.find((candidate) => candidate.id === master?.themeId) ?? document.themes[0]
  );
};

const duplicateGuides = (guides: readonly Guide[]): readonly Guide[] =>
  guides.map((guide) => ({ ...guide, id: crypto.randomUUID() }));

const boundPlaceholderIds = (elements: readonly Element[]): ReadonlySet<string> => {
  const result = new Set<string>();
  const visit = (items: readonly Element[]): void => {
    for (const element of items) {
      if (element.placeholderBinding !== undefined)
        result.add(element.placeholderBinding.placeholderId);
      if (element.type === 'group') visit(element.children);
    }
  };
  visit(elements);
  return result;
};

const createPlaceholder = (
  role: PlaceholderElement['role'],
  page: DeckDocument['page'],
): PlaceholderElement => {
  const titleLike = role === 'title' || role === 'subtitle';
  const mediaLike = role === 'media' || role === 'table';
  return {
    id: crypto.randomUUID(),
    type: 'placeholder',
    name: `${role.slice(0, 1).toUpperCase()}${role.slice(1)} placeholder`,
    frame: {
      xPt: page.widthPt * 0.08,
      yPt: titleLike ? page.heightPt * 0.1 : page.heightPt * 0.28,
      widthPt: page.widthPt * 0.84,
      heightPt: titleLike ? page.heightPt * 0.14 : page.heightPt * 0.56,
      rotationDeg: 0,
    },
    opacity: 1,
    visible: true,
    locked: false,
    role,
    accepts:
      role === 'media' ? ['image', 'shape', 'icon'] : role === 'table' ? ['table'] : ['text'],
    prompt: mediaLike ? `Add ${role}` : `Add ${role} text`,
  };
};

const safeErrorMessage = <T,>(result: DesktopResult<T>): string | undefined =>
  result.ok ? undefined : result.error.message;

function LoadingScreen({ message }: { readonly message: string }) {
  return (
    <main className="loading-screen" aria-live="polite">
      <img
        className="brand-mark loading-mark"
        src={htmllelujahAppIcon}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <strong>HTMLlelujah</strong>
      <span>{message}</span>
    </main>
  );
}

function PresentationMode() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestedStart = new URLSearchParams(window.location.search).get('startSlideId');
  const [index, setIndex] = useState(0);
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    void window.htmllelujah.initialize().then((result) => {
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSession(result.value.session);
      const visible = result.value.session.snapshot.document.slides.filter(
        (slide) => !slide.hidden,
      );
      const startIndex =
        requestedStart === null ? -1 : visible.findIndex((slide) => slide.id === requestedStart);
      setIndex(startIndex < 0 ? 0 : startIndex);
    });
  }, [requestedStart]);

  useEffect(() => {
    const resize = (): void =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    if (session === null) return;
    const remove = window.htmllelujah.onDocumentChanged((event) => {
      if (
        event.sessionId !== session.snapshot.sessionId ||
        event.revision === session.snapshot.revision
      )
        return;
      void window.htmllelujah.initialize().then((result) => {
        if (result.ok) setSession(result.value.session);
      });
    });
    return remove;
  }, [session]);

  const slides = session?.snapshot.document.slides.filter((slide) => !slide.hidden) ?? [];
  const active = slides[index] ?? slides[0];
  const go = useCallback(
    (next: number) => setIndex(clamp(next, 0, Math.max(0, slides.length - 1))),
    [slides.length],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        go(index + 1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) {
        event.preventDefault();
        go(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        go(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        go(slides.length - 1);
      } else if (event.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [go, index, slides.length]);

  if (error !== null) return <LoadingScreen message={error} />;
  if (session === null) return <LoadingScreen message="Preparing presentation…" />;
  if (slides.length === 0)
    return (
      <LoadingScreen message="This presentation has no visible slides. Press Escape to close." />
    );
  if (active === undefined) return <LoadingScreen message="Preparing presentation…" />;
  const projection = resolveSlideFromValidatedDocument(session.snapshot.document, active.id);
  const rawWidth = projection.page.widthPt * (4 / 3);
  const rawHeight = projection.page.heightPt * (4 / 3);
  const presentationScale = Math.min(viewport.width / rawWidth, viewport.height / rawHeight);
  return (
    <main
      className="presentation-stage"
      data-testid="presentation-root"
      onClick={(event) => go(event.clientX < window.innerWidth / 3 ? index - 1 : index + 1)}
    >
      <div
        className="presentation-slide-frame"
        style={{ width: rawWidth * presentationScale, height: rawHeight * presentationScale }}
      >
        <div
          className="presentation-slide-scaled"
          style={{ transform: `scale(${presentationScale})` }}
        >
          <SlideSurface
            slide={projection}
            mode="presentation"
            resolveAsset={(assetId) => session.assetUrls[assetId] ?? null}
          />
        </div>
      </div>
      <div className="presentation-counter" aria-live="polite">
        {index + 1} / {slides.length}
      </div>
      <div className="presentation-help">← → navigate · Esc close</div>
    </main>
  );
}

function SlideThumbnail({
  document,
  slide,
  assetUrls,
  index,
  selected,
  onSelect,
  onReorder,
}: {
  readonly document: DeckDocument;
  readonly slide: Slide;
  readonly assetUrls: Readonly<Record<string, string>>;
  readonly index: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly onReorder: (direction: -1 | 1) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(128);
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (button === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const style = window.getComputedStyle(button);
      const firstColumnWidth = Number.parseFloat(style.gridTemplateColumns) || 20;
      const columnGap = Number.parseFloat(style.columnGap) || 5;
      const available = Math.floor(entry.contentRect.width - firstColumnWidth - columnGap);
      setWidth((current) => {
        const next = clamp(available, 96, 174);
        return Math.abs(current - next) >= 1 ? next : current;
      });
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, []);
  const scale = width / (document.page.widthPt * (4 / 3));
  const height = document.page.heightPt * (4 / 3) * scale;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`canonical-thumbnail${selected ? ' is-selected' : ''}${slide.hidden ? ' is-hidden' : ''}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        onReorder(event.key === 'ArrowUp' ? -1 : 1);
      }}
      aria-label={`Slide ${index + 1}: ${slide.name}${slide.hidden ? ', hidden' : ''}`}
      aria-description="Press Alt plus Up or Down arrow to reorder this slide."
      aria-current={selected ? 'page' : undefined}
    >
      <span className="thumbnail-number">{index + 1}</span>
      <span className="thumbnail-surface" style={{ width, height }}>
        <span className="thumbnail-scaled" style={{ transform: `scale(${scale})` }}>
          <SlideSurface
            slide={resolveSlide(document, slide.id)}
            mode="thumbnail"
            resolveAsset={(assetId) => assetUrls[assetId] ?? null}
          />
        </span>
      </span>
      <span className="thumbnail-title">{slide.name}</span>
      {slide.hidden ? (
        <EyeOff size={12} className="thumbnail-hidden-icon" aria-hidden="true" />
      ) : null}
    </button>
  );
}

function MenuButton({
  children,
  onClick,
  disabled = false,
}: {
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function EditorApp() {
  const [session, setSession] = useState<SessionView | null>(null);
  const sessionRef = useRef<SessionView | null>(null);
  const [activeSlideId, setActiveSlideId] = useState('');
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [zoom, setZoom] = useState<CanvasZoom>({ mode: 'fit' });
  const [fitScale, setFitScale] = useState(0.72);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties');
  const [activeMenu, setActiveMenu] = useState<MenuItem | null>(null);
  const [objectContextMenu, setObjectContextMenu] = useState<ObjectContextMenu | null>(null);
  const objectContextMenuRef = useRef<HTMLDivElement>(null);
  const [contentPicker, setContentPicker] = useState<ContentPickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [hostAddress, setHostAddress] = useState('');
  const hostAddressNeedsConfirmationRef = useRef(false);
  const [shareStatus, setShareStatus] = useState<CollaborationStatus | null>(null);
  const acceptShareStatus = useCallback((next: CollaborationStatus): void => {
    setShareStatus((current) =>
      current !== null && JSON.stringify(current) === JSON.stringify(next) ? current : next,
    );
    if (next.mode === 'offline' && next.availableHostAddresses !== undefined) {
      setHostAddress((current) => {
        const reconciled = reconcileHostAddressSelection(
          current,
          next.availableHostAddresses ?? [],
          hostAddressNeedsConfirmationRef.current,
        );
        hostAddressNeedsConfirmationRef.current = reconciled.requiresConfirmation;
        return reconciled.address;
      });
    }
  }, []);
  const [decidingJoinId, setDecidingJoinId] = useState<string | null>(null);
  const [collaborationDecisionError, setCollaborationDecisionError] = useState<string | null>(null);
  const [collaborationNowMs, setCollaborationNowMs] = useState(() => Date.now());
  const [displayName, setDisplayName] = useState('Presenter');
  const [discovery, setDiscovery] = useState(false);
  const [joinEndpoint, setJoinEndpoint] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinFingerprint, setJoinFingerprint] = useState('');
  const [startingCollaboration, setStartingCollaboration] = useState(false);
  const startingCollaborationRef = useRef(false);
  const [joiningCollaboration, setJoiningCollaboration] = useState(false);
  const joiningCollaborationRef = useRef(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<readonly RecoveryCandidate[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [textDraftConflict, setTextDraftConflict] = useState(false);
  const [textApplyPending, setTextApplyPending] = useState(false);
  const [textEditingLocked, setTextEditingLocked] = useState(false);
  const [inlineTextElementId, setInlineTextElementId] = useState<string | null>(null);
  const [textLeaseStatus, setTextLeaseStatus] = useState<CollaborationTextLeaseStatus | null>(null);
  const [textLeasePending, setTextLeasePending] = useState(false);
  const textBaselineRef = useRef<{ readonly id: string; readonly value: string } | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  const textDraftDirtyRef = useRef(false);
  const textDraftConflictRef = useRef(false);
  const inlineTextElementIdRef = useRef<string | null>(null);
  const textApplyInFlightRef = useRef<Promise<boolean> | null>(null);
  const textEditingLockedRef = useRef(false);
  const inlineCommitInFlightRef = useRef(false);
  const inlineCommitPromiseRef = useRef<Promise<boolean> | null>(null);
  const suppressNextInlineBlurRef = useRef(false);
  const textLeasePendingRef = useRef(false);
  const textLeaseRequestRef = useRef<CollaborationTextLeaseInput | null>(null);
  const textEditorFocusedRef = useRef(false);
  const objectClipboardRef = useRef<string | null>(null);
  const objectClipboardPlainTextRef = useRef<string | null>(null);
  const textDraftVersionRef = useRef(0);
  const textDraftAutosaveFailedVersionRef = useRef<number | null>(null);
  const [tableTsv, setTableTsv] = useState('');
  const [selectedTableCellId, setSelectedTableCellId] = useState('');
  const [designMasterId, setDesignMasterId] = useState('');
  const [designLayoutId, setDesignLayoutId] = useState('');
  const [designThemeId, setDesignThemeId] = useState('');
  const [designSurface, setDesignSurface] = useState<DesignSurface>('slide');
  const [customPageWidthPt, setCustomPageWidthPt] = useState(960);
  const [customPageHeightPt, setCustomPageHeightPt] = useState(540);
  const [customPageEditorOpen, setCustomPageEditorOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const executeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExecuteCountRef = useRef(0);
  const canLeaveInlineTextEditorRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const closePreparationInFlightRef = useRef(false);
  const allowExecuteDuringCloseBlurRef = useRef(false);
  const closeExecutionAdmissionSealedRef = useRef(false);
  const correlatedCloseSealRef = useRef(new CorrelatedCloseSeal());
  const blurCommitBarrierRef = useRef(new BlurCommitBarrier<object>());
  const closeExecutionBarrierRef = useRef(new CloseExecutionBarrier());
  const tableTsvDraftCommitKeyRef = useRef({ kind: 'table-tsv-draft' as const });

  const acceptSession = useCallback((next: SessionView): void => {
    sessionRef.current = next;
    setSession(next);
    setActiveSlideId((current) =>
      next.snapshot.document.slides.some((slide) => slide.id === current)
        ? current
        : (next.snapshot.document.slides[0]?.id ?? ''),
    );
    setSelectedIds((current) => retainExistingCanvasSelection(next.snapshot.document, current));
  }, []);

  const notify = useCallback((message: string, kind: Toast['kind'] = 'info'): void => {
    setToast({ message, kind });
  }, []);

  const commitOnBlur = useCallback(
    (target: object, action: () => boolean | Promise<boolean>): Promise<boolean> =>
      blurCommitBarrierRef.current.attempt(target, action),
    [],
  );

  const restoreBlurValue = useCallback(
    (
      target: HTMLInputElement | HTMLTextAreaElement,
      persistedValue: string | number,
      message?: string,
    ): boolean => {
      target.value = String(persistedValue);
      if (message !== undefined) notify(message, 'error');
      return true;
    },
    [notify],
  );

  const updateTextDraftDirty = useCallback((dirty: boolean): void => {
    textDraftDirtyRef.current = dirty;
    setTextDraftDirty(dirty);
  }, []);

  const updateTextDraft = useCallback((draft: TextDraft | null): void => {
    textDraftRef.current = draft;
    setTextDraft(draft);
  }, []);

  const updateTextDraftConflict = useCallback((conflict: boolean): void => {
    textDraftConflictRef.current = conflict;
    setTextDraftConflict(conflict);
  }, []);

  const updateInlineTextElementId = useCallback((elementId: string | null): void => {
    inlineTextElementIdRef.current = elementId;
    setInlineTextElementId(elementId);
  }, []);

  const editTextDraft = useCallback(
    (next: TextDraft): void => {
      if (textEditingLockedRef.current) return;
      textDraftVersionRef.current += 1;
      updateTextDraft(next);
      updateTextDraftDirty(true);
    },
    [updateTextDraft, updateTextDraftDirty],
  );

  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    void window.htmllelujah.initialize().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setFatalError(result.error.message);
        return;
      }
      acceptSession(result.value.session);
      void window.htmllelujah
        .collaborationStatus({ sessionId: result.value.session.snapshot.sessionId })
        .then((status) => {
          if (active && status.ok) acceptShareStatus(status.value);
        })
        .catch(() => undefined);
      setRecoveryCandidates(result.value.recoveryCandidates);
      if (result.value.recoveryCandidates.length > 0) {
        notify(
          `${result.value.recoveryCandidates.length} recoverable presentation${result.value.recoveryCandidates.length > 1 ? 's' : ''} found.`,
          'info',
        );
      }
    });
    const remove = window.htmllelujah.onDocumentChanged((event) => {
      const current = sessionRef.current;
      if (
        current === null ||
        (event.sessionId === current.snapshot.sessionId &&
          event.revision === current.snapshot.revision)
      )
        return;
      void window.htmllelujah.initialize().then((result) => {
        if (active && result.ok) acceptSession(result.value.session);
      });
    });
    return () => {
      active = false;
      remove();
    };
  }, [acceptSession, acceptShareStatus, notify]);

  const collaborationSessionId = session?.snapshot.sessionId;
  useEffect(() => {
    if (
      collaborationSessionId === undefined ||
      (!shareOpen && shareStatus?.mode !== 'host' && shareStatus?.mode !== 'guest')
    ) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await window.htmllelujah.collaborationStatus({
          sessionId: collaborationSessionId,
        });
        if (!cancelled && result.ok) acceptShareStatus(result.value);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [acceptShareStatus, collaborationSessionId, shareOpen, shareStatus?.mode]);

  useEffect(() => {
    if (!shareOpen || (shareStatus?.pendingJoins.length ?? 0) === 0) return;
    setCollaborationNowMs(Date.now());
    const timer = window.setInterval(() => setCollaborationNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [shareOpen, shareStatus?.pendingJoins.length]);

  const document = session?.snapshot.document;
  const activeSlide = useMemo(
    () => document?.slides.find((slide) => slide.id === activeSlideId) ?? document?.slides[0],
    [activeSlideId, document],
  );
  const designMaster = document?.masters.find((master) => master.id === designMasterId);
  const designLayout = document?.layouts.find((layout) => layout.id === designLayoutId);
  const designTheme = document?.themes.find((theme) => theme.id === designThemeId);
  const activeAuthoringSurface: DesignSurface = designSurface;
  const activeAuthoringReference: AuthoringSurfaceReference =
    activeAuthoringSurface === 'master'
      ? { surface: 'master', id: designMaster?.id ?? '' }
      : activeAuthoringSurface === 'layout'
        ? { surface: 'layout', id: designLayout?.id ?? '' }
        : { surface: 'slide', id: activeSlide?.id ?? '' };
  const activeAuthoringTheme =
    document === undefined
      ? undefined
      : themeForAuthoringSurface(document, activeAuthoringReference);
  const activeSurfaceElements = useMemo(
    () =>
      activeAuthoringSurface === 'master'
        ? (designMaster?.elements ?? [])
        : activeAuthoringSurface === 'layout'
          ? (designLayout?.elements ?? [])
          : (activeSlide?.elements ?? []),
    [activeAuthoringSurface, activeSlide?.elements, designLayout?.elements, designMaster?.elements],
  );
  const selectedElements = useMemo(
    () => activeSurfaceElements.filter((element) => selectedIds.includes(element.id)),
    [activeSurfaceElements, selectedIds],
  );
  const primaryElement = selectedElements.at(-1);
  const primaryText = primaryElement?.type === 'text' ? primaryElement : undefined;
  const primaryThemeReset = useMemo(
    () =>
      primaryElement === undefined ||
      activeAuthoringTheme === undefined ||
      primaryElement.type === 'image'
        ? undefined
        : resetElementThemeStyles(primaryElement, activeAuthoringTheme),
    [activeAuthoringTheme, primaryElement],
  );
  const primaryStyleSource = useMemo(() => {
    if (primaryElement === undefined) return 'No object selected';
    if (primaryElement.type === 'image') return 'Local asset style';
    const matchesTheme =
      primaryThemeReset !== undefined &&
      JSON.stringify(primaryThemeReset) === JSON.stringify(primaryElement);
    const styleOverride = primaryElement.placeholderBinding?.overrides.includes('style') ?? false;
    if (activeAuthoringSurface !== 'slide') {
      return matchesTheme ? 'Template default · theme-managed' : 'Template local override';
    }
    if (primaryElement.placeholderBinding !== undefined) {
      if (styleOverride) return matchesTheme ? 'Theme-managed override' : 'Local style override';
      return matchesTheme ? 'Inherited from layout · theme-managed' : 'Inherited + local style';
    }
    return matchesTheme ? 'Theme-managed local object' : 'Local style override';
  }, [activeAuthoringSurface, primaryElement, primaryThemeReset]);
  const textDraftMatchesPrimary =
    primaryText !== undefined && textBaselineRef.current?.id === primaryText.id;
  const hasOrphanedTextDraft = textDraft !== null && textDraftDirty && !textDraftMatchesPrimary;
  const renderedTextDraftVersion = textDraftVersionRef.current;
  const primaryImage = primaryElement?.type === 'image' ? primaryElement : undefined;
  const primaryTable = primaryElement?.type === 'table' ? primaryElement : undefined;
  const selectedTableCell = primaryTable?.cells.find((cell) => cell.id === selectedTableCellId);
  const designSelectedElement =
    designSurface === 'master'
      ? designMaster?.elements.find((element) => element.id === selectedIds.at(-1))
      : designSurface === 'layout'
        ? designLayout?.elements.find((element) => element.id === selectedIds.at(-1))
        : undefined;
  const canvasScale = resolveCanvasScale(zoom, fitScale);
  const zoomPercent = effectiveZoomPercent(zoom, fitScale);

  useEffect(() => {
    if (document === undefined) return;
    setCustomPageWidthPt(document.page.widthPt);
    setCustomPageHeightPt(document.page.heightPt);
    setCustomPageEditorOpen(
      !Object.values(STANDARD_PAGE_SIZES).some(
        (page) =>
          page.widthPt === document.page.widthPt && page.heightPt === document.page.heightPt,
      ),
    );
  }, [document?.page.heightPt, document?.page.widthPt]);

  useLayoutEffect(() => {
    const retained = retainInlineTextEditingTarget(inlineTextElementId, primaryText?.id);
    if (retained === inlineTextElementId) return;
    textEditorFocusedRef.current = false;
    updateInlineTextElementId(retained);
  }, [inlineTextElementId, primaryText?.id, updateInlineTextElementId]);

  useEffect(() => {
    if (
      session === null ||
      (shareStatus?.mode !== 'host' && shareStatus?.mode !== 'guest') ||
      activeAuthoringSurface !== 'slide' ||
      activeSlide === undefined
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.htmllelujah
        .collaborationUpdatePresence({
          sessionId: session.snapshot.sessionId,
          slideId: activeSlide.id,
          selectedElementIds: selectedIds.slice(0, 100),
          ...(inlineTextElementId === null && !(textDraftDirty && primaryText !== undefined)
            ? {}
            : { editingElementId: inlineTextElementId ?? primaryText?.id }),
        })
        .then((result) => {
          if (!cancelled && result.ok) acceptShareStatus(result.value);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeSlide,
    activeAuthoringSurface,
    acceptShareStatus,
    inlineTextElementId,
    primaryText,
    selectedIds,
    session,
    shareStatus?.mode,
    textDraftDirty,
  ]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace === null || document === undefined) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const style = window.getComputedStyle(workspace);
      const horizontalPadding =
        Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      const verticalPadding =
        Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
      const availableWidth = Math.max(1, workspace.clientWidth - horizontalPadding);
      const availableHeight = Math.max(1, workspace.clientHeight - verticalPadding);
      setFitScale(
        calculateFitScale({ widthPx: availableWidth, heightPx: availableHeight }, document.page),
      );
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [document]);

  useEffect(() => {
    if (
      shouldPreserveDetachedTextDraft(
        textDraftDirtyRef.current,
        textDraft !== null,
        textBaselineRef.current?.id,
        primaryText?.id,
      )
    ) {
      updateTextDraftConflict(true);
      return;
    }
    if (primaryText === undefined || document === undefined) {
      textDraftVersionRef.current += 1;
      updateTextDraft(null);
      updateTextDraftDirty(false);
      updateTextDraftConflict(false);
      textBaselineRef.current = null;
      return;
    }
    const value = textEditingFingerprint(primaryText, activeAuthoringTheme);
    const baseline = textBaselineRef.current;
    if (baseline === null || baseline.id !== primaryText.id) {
      textDraftVersionRef.current += 1;
      updateTextDraft(initialTextDraft(primaryText, activeAuthoringTheme));
      updateTextDraftDirty(false);
      updateTextDraftConflict(false);
      textBaselineRef.current = { id: primaryText.id, value };
      return;
    }
    if (baseline.value === value) return;
    if (textDraftDirty) {
      updateTextDraftConflict(true);
      return;
    }
    textDraftVersionRef.current += 1;
    updateTextDraft(initialTextDraft(primaryText, activeAuthoringTheme));
    updateTextDraftConflict(false);
    textBaselineRef.current = { id: primaryText.id, value };
  }, [
    activeAuthoringTheme,
    document,
    primaryText,
    textDraft,
    textDraftDirty,
    updateTextDraftConflict,
    updateTextDraft,
    updateTextDraftDirty,
  ]);

  useEffect(() => {
    if (primaryTable === undefined) {
      setSelectedTableCellId('');
      return;
    }
    setSelectedTableCellId((current) =>
      primaryTable.cells.some((cell) => cell.id === current)
        ? current
        : (primaryTable.cells[0]?.id ?? ''),
    );
  }, [primaryTable?.id, session?.snapshot.revision]);

  useEffect(() => {
    if (document === undefined || activeSlide === undefined) return;
    const activeLayout = document.layouts.find((layout) => layout.id === activeSlide.layoutId);
    setDesignLayoutId((current) =>
      document.layouts.some((layout) => layout.id === current)
        ? current
        : (activeLayout?.id ?? document.layouts[0]?.id ?? ''),
    );
    setDesignMasterId((current) =>
      document.masters.some((master) => master.id === current)
        ? current
        : (activeLayout?.masterId ?? document.masters[0]?.id ?? ''),
    );
    const activeMaster = document.masters.find((master) => master.id === activeLayout?.masterId);
    setDesignThemeId((current) =>
      document.themes.some((theme) => theme.id === current)
        ? current
        : (activeMaster?.themeId ?? document.themes[0]?.id ?? ''),
    );
  }, [activeSlide?.id, document?.id, session?.snapshot.revision]);

  const showFailure = useCallback(
    (result: DesktopResult<unknown>): void => {
      if (result.ok || result.error.code === 'CANCELLED') return;
      notify(result.error.message, 'error');
      if (result.error.code === 'REVISION_CONFLICT') {
        void window.htmllelujah.initialize().then((refresh) => {
          if (refresh.ok) acceptSession(refresh.value.session);
        });
      }
    },
    [acceptSession, notify],
  );

  const releaseTextLease = useCallback(
    async (
      requested: CollaborationTextLeaseInput | null = textLeaseRequestRef.current,
      reportFailure = false,
    ): Promise<void> => {
      if (requested === null) return;
      if (sameTextLeaseRequest(textLeaseRequestRef.current, requested)) {
        textLeaseRequestRef.current = null;
        textLeasePendingRef.current = false;
        setTextLeaseStatus(null);
        setTextLeasePending(false);
      }
      await executeQueueRef.current.catch(() => undefined);
      const result = await window.htmllelujah
        .collaborationTextLeaseEnd(requested)
        .catch(() => undefined);
      if (
        reportFailure &&
        result !== undefined &&
        !result.ok &&
        !['INVALID_LOCK_TOKEN', 'INVALID_REQUEST', 'NOT_FOUND'].includes(result.error.code)
      ) {
        showFailure(result);
      }
    },
    [showFailure],
  );

  const beginTextLease = useCallback(async (): Promise<void> => {
    if (textLeasePendingRef.current) return;
    const current = sessionRef.current;
    if (
      current === null ||
      activeAuthoringSurface !== 'slide' ||
      activeSlide === undefined ||
      primaryText === undefined ||
      shareStatus?.mode === undefined ||
      shareStatus.mode === 'offline'
    ) {
      textLeasePendingRef.current = false;
      setTextLeasePending(false);
      setTextLeaseStatus(null);
      return;
    }
    const requested: CollaborationTextLeaseInput = {
      sessionId: current.snapshot.sessionId,
      slideId: activeSlide.id,
      elementId: primaryText.id,
    };
    if (
      sameTextLeaseRequest(textLeaseRequestRef.current, requested) &&
      textLeaseStatus?.status === 'owned' &&
      textLeaseStatus.expiresAtMs > Date.now() + 1_000
    ) {
      return;
    }
    textLeasePendingRef.current = true;
    setTextLeasePending(true);
    const previous = textLeaseRequestRef.current;
    if (previous !== null && !sameTextLeaseRequest(previous, requested)) {
      const releasingPrevious = releaseTextLease(previous);
      textLeasePendingRef.current = true;
      setTextLeasePending(true);
      await releasingPrevious;
    }
    textLeaseRequestRef.current = requested;
    textLeasePendingRef.current = true;
    setTextLeasePending(true);
    const result = await window.htmllelujah
      .collaborationTextLeaseBegin(requested)
      .catch(() => undefined);
    const stillCurrent = sameTextLeaseRequest(textLeaseRequestRef.current, requested);
    if (result === undefined) {
      if (stillCurrent) textLeaseRequestRef.current = null;
      textLeasePendingRef.current = false;
      setTextLeasePending(false);
      setTextLeaseStatus(null);
      notify('The text editing reservation could not be reached.', 'error');
      return;
    }
    if (!stillCurrent || !textEditorFocusedRef.current) {
      if (result.ok && result.value.status === 'owned') {
        await window.htmllelujah.collaborationTextLeaseEnd(requested).catch(() => undefined);
      }
      if (stillCurrent) {
        textLeaseRequestRef.current = null;
        textLeasePendingRef.current = false;
        setTextLeasePending(false);
        setTextLeaseStatus(null);
      }
      return;
    }
    textLeasePendingRef.current = false;
    setTextLeasePending(false);
    if (!result.ok) {
      textLeaseRequestRef.current = null;
      setTextLeaseStatus(null);
      showFailure(result);
      return;
    }
    setTextLeaseStatus(result.value);
    if (result.value.status === 'available') {
      const refreshed = await window.htmllelujah
        .collaborationStatus({ sessionId: requested.sessionId })
        .catch(() => undefined);
      if (refreshed?.ok) acceptShareStatus(refreshed.value);
    }
    if (
      result.value.status === 'owned' &&
      window.document.activeElement instanceof HTMLElement &&
      window.document.activeElement.classList.contains('text-lease-gate')
    ) {
      window.setTimeout(() => textAreaRef.current?.focus(), 0);
    }
  }, [
    activeAuthoringSurface,
    activeSlide,
    acceptShareStatus,
    notify,
    primaryText,
    releaseTextLease,
    shareStatus?.mode,
    showFailure,
    textLeaseStatus,
  ]);

  const execute = useCallback(
    async (
      label: string,
      commandSource: CommandSource,
      options: {
        readonly select?: readonly string[];
        readonly message?: string;
        readonly preserveInlineTextDraft?: boolean;
      } = {},
    ): Promise<boolean> => {
      const operation = (async (): Promise<boolean> => {
        if (
          !closeExecutionMayStart(
            closePreparationInFlightRef.current,
            allowExecuteDuringCloseBlurRef.current,
            options.preserveInlineTextDraft === true,
            closeExecutionAdmissionSealedRef.current,
          )
        )
          return false;
        if (
          options.preserveInlineTextDraft !== true &&
          !(await canLeaveInlineTextEditorRef.current())
        ) {
          return false;
        }
        const requestedSession = sessionRef.current;
        if (
          requestedSession === null ||
          (Array.isArray(commandSource) && commandSource.length === 0)
        )
          return false;
        if (busy && pendingExecuteCountRef.current === 0) return false;
        const requestedSessionId = requestedSession.snapshot.sessionId;
        pendingExecuteCountRef.current += 1;
        setBusy(true);
        const run = async (): Promise<boolean> => {
          try {
            const current = sessionRef.current;
            if (current === null || current.snapshot.sessionId !== requestedSessionId) return false;
            const commands =
              typeof commandSource === 'function'
                ? commandSource(current.snapshot.document)
                : commandSource;
            if (commands.length === 0) return false;
            const result = await window.htmllelujah.execute({
              sessionId: requestedSessionId,
              expectedRevision: current.snapshot.revision,
              label,
              commands,
            });
            if (!result.ok) {
              showFailure(result);
              return false;
            }
            acceptSession(result.value);
            if (options.select !== undefined) setSelectedIds(options.select);
            if (options.message !== undefined) notify(options.message, 'success');
            return true;
          } finally {
            pendingExecuteCountRef.current -= 1;
            if (pendingExecuteCountRef.current === 0) setBusy(false);
          }
        };
        const queued = executeQueueRef.current.then(run, run);
        executeQueueRef.current = queued.then(
          () => undefined,
          () => undefined,
        );
        return queued;
      })();
      const tracked = closeExecutionBarrierRef.current.track(operation);
      return tracked;
    },
    [acceptSession, busy, notify, showFailure],
  );

  const save = useCallback(
    async (saveAs = false): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      const current = sessionRef.current;
      if (current === null || busy) return;
      setBusy(true);
      try {
        const result = saveAs
          ? await window.htmllelujah.saveAs({ sessionId: current.snapshot.sessionId })
          : await window.htmllelujah.save({ sessionId: current.snapshot.sessionId });
        if (!result.ok) {
          showFailure(result);
          return;
        }
        acceptSession(result.value);
        notify('Saved locally.', 'success');
      } finally {
        setBusy(false);
      }
    },
    [acceptSession, busy, notify, showFailure],
  );

  const replaceDocument = useCallback(
    async (kind: 'new' | 'open'): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      if (busy) return;
      setBusy(true);
      try {
        const result =
          kind === 'new'
            ? await window.htmllelujah.createDocument()
            : await window.htmllelujah.openDocument();
        if (!result.ok) {
          showFailure(result);
          return;
        }
        acceptSession(result.value);
        setSelectedIds([]);
        const remaining = await window.htmllelujah.listRecovery();
        if (remaining.ok) setRecoveryCandidates(remaining.value);
        notify(kind === 'new' ? 'New presentation created.' : 'Presentation opened.', 'success');
      } finally {
        setBusy(false);
      }
    },
    [acceptSession, busy, notify, showFailure],
  );

  const recoverPresentation = useCallback(
    async (candidateId: string): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      if (busy) return;
      setBusy(true);
      try {
        const result = await window.htmllelujah.recover(candidateId);
        if (!result.ok) {
          showFailure(result);
          return;
        }
        acceptSession(result.value);
        setRecoveryOpen(false);
        const remaining = await window.htmllelujah.listRecovery();
        if (remaining.ok) setRecoveryCandidates(remaining.value);
        notify('Recovered journal opened. Save it to keep the restored work.', 'success');
      } finally {
        setBusy(false);
      }
    },
    [acceptSession, busy, notify, showFailure],
  );

  const undo = useCallback(
    async (redo = false): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      const current = sessionRef.current;
      if (current === null || busy) return;
      const result = redo
        ? await window.htmllelujah.redo({
            sessionId: current.snapshot.sessionId,
            expectedRevision: current.snapshot.revision,
          })
        : await window.htmllelujah.undo({
            sessionId: current.snapshot.sessionId,
            expectedRevision: current.snapshot.revision,
          });
      if (!result.ok) showFailure(result);
      else acceptSession(result.value);
    },
    [acceptSession, busy, showFailure],
  );

  const mutateActiveTemplateElements = useCallback(
    (
      label: string,
      mutation: (elements: readonly Element[]) => readonly Element[],
    ): Promise<boolean> => {
      const surfaceAtRequest = activeAuthoringSurface;
      const containerId =
        surfaceAtRequest === 'master'
          ? designMaster?.id
          : surfaceAtRequest === 'layout'
            ? designLayout?.id
            : undefined;
      if (containerId === undefined || surfaceAtRequest === 'slide') return Promise.resolve(false);
      return execute(label, (latestDocument) => {
        if (surfaceAtRequest === 'master') {
          const latest = latestDocument.masters.find((master) => master.id === containerId);
          if (latest === undefined) return [];
          return [
            {
              type: 'master.update',
              masterId: latest.id,
              replacement: { ...latest, elements: mutation(latest.elements) },
            },
          ];
        }
        const latest = latestDocument.layouts.find((layout) => layout.id === containerId);
        if (latest === undefined) return [];
        return [
          {
            type: 'layout.update',
            layoutId: latest.id,
            replacement: { ...latest, elements: mutation(latest.elements) },
          },
        ];
      });
    },
    [activeAuthoringSurface, designLayout?.id, designMaster?.id, execute],
  );

  const addElement = useCallback(
    async (element: Element): Promise<void> => {
      if (activeAuthoringSurface === 'slide') {
        if (activeSlide === undefined) return;
        await execute(
          'Insert element',
          [{ type: 'element.insert', slideId: activeSlide.id, element }],
          { select: [element.id] },
        );
        return;
      }
      if (
        await mutateActiveTemplateElements('Insert template element', (elements) => [
          ...elements,
          element,
        ])
      ) {
        setSelectedIds([element.id]);
      }
    },
    [activeAuthoringSurface, activeSlide, execute, mutateActiveTemplateElements],
  );

  const importImage = useCallback(
    async (replace?: ImageElement, asWatermark = false): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      const current = sessionRef.current;
      if (current === null || busy) return;
      const target =
        activeAuthoringSurface === 'master'
          ? designMaster === undefined
            ? null
            : ({ surface: 'master', masterId: designMaster.id } as const)
          : activeAuthoringSurface === 'layout'
            ? designLayout === undefined
              ? null
              : ({ surface: 'layout', layoutId: designLayout.id } as const)
            : activeSlide === undefined
              ? null
              : ({ surface: 'slide', slideId: activeSlide.id } as const);
      if (target === null) return;
      setBusy(true);
      try {
        const imported = await window.htmllelujah.importImage({
          sessionId: current.snapshot.sessionId,
          expectedRevision: current.snapshot.revision,
          target,
          ...(replace === undefined ? {} : { replaceElementId: replace.id }),
          ...(asWatermark ? { preset: 'watermark' as const } : {}),
        });
        if (!imported.ok) {
          showFailure(imported);
          return;
        }
        acceptSession(imported.value.session);
        setSelectedIds([imported.value.elementId]);
        notify(
          asWatermark
            ? 'Image watermark added.'
            : replace === undefined
              ? 'Image added.'
              : 'Image replaced.',
          'success',
        );
      } finally {
        setBusy(false);
      }
    },
    [
      acceptSession,
      activeAuthoringSurface,
      activeSlide,
      busy,
      designLayout,
      designMaster,
      notify,
      showFailure,
    ],
  );

  const addSlide = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    if (document === undefined) return;
    let createdSlide: Slide | undefined;
    const activeSlideIdAtRequest = activeSlide?.id;
    const added = await execute('Add slide', (latestDocument) => {
      const latestActiveSlide = latestDocument.slides.find(
        (slide) => slide.id === activeSlideIdAtRequest,
      );
      const layoutId = latestActiveSlide?.layoutId ?? latestDocument.layouts[0]?.id;
      if (layoutId === undefined) return [];
      createdSlide = createSlide(latestDocument, layoutId, latestDocument.slides.length);
      return [{ type: 'slide.create', slide: createdSlide }];
    });
    if (added && createdSlide !== undefined) {
      setActiveSlideId(createdSlide.id);
      setDesignSurface('slide');
      setSelectedIds(createdSlide.elements[0] === undefined ? [] : [createdSlide.elements[0].id]);
    }
  }, [activeSlide?.id, document, execute]);

  const duplicateSlide = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    if (document === undefined || activeSlide === undefined) return;
    const sourceSlideId = activeSlide.id;
    let duplicate: Slide | undefined;
    const duplicated = await execute('Duplicate slide', (latestDocument) => {
      if (!latestDocument.slides.some((slide) => slide.id === sourceSlideId)) return [];
      duplicate = createDuplicateSlide(latestDocument, sourceSlideId, () => crypto.randomUUID());
      return [{ type: 'slide.duplicate', slideId: sourceSlideId, duplicate }];
    });
    if (duplicated && duplicate !== undefined) {
      setActiveSlideId(duplicate.id);
      setDesignSurface('slide');
      setSelectedIds([]);
    }
  }, [activeSlide?.id, document, execute]);

  const reorderSlide = useCallback(
    (slideId: string, direction: -1 | 1): void => {
      if (document === undefined) return;
      const currentIndex = document.slides.findIndex((slide) => slide.id === slideId);
      const toIndex = adjacentSlideIndex(currentIndex, document.slides.length, direction);
      if (toIndex === null) return;
      void execute(direction < 0 ? 'Move slide earlier' : 'Move slide later', [
        { type: 'slide.reorder', slideId, toIndex },
      ]);
    },
    [document, execute],
  );

  const deleteSlide = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    if (document === undefined || activeSlide === undefined || document.slides.length <= 1) return;
    const index = document.slides.findIndex((slide) => slide.id === activeSlide.id);
    const next = document.slides[index + 1] ?? document.slides[index - 1];
    if (await execute('Delete slide', [{ type: 'slide.delete', slideId: activeSlide.id }])) {
      setActiveSlideId(next?.id ?? '');
      setDesignSurface('slide');
      setSelectedIds([]);
    }
  }, [activeSlide, document, execute]);

  const deleteSelection = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    if (selectedIds.length === 0) return;
    if (selectedElements.some((element) => element.locked)) {
      notify('Unlock the selected objects before deleting them.', 'error');
      return;
    }
    const deleted =
      activeAuthoringSurface === 'slide'
        ? activeSlide !== undefined &&
          (await execute('Delete objects', [
            { type: 'element.delete', slideId: activeSlide.id, elementIds: selectedIds },
          ]))
        : await mutateActiveTemplateElements('Delete template objects', (elements) =>
            elements.filter((element) => !selectedIds.includes(element.id)),
          );
    if (deleted) setSelectedIds([]);
  }, [
    activeAuthoringSurface,
    activeSlide,
    execute,
    mutateActiveTemplateElements,
    notify,
    selectedElements,
    selectedIds,
  ]);

  const duplicateSelection = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    if (selectedIds.length === 0) return;
    if (activeAuthoringSurface !== 'slide') {
      let copyIds: readonly string[] = [];
      const succeeded = await mutateActiveTemplateElements(
        'Duplicate template objects',
        (elements) => {
          const selected = elements.filter((element) => selectedIds.includes(element.id));
          if (selected.length !== selectedIds.length) return elements;
          const copies = duplicateElements(selected);
          copyIds = copies.map((element) => element.id);
          return [...elements, ...copies];
        },
      );
      if (succeeded && copyIds.length > 0) setSelectedIds(copyIds);
      return;
    }
    if (activeSlide === undefined) return;
    const sourceSlideId = activeSlide.id;
    const selectedAtRequest = [...selectedIds];
    let copyIds: readonly string[] = [];
    const succeeded = await execute('Duplicate objects', (latestDocument) => {
      const latestSlide = latestDocument.slides.find((slide) => slide.id === sourceSlideId);
      if (latestSlide === undefined) return [];
      const latestSelected = latestSlide.elements.filter((element) =>
        selectedAtRequest.includes(element.id),
      );
      if (latestSelected.length !== selectedAtRequest.length) return [];
      const copies = duplicateElements(latestSelected);
      copyIds = copies.map((element) => element.id);
      return copies.map((element): DocumentCommand => ({
        type: 'element.insert',
        slideId: sourceSlideId,
        element,
      }));
    });
    if (succeeded && copyIds.length > 0) setSelectedIds(copyIds);
  }, [activeAuthoringSurface, activeSlide, execute, mutateActiveTemplateElements, selectedIds]);

  const serializeSelectedObjects = useCallback(() => {
    if (document === undefined || selectedElements.length === 0) return null;
    try {
      return serializeObjectClipboard(document.id, selectedElements);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'The selected objects cannot be copied.',
        'error',
      );
      return null;
    }
  }, [document, notify, selectedElements]);

  const copySelectionToInternalClipboard = useCallback((): boolean => {
    const payload = serializeSelectedObjects();
    if (payload === null) return false;
    objectClipboardRef.current = payload.serialized;
    objectClipboardPlainTextRef.current = payload.plainText;
    void navigator.clipboard?.writeText(payload.plainText).catch(() => undefined);
    notify(
      `${selectedElements.length} object${selectedElements.length === 1 ? '' : 's'} copied.`,
      'success',
    );
    return true;
  }, [notify, selectedElements.length, serializeSelectedObjects]);

  const cutSelectionToInternalClipboard = useCallback(async (): Promise<void> => {
    if (copySelectionToInternalClipboard()) await deleteSelection();
  }, [copySelectionToInternalClipboard, deleteSelection]);

  const pasteSerializedObjects = useCallback(
    async (serialized: string): Promise<void> => {
      if (document === undefined) return;
      let payload: ReturnType<typeof deserializeObjectClipboard>;
      try {
        payload = deserializeObjectClipboard(serialized);
      } catch (error) {
        notify(
          error instanceof Error ? error.message : 'Clipboard object data is invalid.',
          'error',
        );
        return;
      }
      const compatibility = validateObjectClipboardPaste(payload, document.id);
      if (!compatibility.compatible) {
        notify(compatibility.message, 'error');
        return;
      }
      const pasted = payload.elements;
      if (pasted.length === 0) return;
      if (
        activeAuthoringSurface === 'slide' &&
        pasted.some((element) => element.type === 'placeholder')
      ) {
        notify('Template placeholders can only be pasted into a layout or master.', 'error');
        return;
      }
      const inserted =
        activeAuthoringSurface === 'slide'
          ? activeSlide !== undefined &&
            (await execute(
              'Paste objects',
              pasted.map((element): DocumentCommand => ({
                type: 'element.insert',
                slideId: activeSlide.id,
                element,
              })),
            ))
          : await mutateActiveTemplateElements('Paste template objects', (elements) => [
              ...elements,
              ...pasted,
            ]);
      if (inserted) {
        setSelectedIds(pasted.map((element) => element.id));
        notify(`${pasted.length} object${pasted.length === 1 ? '' : 's'} pasted.`, 'success');
      }
    },
    [activeAuthoringSurface, activeSlide, document, execute, mutateActiveTemplateElements, notify],
  );

  const transform = useCallback(
    (frames: readonly { readonly elementId: string; readonly frame: Frame }[]): void => {
      const unlockedIds = new Set(
        activeSurfaceElements.filter((element) => !element.locked).map((element) => element.id),
      );
      const permittedFrames = frames.filter((frame) => unlockedIds.has(frame.elementId));
      if (permittedFrames.length === 0) return;
      if (activeAuthoringSurface === 'slide') {
        if (activeSlide === undefined) return;
        void execute('Move or resize objects', [
          { type: 'element.transform', slideId: activeSlide.id, transforms: permittedFrames },
        ]);
        return;
      }
      void mutateActiveTemplateElements('Move or resize template objects', (elements) =>
        replaceElementFrames(elements, permittedFrames),
      );
    },
    [
      activeAuthoringSurface,
      activeSlide,
      activeSurfaceElements,
      execute,
      mutateActiveTemplateElements,
    ],
  );

  const align = useCallback(
    (mode: 'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-middle' | 'bottom'): void => {
      if (selectedIds.length < 2) return;
      if (selectedElements.some((element) => element.locked)) {
        notify('Unlock the selected objects before aligning them.', 'error');
        return;
      }
      if (activeAuthoringSurface === 'slide') {
        if (activeSlide === undefined) return;
        void execute('Align objects', [
          {
            type: 'element.align',
            slideId: activeSlide.id,
            elementIds: selectedIds,
            mode,
            relativeTo: 'selection',
          },
        ]);
        return;
      }
      const geometryMode =
        mode === 'horizontal-center' ? 'center' : mode === 'vertical-middle' ? 'middle' : mode;
      const aligned = alignItems(selectedElements, geometryMode);
      transform(
        aligned.map((element) => ({
          elementId: element.id,
          frame: element.frame,
        })),
      );
    },
    [
      activeAuthoringSurface,
      activeSlide,
      execute,
      notify,
      selectedElements,
      selectedIds,
      transform,
    ],
  );

  const distribute = useCallback(
    (axis: 'horizontal' | 'vertical'): void => {
      if (selectedIds.length < 3) return;
      if (selectedElements.some((element) => element.locked)) {
        notify('Unlock the selected objects before distributing them.', 'error');
        return;
      }
      if (activeAuthoringSurface === 'slide') {
        if (activeSlide === undefined) return;
        void execute('Distribute objects', [
          {
            type: 'element.distribute',
            slideId: activeSlide.id,
            elementIds: selectedIds,
            axis,
            relativeTo: 'selection',
          },
        ]);
        return;
      }
      const distributed = distributeItems(selectedElements, axis);
      transform(
        distributed.map((element) => ({
          elementId: element.id,
          frame: element.frame,
        })),
      );
    },
    [
      activeAuthoringSurface,
      activeSlide,
      execute,
      notify,
      selectedElements,
      selectedIds,
      transform,
    ],
  );

  const groupSelection = useCallback(async (): Promise<void> => {
    if (activeAuthoringSurface !== 'slide' || activeSlide === undefined || selectedIds.length < 2)
      return;
    if (selectedElements.some((element) => element.locked)) {
      notify('Unlock the selected objects before grouping them.', 'error');
      return;
    }
    const groupId = crypto.randomUUID();
    await execute(
      'Group objects',
      [
        {
          type: 'element.group',
          slideId: activeSlide.id,
          elementIds: selectedIds,
          groupId,
          name: 'Group',
        },
      ],
      { select: [groupId] },
    );
  }, [activeAuthoringSurface, activeSlide, execute, notify, selectedElements, selectedIds]);

  const ungroupSelection = useCallback(async (): Promise<void> => {
    if (
      activeAuthoringSurface !== 'slide' ||
      activeSlide === undefined ||
      primaryElement?.type !== 'group' ||
      primaryElement.locked
    )
      return;
    const children = primaryElement.children.map((child) => child.id);
    await execute(
      'Ungroup objects',
      [{ type: 'element.ungroup', slideId: activeSlide.id, groupId: primaryElement.id }],
      { select: children },
    );
  }, [activeAuthoringSurface, activeSlide, execute, primaryElement]);

  const reorder = useCallback(
    (to: 'front' | 'back'): void => {
      if (primaryElement === undefined) return;
      if (primaryElement.locked) {
        notify('Unlock the object before changing its layer order.', 'error');
        return;
      }
      if (activeAuthoringSurface !== 'slide') {
        const elementId = primaryElement.id;
        void mutateActiveTemplateElements(
          to === 'front' ? 'Bring template object to front' : 'Send template object to back',
          (elements) => {
            const target = elements.find((element) => element.id === elementId);
            if (target === undefined) return elements;
            const remaining = elements.filter((element) => element.id !== elementId);
            return to === 'front' ? [...remaining, target] : [target, ...remaining];
          },
        );
        return;
      }
      if (activeSlide === undefined) return;
      const slideId = activeSlide.id;
      const elementId = primaryElement.id;
      void execute(to === 'front' ? 'Bring to front' : 'Send to back', (latestDocument) => {
        const latestSlide = latestDocument.slides.find((slide) => slide.id === slideId);
        if (
          latestSlide === undefined ||
          !latestSlide.elements.some((element) => element.id === elementId)
        )
          return [];
        return [
          {
            type: 'element.reorder',
            slideId,
            elementId,
            toIndex: to === 'front' ? latestSlide.elements.length - 1 : 0,
          },
        ];
      });
    },
    [
      activeAuthoringSurface,
      activeSlide,
      execute,
      mutateActiveTemplateElements,
      notify,
      primaryElement,
    ],
  );

  const patchElement = useCallback(
    (replacement: Element, label = 'Update object'): Promise<boolean> => {
      const surfaceBaseline = activeSurfaceElements.find(
        (element) => element.id === replacement.id,
      );
      if (
        surfaceBaseline?.locked &&
        JSON.stringify({ ...surfaceBaseline, locked: replacement.locked }) !==
          JSON.stringify(replacement)
      ) {
        notify('Unlock the object before editing it.', 'error');
        return Promise.resolve(false);
      }
      if (activeAuthoringSurface !== 'slide') {
        const baseline = surfaceBaseline;
        if (baseline === undefined) return Promise.resolve(false);
        return mutateActiveTemplateElements(label, (elements) =>
          elements.map((latest) =>
            latest.id === replacement.id &&
            latest.type === replacement.type &&
            baseline.type === latest.type
              ? rebaseEntityReplacement(baseline, replacement, latest)
              : latest,
          ),
        );
      }
      if (activeSlide === undefined) return Promise.resolve(false);
      const slideId = activeSlide.id;
      const baseline = sessionRef.current?.snapshot.document.slides
        .find((slide) => slide.id === slideId)
        ?.elements.find((element) => element.id === replacement.id);
      if (baseline === undefined) return Promise.resolve(false);
      return execute(label, (latestDocument) => {
        const latest = latestDocument.slides
          .find((slide) => slide.id === slideId)
          ?.elements.find((element) => element.id === replacement.id);
        if (
          latest === undefined ||
          latest.type !== replacement.type ||
          baseline.type !== latest.type
        )
          return [];
        return [
          {
            type: 'element.update',
            slideId,
            elementId: replacement.id,
            replacement: rebaseEntityReplacement(baseline, replacement, latest),
          },
        ];
      });
    },
    [
      activeAuthoringSurface,
      activeSlide,
      activeSurfaceElements,
      execute,
      mutateActiveTemplateElements,
      notify,
    ],
  );

  const resetPrimaryElementToTheme = useCallback(async (): Promise<void> => {
    if (primaryElement === undefined || primaryThemeReset === undefined || primaryElement.locked)
      return;
    if (JSON.stringify(primaryElement) === JSON.stringify(primaryThemeReset)) {
      notify('This object already uses theme-managed fonts and colors.', 'info');
      return;
    }
    if (await patchElement(primaryThemeReset, 'Reset object to theme')) {
      notify('Object fonts and colors reset to the active theme.', 'success');
    }
  }, [notify, patchElement, primaryElement, primaryThemeReset]);

  const resetPrimaryElementToLayout = useCallback(async (): Promise<void> => {
    if (
      activeAuthoringSurface !== 'slide' ||
      activeSlide === undefined ||
      primaryElement?.placeholderBinding === undefined ||
      primaryElement.locked
    )
      return;
    const reset = await execute('Reset object to layout', [
      {
        type: 'slide.reset-placeholder',
        slideId: activeSlide.id,
        placeholderId: primaryElement.placeholderBinding.placeholderId,
      },
    ]);
    if (reset) notify('Object geometry, visibility and style reset to its layout.', 'success');
  }, [activeAuthoringSurface, activeSlide, execute, notify, primaryElement]);

  const selectContentCatalogEntry = useCallback(
    async (entry: ContentCatalogEntry): Promise<void> => {
      const replaceElement =
        contentPicker?.replaceElementId === undefined
          ? undefined
          : activeSurfaceElements.find((element) => element.id === contentPicker.replaceElementId);
      let changed = false;
      if (replaceElement !== undefined) {
        if (entry.insert.type === 'shape' && replaceElement.type === 'shape') {
          changed = await patchElement(
            {
              ...replaceElement,
              name: entry.localizedLabel || entry.label,
              shape: entry.insert.shape,
              cornerRadiusPt: entry.insert.shape === 'rounded-rectangle' ? 12 : 0,
            },
            'Change shape',
          );
        } else if (entry.insert.type === 'icon' && replaceElement.type === 'icon') {
          changed = await patchElement(
            {
              ...replaceElement,
              name: entry.localizedLabel || entry.label,
              iconSet: entry.insert.iconSet,
              iconName: entry.insert.iconName,
            },
            'Change catalog visual',
          );
        } else {
          notify('Choose a visual from the same object family.', 'error');
          return;
        }
      } else if (entry.insert.type === 'shape') {
        await addElement(createShapeElement(entry.insert.shape));
        changed = true;
      } else {
        await addElement({
          ...createIconElement(entry.insert.iconName),
          name: entry.localizedLabel || entry.label,
          iconSet: entry.insert.iconSet,
          iconName: entry.insert.iconName,
        });
        changed = true;
      }
      if (changed) setContentPicker(null);
    },
    [activeSurfaceElements, addElement, contentPicker, notify, patchElement],
  );

  const updateFrameNumber = useCallback(
    (property: keyof Frame, raw: string): void => {
      if (primaryElement === undefined || document === undefined) return;
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      const frame = { ...primaryElement.frame };
      if (property === 'widthPt')
        frame.widthPt = clamp(value, 12, document.page.widthPt - frame.xPt);
      else if (property === 'heightPt')
        frame.heightPt = clamp(value, 12, document.page.heightPt - frame.yPt);
      else if (property === 'xPt')
        frame.xPt = clamp(value, 0, document.page.widthPt - frame.widthPt);
      else if (property === 'yPt')
        frame.yPt = clamp(value, 0, document.page.heightPt - frame.heightPt);
      else frame.rotationDeg = clamp(value, -180, 180);
      transform([{ elementId: primaryElement.id, frame }]);
    },
    [document, primaryElement, transform],
  );

  const applyTextDraft = useCallback(
    async (
      options: Readonly<{
        readonly confirmConflict?: boolean;
        readonly lockEditing?: boolean;
      }> = {},
    ): Promise<boolean> => {
      const draft = textDraftRef.current;
      if (activeSlide === undefined || primaryText === undefined || draft === null) return false;
      const draftVersion = textDraftVersionRef.current;
      const targetTextId = primaryText.id;
      const surfaceReference: AuthoringSurfaceReference =
        activeAuthoringSurface === 'master'
          ? { surface: 'master', id: designMaster?.id ?? '' }
          : activeAuthoringSurface === 'layout'
            ? { surface: 'layout', id: designLayout?.id ?? '' }
            : { surface: 'slide', id: activeSlide.id };
      if (surfaceReference.id === '') return false;
      const latestDocument = sessionRef.current?.snapshot.document;
      const latestText = latestDocument
        ? elementsForAuthoringSurface(latestDocument, surfaceReference).find(
            (element): element is TextElement =>
              element.id === targetTextId && element.type === 'text',
          )
        : undefined;
      if (latestDocument === undefined || latestText === undefined) {
        updateTextDraftConflict(true);
        return false;
      }
      if (latestText.locked) {
        notify('Unlock the text object before editing it.', 'error');
        return false;
      }
      const latestTheme = themeForAuthoringSurface(latestDocument, surfaceReference);
      const latestFingerprint = textEditingFingerprint(latestText, latestTheme);
      const recordedBaseline = textBaselineRef.current;
      const hasExternalConflict = textDraftTargetHasChanged(
        recordedBaseline,
        targetTextId,
        latestFingerprint,
        textDraftConflictRef.current,
      );
      if (hasExternalConflict) {
        updateTextDraftConflict(true);
        if (options.confirmConflict !== true) return false;
        if (
          !window.confirm(
            'This text changed elsewhere while you were editing. Replace it with your draft?',
          )
        )
          return false;
      }
      const expectedFingerprint = latestFingerprint;
      const baseline = initialTextDraft(latestText, latestTheme);
      const markPatch: MutableTextMarksPatch = {};
      if (draft.bold !== baseline.bold) {
        markPatch.bold = draft.bold;
        markPatch.fontWeight = draft.bold ? 700 : 400;
      }
      if (draft.italic !== baseline.italic) markPatch.italic = draft.italic;
      if (draft.underline !== baseline.underline) markPatch.underline = draft.underline;
      if (draft.strikethrough !== baseline.strikethrough)
        markPatch.strikethrough = draft.strikethrough;
      if (draft.color !== baseline.color) markPatch.color = draft.color;
      if (draft.fontFamily !== baseline.fontFamily) markPatch.fontFamily = draft.fontFamily;
      if (draft.fontSizePt !== baseline.fontSizePt) markPatch.fontSizePt = draft.fontSizePt;
      const marksChanged = Object.keys(markPatch).length > 0;
      const alignmentChanged = draft.alignment !== baseline.alignment;
      const kindChanged = draft.kind !== baseline.kind;
      const headingLevelChanged = draft.headingLevel !== baseline.headingLevel;
      const listLevelChanged = draft.listLevel !== baseline.listLevel;
      const textChanged = draft.text !== baseline.text;
      let content = draft.contentOverride ?? latestText.content;
      if (kindChanged && draft.contentOverride === null) {
        const first = firstMarks(latestText.content);
        content = contentFromPlainText(draft.text, {
          kind: draft.kind,
          alignment: draft.alignment,
          marks: {
            ...first,
            bold: draft.bold,
            italic: draft.italic,
            underline: draft.underline,
            strikethrough: draft.strikethrough,
            color: draft.color,
            fontFamily: draft.fontFamily,
            fontSizePt: draft.fontSizePt,
            fontWeight: draft.bold ? 700 : 400,
          },
          headingLevel: draft.headingLevel,
        });
      } else if (
        textChanged ||
        marksChanged ||
        alignmentChanged ||
        listLevelChanged ||
        headingLevelChanged ||
        draft.contentOverride !== null
      ) {
        if (
          draft.contentOverride === null ||
          contentToPlainText(draft.contentOverride) !== draft.text
        ) {
          content = replacePlainTextPreservingStyles(content, draft.text);
        }
        if (headingLevelChanged && draft.kind === 'heading') {
          content = updateHeadingLevel(content, draft.headingLevel);
        }
        content = updateRichTextPresentation(content, {
          ...(alignmentChanged ? { alignment: draft.alignment } : {}),
          ...(marksChanged ? { marks: markPatch } : {}),
        });
      }
      if (
        (listLevelChanged || kindChanged) &&
        draft.kind !== 'paragraph' &&
        draft.kind !== 'heading'
      ) {
        content = {
          blocks: content.blocks.map((block) =>
            block.type === 'list'
              ? {
                  ...block,
                  items: block.items.map((item) => ({ ...item, level: draft.listLevel })),
                }
              : block,
          ),
        };
      }

      const contentChanged =
        kindChanged ||
        textChanged ||
        marksChanged ||
        alignmentChanged ||
        listLevelChanged ||
        headingLevelChanged ||
        draft.contentOverride !== null;
      const styleChanged =
        draft.role !== baseline.role ||
        alignmentChanged ||
        draft.fontFamily !== baseline.fontFamily ||
        draft.fontSizePt !== baseline.fontSizePt ||
        draft.bold !== baseline.bold ||
        draft.italic !== baseline.italic ||
        draft.color !== baseline.color ||
        draft.lineHeight !== baseline.lineHeight ||
        draft.letterSpacingPt !== baseline.letterSpacingPt;
      const textStyleOverrides: NonNullable<TextElement['style']> = {
        alignment: draft.alignment,
        fontFamily: draft.fontFamily,
        fontSizePt: draft.fontSizePt,
        fontWeight: draft.bold ? 700 : 400,
        italic: draft.italic,
        color: draft.color,
        lineHeight: draft.lineHeight,
        letterSpacingPt: draft.letterSpacingPt,
      };
      const applyChanges = (current: TextElement): TextElement => ({
        ...current,
        ...(contentChanged ? { content } : {}),
        ...(styleChanged
          ? {
              styleRole: draft.role,
              style: { ...(current.style ?? {}), ...textStyleOverrides },
            }
          : {}),
      });
      const commands: DocumentCommand[] = [];
      if (surfaceReference.surface === 'slide' && contentChanged) {
        commands.push({
          type: 'text.replace-content',
          slideId: surfaceReference.id,
          textId: latestText.id,
          content,
        });
      }
      if (surfaceReference.surface === 'slide' && styleChanged) {
        commands.push({
          type: 'element.update-style',
          slideId: surfaceReference.id,
          elementId: latestText.id,
          patch: {
            kind: 'text',
            styleRole: draft.role,
            style: textStyleOverrides,
          },
        });
      }
      if (!contentChanged && !styleChanged) {
        updateTextDraftDirty(false);
        updateTextDraftConflict(false);
        return true;
      }
      const currentApply = textApplyInFlightRef.current;
      if (currentApply !== null) {
        if (options.lockEditing !== true) return currentApply;
        textEditingLockedRef.current = true;
        setTextEditingLocked(true);
        try {
          return await currentApply;
        } finally {
          textEditingLockedRef.current = false;
          setTextEditingLocked(false);
        }
      }
      const lockEditing = options.lockEditing === true;
      if (lockEditing) {
        textEditingLockedRef.current = true;
        setTextEditingLocked(true);
      }
      setTextApplyPending(true);
      const apply = (async (): Promise<boolean> => {
        const applied = await execute(
          'Edit text',
          (queuedDocument) => {
            const queuedText = elementsForAuthoringSurface(queuedDocument, surfaceReference).find(
              (element): element is TextElement =>
                element.id === targetTextId && element.type === 'text',
            );
            if (
              queuedText === undefined ||
              queuedText.locked ||
              textEditingFingerprint(
                queuedText,
                themeForAuthoringSurface(queuedDocument, surfaceReference),
              ) !== expectedFingerprint
            ) {
              updateTextDraftConflict(true);
              return [];
            }
            if (surfaceReference.surface === 'slide') return commands;
            if (surfaceReference.surface === 'master') {
              const master = queuedDocument.masters.find(
                (candidate) => candidate.id === surfaceReference.id,
              );
              if (master === undefined) return [];
              return [
                {
                  type: 'master.update',
                  masterId: master.id,
                  replacement: {
                    ...master,
                    elements: master.elements.map((element) =>
                      element.id === targetTextId && element.type === 'text'
                        ? applyChanges(element)
                        : element,
                    ),
                  },
                },
              ];
            }
            const layout = queuedDocument.layouts.find(
              (candidate) => candidate.id === surfaceReference.id,
            );
            if (layout === undefined) return [];
            return [
              {
                type: 'layout.update',
                layoutId: layout.id,
                replacement: {
                  ...layout,
                  elements: layout.elements.map((element) =>
                    element.id === targetTextId && element.type === 'text'
                      ? applyChanges(element)
                      : element,
                  ),
                },
              },
            ];
          },
          { preserveInlineTextDraft: true },
        );
        if (!applied) return false;
        const committedDocument = sessionRef.current?.snapshot.document;
        const committedText = committedDocument
          ? elementsForAuthoringSurface(committedDocument, surfaceReference).find(
              (element): element is TextElement =>
                element.id === targetTextId && element.type === 'text',
            )
          : undefined;
        const targetUnchanged =
          textBaselineRef.current?.id === targetTextId &&
          committedDocument !== undefined &&
          committedText !== undefined;
        if (targetUnchanged) {
          textBaselineRef.current = {
            id: targetTextId,
            value: textEditingFingerprint(
              committedText,
              themeForAuthoringSurface(committedDocument, surfaceReference),
            ),
          };
        }
        if (!targetUnchanged || textDraftVersionRef.current !== draftVersion) return false;
        updateTextDraftDirty(false);
        updateTextDraftConflict(false);
        return true;
      })();
      textApplyInFlightRef.current = apply;
      try {
        return await apply;
      } finally {
        if (textApplyInFlightRef.current === apply) textApplyInFlightRef.current = null;
        setTextApplyPending(false);
        if (lockEditing) {
          textEditingLockedRef.current = false;
          setTextEditingLocked(false);
        }
      }
    },
    [
      activeAuthoringSurface,
      activeSlide,
      designLayout?.id,
      designMaster?.id,
      execute,
      notify,
      primaryText,
      updateTextDraftConflict,
      updateTextDraftDirty,
    ],
  );
  const pasteRichText = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
      if (textDraft === null || primaryText === undefined) return;
      const html = event.clipboardData.getData('text/html');
      if (html.trim() === '') return;
      event.preventDefault();
      try {
        const pasted = sanitizeClipboardHtml(html, {
          fallbackMarks: firstMarks(textDraft.contentOverride ?? primaryText.content),
          alignment: textDraft.alignment,
        });
        const start = event.currentTarget.selectionStart ?? textDraft.text.length;
        const end = event.currentTarget.selectionEnd ?? start;
        const content = replaceRichTextRange(
          textDraft.contentOverride ?? primaryText.content,
          start,
          end,
          pasted,
          firstMarks(primaryText.content),
        );
        editTextDraft({
          ...textDraft,
          text: contentToPlainText(content),
          contentOverride: content,
        });
        notify('Rich text pasted with supported formatting only.', 'success');
      } catch (error) {
        notify(
          error instanceof RichClipboardError
            ? error.message
            : 'The clipboard content could not be normalized safely.',
          'error',
        );
      }
    },
    [editTextDraft, notify, primaryText, textDraft],
  );

  const finishInlineTextEditing = useCallback((): void => {
    updateInlineTextElementId(null);
    textEditorFocusedRef.current = false;
    void releaseTextLease();
  }, [releaseTextLease, updateInlineTextElementId]);

  const revertTextDraft = useCallback((): void => {
    if (textApplyInFlightRef.current !== null) return;
    if (
      window.document.activeElement instanceof HTMLElement &&
      window.document.activeElement.classList.contains('canonical-inline-text-input')
    ) {
      suppressNextInlineBlurRef.current = true;
      window.setTimeout(() => {
        suppressNextInlineBlurRef.current = false;
      }, 0);
    }
    textDraftVersionRef.current += 1;
    if (primaryText !== undefined && document !== undefined) {
      updateTextDraft(initialTextDraft(primaryText, activeAuthoringTheme));
      updateTextDraftDirty(false);
      updateTextDraftConflict(false);
      textBaselineRef.current = {
        id: primaryText.id,
        value: textEditingFingerprint(primaryText, activeAuthoringTheme),
      };
    } else {
      updateTextDraft(null);
      updateTextDraftDirty(false);
      updateTextDraftConflict(false);
      textBaselineRef.current = null;
    }
    finishInlineTextEditing();
  }, [
    activeAuthoringTheme,
    document,
    finishInlineTextEditing,
    primaryText,
    updateTextDraft,
    updateTextDraftConflict,
    updateTextDraftDirty,
  ]);

  const commitInlineText = useCallback(
    (options: Readonly<{ readonly confirmConflict?: boolean }> = {}): Promise<boolean> => {
      const current = inlineCommitPromiseRef.current;
      if (current !== null) return current;
      const commit = (async (): Promise<boolean> => {
        let canLeaveEditor = false;
        try {
          const ran = await runInlineTextCommitOnce(
            inlineCommitInFlightRef,
            async () => {
              const draftDirty = textDraftDirtyRef.current;
              const draftConflict = textDraftConflictRef.current;
              if (inlineTextCanCloseWithoutApply(draftDirty, draftConflict)) {
                canLeaveEditor = true;
                return;
              }
              if (!canAutoCommitInlineText(draftConflict) && options.confirmConflict !== true) {
                notify(
                  'Remote change detected. Your draft is preserved in the inspector.',
                  'error',
                );
                return;
              }
              const applied = await applyTextDraft({
                confirmConflict: options.confirmConflict === true,
                lockEditing: true,
              });
              canLeaveEditor = applied;
              if (!applied && textDraftDirtyRef.current) {
                notify(
                  'The inline draft could not be applied and remains available in the inspector.',
                  'error',
                );
              }
            },
            finishInlineTextEditing,
          );
          return ran && canLeaveEditor;
        } catch {
          notify(
            'The inline draft could not be applied and remains available in the inspector.',
            'error',
          );
          return false;
        }
      })();
      inlineCommitPromiseRef.current = commit;
      void commit.then(() => {
        if (inlineCommitPromiseRef.current === commit) inlineCommitPromiseRef.current = null;
      });
      return commit;
    },
    [applyTextDraft, finishInlineTextEditing, notify],
  );
  const canLeaveInlineTextEditor = useCallback(async (): Promise<boolean> => {
    if (
      inlineTextElementIdRef.current !== null ||
      inlineCommitPromiseRef.current !== null ||
      textDraftDirtyRef.current
    )
      return commitInlineText();
    if (textDraftConflictRef.current) {
      notify('Resolve the preserved text conflict before changing selection.', 'error');
      return false;
    }
    return true;
  }, [commitInlineText, notify]);
  useLayoutEffect(() => {
    canLeaveInlineTextEditorRef.current = canLeaveInlineTextEditor;
  }, [canLeaveInlineTextEditor]);
  const releaseClosePreparation = useCallback((requestId: string): boolean => {
    if (!correlatedCloseSealRef.current.release(requestId)) return false;
    closeExecutionAdmissionSealedRef.current = false;
    closePreparationInFlightRef.current = false;
    return true;
  }, []);
  useEffect(
    () =>
      window.htmllelujah.onWindowCloseReleased((release) => {
        releaseClosePreparation(release.requestId);
      }),
    [releaseClosePreparation],
  );
  useEffect(
    () =>
      window.htmllelujah.onWindowCloseRequested(async (request) => {
        const settleDeadlineAtMs = request.deadlineAtMs - 50;
        if (
          Date.now() >= settleDeadlineAtMs ||
          closePreparationInFlightRef.current ||
          correlatedCloseSealRef.current.activeRequestId !== null
        )
          return 'blocked';
        closePreparationInFlightRef.current = true;
        closeExecutionAdmissionSealedRef.current = false;
        let closeExecutions: ReturnType<CloseExecutionBarrier['begin']> | null = null;
        let keepAdmissionSealed = false;
        try {
          closeExecutions = closeExecutionBarrierRef.current.begin();
          allowExecuteDuringCloseBlurRef.current = true;
          try {
            const activeElement = window.document.activeElement;
            if (
              activeElement instanceof HTMLElement &&
              activeElementNeedsBlurCommit(activeElement.tagName, activeElement.isContentEditable)
            ) {
              activeElement.blur();
            }
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
          } finally {
            allowExecuteDuringCloseBlurRef.current = false;
          }
          if (
            !(await blurCommitBarrierRef.current.settle(
              settleDeadlineAtMs,
              (target) =>
                target === tableTsvDraftCommitKeyRef.current ||
                (target instanceof HTMLElement && target.isConnected),
            ))
          )
            return 'blocked';
          if (!(await closeExecutions.settle(settleDeadlineAtMs))) return 'blocked';
          if (
            !(await settleBooleanBeforeDeadline(
              canLeaveInlineTextEditorRef.current(),
              settleDeadlineAtMs,
            ))
          )
            return 'blocked';
          if (!(await closeExecutions.settle(settleDeadlineAtMs))) return 'blocked';
          for (;;) {
            const queued = executeQueueRef.current;
            if (
              !(await settleBooleanBeforeDeadline(
                queued.then(
                  () => true,
                  () => false,
                ),
                settleDeadlineAtMs,
              ))
            )
              return 'blocked';
            if (queued === executeQueueRef.current && pendingExecuteCountRef.current === 0) break;
          }
          closeExecutionAdmissionSealedRef.current = true;
          if (!(await closeExecutions.sealAndSettle(settleDeadlineAtMs))) return 'blocked';
          if (!closeExecutions.isSealedStable()) {
            if (!(await closeExecutions.sealAndSettle(settleDeadlineAtMs))) return 'blocked';
            if (!closeExecutions.isSealedStable()) return 'blocked';
          }
          if (Date.now() >= settleDeadlineAtMs) return 'blocked';
          if (!correlatedCloseSealRef.current.seal(request.requestId)) return 'blocked';
          keepAdmissionSealed = true;
          return 'ready';
        } catch {
          return 'blocked';
        } finally {
          closeExecutions?.end();
          allowExecuteDuringCloseBlurRef.current = false;
          if (keepAdmissionSealed) {
            const remainingMs = Math.max(0, request.deadlineAtMs - Date.now());
            window.setTimeout(() => releaseClosePreparation(request.requestId), remainingMs);
          } else {
            closeExecutionAdmissionSealedRef.current = false;
            closePreparationInFlightRef.current = false;
          }
        }
      }),
    [releaseClosePreparation],
  );
  useEffect(() => {
    if (
      activeAuthoringSurface !== 'slide' ||
      inlineTextElementId === null ||
      primaryText?.id !== inlineTextElementId
    )
      return;
    textEditorFocusedRef.current = true;
    if (shareStatus?.mode === 'host' || shareStatus?.mode === 'guest') void beginTextLease();
  }, [
    activeAuthoringSurface,
    beginTextLease,
    inlineTextElementId,
    primaryText?.id,
    shareStatus?.mode,
  ]);

  useEffect(() => {
    if (
      inlineTextElementId !== null ||
      !textDraftDirty ||
      textDraftConflict ||
      primaryText === undefined ||
      textApplyPending ||
      textApplyInFlightRef.current !== null ||
      !textDraftAutosaveMayAttempt(
        textDraftAutosaveFailedVersionRef.current,
        renderedTextDraftVersion,
      )
    )
      return;
    const draftVersion = renderedTextDraftVersion;
    const timer = window.setTimeout(() => {
      if (
        textApplyInFlightRef.current !== null ||
        !textDraftAutosaveMayAttempt(textDraftAutosaveFailedVersionRef.current, draftVersion)
      )
        return;
      void applyTextDraft()
        .then((applied) => {
          if (applied) {
            textDraftAutosaveFailedVersionRef.current = null;
          } else if (textDraftVersionRef.current === draftVersion) {
            textDraftAutosaveFailedVersionRef.current = draftVersion;
          }
        })
        .catch(() => {
          if (textDraftVersionRef.current === draftVersion)
            textDraftAutosaveFailedVersionRef.current = draftVersion;
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [
    applyTextDraft,
    inlineTextElementId,
    primaryText,
    renderedTextDraftVersion,
    textApplyPending,
    textDraftConflict,
    textDraftDirty,
  ]);

  useEffect(() => {
    const requested = textLeaseRequestRef.current;
    if (
      requested === null ||
      textLeaseStatus?.status !== 'owned' ||
      shareStatus?.mode === undefined ||
      shareStatus.mode === 'offline'
    ) {
      return;
    }
    const delayMs = clamp(textLeaseStatus.expiresAtMs - Date.now() - 5_000, 1_000, 5_000);
    const timer = window.setTimeout(() => {
      if (!textEditorFocusedRef.current) return;
      void window.htmllelujah
        .collaborationTextLeaseRenew(requested)
        .then((result) => {
          if (!sameTextLeaseRequest(textLeaseRequestRef.current, requested)) return;
          if (!result.ok) {
            textLeaseRequestRef.current = null;
            setTextLeaseStatus(null);
            showFailure(result);
            return;
          }
          setTextLeaseStatus(result.value);
          if (result.value.status === 'available') {
            void window.htmllelujah
              .collaborationStatus({ sessionId: requested.sessionId })
              .then((status) => {
                if (status.ok) acceptShareStatus(status.value);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => {
          if (!sameTextLeaseRequest(textLeaseRequestRef.current, requested)) return;
          textLeaseRequestRef.current = null;
          setTextLeaseStatus(null);
          notify('The text editing reservation could not be renewed.', 'error');
        });
    }, delayMs);
    return () => window.clearTimeout(timer);
  }, [acceptShareStatus, notify, shareStatus?.mode, showFailure, textLeaseStatus]);

  useEffect(() => {
    if (
      textLeaseStatus?.status !== 'held' ||
      !textEditorFocusedRef.current ||
      shareStatus?.mode === undefined ||
      shareStatus.mode === 'offline'
    ) {
      return;
    }
    const timer = window.setTimeout(
      () => void beginTextLease(),
      clamp(textLeaseStatus.expiresAtMs - Date.now() + 75, 250, 15_250),
    );
    return () => window.clearTimeout(timer);
  }, [beginTextLease, shareStatus?.mode, textLeaseStatus]);

  useEffect(() => {
    const requested = textLeaseRequestRef.current;
    const current = sessionRef.current;
    if (
      requested !== null &&
      (current === null ||
        activeAuthoringSurface !== 'slide' ||
        current.snapshot.sessionId !== requested.sessionId ||
        activeSlide?.id !== requested.slideId ||
        primaryText?.id !== requested.elementId)
    ) {
      textEditorFocusedRef.current = false;
      void releaseTextLease(requested);
    }
  }, [
    activeAuthoringSurface,
    activeSlide?.id,
    primaryText?.id,
    releaseTextLease,
    session?.snapshot.sessionId,
  ]);

  useEffect(() => {
    if (shareStatus?.mode === 'offline' && textLeaseRequestRef.current !== null) {
      const requested = textLeaseRequestRef.current;
      textEditorFocusedRef.current = false;
      void releaseTextLease(requested);
    }
  }, [releaseTextLease, shareStatus?.mode]);

  const mutateTable = useCallback(
    async (label: string, createCommand: TableCommandFactory): Promise<boolean> => {
      if (primaryTable === undefined || document === undefined) return false;
      if (primaryTable.locked) {
        notify('Unlock the table before editing it.', 'error');
        return false;
      }
      if (activeAuthoringSurface === 'slide') {
        if (activeSlide === undefined) return false;
        return execute(label, [createCommand(activeSlide.id, primaryTable.id)]);
      }
      try {
        return patchElement(
          applyCanonicalTableMutation(primaryTable, document.page, createCommand),
          label,
        );
      } catch (error) {
        notify(
          error instanceof Error ? error.message : 'The table change could not be applied.',
          'error',
        );
        return false;
      }
    },
    [activeAuthoringSurface, activeSlide, document, execute, notify, patchElement, primaryTable],
  );

  const pasteTable = useCallback(async (): Promise<void> => {
    if (primaryTable === undefined || tableTsv.trim() === '') return;
    if (
      await mutateTable('Paste table data', (slideId, tableId) => ({
        type: 'table.paste-tsv',
        slideId,
        tableId,
        startRow: 0,
        startColumn: 0,
        tsv: tableTsv,
      }))
    ) {
      setTableTsv('');
      void commitOnBlur(tableTsvDraftCommitKeyRef.current, () => true);
    }
  }, [commitOnBlur, mutateTable, primaryTable, tableTsv]);

  const updateImageCrop = useCallback(
    (side: keyof ImageElement['crop'], raw: string): Promise<boolean> => {
      if (primaryImage === undefined) return Promise.resolve(false);
      const requested = Number(raw);
      if (!Number.isFinite(requested)) return Promise.resolve(false);
      const opposite =
        side === 'left'
          ? primaryImage.crop.right
          : side === 'right'
            ? primaryImage.crop.left
            : side === 'top'
              ? primaryImage.crop.bottom
              : primaryImage.crop.top;
      return patchElement(
        {
          ...primaryImage,
          crop: {
            ...primaryImage.crop,
            [side]: clamp(requested, 0, Math.max(0, 0.99 - opposite)),
          },
        },
        'Crop image',
      );
    },
    [patchElement, primaryImage],
  );

  const updateConnectorEndpoint = useCallback(
    (
      connector: ConnectorElement,
      endpoint: 'start' | 'end',
      value: ConnectorElement['start'],
    ): Promise<boolean> => {
      if (activeAuthoringSurface !== 'slide') {
        return patchElement(
          { ...connector, [endpoint]: value },
          'Update template connector endpoint',
        );
      }
      if (activeSlide === undefined) return Promise.resolve(false);
      return execute('Update connector endpoint', [
        {
          type: 'connector.update-endpoint',
          slideId: activeSlide.id,
          connectorId: connector.id,
          endpoint,
          value,
        },
      ]);
    },
    [activeAuthoringSurface, activeSlide, execute, patchElement],
  );

  const updateTheme = useCallback(
    (
      themeId: string,
      updater: (theme: Theme) => Theme,
      label = 'Update theme',
    ): Promise<boolean> => {
      return execute(label, (latestDocument) => {
        const latest = latestDocument.themes.find((theme) => theme.id === themeId);
        if (latest === undefined) return [];
        return [{ type: 'theme.update', themeId, replacement: updater(latest) }];
      });
    },
    [execute],
  );

  const duplicateTheme = useCallback(async (): Promise<void> => {
    const source = designTheme ?? document?.themes[0];
    if (source === undefined) return;
    const theme = duplicateThemeWithFreshIds(source, () => crypto.randomUUID());
    if (await execute('Create theme', [{ type: 'theme.create', theme }]))
      setDesignThemeId(theme.id);
  }, [designTheme, document, execute]);

  const createNewBlankTheme = useCallback(async (): Promise<void> => {
    const theme = createBlankTheme(() => crypto.randomUUID(), 'New theme');
    if (await execute('Create blank theme', [{ type: 'theme.create', theme }]))
      setDesignThemeId(theme.id);
  }, [execute]);

  const enforceThemeById = useCallback(
    async (themeId: string): Promise<void> => {
      const themeName =
        sessionRef.current?.snapshot.document.themes.find((theme) => theme.id === themeId)?.name ??
        'Selected theme';
      const applied = await execute('Apply theme to presentation', [
        { type: 'theme.enforce-deck', themeId },
      ]);
      if (applied) notify(`Theme “${themeName}” applied to the full presentation.`, 'success');
    },
    [execute, notify],
  );

  const enforceSelectedTheme = useCallback(async (): Promise<void> => {
    if (designTheme !== undefined) await enforceThemeById(designTheme.id);
  }, [designTheme, enforceThemeById]);

  const deleteTheme = useCallback(async (): Promise<void> => {
    if (document === undefined || designTheme === undefined || document.themes.length <= 1) return;
    const replacement = document.themes.find((theme) => theme.id !== designTheme.id);
    if (replacement === undefined) return;
    if (!window.confirm(`Delete theme “${designTheme.name}” and remap its masters?`)) return;
    if (
      await execute('Delete theme', [
        {
          type: 'theme.delete',
          themeId: designTheme.id,
          replacementThemeId: replacement.id,
        },
      ])
    ) {
      setDesignThemeId(replacement.id);
    }
  }, [designTheme, document, execute]);

  const updateThemeTextStyle = useCallback(
    (role: TextStyleRole, patch: Partial<Omit<TextStyle, 'id' | 'role'>>): Promise<boolean> => {
      if (designTheme === undefined) return Promise.resolve(false);
      return updateTheme(
        designTheme.id,
        (theme) => updateThemeRoleStyle(theme, role, patch),
        `Update ${role} style`,
      );
    },
    [designTheme, updateTheme],
  );

  const updateMaster = useCallback(
    (replacement: Master, label = 'Update master'): Promise<boolean> => {
      const baseline = sessionRef.current?.snapshot.document.masters.find(
        (master) => master.id === replacement.id,
      );
      if (baseline === undefined) return Promise.resolve(false);
      return execute(label, (latestDocument) => {
        const latest = latestDocument.masters.find((master) => master.id === replacement.id);
        if (latest === undefined) return [];
        return [
          {
            type: 'master.update',
            masterId: replacement.id,
            replacement: rebaseEntityReplacement(baseline, replacement, latest),
          },
        ];
      });
    },
    [execute],
  );

  const addMasterTextField = useCallback(
    (
      name: string,
      text: string,
      alignment: TextAlignment,
      frame: Frame,
      options: Readonly<{
        opacity?: number;
        fontSizePt?: number;
        locked?: boolean;
      }> = {},
    ): Promise<boolean> => {
      if (designMaster === undefined) return Promise.resolve(false);
      const element: TextElement = {
        ...createTextElement('caption', text),
        name,
        frame,
        opacity: options.opacity ?? 1,
        locked: options.locked ?? true,
        verticalAlignment: 'middle',
        content: contentFromPlainText(text, {
          kind: 'paragraph',
          alignment,
          marks: emptyMarks(),
        }),
        style: {
          alignment,
          ...(options.fontSizePt === undefined ? {} : { fontSizePt: options.fontSizePt }),
        },
      };
      return updateMaster(
        { ...designMaster, elements: [...designMaster.elements, element] },
        `Add ${name.toLowerCase()}`,
      );
    },
    [designMaster, updateMaster],
  );

  const updateLayout = useCallback(
    (replacement: Layout, label = 'Update layout'): Promise<boolean> => {
      const baseline = sessionRef.current?.snapshot.document.layouts.find(
        (layout) => layout.id === replacement.id,
      );
      if (baseline === undefined) return Promise.resolve(false);
      return execute(label, (latestDocument) => {
        const latest = latestDocument.layouts.find((layout) => layout.id === replacement.id);
        if (latest === undefined) return [];
        return [
          {
            type: 'layout.update',
            layoutId: replacement.id,
            replacement: rebaseEntityReplacement(baseline, replacement, latest),
          },
        ];
      });
    },
    [execute],
  );

  const duplicateMaster = useCallback(async (): Promise<void> => {
    if (designMaster === undefined) return;
    const master: Master = {
      ...designMaster,
      id: crypto.randomUUID(),
      name: `${designMaster.name} copy`,
      elements: duplicateTemplateElements(designMaster.elements),
      guides: duplicateGuides(designMaster.guides),
    };
    if (await execute('Create master', [{ type: 'master.create', master }])) {
      setDesignMasterId(master.id);
      setDesignThemeId(master.themeId);
      setDesignSurface('master');
      setSelectedIds([]);
    }
  }, [designMaster, execute]);

  const duplicateLayout = useCallback(async (): Promise<void> => {
    if (designLayout === undefined) return;
    const layout: Layout = {
      ...designLayout,
      id: crypto.randomUUID(),
      name: `${designLayout.name} copy`,
      elements: duplicateTemplateElements(designLayout.elements),
      guides: duplicateGuides(designLayout.guides),
    };
    if (await execute('Create layout', [{ type: 'layout.create', layout }])) {
      setDesignLayoutId(layout.id);
      setDesignMasterId(layout.masterId);
      setDesignSurface('layout');
      setSelectedIds([]);
    }
  }, [designLayout, execute]);

  const deleteMaster = useCallback(async (): Promise<void> => {
    if (document === undefined || designMaster === undefined || document.masters.length <= 1)
      return;
    if (!window.confirm(`Delete master “${designMaster.name}” and remap its layouts?`)) return;
    const replacement = document.masters.find((master) => master.id !== designMaster.id);
    if (replacement === undefined) return;
    if (
      await execute('Delete master', [
        {
          type: 'master.delete',
          masterId: designMaster.id,
          replacementMasterId: replacement.id,
        },
      ])
    )
      setDesignMasterId(replacement.id);
  }, [designMaster, document, execute]);

  const deleteLayout = useCallback(async (): Promise<void> => {
    if (document === undefined || designLayout === undefined || document.layouts.length <= 1)
      return;
    if (!window.confirm(`Delete layout “${designLayout.name}” and remap its slides?`)) return;
    const replacement = document.layouts.find((layout) => layout.id !== designLayout.id);
    if (replacement === undefined) return;
    if (
      await execute('Delete layout', [
        {
          type: 'layout.delete',
          layoutId: designLayout.id,
          replacementLayoutId: replacement.id,
        },
      ])
    )
      setDesignLayoutId(replacement.id);
  }, [designLayout, document, execute]);

  const transformCanvasElements = useCallback(
    (frames: readonly { readonly elementId: string; readonly frame: Frame }[]): void => {
      transform(frames);
    },
    [transform],
  );

  const toggleLock = useCallback((): void => {
    if (primaryElement === undefined) return;
    if (activeAuthoringSurface === 'slide') {
      if (activeSlide === undefined) return;
      void execute(primaryElement.locked ? 'Unlock object' : 'Lock object', [
        {
          type: 'element.set-locked',
          slideId: activeSlide.id,
          elementId: primaryElement.id,
          locked: !primaryElement.locked,
        },
      ]);
      return;
    }
    void patchElement(
      { ...primaryElement, locked: !primaryElement.locked },
      primaryElement.locked ? 'Unlock template object' : 'Lock template object',
    );
  }, [activeAuthoringSurface, activeSlide, execute, patchElement, primaryElement]);

  const toggleVisible = useCallback((): void => {
    if (primaryElement === undefined) return;
    if (activeAuthoringSurface === 'slide') {
      if (activeSlide === undefined) return;
      void execute(primaryElement.visible ? 'Hide object' : 'Show object', [
        {
          type: 'element.set-visible',
          slideId: activeSlide.id,
          elementId: primaryElement.id,
          visible: !primaryElement.visible,
        },
      ]);
      return;
    }
    void patchElement(
      { ...primaryElement, visible: !primaryElement.visible },
      primaryElement.visible ? 'Hide template object' : 'Show template object',
    );
  }, [activeAuthoringSurface, activeSlide, execute, patchElement, primaryElement]);

  const renameDocument = useCallback((): void => {
    if (document === undefined) return;
    const name = window.prompt('Presentation name', document.name)?.trim();
    if (name !== undefined && name !== '' && name !== document.name)
      void execute('Rename presentation', [{ type: 'deck.rename', name }]);
  }, [document, execute]);

  const renameSlide = useCallback((): void => {
    if (activeSlide === undefined) return;
    const name = window.prompt('Slide name', activeSlide.name)?.trim();
    if (name !== undefined && name !== '' && name !== activeSlide.name)
      void execute('Rename slide', [{ type: 'slide.update', slideId: activeSlide.id, name }]);
  }, [activeSlide, execute]);

  const exportDocument = useCallback(
    async (format: 'html' | 'pdf'): Promise<void> => {
      if (!(await canLeaveInlineTextEditorRef.current())) return;
      const current = sessionRef.current;
      if (current === null || busy) return;
      setBusy(true);
      try {
        const result = await window.htmllelujah.exportDocument({
          sessionId: current.snapshot.sessionId,
          expectedRevision: current.snapshot.revision,
          format,
          includeHidden: current.snapshot.document.settings.includeHiddenSlidesInExport,
        });
        if (!result.ok) showFailure(result);
        else
          notify(
            `${format.toUpperCase()} exported: ${result.value.pageCount} slide${result.value.pageCount === 1 ? '' : 's'}.`,
            'success',
          );
      } finally {
        setBusy(false);
      }
    },
    [busy, notify, showFailure],
  );

  const present = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    const current = sessionRef.current;
    if (current === null || busy) return;
    const result = await window.htmllelujah.present({
      sessionId: current.snapshot.sessionId,
      ...(activeSlide === undefined ? {} : { startSlideId: activeSlide.id }),
    });
    if (!result.ok) showFailure(result);
  }, [activeSlide, busy, showFailure]);

  const openMcp = useCallback(async (): Promise<void> => {
    setMcpOpen(true);
    const result = await window.htmllelujah.mcpStatus();
    if (result.ok) setMcpStatus(result.value);
    else showFailure(result);
  }, [showFailure]);

  const openShare = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
    setShareOpen(true);
    const result = await window.htmllelujah.collaborationStatus({
      sessionId: current.snapshot.sessionId,
    });
    if (result.ok) acceptShareStatus(result.value);
    else showFailure(result);
  }, [showFailure]);

  const hostCollaboration = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    const current = sessionRef.current;
    if (current === null || startingCollaborationRef.current) return;
    startingCollaborationRef.current = true;
    setStartingCollaboration(true);
    try {
      const result = await window.htmllelujah.collaborationHost({
        sessionId: current.snapshot.sessionId,
        displayName,
        enableDiscovery: discovery,
        hostAddress,
      });
      if (!result.ok) {
        showFailure(result);
        return;
      }
      acceptShareStatus(result.value);
      const refresh = await window.htmllelujah.initialize();
      if (refresh.ok) acceptSession(refresh.value.session);
      else showFailure(refresh);
    } finally {
      startingCollaborationRef.current = false;
      setStartingCollaboration(false);
    }
  }, [acceptSession, acceptShareStatus, discovery, displayName, hostAddress, showFailure]);

  const joinCollaboration = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    const current = sessionRef.current;
    if (current === null || joiningCollaborationRef.current) return;
    joiningCollaborationRef.current = true;
    setJoiningCollaboration(true);
    try {
      const result = await window.htmllelujah.collaborationJoin({
        sessionId: current.snapshot.sessionId,
        endpoint: joinEndpoint,
        sessionCode: joinCode,
        expectedFingerprint: joinFingerprint,
        displayName,
      });
      if (!result.ok) {
        showFailure(result);
        return;
      }
      acceptShareStatus(result.value);
      const refresh = await window.htmllelujah.initialize();
      if (refresh.ok) acceptSession(refresh.value.session);
      else showFailure(refresh);
    } finally {
      joiningCollaborationRef.current = false;
      setJoiningCollaboration(false);
    }
  }, [
    acceptSession,
    acceptShareStatus,
    displayName,
    joinCode,
    joinEndpoint,
    joinFingerprint,
    showFailure,
  ]);

  const decideCollaborationJoin = useCallback(
    async (joinRequestId: string, decision: 'accept' | 'reject'): Promise<void> => {
      const current = sessionRef.current;
      if (current === null || decidingJoinId !== null) return;
      setDecidingJoinId(joinRequestId);
      setCollaborationDecisionError(null);
      try {
        const result = await window.htmllelujah.collaborationDecideJoin({
          sessionId: current.snapshot.sessionId,
          joinRequestId,
          decision,
        });
        if (!result.ok) {
          setCollaborationDecisionError(result.error.message);
          showFailure(result);
          return;
        }
        acceptShareStatus(result.value);
        notify(
          decision === 'accept' ? 'Participant accepted.' : 'Join request rejected.',
          'success',
        );
      } finally {
        setDecidingJoinId(null);
      }
    },
    [acceptShareStatus, decidingJoinId, notify, showFailure],
  );

  const leaveCollaboration = useCallback(async (): Promise<void> => {
    if (!(await canLeaveInlineTextEditorRef.current())) return;
    const current = sessionRef.current;
    if (current === null) return;
    const result = await window.htmllelujah.collaborationLeave({
      sessionId: current.snapshot.sessionId,
    });
    if (!result.ok) {
      showFailure(result);
      return;
    }
    acceptShareStatus(result.value);
    const refresh = await window.htmllelujah.initialize();
    if (refresh.ok) acceptSession(refresh.value.session);
    else showFailure(refresh);
    notify('LAN session ended safely.', 'success');
  }, [acceptSession, acceptShareStatus, notify, showFailure]);

  const nudge = useCallback(
    (dxPt: number, dyPt: number): void => {
      if (selectedElements.length === 0 || document === undefined) return;
      transform(
        selectedElements
          .filter((element) => !element.locked)
          .map((element) => ({
            elementId: element.id,
            frame: {
              ...element.frame,
              xPt: clamp(
                element.frame.xPt + dxPt,
                0,
                document.page.widthPt - element.frame.widthPt,
              ),
              yPt: clamp(
                element.frame.yPt + dyPt,
                0,
                document.page.heightPt - element.frame.heightPt,
              ),
            },
          })),
      );
    },
    [document, selectedElements, transform],
  );

  useEffect(() => {
    const writeSelection = (event: ClipboardEvent, cut: boolean): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const payload = serializeSelectedObjects();
      if (payload === null || event.clipboardData === null) return;
      event.preventDefault();
      event.clipboardData.setData(OBJECT_CLIPBOARD_MIME, payload.serialized);
      event.clipboardData.setData('text/plain', payload.plainText);
      objectClipboardRef.current = payload.serialized;
      objectClipboardPlainTextRef.current = payload.plainText;
      notify(
        `${selectedElements.length} object${selectedElements.length === 1 ? '' : 's'} ${
          cut ? 'cut' : 'copied'
        }.`,
        'success',
      );
      if (cut) void deleteSelection();
    };
    const onCopy = (event: ClipboardEvent): void => writeSelection(event, false);
    const onCut = (event: ClipboardEvent): void => writeSelection(event, true);
    const onPaste = (event: ClipboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target) || event.clipboardData === null)
        return;
      const privateSerialized = event.clipboardData.getData(OBJECT_CLIPBOARD_MIME);
      const serialized =
        privateSerialized !== ''
          ? privateSerialized
          : event.clipboardData.getData('text/plain') === objectClipboardPlainTextRef.current
            ? objectClipboardRef.current
            : null;
      if (serialized === null) return;
      event.preventDefault();
      objectClipboardRef.current = serialized;
      void pasteSerializedObjects(serialized);
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('cut', onCut);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('cut', onCut);
      window.removeEventListener('paste', onPaste);
    };
  }, [
    deleteSelection,
    notify,
    pasteSerializedObjects,
    selectedElements.length,
    serializeSelectedObjects,
  ]);

  const focusCanvasObject = useCallback((elementId: string): void => {
    const target = [
      ...window.document.querySelectorAll<HTMLElement>('[data-canvas-element-id]'),
    ].find((candidate) => candidate.dataset.canvasElementId === elementId);
    target?.focus({ preventScroll: true });
  }, []);

  const dismissObjectContextMenu = useCallback(
    (restoreFocus: boolean): void => {
      const elementId = objectContextMenu?.elementId;
      setObjectContextMenu(null);
      if (restoreFocus && elementId !== undefined) {
        window.requestAnimationFrame(() => focusCanvasObject(elementId));
      }
    },
    [focusCanvasObject, objectContextMenu?.elementId],
  );

  useEffect(() => {
    if (objectContextMenu === null) return;
    const frame = window.requestAnimationFrame(() => {
      objectContextMenuRef.current
        ?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [objectContextMenu]);

  const navigateObjectContextMenu = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      const buttons = [
        ...(objectContextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        ) ?? []),
      ];
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismissObjectContextMenu(true);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || buttons.length === 0)
        return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = buttons.findIndex((button) => button === window.document.activeElement);
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : event.key === 'ArrowDown'
              ? currentIndex < 0
                ? 0
                : (currentIndex + 1) % buttons.length
              : currentIndex <= 0
                ? buttons.length - 1
                : currentIndex - 1;
      buttons[nextIndex]?.focus({ preventScroll: true });
    },
    [dismissObjectContextMenu],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 's') {
        event.preventDefault();
        void save(event.shiftKey);
      } else if (modifier && key === 'o') {
        event.preventDefault();
        void replaceDocument('open');
      } else if (modifier && key === 'n') {
        event.preventDefault();
        void replaceDocument('new');
      } else if (modifier && key === 'z') {
        event.preventDefault();
        void undo(event.shiftKey);
      } else if (modifier && key === 'y') {
        event.preventDefault();
        void undo(true);
      } else if (modifier && key === 'd') {
        event.preventDefault();
        void duplicateSelection();
      } else if (modifier && key === 'g' && activeAuthoringSurface === 'slide') {
        event.preventDefault();
        if (event.shiftKey) void ungroupSelection();
        else void groupSelection();
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedIds.length > 0) {
          event.preventDefault();
          void deleteSelection();
        }
      } else if (event.key === 'F5') {
        event.preventDefault();
        void present();
      } else if (event.key.startsWith('Arrow') && selectedIds.length > 0) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        nudge(
          event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
        );
      } else if (event.key === 'Escape') {
        setActiveMenu(null);
        dismissObjectContextMenu(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeAuthoringSurface,
    deleteSelection,
    dismissObjectContextMenu,
    duplicateSelection,
    groupSelection,
    nudge,
    present,
    replaceDocument,
    save,
    selectedIds.length,
    undo,
    ungroupSelection,
  ]);

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (!(event.target instanceof HTMLElement)) return;
      if (activeMenu !== null && event.target.closest('.application-menu') === null)
        setActiveMenu(null);
      if (
        objectContextMenu !== null &&
        event.target.closest('.object-context-menu') === null &&
        event.button === 0
      )
        dismissObjectContextMenu(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [activeMenu, dismissObjectContextMenu, objectContextMenu]);

  if (fatalError !== null) return <LoadingScreen message={fatalError} />;
  if (session === null || document === undefined || activeSlide === undefined)
    return <LoadingScreen message="Opening your local workspace…" />;

  const canvasContext = createDesignCanvasContext(
    document,
    activeSlide,
    designSurface,
    designLayout,
    designMaster,
  );
  const canvasDocument = canvasContext.document;
  const canvasSlide = canvasContext.slide;
  const canvasEditableElements = canvasContext.editableElements;
  const canvasEditableSource = canvasContext.editableSource;
  const canvasContextLabel = canvasContext.label;

  const collaborationTextActive =
    activeAuthoringSurface === 'slide' &&
    (shareStatus?.mode === 'host' || shareStatus?.mode === 'guest');
  const currentTextLeaseRequest: CollaborationTextLeaseInput | null =
    activeAuthoringSurface !== 'slide' || primaryText === undefined
      ? null
      : {
          sessionId: session.snapshot.sessionId,
          slideId: activeSlide.id,
          elementId: primaryText.id,
        };
  const currentTextLeaseOwned =
    textLeaseStatus?.status === 'owned' &&
    sameTextLeaseRequest(textLeaseRequestRef.current, currentTextLeaseRequest) &&
    textLeaseStatus.expiresAtMs > Date.now();
  const textLeaseBlocked = collaborationTextActive && (!currentTextLeaseOwned || textLeasePending);
  const textDraftLabel = textDraftConflict
    ? 'Conflict — draft preserved'
    : textDraftDirty
      ? 'Draft not applied'
      : 'Up to date';
  const textLeaseLabel = textLeasePending
    ? 'Reserving text…'
    : textLeaseStatus?.status === 'held'
      ? `Editing by participant ${textLeaseStatus.ownerClientId.slice(0, 8)}`
      : currentTextLeaseOwned
        ? `Reserved for you · ${textDraftLabel}`
        : collaborationTextActive
          ? 'Reserve this text to edit'
          : textDraftLabel;

  const renderMenu = (): React.ReactNode => {
    if (activeMenu === null) return null;
    const closeThen =
      (action: () => void): (() => void) =>
      () => {
        setActiveMenu(null);
        action();
      };
    return (
      <div className="menu-popover" role="menu" aria-label={`${activeMenu} menu`}>
        {activeMenu === 'File' ? (
          <>
            <MenuButton onClick={closeThen(() => void replaceDocument('new'))}>
              New <kbd>Ctrl N</kbd>
            </MenuButton>
            <MenuButton onClick={closeThen(() => void replaceDocument('open'))}>
              Open… <kbd>Ctrl O</kbd>
            </MenuButton>
            <span className="menu-separator" />
            <MenuButton onClick={closeThen(() => void save())}>
              Save <kbd>Ctrl S</kbd>
            </MenuButton>
            <MenuButton onClick={closeThen(() => void save(true))}>
              Save as… <kbd>Ctrl Shift S</kbd>
            </MenuButton>
            {recoveryCandidates.length > 0 ? (
              <MenuButton onClick={closeThen(() => setRecoveryOpen(true))}>
                Recover local work <kbd>{recoveryCandidates.length}</kbd>
              </MenuButton>
            ) : null}
            <span className="menu-separator" />
            <MenuButton onClick={closeThen(() => void exportDocument('html'))}>
              Export standalone HTML…
            </MenuButton>
            <MenuButton onClick={closeThen(() => void exportDocument('pdf'))}>
              Export PDF…
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'Edit' ? (
          <>
            <MenuButton disabled={!session.snapshot.canUndo} onClick={closeThen(() => void undo())}>
              Undo <kbd>Ctrl Z</kbd>
            </MenuButton>
            <MenuButton
              disabled={!session.snapshot.canRedo}
              onClick={closeThen(() => void undo(true))}
            >
              Redo <kbd>Ctrl Y</kbd>
            </MenuButton>
            <span className="menu-separator" />
            <MenuButton
              disabled={selectedIds.length === 0}
              onClick={closeThen(() => copySelectionToInternalClipboard())}
            >
              Copy <kbd>Ctrl C</kbd>
            </MenuButton>
            <MenuButton
              disabled={selectedIds.length === 0}
              onClick={closeThen(() => void cutSelectionToInternalClipboard())}
            >
              Cut <kbd>Ctrl X</kbd>
            </MenuButton>
            <MenuButton
              disabled={objectClipboardRef.current === null}
              onClick={closeThen(() => {
                const serialized = objectClipboardRef.current;
                if (serialized !== null) void pasteSerializedObjects(serialized);
              })}
            >
              Paste <kbd>Ctrl V</kbd>
            </MenuButton>
            <span className="menu-separator" />
            <MenuButton
              disabled={selectedIds.length === 0}
              onClick={closeThen(() => void duplicateSelection())}
            >
              Duplicate <kbd>Ctrl D</kbd>
            </MenuButton>
            <MenuButton
              disabled={selectedIds.length === 0}
              onClick={closeThen(() => void deleteSelection())}
            >
              Delete <kbd>Del</kbd>
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'View' ? (
          <>
            <MenuButton onClick={closeThen(() => setGridEnabled((value) => !value))}>
              {gridEnabled ? 'Hide' : 'Show'} grid
            </MenuButton>
            <MenuButton onClick={closeThen(() => setZoom({ mode: 'manual', percent: 100 }))}>
              Actual size
            </MenuButton>
            <MenuButton onClick={closeThen(() => setZoom({ mode: 'fit' }))}>Fit slide</MenuButton>
            <MenuButton onClick={closeThen(() => void present())}>
              Present <kbd>F5</kbd>
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'Insert' ? (
          <>
            <MenuButton onClick={closeThen(() => void addSlide())}>New slide</MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createTextElement()))}>
              Text box
            </MenuButton>
            <MenuButton onClick={closeThen(() => void importImage())}>Image…</MenuButton>
            <MenuButton
              onClick={closeThen(() =>
                setContentPicker({ initialCatalog: 'shapes', catalogs: ['shapes'] }),
              )}
            >
              Shape…
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createTableElement()))}>
              Table
            </MenuButton>
            <MenuButton
              onClick={closeThen(() =>
                setContentPicker({
                  initialCatalog: 'local-icons',
                  catalogs: ['local-icons'],
                }),
              )}
            >
              Icon…
            </MenuButton>
            <MenuButton
              onClick={closeThen(() =>
                setContentPicker({ initialCatalog: 'twemoji', catalogs: ['twemoji'] }),
              )}
            >
              Emoji…
            </MenuButton>
            <MenuButton
              onClick={closeThen(() =>
                setContentPicker({
                  initialCatalog: 'circle-flags',
                  catalogs: ['circle-flags'],
                }),
              )}
            >
              Circle flag…
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createConnectorElement()))}>
              Connector
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'Arrange' ? (
          <>
            <MenuButton
              disabled={activeAuthoringSurface !== 'slide' || selectedIds.length < 2}
              onClick={closeThen(groupSelection)}
            >
              Group <kbd>Ctrl G</kbd>
            </MenuButton>
            <MenuButton
              disabled={activeAuthoringSurface !== 'slide' || primaryElement?.type !== 'group'}
              onClick={closeThen(ungroupSelection)}
            >
              Ungroup <kbd>Ctrl Shift G</kbd>
            </MenuButton>
            <span className="menu-separator" />
            <MenuButton disabled={selectedIds.length < 2} onClick={closeThen(() => align('left'))}>
              Align left
            </MenuButton>
            <MenuButton
              disabled={selectedIds.length < 3}
              onClick={closeThen(() => distribute('horizontal'))}
            >
              Distribute horizontally
            </MenuButton>
            <MenuButton
              disabled={primaryElement === undefined}
              onClick={closeThen(() => reorder('front'))}
            >
              Bring to front
            </MenuButton>
            <MenuButton
              disabled={primaryElement === undefined}
              onClick={closeThen(() => reorder('back'))}
            >
              Send to back
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'Help' ? (
          <>
            <MenuButton
              onClick={closeThen(() =>
                notify(
                  'Double-click text to edit. Shift constrains movement. Alt resizes from center.',
                  'info',
                ),
              )}
            >
              Editing tips
            </MenuButton>
            <MenuButton
              onClick={closeThen(() => notify('HTMLlelujah V1 · local-first · AI-native.', 'info'))}
            >
              About HTMLlelujah
            </MenuButton>
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="app-shell" aria-busy={busy}>
      <header className="app-header">
        <div className="title-row">
          <div className="brand-lockup" aria-label="HTMLlelujah">
            <img
              className="brand-mark"
              src={htmllelujahAppIcon}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
            <span className="brand-name">HTMLlelujah</span>
          </div>
          <button
            type="button"
            className="document-title"
            title="Rename presentation"
            onClick={renameDocument}
          >
            <span>{document.name}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <span
            className={`save-state${session.snapshot.dirty ? '' : ' is-saved'}`}
            aria-live="polite"
          >
            {session.snapshot.dirty ? (
              <span className="save-dot" />
            ) : (
              <Check size={13} aria-hidden="true" />
            )}
            {session.snapshot.dirty
              ? session.snapshot.durability === 'journaled'
                ? 'Recovered locally'
                : 'Local changes'
              : 'Saved locally'}
          </span>
          <div className="title-actions">
            <EditorButton label="Save locally" onClick={() => void save()} disabled={busy}>
              <Save size={16} />
            </EditorButton>
            <button type="button" className="share-button" onClick={() => void openMcp()}>
              <Code2 size={15} aria-hidden="true" /> Codex
            </button>
            <button type="button" className="share-button" onClick={() => void openShare()}>
              <Share2 size={15} aria-hidden="true" /> Share
            </button>
            <button
              type="button"
              className="present-button"
              disabled={busy}
              onClick={() => void present()}
            >
              <Play size={14} fill="currentColor" aria-hidden="true" /> Present
            </button>
          </div>
        </div>
        <div className="menu-row">
          <nav aria-label="Application menu" className="application-menu">
            {menuItems.map((item) => (
              <button
                type="button"
                key={item}
                className={activeMenu === item ? 'is-active' : ''}
                aria-haspopup="menu"
                aria-expanded={activeMenu === item}
                onClick={() => setActiveMenu((current) => (current === item ? null : item))}
              >
                {item}
              </button>
            ))}
            {renderMenu()}
          </nav>
          <span className="local-badge">
            <Sparkles size={11} aria-hidden="true" /> AI-NATIVE · LOCAL
          </span>
        </div>
        <div className="toolbar" role="toolbar" aria-label="Editing tools">
          <div className="toolbar-group">
            <EditorButton
              label="Undo"
              shortcut="Ctrl+Z"
              disabled={!session.snapshot.canUndo || busy}
              onClick={() => void undo()}
            >
              <Undo2 size={17} />
            </EditorButton>
            <EditorButton
              label="Redo"
              shortcut="Ctrl+Y"
              disabled={!session.snapshot.canRedo || busy}
              onClick={() => void undo(true)}
            >
              <Redo2 size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group">
            <EditorButton label="Select" active>
              <MousePointer2 size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group add-tools">
            <EditorButton
              label="Add text"
              text="Text"
              onClick={() => void addElement(createTextElement())}
            >
              <Type size={17} />
            </EditorButton>
            <EditorButton
              label="Add shape"
              text="Shape"
              onClick={() => setContentPicker({ initialCatalog: 'shapes', catalogs: ['shapes'] })}
            >
              <Square size={17} />
              <ChevronDown size={11} />
            </EditorButton>
            <EditorButton label="Add image" text="Image" onClick={() => void importImage()}>
              <Image size={17} />
            </EditorButton>
            <EditorButton
              label="Add table"
              text="Table"
              onClick={() => void addElement(createTableElement())}
            >
              <Table2 size={17} />
            </EditorButton>
            <EditorButton
              label="Add icon"
              onClick={() =>
                setContentPicker({
                  initialCatalog: 'local-icons',
                  catalogs: ['local-icons'],
                })
              }
            >
              <Sparkles size={17} />
              <ChevronDown size={11} />
            </EditorButton>
            <EditorButton
              label="Add emoji"
              onClick={() => setContentPicker({ initialCatalog: 'twemoji', catalogs: ['twemoji'] })}
            >
              <Smile size={17} />
              <ChevronDown size={11} />
            </EditorButton>
            <EditorButton
              label="Add flag"
              onClick={() =>
                setContentPicker({
                  initialCatalog: 'circle-flags',
                  catalogs: ['circle-flags'],
                })
              }
            >
              <Flag size={17} />
              <ChevronDown size={11} />
            </EditorButton>
            <EditorButton
              label="Add connector"
              onClick={() => void addElement(createConnectorElement())}
            >
              <Link2 size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group">
            <EditorButton
              label="Align left"
              disabled={selectedIds.length < 2}
              onClick={() => align('left')}
            >
              <AlignStartVertical size={17} />
            </EditorButton>
            <EditorButton
              label="Align centers"
              disabled={selectedIds.length < 2}
              onClick={() => align('horizontal-center')}
            >
              <AlignCenterVertical size={17} />
            </EditorButton>
            <EditorButton
              label="Align right"
              disabled={selectedIds.length < 2}
              onClick={() => align('right')}
            >
              <AlignEndHorizontal size={17} />
            </EditorButton>
            <EditorButton
              label="Distribute horizontally"
              disabled={selectedIds.length < 3}
              onClick={() => distribute('horizontal')}
            >
              <Columns3 size={17} />
            </EditorButton>
            <EditorButton
              label="Distribute vertically"
              disabled={selectedIds.length < 3}
              onClick={() => distribute('vertical')}
            >
              <Rows3 size={17} />
            </EditorButton>
            <EditorButton
              label={primaryElement?.locked ? 'Unlock object' : 'Lock object'}
              disabled={primaryElement === undefined}
              active={primaryElement?.locked === true}
              onClick={toggleLock}
            >
              {primaryElement?.locked ? <Unlock size={17} /> : <Lock size={17} />}
            </EditorButton>
          </div>
          <div className="toolbar-group toolbar-tail">
            <EditorButton
              label="Toggle grid"
              active={gridEnabled}
              onClick={() => setGridEnabled((current) => !current)}
            >
              <Grid3X3 size={17} />
            </EditorButton>
            <EditorButton label="More tools" onClick={() => setActiveMenu('Insert')}>
              <MoreHorizontal size={18} />
            </EditorButton>
          </div>
        </div>
      </header>

      <main className="editor-layout">
        <aside className="slides-panel" aria-label="Slides">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DECK</span>
              <h2>Slides</h2>
            </div>
            <EditorButton label="Add slide" compact onClick={() => void addSlide()}>
              <Plus size={16} />
            </EditorButton>
          </div>
          <div className="slide-list">
            {document.slides.map((slide, index) => (
              <SlideThumbnail
                key={slide.id}
                document={document}
                slide={slide}
                assetUrls={session.assetUrls}
                index={index}
                selected={slide.id === activeSlide.id}
                onSelect={() => {
                  void canLeaveInlineTextEditor().then((canLeave) => {
                    if (!canLeave) return;
                    setActiveSlideId(slide.id);
                    setDesignSurface('slide');
                    setSelectedIds([]);
                  });
                }}
                onReorder={(direction) => reorderSlide(slide.id, direction)}
              />
            ))}
          </div>
          <div className="slide-panel-actions">
            <button type="button" className="new-slide-button" onClick={() => void addSlide()}>
              <Plus size={15} /> New slide
            </button>
            <button
              type="button"
              className="slide-mini-action"
              title="Move slide earlier"
              aria-label="Move selected slide earlier"
              disabled={document.slides.findIndex((slide) => slide.id === activeSlide.id) <= 0}
              onClick={() => reorderSlide(activeSlide.id, -1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="slide-mini-action"
              title="Move slide later"
              aria-label="Move selected slide later"
              disabled={
                document.slides.findIndex((slide) => slide.id === activeSlide.id) >=
                document.slides.length - 1
              }
              onClick={() => reorderSlide(activeSlide.id, 1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="slide-mini-action"
              title="Duplicate slide"
              onClick={() => void duplicateSlide()}
            >
              <Copy size={14} />
            </button>
            <button
              type="button"
              className="slide-mini-action"
              title="Delete slide"
              disabled={document.slides.length <= 1}
              onClick={() => void deleteSlide()}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </aside>

        <section className="workspace" ref={workspaceRef} aria-label="Slide workspace">
          <div className="workspace-ruler horizontal-ruler" aria-hidden="true">
            {[0, 2, 4, 6, 8, 10, 12].map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
          <div className="workspace-ruler vertical-ruler" aria-hidden="true">
            {[0, 2, 4, 6].map((mark) => (
              <span key={mark}>{mark}</span>
            ))}
          </div>
          <div className="canvas-context-badge" role="status">
            {canvasContextLabel}
          </div>
          <CanonicalSlideCanvas
            document={canvasDocument}
            slide={canvasSlide}
            assetUrls={session.assetUrls}
            scale={canvasScale}
            gridEnabled={gridEnabled}
            editableElements={canvasEditableElements}
            editableSource={canvasEditableSource}
            includeTemplatePlaceholders={canvasEditableSource !== 'slide'}
            inlineTextEditor={
              canvasEditableSource === 'slide' &&
              inlineTextElementId === primaryText?.id &&
              textDraftMatchesPrimary &&
              textDraft !== null
                ? {
                    elementId: inlineTextElementId,
                    value: textDraft.text,
                    disabled: textLeaseBlocked || textEditingLocked,
                    pending: textEditingLocked,
                    conflict: textDraftConflict,
                    maxLength: RICH_CLIPBOARD_LIMITS.maxTextLength,
                    fontFamily: textDraft.fontFamily,
                    fontSizePt: textDraft.fontSizePt,
                    fontWeight: textDraft.bold ? 700 : 400,
                    italic: textDraft.italic,
                    color: textDraft.color,
                    lineHeight: textDraft.lineHeight,
                    letterSpacingPt: textDraft.letterSpacingPt,
                    alignment: textDraft.alignment,
                  }
                : null
            }
            selectedIds={selectedIds}
            onSelect={(ids) => {
              if (sameCanvasSelection(ids, selectedIds)) {
                setSelectedIds(ids);
                return true;
              }
              return canLeaveInlineTextEditorRef.current().then((canLeave) => {
                if (canLeave) setSelectedIds(ids);
                return canLeave;
              });
            }}
            onTransform={transformCanvasElements}
            onEditText={(elementId) => {
              const beginEditing = (): void => {
                setSelectedIds([elementId]);
                setInspectorTab('properties');
                if (canvasEditableSource === 'slide') {
                  inlineCommitInFlightRef.current = false;
                  updateInlineTextElementId(elementId);
                }
              };
              if (
                textApplyInFlightRef.current === null &&
                inlineCommitPromiseRef.current === null &&
                primaryText?.id === elementId &&
                sameCanvasSelection(selectedIds, [elementId])
              ) {
                beginEditing();
                return;
              }
              void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                if (canLeave) beginEditing();
              });
            }}
            onContextMenu={(elementId, position) => {
              setActiveMenu(null);
              setObjectContextMenu({
                elementId,
                x: Math.max(8, Math.min(position.clientX, window.innerWidth - 236)),
                y: Math.max(8, Math.min(position.clientY, window.innerHeight - 520)),
              });
            }}
            onInlineTextChange={(text) => {
              if (textDraft === null) return;
              editTextDraft({
                ...textDraft,
                text,
                contentOverride:
                  textDraft.contentOverride === null
                    ? null
                    : replacePlainTextPreservingStyles(textDraft.contentOverride, text),
              });
            }}
            onInlineTextPaste={pasteRichText}
            onInlineTextCommit={(target, confirmConflict, relatedTarget) => {
              if (!confirmConflict) {
                if (consumeInlineTextBlurSuppression(suppressNextInlineBlurRef)) {
                  void commitOnBlur(target, () => true);
                  return;
                }
                if (
                  relatedTarget instanceof HTMLElement &&
                  relatedTarget.closest('.text-editor-section') !== null
                )
                  return;
              }
              void commitOnBlur(target, () => commitInlineText({ confirmConflict }));
            }}
            onInlineTextCancel={revertTextDraft}
            onInlineTextFocus={() => {
              textEditorFocusedRef.current = true;
              if (collaborationTextActive) void beginTextLease();
            }}
          />
          <div className="canvas-caption">
            <button type="button" disabled={canvasEditableSource !== 'slide'} onClick={renameSlide}>
              {canvasContextLabel}
            </button>
            <span>
              {document.page.widthPt} × {document.page.heightPt} pt
            </span>
          </div>
        </section>

        <aside className="inspector" aria-label="Inspector">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector view">
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'properties'}
              className={inspectorTab === 'properties' ? 'is-active' : ''}
              onClick={() => {
                void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                  if (!canLeave) return;
                  setInspectorTab('properties');
                });
              }}
            >
              <SlidersHorizontal size={14} /> Properties
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'design'}
              className={inspectorTab === 'design' ? 'is-active' : ''}
              onClick={() => {
                void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                  if (canLeave) setInspectorTab('design');
                });
              }}
            >
              <Palette size={14} /> Design
            </button>
          </div>
          {hasOrphanedTextDraft && textDraft !== null ? (
            <section className="inspector-section text-draft-recovery" role="alert">
              <div className="section-heading-row">
                <h3>Preserved text draft</h3>
                <span className="section-status">Copy before discarding</span>
              </div>
              <p className="field-hint">
                The original text object is no longer selected or available. Your local draft is
                preserved below.
              </p>
              <textarea
                className="text-content-editor"
                aria-label="Preserved text draft"
                readOnly
                rows={6}
                value={textDraft.text}
              />
              <button
                type="button"
                className="danger-action"
                disabled={textApplyPending}
                onClick={revertTextDraft}
              >
                Discard preserved draft
              </button>
            </section>
          ) : null}
          {inspectorTab === 'design' ? (
            <div className="inspector-scroll" role="tabpanel">
              <nav className="design-breadcrumb" aria-label="Design editing scope">
                {(['slide', 'layout', 'master'] as const).map((surface) => (
                  <button
                    key={surface}
                    type="button"
                    className={designSurface === surface ? 'is-active' : ''}
                    aria-pressed={designSurface === surface}
                    onClick={() => {
                      void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                        if (!canLeave) return;
                        setDesignSurface(surface);
                        setSelectedIds([]);
                      });
                    }}
                  >
                    {surface.slice(0, 1).toUpperCase() + surface.slice(1)}
                  </button>
                ))}
              </nav>
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Theme</h3>
                  <span className="section-status">{document.themes.length} available</span>
                </div>
                <label className="stacked-field">
                  <span>Presentation theme</span>
                  <select
                    value={designTheme?.id ?? ''}
                    onChange={(event) => {
                      const themeId = event.currentTarget.value;
                      setDesignThemeId(themeId);
                      void enforceThemeById(themeId);
                    }}
                  >
                    {document.themes.map((theme) => (
                      <option key={theme.id} value={theme.id}>
                        {theme.name}
                      </option>
                    ))}
                  </select>
                </label>
                {designTheme !== undefined ? (
                  <div className="theme-card">
                    <div className="theme-swatch-row">
                      {Object.values(designTheme.colors).map((color, index) => (
                        <span
                          key={`${color}-${index}`}
                          className="theme-color-dot"
                          style={{ background: color }}
                        />
                      ))}
                    </div>
                    <label className="stacked-field">
                      <span>Name</span>
                      <input
                        key={`${designTheme.id}-name`}
                        defaultValue={designTheme.name}
                        maxLength={120}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            const name = target.value.trim();
                            if (name === designTheme.name)
                              return restoreBlurValue(target, designTheme.name);
                            if (name === '')
                              return restoreBlurValue(
                                target,
                                designTheme.name,
                                'A theme name cannot be empty.',
                              );
                            target.value = name;
                            return updateTheme(
                              designTheme.id,
                              (theme) => ({ ...theme, name }),
                              'Rename theme',
                            );
                          });
                        }}
                      />
                    </label>
                    <div className="font-controls">
                      {(['heading', 'body'] as const).map((familyKind) => (
                        <label className="stacked-field font-family" key={familyKind}>
                          <span>{familyKind === 'heading' ? 'Heading font' : 'Body font'}</span>
                          <select
                            value={
                              familyKind === 'heading'
                                ? designTheme.headingFontFamily
                                : designTheme.bodyFontFamily
                            }
                            onChange={(event) => {
                              const family = event.currentTarget.value;
                              updateTheme(
                                designTheme.id,
                                (theme) => updateThemeFontFamily(theme, familyKind, family),
                                `Change ${familyKind} font`,
                              );
                            }}
                          >
                            {[
                              'Arial',
                              'Aptos',
                              'Calibri',
                              'Georgia',
                              'Times New Roman',
                              'Verdana',
                            ].map((family) => (
                              <option value={family} key={family}>
                                {family}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    <div className="theme-color-fields">
                      {(Object.keys(designTheme.colors) as (keyof Theme['colors'])[]).map((key) => (
                        <label className="color-field" key={key}>
                          {key.replace(/([A-Z])/g, ' $1')}
                          <input
                            type="color"
                            value={designTheme.colors[key]}
                            onChange={(event) => {
                              const color = event.currentTarget.value;
                              updateTheme(
                                designTheme.id,
                                (theme) => ({
                                  ...theme,
                                  colors: {
                                    ...theme.colors,
                                    [key]: color,
                                  },
                                }),
                                `Change theme ${key}`,
                              );
                            }}
                          />
                        </label>
                      ))}
                    </div>
                    {themeTextStyleRoles.map((role) => {
                      const style = themeRoleStyle(designTheme, role);
                      return (
                        <fieldset className="theme-text-style" key={role}>
                          <legend>{`${role.slice(0, 1).toUpperCase()}${role.slice(1)} style`}</legend>
                          <label className="stacked-field">
                            <span>Font</span>
                            <select
                              value={style.fontFamily}
                              onChange={(event) =>
                                updateThemeTextStyle(role, {
                                  fontFamily: event.currentTarget.value,
                                })
                              }
                            >
                              {[
                                'Arial',
                                'Aptos',
                                'Calibri',
                                'Georgia',
                                'Times New Roman',
                                'Verdana',
                              ].map((family) => (
                                <option value={family} key={family}>
                                  {family}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="stacked-field">
                            <span>Size (pt)</span>
                            <input
                              type="number"
                              min="6"
                              max="240"
                              key={`${style.id}-size`}
                              defaultValue={style.fontSizePt}
                              onBlur={(event) => {
                                const target = event.currentTarget;
                                void commitOnBlur(target, () => {
                                  if (
                                    target.value.trim() === '' ||
                                    !Number.isFinite(target.valueAsNumber)
                                  )
                                    return restoreBlurValue(
                                      target,
                                      style.fontSizePt,
                                      'Enter a valid font size.',
                                    );
                                  const fontSizePt = clamp(target.valueAsNumber, 6, 240);
                                  if (fontSizePt === style.fontSizePt)
                                    return restoreBlurValue(target, style.fontSizePt);
                                  target.value = String(fontSizePt);
                                  return updateThemeTextStyle(role, { fontSizePt });
                                });
                              }}
                            />
                          </label>
                          <label className="stacked-field">
                            <span>Weight</span>
                            <input
                              type="number"
                              min="100"
                              max="900"
                              step="100"
                              key={`${style.id}-weight`}
                              defaultValue={style.fontWeight}
                              onBlur={(event) => {
                                const target = event.currentTarget;
                                void commitOnBlur(target, () => {
                                  if (
                                    target.value.trim() === '' ||
                                    !Number.isFinite(target.valueAsNumber)
                                  )
                                    return restoreBlurValue(
                                      target,
                                      style.fontWeight,
                                      'Enter a valid font weight.',
                                    );
                                  const fontWeight =
                                    Math.round(clamp(target.valueAsNumber, 100, 900) / 100) * 100;
                                  if (fontWeight === style.fontWeight)
                                    return restoreBlurValue(target, style.fontWeight);
                                  target.value = String(fontWeight);
                                  return updateThemeTextStyle(role, { fontWeight });
                                });
                              }}
                            />
                          </label>
                          <label className="toggle-row">
                            <input
                              type="checkbox"
                              checked={style.italic}
                              onChange={(event) =>
                                updateThemeTextStyle(role, { italic: event.currentTarget.checked })
                              }
                            />{' '}
                            Italic
                          </label>
                          <label className="stacked-field">
                            <span>Line height</span>
                            <input
                              type="number"
                              min="0.5"
                              max="4"
                              step="0.05"
                              key={`${style.id}-line-height`}
                              defaultValue={style.lineHeight}
                              onBlur={(event) => {
                                const target = event.currentTarget;
                                void commitOnBlur(target, () => {
                                  if (
                                    target.value.trim() === '' ||
                                    !Number.isFinite(target.valueAsNumber)
                                  )
                                    return restoreBlurValue(
                                      target,
                                      style.lineHeight,
                                      'Enter a valid line height.',
                                    );
                                  const lineHeight = clamp(target.valueAsNumber, 0.5, 4);
                                  if (lineHeight === style.lineHeight)
                                    return restoreBlurValue(target, style.lineHeight);
                                  target.value = String(lineHeight);
                                  return updateThemeTextStyle(role, { lineHeight });
                                });
                              }}
                            />
                          </label>
                          <label className="stacked-field">
                            <span>Alignment</span>
                            <select
                              value={style.alignment}
                              onChange={(event) =>
                                updateThemeTextStyle(role, {
                                  alignment: event.currentTarget.value as TextAlignment,
                                })
                              }
                            >
                              <option value="left">Left</option>
                              <option value="center">Center</option>
                              <option value="right">Right</option>
                              <option value="justify">Justify</option>
                            </select>
                          </label>
                          <label className="color-field">
                            Color
                            <input
                              type="color"
                              value={style.color}
                              onChange={(event) =>
                                updateThemeTextStyle(role, { color: event.currentTarget.value })
                              }
                            />
                          </label>
                        </fieldset>
                      );
                    })}
                    <div className="design-actions">
                      <button type="button" onClick={() => void createNewBlankTheme()}>
                        <Plus size={13} /> New blank
                      </button>
                      <button type="button" onClick={() => void duplicateTheme()}>
                        <Copy size={13} /> Create copy
                      </button>
                      <button
                        type="button"
                        className="primary-inspector-action"
                        onClick={() => void enforceSelectedTheme()}
                      >
                        <Check size={13} /> Apply to presentation
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={document.themes.length <= 1}
                        onClick={() => void deleteTheme()}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  </div>
                ) : null}
              </section>
              <section className="inspector-section">
                <h3>Slide layout</h3>
                <label className="stacked-field">
                  <span>Layout</span>
                  <select
                    value={activeSlide.layoutId}
                    onChange={(event) => {
                      const layoutId = event.currentTarget.value;
                      const layout = document.layouts.find(
                        (candidate) => candidate.id === layoutId,
                      );
                      void execute('Change slide layout', [
                        {
                          type: 'slide.set-layout',
                          slideId: activeSlide.id,
                          layoutId,
                        },
                      ]).then((applied) => {
                        if (!applied) return;
                        setDesignSurface('slide');
                        setDesignLayoutId(layoutId);
                        if (layout !== undefined) {
                          setDesignMasterId(layout.masterId);
                          const master = document.masters.find(
                            (candidate) => candidate.id === layout.masterId,
                          );
                          if (master !== undefined) setDesignThemeId(master.themeId);
                        }
                      });
                    }}
                  >
                    {document.layouts.map((layout) => (
                      <option key={layout.id} value={layout.id}>
                        {layout.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => {
                    const bound = boundPlaceholderIds(activeSlide.elements);
                    const placeholders =
                      document.layouts
                        .find((layout) => layout.id === activeSlide.layoutId)
                        ?.elements.filter(
                          (element) => element.type === 'placeholder' && bound.has(element.id),
                        ) ?? [];
                    if (placeholders.length > 0)
                      void execute(
                        'Reset placeholders',
                        placeholders.map((placeholder) => ({
                          type: 'slide.reset-placeholder' as const,
                          slideId: activeSlide.id,
                          placeholderId: placeholder.id,
                        })),
                      );
                  }}
                >
                  Reset placeholders to layout
                </button>
              </section>
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Layout editor</h3>
                  <span className="section-status">Reusable placeholders</span>
                </div>
                <label className="stacked-field">
                  <span>Layout to edit</span>
                  <select
                    value={designLayout?.id ?? ''}
                    onChange={(event) => {
                      const layoutId = event.currentTarget.value;
                      const layout = document.layouts.find(
                        (candidate) => candidate.id === layoutId,
                      );
                      void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                        if (!canLeave) return;
                        setDesignLayoutId(layoutId);
                        setDesignSurface('layout');
                        setSelectedIds([]);
                        if (layout !== undefined) {
                          setDesignMasterId(layout.masterId);
                          const master = document.masters.find(
                            (candidate) => candidate.id === layout.masterId,
                          );
                          if (master !== undefined) setDesignThemeId(master.themeId);
                        }
                      });
                    }}
                  >
                    {document.layouts.map((layout) => (
                      <option key={layout.id} value={layout.id}>
                        {layout.name}
                      </option>
                    ))}
                  </select>
                </label>
                {designLayout !== undefined ? (
                  <div className="design-editor-card">
                    <label className="stacked-field">
                      <span>Name</span>
                      <input
                        key={`${designLayout.id}-name`}
                        defaultValue={designLayout.name}
                        maxLength={120}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            const name = target.value.trim();
                            if (name === designLayout.name)
                              return restoreBlurValue(target, designLayout.name);
                            if (name === '')
                              return restoreBlurValue(
                                target,
                                designLayout.name,
                                'A layout name cannot be empty.',
                              );
                            target.value = name;
                            return updateLayout({ ...designLayout, name }, 'Rename layout');
                          });
                        }}
                      />
                    </label>
                    <label className="stacked-field">
                      <span>Master</span>
                      <select
                        value={designLayout.masterId}
                        onChange={(event) =>
                          updateLayout(
                            { ...designLayout, masterId: event.currentTarget.value },
                            'Change layout master',
                          )
                        }
                      >
                        {document.masters.map((master) => (
                          <option key={master.id} value={master.id}>
                            {master.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="color-field">
                      Background
                      <input
                        type="color"
                        value={
                          designLayout.background?.type === 'solid'
                            ? designLayout.background.color
                            : (document.themes[0]?.colors.background ?? '#ffffff')
                        }
                        onChange={(event) =>
                          updateLayout(
                            {
                              ...designLayout,
                              background: {
                                type: 'solid',
                                color: event.currentTarget.value,
                              },
                            },
                            'Change layout background',
                          )
                        }
                      />
                    </label>
                    <div className="design-actions">
                      <button type="button" onClick={() => void duplicateLayout()}>
                        <Copy size={13} /> Duplicate
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={document.layouts.length <= 1}
                        onClick={() => void deleteLayout()}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                    {designSurface === 'layout' && designSelectedElement !== undefined ? (
                      <div className="selected-template-object">
                        <div className="design-subheading">Selected layout object</div>
                        <label className="stacked-field">
                          <span>Object name</span>
                          <input
                            key={`${designSelectedElement.id}-layout-object-name`}
                            defaultValue={designSelectedElement.name}
                            maxLength={120}
                            disabled={designSelectedElement.locked}
                            onBlur={(event) => {
                              const name = event.currentTarget.value.trim();
                              if (name !== '' && name !== designSelectedElement.name) {
                                void patchElement(
                                  { ...designSelectedElement, name },
                                  'Rename layout object',
                                );
                              }
                            }}
                          />
                        </label>
                        <label className="toggle-row">
                          <input
                            type="checkbox"
                            checked={designSelectedElement.locked}
                            onChange={() => toggleLock()}
                          />{' '}
                          Lock inherited object
                        </label>
                        {designSelectedElement.type === 'text' ? (
                          <label className="stacked-field">
                            <span>Text</span>
                            <textarea
                              key={`${designSelectedElement.id}-layout-text`}
                              defaultValue={contentToPlainText(designSelectedElement.content)}
                              disabled={designSelectedElement.locked}
                              onBlur={(event) => {
                                const text = event.currentTarget.value;
                                if (text !== contentToPlainText(designSelectedElement.content)) {
                                  void patchElement(
                                    {
                                      ...designSelectedElement,
                                      content: replacePlainTextPreservingStyles(
                                        designSelectedElement.content,
                                        text,
                                      ),
                                    },
                                    'Edit layout text',
                                  );
                                }
                              }}
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="design-subheading">Placeholders</div>
                    {designLayout.elements
                      .filter(
                        (element): element is PlaceholderElement => element.type === 'placeholder',
                      )
                      .map((placeholder) => (
                        <div className="placeholder-card" key={placeholder.id}>
                          <div>
                            <strong>{placeholder.name}</strong>
                            <span>{placeholder.role}</span>
                          </div>
                          <button
                            type="button"
                            title="Delete placeholder"
                            disabled={placeholder.locked}
                            onClick={() =>
                              updateLayout(
                                {
                                  ...designLayout,
                                  elements: designLayout.elements.filter(
                                    (element) => element.id !== placeholder.id,
                                  ),
                                },
                                'Delete layout placeholder',
                              )
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                          <label className="stacked-field placeholder-prompt">
                            <span>Prompt</span>
                            <input
                              key={`${placeholder.id}-prompt`}
                              defaultValue={placeholder.prompt}
                              disabled={placeholder.locked}
                              onBlur={(event) => {
                                const target = event.currentTarget;
                                void commitOnBlur(target, () => {
                                  const prompt = target.value;
                                  if (prompt === placeholder.prompt) return true;
                                  return updateLayout(
                                    {
                                      ...designLayout,
                                      elements: designLayout.elements.map((element) =>
                                        element.id === placeholder.id
                                          ? { ...placeholder, prompt }
                                          : element,
                                      ),
                                    },
                                    'Edit placeholder prompt',
                                  );
                                });
                              }}
                            />
                          </label>
                          <div className="field-grid placeholder-frame-grid">
                            {(
                              [
                                ['xPt', 'X'],
                                ['yPt', 'Y'],
                                ['widthPt', 'W'],
                                ['heightPt', 'H'],
                              ] as const
                            ).map(([property, label]) => (
                              <label key={property}>
                                <span>{label}</span>
                                <input
                                  key={`${placeholder.id}-${property}`}
                                  type="number"
                                  min="0"
                                  max={
                                    property === 'xPt' || property === 'widthPt'
                                      ? document.page.widthPt
                                      : document.page.heightPt
                                  }
                                  step="1"
                                  defaultValue={Math.round(placeholder.frame[property])}
                                  disabled={placeholder.locked}
                                  onBlur={(event) => {
                                    const target = event.currentTarget;
                                    void commitOnBlur(target, () => {
                                      const persistedValue = Math.round(
                                        placeholder.frame[property],
                                      );
                                      if (
                                        target.value.trim() === '' ||
                                        !Number.isFinite(target.valueAsNumber)
                                      )
                                        return restoreBlurValue(
                                          target,
                                          persistedValue,
                                          'Enter a valid placeholder position or size.',
                                        );
                                      if (target.valueAsNumber === persistedValue)
                                        return restoreBlurValue(target, persistedValue);
                                      const maximum =
                                        property === 'xPt' || property === 'widthPt'
                                          ? document.page.widthPt
                                          : document.page.heightPt;
                                      const minimum =
                                        property === 'widthPt' || property === 'heightPt' ? 12 : 0;
                                      const value = clamp(target.valueAsNumber, minimum, maximum);
                                      target.value = String(value);
                                      const replacement = {
                                        ...placeholder,
                                        frame: { ...placeholder.frame, [property]: value },
                                      };
                                      return updateLayout(
                                        {
                                          ...designLayout,
                                          elements: designLayout.elements.map((element) =>
                                            element.id === placeholder.id ? replacement : element,
                                          ),
                                        },
                                        'Resize layout placeholder',
                                      );
                                    });
                                  }}
                                />
                              </label>
                            ))}
                          </div>
                          <label className="toggle-row">
                            <input
                              type="checkbox"
                              checked={placeholder.locked}
                              onChange={(event) =>
                                updateLayout(
                                  {
                                    ...designLayout,
                                    elements: designLayout.elements.map((element) =>
                                      element.id === placeholder.id
                                        ? { ...placeholder, locked: event.currentTarget.checked }
                                        : element,
                                    ),
                                  },
                                  event.currentTarget.checked
                                    ? 'Lock layout placeholder'
                                    : 'Unlock layout placeholder',
                                )
                              }
                            />{' '}
                            Lock inherited placeholder
                          </label>
                        </div>
                      ))}
                    <div className="placeholder-actions">
                      {(['title', 'body', 'media', 'table'] as const).map((role) => (
                        <button
                          type="button"
                          key={role}
                          onClick={() =>
                            updateLayout(
                              {
                                ...designLayout,
                                elements: [
                                  ...designLayout.elements,
                                  createPlaceholder(role, document.page),
                                ],
                              },
                              `Add ${role} placeholder`,
                            )
                          }
                        >
                          <Plus size={12} /> {role}
                        </button>
                      ))}
                    </div>
                    <div className="design-subheading">Guides</div>
                    {designLayout.guides.map((guide) => (
                      <div className="guide-row" key={guide.id}>
                        <select
                          value={guide.orientation}
                          aria-label="Guide orientation"
                          onChange={(event) =>
                            updateLayout(
                              {
                                ...designLayout,
                                guides: designLayout.guides.map((candidate) =>
                                  candidate.id === guide.id
                                    ? {
                                        ...candidate,
                                        orientation: event.currentTarget.value as
                                          'horizontal' | 'vertical',
                                      }
                                    : candidate,
                                ),
                              },
                              'Change layout guide',
                            )
                          }
                        >
                          <option value="vertical">Vertical</option>
                          <option value="horizontal">Horizontal</option>
                        </select>
                        <input
                          key={guide.id}
                          type="number"
                          aria-label="Guide position in points"
                          defaultValue={guide.positionPt}
                          onBlur={(event) => {
                            const target = event.currentTarget;
                            void commitOnBlur(target, () => {
                              if (
                                target.value.trim() === '' ||
                                !Number.isFinite(target.valueAsNumber)
                              )
                                return restoreBlurValue(
                                  target,
                                  guide.positionPt,
                                  'Enter a valid guide position.',
                                );
                              const positionPt = target.valueAsNumber;
                              if (positionPt === guide.positionPt)
                                return restoreBlurValue(target, guide.positionPt);
                              return updateLayout(
                                {
                                  ...designLayout,
                                  guides: designLayout.guides.map((candidate) =>
                                    candidate.id === guide.id
                                      ? { ...candidate, positionPt }
                                      : candidate,
                                  ),
                                },
                                'Move layout guide',
                              );
                            });
                          }}
                        />
                        <button
                          type="button"
                          title="Delete guide"
                          onClick={() =>
                            updateLayout(
                              {
                                ...designLayout,
                                guides: designLayout.guides.filter(
                                  (candidate) => candidate.id !== guide.id,
                                ),
                              },
                              'Delete layout guide',
                            )
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() =>
                        updateLayout(
                          {
                            ...designLayout,
                            guides: [
                              ...designLayout.guides,
                              {
                                id: crypto.randomUUID(),
                                orientation: 'vertical',
                                positionPt: document.page.widthPt / 2,
                              },
                            ],
                          },
                          'Add layout guide',
                        )
                      }
                    >
                      <Plus size={13} /> Add guide
                    </button>
                  </div>
                ) : null}
              </section>
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Master editor</h3>
                  <Layers3 size={14} />
                </div>
                <label className="stacked-field">
                  <span>Master to edit</span>
                  <select
                    value={designMaster?.id ?? ''}
                    onChange={(event) => {
                      const masterId = event.currentTarget.value;
                      const master = document.masters.find(
                        (candidate) => candidate.id === masterId,
                      );
                      void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                        if (!canLeave) return;
                        setDesignMasterId(masterId);
                        setDesignSurface('master');
                        setSelectedIds([]);
                        if (master !== undefined) setDesignThemeId(master.themeId);
                      });
                    }}
                  >
                    {document.masters.map((master) => (
                      <option key={master.id} value={master.id}>
                        {master.name}
                      </option>
                    ))}
                  </select>
                </label>
                {designMaster !== undefined ? (
                  <div className="design-editor-card">
                    <label className="stacked-field">
                      <span>Name</span>
                      <input
                        key={`${designMaster.id}-name`}
                        defaultValue={designMaster.name}
                        maxLength={120}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            const name = target.value.trim();
                            if (name === designMaster.name)
                              return restoreBlurValue(target, designMaster.name);
                            if (name === '')
                              return restoreBlurValue(
                                target,
                                designMaster.name,
                                'A master name cannot be empty.',
                              );
                            target.value = name;
                            return updateMaster({ ...designMaster, name }, 'Rename master');
                          });
                        }}
                      />
                    </label>
                    <label className="stacked-field">
                      <span>Theme</span>
                      <select
                        value={designMaster.themeId}
                        onChange={(event) => {
                          setDesignThemeId(event.currentTarget.value);
                          updateMaster(
                            { ...designMaster, themeId: event.currentTarget.value },
                            'Change master theme',
                          );
                        }}
                      >
                        {document.themes.map((theme) => (
                          <option key={theme.id} value={theme.id}>
                            {theme.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="color-field">
                      Background
                      <input
                        type="color"
                        value={
                          designMaster.background?.type === 'solid'
                            ? designMaster.background.color
                            : (document.themes[0]?.colors.background ?? '#ffffff')
                        }
                        onChange={(event) =>
                          updateMaster(
                            {
                              ...designMaster,
                              background: {
                                type: 'solid',
                                color: event.currentTarget.value,
                              },
                            },
                            'Change master background',
                          )
                        }
                      />
                    </label>
                    <div className="design-actions">
                      <button type="button" onClick={() => void duplicateMaster()}>
                        <Copy size={13} /> Duplicate
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        disabled={document.masters.length <= 1}
                        onClick={() => void deleteMaster()}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                    <div className="design-subheading">Fixed objects</div>
                    {designMaster.elements.map((element) => (
                      <div
                        className={`master-object-row${selectedIds.includes(element.id) ? ' is-selected' : ''}`}
                        key={element.id}
                      >
                        <button
                          type="button"
                          className="master-object-select"
                          aria-pressed={selectedIds.includes(element.id)}
                          onClick={() => {
                            void canLeaveInlineTextEditorRef.current().then((canLeave) => {
                              if (!canLeave) return;
                              setDesignSurface('master');
                              setSelectedIds([element.id]);
                            });
                          }}
                        >
                          <strong>{element.name}</strong>
                          <small>{element.type}</small>
                        </button>
                        <button
                          type="button"
                          title="Delete master object"
                          disabled={element.locked}
                          onClick={() =>
                            updateMaster(
                              {
                                ...designMaster,
                                elements: designMaster.elements.filter(
                                  (candidate) => candidate.id !== element.id,
                                ),
                              },
                              'Delete master object',
                            )
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    {designSurface === 'master' && designSelectedElement !== undefined ? (
                      <div className="design-object-editor">
                        <label className="stacked-field">
                          <span>Object name</span>
                          <input
                            key={`${designSelectedElement.id}-object-name`}
                            defaultValue={designSelectedElement.name}
                            maxLength={120}
                            disabled={designSelectedElement.locked}
                            onBlur={(event) => {
                              const target = event.currentTarget;
                              void commitOnBlur(target, () => {
                                const name = target.value.trim();
                                if (name === designSelectedElement.name)
                                  return restoreBlurValue(target, designSelectedElement.name);
                                if (name === '')
                                  return restoreBlurValue(
                                    target,
                                    designSelectedElement.name,
                                    'An object name cannot be empty.',
                                  );
                                target.value = name;
                                return updateMaster(
                                  {
                                    ...designMaster,
                                    elements: designMaster.elements.map((element) =>
                                      element.id === designSelectedElement.id
                                        ? { ...element, name }
                                        : element,
                                    ),
                                  },
                                  'Rename master object',
                                );
                              });
                            }}
                          />
                        </label>
                        <div className="field-grid">
                          {(
                            [
                              ['xPt', 'X'],
                              ['yPt', 'Y'],
                              ['widthPt', 'W'],
                              ['heightPt', 'H'],
                              ['rotationDeg', '°'],
                            ] as const
                          ).map(([property, label]) => (
                            <label key={property}>
                              <span>{label}</span>
                              <input
                                key={`${designSelectedElement.id}-${property}`}
                                type="number"
                                defaultValue={Math.round(designSelectedElement.frame[property])}
                                disabled={designSelectedElement.locked}
                                onBlur={(event) => {
                                  const target = event.currentTarget;
                                  void commitOnBlur(target, () => {
                                    const persistedValue = Math.round(
                                      designSelectedElement.frame[property],
                                    );
                                    if (
                                      target.value.trim() === '' ||
                                      !Number.isFinite(target.valueAsNumber)
                                    )
                                      return restoreBlurValue(
                                        target,
                                        persistedValue,
                                        'Enter a valid object position or size.',
                                      );
                                    if (target.valueAsNumber === persistedValue)
                                      return restoreBlurValue(target, persistedValue);
                                    const value =
                                      property === 'rotationDeg'
                                        ? clamp(target.valueAsNumber, -180, 180)
                                        : property === 'widthPt' || property === 'heightPt'
                                          ? clamp(target.valueAsNumber, 12, 20_000)
                                          : clamp(target.valueAsNumber, -20_000, 20_000);
                                    target.value = String(value);
                                    return updateMaster(
                                      {
                                        ...designMaster,
                                        elements: designMaster.elements.map((element) =>
                                          element.id === designSelectedElement.id
                                            ? {
                                                ...element,
                                                frame: { ...element.frame, [property]: value },
                                              }
                                            : element,
                                        ),
                                      },
                                      'Edit master object geometry',
                                    );
                                  });
                                }}
                              />
                            </label>
                          ))}
                        </div>
                        <label className="toggle-row">
                          <input
                            type="checkbox"
                            checked={designSelectedElement.locked}
                            onChange={(event) =>
                              updateMaster(
                                {
                                  ...designMaster,
                                  elements: designMaster.elements.map((element) =>
                                    element.id === designSelectedElement.id
                                      ? { ...element, locked: event.currentTarget.checked }
                                      : element,
                                  ),
                                },
                                event.currentTarget.checked
                                  ? 'Lock master object'
                                  : 'Unlock master object',
                              )
                            }
                          />{' '}
                          Lock inherited object
                        </label>
                        {designSelectedElement.type === 'text' ? (
                          <label className="stacked-field">
                            <span>Text</span>
                            <textarea
                              key={`${designSelectedElement.id}-text`}
                              defaultValue={contentToPlainText(designSelectedElement.content)}
                              disabled={designSelectedElement.locked}
                              onBlur={(event) => {
                                const target = event.currentTarget;
                                void commitOnBlur(target, () => {
                                  const persistedText = contentToPlainText(
                                    designSelectedElement.content,
                                  );
                                  if (target.value === persistedText) return true;
                                  return updateMaster(
                                    {
                                      ...designMaster,
                                      elements: designMaster.elements.map((element) =>
                                        element.id === designSelectedElement.id &&
                                        element.type === 'text'
                                          ? {
                                              ...element,
                                              content: replacePlainTextPreservingStyles(
                                                element.content,
                                                target.value,
                                              ),
                                            }
                                          : element,
                                      ),
                                    },
                                    'Edit master text',
                                  );
                                });
                              }}
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() =>
                        addMasterTextField('Presentation title footer', '{{title}}', 'left', {
                          xPt: 36,
                          yPt: document.page.heightPt - 32,
                          widthPt: Math.max(120, document.page.widthPt - 180),
                          heightPt: 18,
                          rotationDeg: 0,
                        })
                      }
                    >
                      <Plus size={13} /> Add presentation footer
                    </button>
                    <div className="design-subheading">Page furniture</div>
                    <div className="placeholder-actions" aria-label="Add dynamic master fields">
                      {(['left', 'center', 'right'] as const).map((alignment) => (
                        <button
                          type="button"
                          key={`page-${alignment}`}
                          onClick={() => {
                            const widthPt = 108;
                            const xPt =
                              alignment === 'left'
                                ? 36
                                : alignment === 'center'
                                  ? (document.page.widthPt - widthPt) / 2
                                  : document.page.widthPt - widthPt - 36;
                            void addMasterTextField(
                              `Page number ${alignment}`,
                              '{{page}} / {{pages}}',
                              alignment,
                              {
                                xPt,
                                yPt: document.page.heightPt - 32,
                                widthPt,
                                heightPt: 18,
                                rotationDeg: 0,
                              },
                            );
                          }}
                        >
                          <Plus size={12} /> page {alignment}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() =>
                          addMasterTextField('Date field', '{{date}}', 'left', {
                            xPt: 36,
                            yPt: document.page.heightPt - 54,
                            widthPt: 120,
                            heightPt: 18,
                            rotationDeg: 0,
                          })
                        }
                      >
                        <Plus size={12} /> date
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          addMasterTextField('Time field', '{{time}}', 'left', {
                            xPt: 164,
                            yPt: document.page.heightPt - 54,
                            widthPt: 90,
                            heightPt: 18,
                            rotationDeg: 0,
                          })
                        }
                      >
                        <Plus size={12} /> time
                      </button>
                    </div>
                    <div className="design-subheading">Watermark</div>
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => {
                        const text = window.prompt('Watermark text', 'CONFIDENTIAL')?.trim();
                        if (text === undefined || text === '') return;
                        void addMasterTextField(
                          'Text watermark',
                          text,
                          'center',
                          {
                            xPt: document.page.widthPt * 0.12,
                            yPt: document.page.heightPt * 0.36,
                            widthPt: document.page.widthPt * 0.76,
                            heightPt: Math.max(60, document.page.heightPt * 0.18),
                            rotationDeg: -32,
                          },
                          { opacity: 0.16, fontSizePt: 42, locked: true },
                        );
                      }}
                    >
                      <Plus size={13} /> Add text watermark
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => void importImage(undefined, true)}
                    >
                      <Image size={13} /> Add image watermark
                    </button>
                    <div className="placeholder-actions" aria-label="Add master objects">
                      <button
                        type="button"
                        onClick={() =>
                          updateMaster(
                            {
                              ...designMaster,
                              elements: [...designMaster.elements, createTextElement('body')],
                            },
                            'Add master text',
                          )
                        }
                      >
                        <Plus size={12} /> text
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          updateMaster(
                            {
                              ...designMaster,
                              elements: [...designMaster.elements, createShapeElement()],
                            },
                            'Add master shape',
                          )
                        }
                      >
                        <Plus size={12} /> shape
                      </button>
                    </div>
                    <div className="design-subheading">Guides</div>
                    {designMaster.guides.map((guide) => (
                      <div className="guide-row" key={guide.id}>
                        <select
                          value={guide.orientation}
                          aria-label="Master guide orientation"
                          onChange={(event) =>
                            updateMaster(
                              {
                                ...designMaster,
                                guides: designMaster.guides.map((candidate) =>
                                  candidate.id === guide.id
                                    ? {
                                        ...candidate,
                                        orientation: event.currentTarget.value as
                                          'horizontal' | 'vertical',
                                      }
                                    : candidate,
                                ),
                              },
                              'Change master guide',
                            )
                          }
                        >
                          <option value="vertical">Vertical</option>
                          <option value="horizontal">Horizontal</option>
                        </select>
                        <input
                          key={guide.id}
                          type="number"
                          aria-label="Master guide position in points"
                          defaultValue={guide.positionPt}
                          onBlur={(event) => {
                            const target = event.currentTarget;
                            void commitOnBlur(target, () => {
                              if (
                                target.value.trim() === '' ||
                                !Number.isFinite(target.valueAsNumber)
                              )
                                return restoreBlurValue(
                                  target,
                                  guide.positionPt,
                                  'Enter a valid guide position.',
                                );
                              const positionPt = target.valueAsNumber;
                              if (positionPt === guide.positionPt)
                                return restoreBlurValue(target, guide.positionPt);
                              return updateMaster(
                                {
                                  ...designMaster,
                                  guides: designMaster.guides.map((candidate) =>
                                    candidate.id === guide.id
                                      ? { ...candidate, positionPt }
                                      : candidate,
                                  ),
                                },
                                'Move master guide',
                              );
                            });
                          }}
                        />
                        <button
                          type="button"
                          title="Delete master guide"
                          onClick={() =>
                            updateMaster(
                              {
                                ...designMaster,
                                guides: designMaster.guides.filter(
                                  (candidate) => candidate.id !== guide.id,
                                ),
                              },
                              'Delete master guide',
                            )
                          }
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() =>
                        updateMaster(
                          {
                            ...designMaster,
                            guides: [
                              ...designMaster.guides,
                              {
                                id: crypto.randomUUID(),
                                orientation: 'vertical',
                                positionPt: document.page.widthPt / 2,
                              },
                            ],
                          },
                          'Add master guide',
                        )
                      }
                    >
                      <Plus size={13} /> Add guide
                    </button>
                  </div>
                ) : null}
              </section>
              <section className="inspector-section">
                <h3>Page format</h3>
                <select
                  value={
                    customPageEditorOpen
                      ? 'custom'
                      : (Object.entries(STANDARD_PAGE_SIZES).find(
                          ([, page]) =>
                            page.widthPt === document.page.widthPt &&
                            page.heightPt === document.page.heightPt,
                        )?.[0] ?? 'custom')
                  }
                  onChange={(event) => {
                    if (event.currentTarget.value === 'custom') {
                      setCustomPageEditorOpen(true);
                      return;
                    }
                    const page =
                      STANDARD_PAGE_SIZES[
                        event.currentTarget.value as keyof typeof STANDARD_PAGE_SIZES
                      ];
                    if (page !== undefined) {
                      setCustomPageEditorOpen(false);
                      void execute('Change page format', [{ type: 'deck.set-page', page }]);
                    }
                  }}
                >
                  <option value="widescreen">Widescreen 16:9</option>
                  <option value="standard">Standard 4:3</option>
                  <option value="a4Landscape">A4 landscape</option>
                  <option value="custom">Custom</option>
                </select>
                {customPageEditorOpen ? (
                  <>
                    <div className="field-grid">
                      <label>
                        <span>Width</span>
                        <div className="number-input">
                          <input
                            type="number"
                            min="1"
                            max="20000"
                            step="1"
                            value={customPageWidthPt}
                            onChange={(event) => {
                              if (Number.isFinite(event.currentTarget.valueAsNumber))
                                setCustomPageWidthPt(event.currentTarget.valueAsNumber);
                            }}
                          />
                          <small>pt</small>
                        </div>
                      </label>
                      <label>
                        <span>Height</span>
                        <div className="number-input">
                          <input
                            type="number"
                            min="1"
                            max="20000"
                            step="1"
                            value={customPageHeightPt}
                            onChange={(event) => {
                              if (Number.isFinite(event.currentTarget.valueAsNumber))
                                setCustomPageHeightPt(event.currentTarget.valueAsNumber);
                            }}
                          />
                          <small>pt</small>
                        </div>
                      </label>
                    </div>
                    <button
                      type="button"
                      className="primary-inspector-action"
                      onClick={() => {
                        try {
                          const page = createBoundedPageSize(customPageWidthPt, customPageHeightPt);
                          setCustomPageWidthPt(page.widthPt);
                          setCustomPageHeightPt(page.heightPt);
                          void execute('Change custom page format', [
                            { type: 'deck.set-page', page },
                          ]);
                        } catch (error) {
                          notify(
                            error instanceof Error
                              ? error.message
                              : 'Enter valid custom page dimensions.',
                            'error',
                          );
                        }
                      }}
                    >
                      Apply custom size
                    </button>
                  </>
                ) : null}
              </section>
              <section className="inspector-section">
                <h3>Slide</h3>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={activeSlide.hidden}
                    onChange={(event) =>
                      void execute(event.currentTarget.checked ? 'Hide slide' : 'Show slide', [
                        {
                          type: 'slide.set-hidden',
                          slideId: activeSlide.id,
                          hidden: event.currentTarget.checked,
                        },
                      ])
                    }
                  />{' '}
                  Hide slide by default
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={document.settings.includeHiddenSlidesInExport}
                    onChange={(event) =>
                      void execute('Change hidden-slide export policy', [
                        {
                          type: 'deck.set-export-options',
                          includeHiddenSlidesInExport: event.currentTarget.checked,
                        },
                      ])
                    }
                  />{' '}
                  Include hidden slides in HTML and PDF exports
                </label>
                <label className="color-field">
                  Background{' '}
                  <input
                    type="color"
                    value={
                      activeSlide.background?.type === 'solid'
                        ? activeSlide.background.color
                        : (document.themes[0]?.colors.background ?? '#ffffff')
                    }
                    onChange={(event) =>
                      void execute('Set slide background', [
                        {
                          type: 'slide.update',
                          slideId: activeSlide.id,
                          background: { type: 'solid', color: event.currentTarget.value },
                        },
                      ])
                    }
                  />
                </label>
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() =>
                    void execute('Reset slide background', [
                      { type: 'slide.update', slideId: activeSlide.id, background: null },
                    ])
                  }
                >
                  Use master background
                </button>
              </section>
            </div>
          ) : (
            <div className="inspector-scroll" role="tabpanel">
              <section className="selection-summary">
                <div className={`selection-icon kind-${primaryElement?.type ?? 'none'}`}>
                  {primaryElement?.type === 'text' ? <Type size={17} /> : <Square size={17} />}
                </div>
                <div>
                  <strong>
                    {selectedElements.length === 0
                      ? 'Nothing selected'
                      : selectedElements.length === 1
                        ? primaryElement?.name
                        : `${selectedElements.length} objects`}
                  </strong>
                  <span>
                    {selectedElements.length === 0
                      ? 'Select an object to edit'
                      : primaryElement?.type}
                  </span>
                </div>
                <EditorButton
                  label={primaryElement?.locked ? 'Unlock selection' : 'Lock selection'}
                  compact
                  disabled={primaryElement === undefined}
                  onClick={toggleLock}
                >
                  {primaryElement?.locked ? <Unlock size={14} /> : <Lock size={14} />}
                </EditorButton>
              </section>
              {primaryElement !== undefined ? (
                <section className="inspector-section style-authority-section">
                  <div className="section-heading-row">
                    <h3>Style authority</h3>
                    <span className="section-status">{primaryStyleSource}</span>
                  </div>
                  <div className="design-actions">
                    <button
                      type="button"
                      disabled={primaryThemeReset === undefined || primaryElement.locked}
                      onClick={() => void resetPrimaryElementToTheme()}
                    >
                      <Palette size={13} /> Reset to theme
                    </button>
                    <button
                      type="button"
                      disabled={
                        activeAuthoringSurface !== 'slide' ||
                        primaryElement.placeholderBinding === undefined ||
                        primaryElement.locked
                      }
                      onClick={() => void resetPrimaryElementToLayout()}
                    >
                      <Layers3 size={13} /> Reset to layout
                    </button>
                  </div>
                </section>
              ) : null}
              <section className="inspector-section">
                <h3>Position & size</h3>
                <div className="field-grid">
                  {(
                    [
                      ['xPt', 'X'],
                      ['yPt', 'Y'],
                      ['widthPt', 'W'],
                      ['heightPt', 'H'],
                    ] as const
                  ).map(([property, label]) => (
                    <label key={property}>
                      <span>{label}</span>
                      <div className="number-input">
                        <input
                          type="number"
                          value={
                            primaryElement === undefined
                              ? ''
                              : Math.round(primaryElement.frame[property] * 10) / 10
                          }
                          disabled={primaryElement === undefined || primaryElement.locked}
                          onChange={(event) =>
                            updateFrameNumber(property, event.currentTarget.value)
                          }
                        />
                        <small>pt</small>
                      </div>
                    </label>
                  ))}
                </div>
                <label className="stacked-field">
                  <span>Rotation</span>
                  <div className="number-input">
                    <input
                      type="number"
                      min="-180"
                      max="180"
                      value={primaryElement?.frame.rotationDeg ?? ''}
                      disabled={primaryElement === undefined || primaryElement.locked}
                      onChange={(event) =>
                        updateFrameNumber('rotationDeg', event.currentTarget.value)
                      }
                    />
                    <small>°</small>
                  </div>
                </label>
                <div className="align-grid" role="group" aria-label="Align selected objects">
                  <EditorButton
                    label="Align left"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => align('left')}
                  >
                    <AlignStartVertical size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align center"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => align('horizontal-center')}
                  >
                    <AlignCenterVertical size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align right"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => align('right')}
                  >
                    <AlignEndHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align top"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => align('top')}
                  >
                    <AlignStartHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align middle"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => align('vertical-middle')}
                  >
                    <AlignCenterHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Distribute horizontally"
                    compact
                    disabled={selectedIds.length < 3}
                    onClick={() => distribute('horizontal')}
                  >
                    <Columns3 size={16} />
                  </EditorButton>
                </div>
              </section>
              {primaryText !== undefined && textDraft !== null && textDraftMatchesPrimary ? (
                <section
                  className="inspector-section text-editor-section"
                  onFocusCapture={() => {
                    textEditorFocusedRef.current = true;
                    if (collaborationTextActive) void beginTextLease();
                  }}
                  onBlurCapture={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget)) return;
                    textEditorFocusedRef.current = false;
                    const target = event.currentTarget;
                    void commitOnBlur(target, () => commitInlineText());
                  }}
                >
                  <div className="section-heading-row">
                    <h3>Text</h3>
                    <span className="section-status" aria-live="polite">
                      {textEditingLocked
                        ? 'Applying text...'
                        : textApplyPending
                          ? 'Saving draft...'
                          : textLeaseLabel}
                    </span>
                  </div>
                  {textLeaseBlocked ? (
                    <button
                      type="button"
                      className="text-lease-gate"
                      aria-busy={textLeasePending}
                      onClick={() => void beginTextLease()}
                    >
                      <Lock size={13} aria-hidden="true" />
                      <span>
                        {textLeaseStatus?.status === 'held'
                          ? 'Retry when available'
                          : 'Start editing text'}
                      </span>
                    </button>
                  ) : null}
                  {textDraftDirty ? (
                    <div className="draft-conflict" role={textDraftConflict ? 'alert' : 'status'}>
                      <span>
                        {textDraftConflict
                          ? 'The same text changed elsewhere. Your draft has not been lost.'
                          : 'This text has an unapplied local draft.'}
                      </span>
                      <button type="button" disabled={textApplyPending} onClick={revertTextDraft}>
                        Revert draft
                      </button>
                    </div>
                  ) : null}
                  <fieldset
                    className="text-editor-controls"
                    disabled={primaryText.locked || textLeaseBlocked || textEditingLocked}
                    aria-busy={textEditingLocked || undefined}
                  >
                    <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
                      <button
                        type="button"
                        className={textDraft.bold ? 'is-active' : ''}
                        aria-pressed={textDraft.bold}
                        onClick={() => editTextDraft({ ...textDraft, bold: !textDraft.bold })}
                      >
                        <Bold size={14} />
                        <span className="sr-only">Bold</span>
                      </button>
                      <button
                        type="button"
                        className={textDraft.italic ? 'is-active' : ''}
                        aria-pressed={textDraft.italic}
                        onClick={() => editTextDraft({ ...textDraft, italic: !textDraft.italic })}
                      >
                        <Italic size={14} />
                        <span className="sr-only">Italic</span>
                      </button>
                      <button
                        type="button"
                        className={textDraft.underline ? 'is-active' : ''}
                        aria-pressed={textDraft.underline}
                        onClick={() =>
                          editTextDraft({ ...textDraft, underline: !textDraft.underline })
                        }
                      >
                        <Underline size={14} />
                        <span className="sr-only">Underline</span>
                      </button>
                      <button
                        type="button"
                        className={textDraft.strikethrough ? 'is-active' : ''}
                        aria-pressed={textDraft.strikethrough}
                        onClick={() =>
                          editTextDraft({
                            ...textDraft,
                            strikethrough: !textDraft.strikethrough,
                          })
                        }
                      >
                        <span aria-hidden="true" className="strikethrough-glyph">
                          S
                        </span>
                        <span className="sr-only">Strikethrough</span>
                      </button>
                      <button
                        type="button"
                        className={textDraft.kind === 'bullets' ? 'is-active' : ''}
                        aria-pressed={textDraft.kind === 'bullets'}
                        onClick={() =>
                          editTextDraft({
                            ...textDraft,
                            kind: textDraft.kind === 'bullets' ? 'paragraph' : 'bullets',
                            contentOverride: null,
                          })
                        }
                      >
                        <List size={14} />
                        <span className="sr-only">Bullets</span>
                      </button>
                      <button
                        type="button"
                        className={textDraft.kind === 'numbered' ? 'is-active' : ''}
                        aria-pressed={textDraft.kind === 'numbered'}
                        onClick={() =>
                          editTextDraft({
                            ...textDraft,
                            kind: textDraft.kind === 'numbered' ? 'paragraph' : 'numbered',
                            contentOverride: null,
                          })
                        }
                      >
                        <ListOrdered size={14} />
                        <span className="sr-only">Numbered list</span>
                      </button>
                    </div>
                    <label className="stacked-field">
                      <span>Content type</span>
                      <select
                        aria-label="Text block type and heading level"
                        value={
                          textDraft.kind === 'heading'
                            ? `heading-${textDraft.headingLevel}`
                            : textDraft.kind
                        }
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          if (value.startsWith('heading-')) {
                            editTextDraft({
                              ...textDraft,
                              kind: 'heading',
                              headingLevel: Number(value.slice(-1)) as HeadingLevel,
                              contentOverride: null,
                            });
                          } else {
                            editTextDraft({
                              ...textDraft,
                              kind: value as 'paragraph' | 'bullets' | 'numbered',
                              contentOverride: null,
                            });
                          }
                        }}
                      >
                        <option value="paragraph">Paragraph</option>
                        <option value="heading-1">Heading 1</option>
                        <option value="heading-2">Heading 2</option>
                        <option value="heading-3">Heading 3</option>
                        <option value="heading-4">Heading 4</option>
                        <option value="heading-5">Heading 5</option>
                        <option value="heading-6">Heading 6</option>
                        <option value="bullets">Bulleted list</option>
                        <option value="numbered">Numbered list</option>
                      </select>
                    </label>
                    <textarea
                      ref={textAreaRef}
                      className="text-content-editor"
                      aria-label="Text content"
                      value={textDraft.text}
                      maxLength={RICH_CLIPBOARD_LIMITS.maxTextLength}
                      spellCheck
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        editTextDraft({
                          ...textDraft,
                          text,
                          contentOverride:
                            textDraft.contentOverride === null
                              ? null
                              : replacePlainTextPreservingStyles(textDraft.contentOverride, text),
                        });
                      }}
                      onPaste={pasteRichText}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void commitInlineText({ confirmConflict: true });
                        }
                      }}
                    />
                    <p
                      className="field-hint"
                      role={
                        textDraft.text.length >= RICH_CLIPBOARD_LIMITS.maxTextLength * 0.9
                          ? 'status'
                          : undefined
                      }
                    >
                      {textDraft.text.length.toLocaleString()} /{' '}
                      {RICH_CLIPBOARD_LIMITS.maxTextLength.toLocaleString()} characters
                      {textDraft.text.length >= RICH_CLIPBOARD_LIMITS.maxTextLength * 0.9
                        ? ' — near the V1 text limit.'
                        : ''}
                    </p>
                    <label className="stacked-field">
                      <span>Style role</span>
                      <select
                        value={textDraft.role}
                        onChange={(event) =>
                          editTextDraft({
                            ...textDraft,
                            role: event.currentTarget.value as TextStyleRole,
                            kind:
                              event.currentTarget.value === 'title' ? 'heading' : textDraft.kind,
                            contentOverride:
                              event.currentTarget.value === 'title'
                                ? null
                                : textDraft.contentOverride,
                          })
                        }
                      >
                        <option value="title">Title</option>
                        <option value="subtitle">Subtitle</option>
                        <option value="body">Body</option>
                        <option value="caption">Caption</option>
                        <option value="label">Label</option>
                        <option value="quote">Quote</option>
                      </select>
                    </label>
                    <div className="font-controls">
                      <label className="stacked-field font-family">
                        <span>Font</span>
                        <select
                          value={textDraft.fontFamily}
                          onChange={(event) =>
                            editTextDraft({ ...textDraft, fontFamily: event.currentTarget.value })
                          }
                        >
                          <option value="Arial">Arial</option>
                          <option value="Aptos">Aptos</option>
                          <option value="Calibri">Calibri</option>
                          <option value="Georgia">Georgia</option>
                          <option value="Times New Roman">Times New Roman</option>
                          <option value="Verdana">Verdana</option>
                        </select>
                      </label>
                      <label className="stacked-field font-size">
                        <span>Size</span>
                        <input
                          type="number"
                          min="6"
                          max="240"
                          value={textDraft.fontSizePt}
                          onChange={(event) =>
                            editTextDraft({
                              ...textDraft,
                              fontSizePt: clamp(Number(event.currentTarget.value), 6, 240),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="text-detail-controls">
                      <label className="color-field">
                        Text color
                        <input
                          type="color"
                          value={textDraft.color}
                          onChange={(event) =>
                            editTextDraft({ ...textDraft, color: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label className="stacked-field">
                        <span>Line spacing</span>
                        <input
                          type="number"
                          min="0.5"
                          max="4"
                          step="0.05"
                          value={textDraft.lineHeight}
                          onChange={(event) =>
                            editTextDraft({
                              ...textDraft,
                              lineHeight: clamp(Number(event.currentTarget.value), 0.5, 4),
                            })
                          }
                        />
                      </label>
                      <label className="stacked-field">
                        <span>Letter spacing</span>
                        <input
                          type="number"
                          min="-10"
                          max="50"
                          step="0.1"
                          value={textDraft.letterSpacingPt}
                          onChange={(event) =>
                            editTextDraft({
                              ...textDraft,
                              letterSpacingPt: clamp(Number(event.currentTarget.value), -10, 50),
                            })
                          }
                        />
                      </label>
                      <label className="stacked-field">
                        <span>List level</span>
                        <input
                          type="number"
                          min="0"
                          max="8"
                          step="1"
                          disabled={textDraft.kind !== 'bullets' && textDraft.kind !== 'numbered'}
                          value={textDraft.listLevel}
                          onChange={(event) =>
                            editTextDraft({
                              ...textDraft,
                              listLevel: Math.round(clamp(Number(event.currentTarget.value), 0, 8)),
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="segmented-control" role="group" aria-label="Text alignment">
                      {(['left', 'center', 'right', 'justify'] as const).map((alignment) => (
                        <button
                          type="button"
                          key={alignment}
                          className={textDraft.alignment === alignment ? 'is-active' : ''}
                          aria-pressed={textDraft.alignment === alignment}
                          onClick={() => editTextDraft({ ...textDraft, alignment })}
                        >
                          {alignment.slice(0, 1).toUpperCase()}
                          <span className="sr-only">Align {alignment}</span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="primary-inspector-action"
                      onClick={() => void commitInlineText({ confirmConflict: true })}
                    >
                      {textEditingLocked ? 'Applying...' : 'Apply text'} <kbd>Ctrl Enter</kbd>
                    </button>
                  </fieldset>
                </section>
              ) : null}
              {primaryImage !== undefined ? (
                <section className="inspector-section image-editor-section">
                  <div className="section-heading-row">
                    <h3>Image</h3>
                    <span className="section-status">Embedded locally</span>
                  </div>
                  <label className="stacked-field">
                    <span>Alternative text</span>
                    <input
                      key={`${primaryImage.id}-alt`}
                      type="text"
                      maxLength={2_000}
                      defaultValue={primaryImage.altText}
                      onBlur={(event) => {
                        const target = event.currentTarget;
                        void commitOnBlur(target, () => {
                          if (target.value === primaryImage.altText) return true;
                          return patchElement(
                            { ...primaryImage, altText: target.value },
                            'Edit image description',
                          );
                        });
                      }}
                    />
                  </label>
                  <label className="stacked-field">
                    <span>Fit</span>
                    <select
                      value={primaryImage.fit}
                      onChange={(event) =>
                        patchElement(
                          {
                            ...primaryImage,
                            fit: event.currentTarget.value as ImageElement['fit'],
                          },
                          'Change image fit',
                        )
                      }
                    >
                      <option value="contain">Contain</option>
                      <option value="cover">Cover</option>
                      <option value="fill">Stretch</option>
                    </select>
                  </label>
                  <div className="field-grid image-crop-grid">
                    {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
                      <label key={side}>
                        <span>Crop {side} (%)</span>
                        <input
                          key={`${primaryImage.id}-${side}`}
                          type="number"
                          min="0"
                          max="99"
                          step="1"
                          defaultValue={Math.round(primaryImage.crop[side] * 100)}
                          onBlur={(event) => {
                            const target = event.currentTarget;
                            void commitOnBlur(target, () => {
                              const persistedPercent = Math.round(primaryImage.crop[side] * 100);
                              if (
                                target.value.trim() === '' ||
                                !Number.isFinite(target.valueAsNumber)
                              )
                                return restoreBlurValue(
                                  target,
                                  persistedPercent,
                                  'Enter a valid crop percentage.',
                                );
                              const requested = target.valueAsNumber / 100;
                              const opposite =
                                side === 'left'
                                  ? primaryImage.crop.right
                                  : side === 'right'
                                    ? primaryImage.crop.left
                                    : side === 'top'
                                      ? primaryImage.crop.bottom
                                      : primaryImage.crop.top;
                              const crop = clamp(requested, 0, Math.max(0, 0.99 - opposite));
                              if (crop === primaryImage.crop[side])
                                return restoreBlurValue(target, persistedPercent);
                              target.value = String(crop * 100);
                              return updateImageCrop(side, String(requested));
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                  <label className="stacked-field">
                    <span>Opacity (%)</span>
                    <input
                      key={`${primaryImage.id}-opacity`}
                      type="number"
                      min="0"
                      max="100"
                      defaultValue={Math.round(primaryImage.opacity * 100)}
                      onBlur={(event) => {
                        const target = event.currentTarget;
                        void commitOnBlur(target, () => {
                          const persistedPercent = Math.round(primaryImage.opacity * 100);
                          if (target.value.trim() === '' || !Number.isFinite(target.valueAsNumber))
                            return restoreBlurValue(
                              target,
                              persistedPercent,
                              'Enter a valid opacity percentage.',
                            );
                          const opacity = clamp(target.valueAsNumber / 100, 0, 1);
                          if (opacity === primaryImage.opacity)
                            return restoreBlurValue(target, persistedPercent);
                          target.value = String(opacity * 100);
                          return patchElement({ ...primaryImage, opacity }, 'Change image opacity');
                        });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => void importImage(primaryImage)}
                  >
                    <Image size={14} /> Replace image…
                  </button>
                </section>
              ) : null}
              {primaryElement?.type === 'shape' ? (
                <section className="inspector-section vector-editor-section">
                  <div className="section-heading-row">
                    <h3>Shape</h3>
                    <span className="section-status">Native SVG</span>
                  </div>
                  <label className="stacked-field">
                    <span>Shape</span>
                    <select
                      value={primaryElement.shape}
                      onChange={(event) =>
                        patchElement(
                          {
                            ...primaryElement,
                            shape: event.currentTarget.value as typeof primaryElement.shape,
                            cornerRadiusPt:
                              event.currentTarget.value === 'rounded-rectangle'
                                ? Math.max(primaryElement.cornerRadiusPt, 12)
                                : primaryElement.cornerRadiusPt,
                          },
                          'Change shape type',
                        )
                      }
                    >
                      <option value="rectangle">Rectangle</option>
                      <option value="rounded-rectangle">Rounded rectangle</option>
                      <option value="ellipse">Ellipse</option>
                      <option value="triangle">Triangle</option>
                      <option value="diamond">Diamond</option>
                      <option value="line">Line</option>
                      <option value="arrow">Arrow</option>
                    </select>
                  </label>
                  <label className="color-field">
                    Fill
                    <input
                      type="color"
                      value={primaryElement.fill ?? '#ffffff'}
                      onChange={(event) =>
                        void patchElement(
                          { ...primaryElement, fill: event.currentTarget.value },
                          'Change shape fill',
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="secondary-action compact-action"
                    onClick={() =>
                      patchElement({ ...primaryElement, fill: null }, 'Remove shape fill')
                    }
                  >
                    No fill
                  </button>
                  <label className="color-field">
                    Stroke
                    <input
                      type="color"
                      value={primaryElement.stroke.color}
                      onChange={(event) =>
                        void patchElement(
                          {
                            ...primaryElement,
                            stroke: {
                              ...primaryElement.stroke,
                              color: event.currentTarget.value,
                            },
                          },
                          'Change shape stroke',
                        )
                      }
                    />
                  </label>
                  <div className="field-grid vector-number-grid">
                    <label>
                      <span>Stroke width</span>
                      <input
                        key={`${primaryElement.id}-stroke-width`}
                        type="number"
                        min="0"
                        max="24"
                        step="0.25"
                        defaultValue={primaryElement.stroke.widthPt}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            if (
                              target.value.trim() === '' ||
                              !Number.isFinite(target.valueAsNumber)
                            )
                              return restoreBlurValue(
                                target,
                                primaryElement.stroke.widthPt,
                                'Enter a valid stroke width.',
                              );
                            const widthPt = clamp(target.valueAsNumber, 0, 24);
                            if (widthPt === primaryElement.stroke.widthPt)
                              return restoreBlurValue(target, primaryElement.stroke.widthPt);
                            target.value = String(widthPt);
                            return patchElement(
                              {
                                ...primaryElement,
                                stroke: { ...primaryElement.stroke, widthPt },
                              },
                              'Change shape stroke width',
                            );
                          });
                        }}
                      />
                    </label>
                    <label>
                      <span>Corner radius</span>
                      <input
                        key={`${primaryElement.id}-corner-radius`}
                        type="number"
                        min="0"
                        max="240"
                        step="1"
                        defaultValue={primaryElement.cornerRadiusPt}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            if (
                              target.value.trim() === '' ||
                              !Number.isFinite(target.valueAsNumber)
                            )
                              return restoreBlurValue(
                                target,
                                primaryElement.cornerRadiusPt,
                                'Enter a valid corner radius.',
                              );
                            const cornerRadiusPt = clamp(target.valueAsNumber, 0, 240);
                            if (cornerRadiusPt === primaryElement.cornerRadiusPt)
                              return restoreBlurValue(target, primaryElement.cornerRadiusPt);
                            target.value = String(cornerRadiusPt);
                            return patchElement(
                              { ...primaryElement, cornerRadiusPt },
                              'Change corner radius',
                            );
                          });
                        }}
                      />
                    </label>
                  </div>
                  <label className="stacked-field">
                    <span>Stroke pattern</span>
                    <select
                      value={primaryElement.stroke.dash}
                      onChange={(event) =>
                        patchElement(
                          {
                            ...primaryElement,
                            stroke: {
                              ...primaryElement.stroke,
                              dash: event.currentTarget.value as typeof primaryElement.stroke.dash,
                            },
                          },
                          'Change shape stroke pattern',
                        )
                      }
                    >
                      <option value="solid">Solid</option>
                      <option value="dash">Dashed</option>
                      <option value="dot">Dotted</option>
                    </select>
                  </label>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={primaryElement.shadow !== undefined}
                      onChange={(event) =>
                        patchElement(
                          event.currentTarget.checked
                            ? {
                                ...primaryElement,
                                shadow: {
                                  color: '#172033',
                                  blurPt: 10,
                                  offsetXPt: 0,
                                  offsetYPt: 5,
                                  opacity: 0.2,
                                },
                              }
                            : { ...primaryElement, shadow: undefined },
                          event.currentTarget.checked ? 'Add shape shadow' : 'Remove shape shadow',
                        )
                      }
                    />
                    Drop shadow
                  </label>
                </section>
              ) : null}
              {primaryElement?.type === 'connector' ? (
                <section className="inspector-section vector-editor-section">
                  <div className="section-heading-row">
                    <h3>Connector</h3>
                    <span className="section-status">Bindable</span>
                  </div>
                  <div className="font-controls">
                    <label className="stacked-field">
                      <span>Routing</span>
                      <select
                        value={primaryElement.routing}
                        onChange={(event) =>
                          patchElement(
                            {
                              ...primaryElement,
                              routing: event.currentTarget.value as typeof primaryElement.routing,
                            },
                            'Change connector routing',
                          )
                        }
                      >
                        <option value="straight">Straight</option>
                        <option value="elbow">Elbow</option>
                      </select>
                    </label>
                    <label className="stacked-field">
                      <span>Pattern</span>
                      <select
                        value={primaryElement.stroke.dash}
                        onChange={(event) =>
                          patchElement(
                            {
                              ...primaryElement,
                              stroke: {
                                ...primaryElement.stroke,
                                dash: event.currentTarget
                                  .value as typeof primaryElement.stroke.dash,
                              },
                            },
                            'Change connector pattern',
                          )
                        }
                      >
                        <option value="solid">Solid</option>
                        <option value="dash">Dashed</option>
                        <option value="dot">Dotted</option>
                      </select>
                    </label>
                  </div>
                  <label className="color-field">
                    Line color
                    <input
                      type="color"
                      value={primaryElement.stroke.color}
                      onChange={(event) =>
                        patchElement(
                          {
                            ...primaryElement,
                            stroke: { ...primaryElement.stroke, color: event.currentTarget.value },
                          },
                          'Change connector color',
                        )
                      }
                    />
                  </label>
                  <div className="field-grid">
                    <label>
                      <span>Width</span>
                      <input
                        key={`${primaryElement.id}-connector-width`}
                        type="number"
                        min="0"
                        max="24"
                        step="0.25"
                        defaultValue={primaryElement.stroke.widthPt}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            if (
                              target.value.trim() === '' ||
                              !Number.isFinite(target.valueAsNumber)
                            )
                              return restoreBlurValue(
                                target,
                                primaryElement.stroke.widthPt,
                                'Enter a valid connector width.',
                              );
                            const widthPt = clamp(target.valueAsNumber, 0, 24);
                            if (widthPt === primaryElement.stroke.widthPt)
                              return restoreBlurValue(target, primaryElement.stroke.widthPt);
                            target.value = String(widthPt);
                            return patchElement(
                              {
                                ...primaryElement,
                                stroke: { ...primaryElement.stroke, widthPt },
                              },
                              'Change connector width',
                            );
                          });
                        }}
                      />
                    </label>
                    <label>
                      <span>End cap</span>
                      <select
                        value={primaryElement.endCap}
                        onChange={(event) =>
                          patchElement(
                            {
                              ...primaryElement,
                              endCap: event.currentTarget.value as typeof primaryElement.endCap,
                            },
                            'Change connector end cap',
                          )
                        }
                      >
                        <option value="none">None</option>
                        <option value="arrow">Arrow</option>
                      </select>
                    </label>
                  </div>
                  {(['start', 'end'] as const).map((endpointName) => {
                    const endpoint = primaryElement[endpointName];
                    return (
                      <div className="connector-endpoint-card" key={endpointName}>
                        <strong>{endpointName === 'start' ? 'Start' : 'End'} endpoint</strong>
                        <label className="stacked-field">
                          <span>Attach to object</span>
                          <select
                            value={endpoint.binding.elementId ?? ''}
                            onChange={(event) => {
                              const elementId = event.currentTarget.value;
                              updateConnectorEndpoint(primaryElement, endpointName, {
                                ...endpoint,
                                binding:
                                  elementId === ''
                                    ? {}
                                    : {
                                        elementId,
                                        anchor: endpoint.binding.anchor ?? 'center',
                                      },
                              });
                            }}
                          >
                            <option value="">Free endpoint</option>
                            {activeSurfaceElements
                              .filter((element) => element.id !== primaryElement.id)
                              .map((element) => (
                                <option key={element.id} value={element.id}>
                                  {element.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="stacked-field">
                          <span>Anchor</span>
                          <select
                            disabled={endpoint.binding.elementId === undefined}
                            value={endpoint.binding.anchor ?? 'center'}
                            onChange={(event) =>
                              updateConnectorEndpoint(primaryElement, endpointName, {
                                ...endpoint,
                                binding: {
                                  ...endpoint.binding,
                                  anchor: event.currentTarget.value as NonNullable<
                                    typeof endpoint.binding.anchor
                                  >,
                                },
                              })
                            }
                          >
                            <option value="top">Top</option>
                            <option value="right">Right</option>
                            <option value="bottom">Bottom</option>
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                          </select>
                        </label>
                        <div className="field-grid">
                          {(['xPt', 'yPt'] as const).map((axis) => (
                            <label key={axis}>
                              <span>{axis === 'xPt' ? 'X' : 'Y'}</span>
                              <input
                                key={`${primaryElement.id}-${endpointName}-${axis}`}
                                type="number"
                                disabled={endpoint.binding.elementId !== undefined}
                                defaultValue={endpoint[axis]}
                                onBlur={(event) => {
                                  const target = event.currentTarget;
                                  void commitOnBlur(target, () => {
                                    if (
                                      target.value.trim() === '' ||
                                      !Number.isFinite(target.valueAsNumber)
                                    )
                                      return restoreBlurValue(
                                        target,
                                        endpoint[axis],
                                        'Enter a valid endpoint coordinate.',
                                      );
                                    const value = target.valueAsNumber;
                                    if (value === endpoint[axis])
                                      return restoreBlurValue(target, endpoint[axis]);
                                    return updateConnectorEndpoint(primaryElement, endpointName, {
                                      ...endpoint,
                                      [axis]: value,
                                    });
                                  });
                                }}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}
              {primaryElement?.type === 'icon' ? (
                <section className="inspector-section icon-editor-section">
                  <div className="section-heading-row">
                    <h3>
                      {primaryElement.iconSet === 'twemoji'
                        ? 'Emoji'
                        : primaryElement.iconSet === 'circle-flags' ||
                            primaryElement.iconSet === 'flags'
                          ? 'Circle flag'
                          : 'Icon'}
                    </h3>
                    <span className="section-status">Offline vector catalog</span>
                  </div>
                  <div className="mcp-command-card">
                    <span>Current visual</span>
                    <code>
                      {primaryElement.iconSet}:{primaryElement.iconName}
                    </code>
                  </div>
                  <button
                    type="button"
                    className="primary-inspector-action"
                    onClick={() => {
                      const initialCatalog: CatalogId =
                        primaryElement.iconSet === 'twemoji'
                          ? 'twemoji'
                          : primaryElement.iconSet === 'circle-flags' ||
                              primaryElement.iconSet === 'flags'
                            ? 'circle-flags'
                            : 'local-icons';
                      setContentPicker({
                        initialCatalog,
                        catalogs: ['local-icons', 'twemoji', 'circle-flags'],
                        replaceElementId: primaryElement.id,
                      });
                    }}
                  >
                    Choose another visual…
                  </button>
                  {primaryElement.iconSet === 'htmllelujah-local' ? (
                    <label className="color-field">
                      Color
                      <input
                        type="color"
                        value={primaryElement.color}
                        onChange={(event) =>
                          patchElement(
                            { ...primaryElement, color: event.currentTarget.value },
                            'Change icon color',
                          )
                        }
                      />
                    </label>
                  ) : null}
                </section>
              ) : null}
              {primaryTable !== undefined ? (
                <section className="inspector-section table-editor-section">
                  <div className="section-heading-row">
                    <h3>Table</h3>
                    <span className="section-status">
                      {primaryTable.rowCount} × {primaryTable.columnCount}
                    </span>
                  </div>
                  <div
                    className="table-cell-grid"
                    role="grid"
                    aria-label="Editable table cells"
                    style={{
                      gridTemplateColumns: `repeat(${Math.min(primaryTable.columnCount, 6)}, minmax(58px, 1fr))`,
                    }}
                  >
                    {Array.from({ length: Math.min(primaryTable.rowCount, 10) }, (_, row) =>
                      Array.from({ length: Math.min(primaryTable.columnCount, 6) }, (_, column) => {
                        const cell = primaryTable.cells.find(
                          (candidate) => candidate.row === row && candidate.column === column,
                        );
                        if (cell === undefined)
                          return (
                            <span
                              key={`covered-${row}-${column}`}
                              className="table-cell-covered"
                              aria-label={`Covered cell ${row + 1}, ${column + 1}`}
                            />
                          );
                        return (
                          <input
                            key={cell.id}
                            role="gridcell"
                            aria-label={`Cell ${row + 1}, ${column + 1}`}
                            className={selectedTableCellId === cell.id ? 'is-selected' : ''}
                            defaultValue={contentToPlainText(cell.content)}
                            onFocus={() => setSelectedTableCellId(cell.id)}
                            onBlur={(event) => {
                              const target = event.currentTarget;
                              void commitOnBlur(target, () => {
                                const value = target.value;
                                if (value === contentToPlainText(cell.content)) return true;
                                return mutateTable('Edit table cell', (slideId, tableId) => ({
                                  type: 'table.update-cell',
                                  slideId,
                                  tableId,
                                  cellId: cell.id,
                                  content: plainParagraph(value),
                                }));
                              });
                            }}
                          />
                        );
                      }),
                    )}
                  </div>
                  {primaryTable.rowCount > 10 || primaryTable.columnCount > 6 ? (
                    <p className="field-hint">
                      Showing the first 10 rows and 6 columns. Paste TSV to update a larger range.
                    </p>
                  ) : null}
                  <textarea
                    className="tsv-editor"
                    aria-label="Table cells (tab-separated values)"
                    value={tableTsv}
                    placeholder={'Paste tab-separated cells\nName\tValue'}
                    onChange={(event) => {
                      const target = event.currentTarget;
                      const value = target.value;
                      setTableTsv(value);
                      void commitOnBlur(
                        tableTsvDraftCommitKeyRef.current,
                        () => value.trim() === '',
                      );
                    }}
                  />
                  <button
                    type="button"
                    className="primary-inspector-action"
                    disabled={tableTsv.trim() === ''}
                    onClick={() => void pasteTable()}
                  >
                    Paste TSV into table
                  </button>
                  <div className="table-actions">
                    <button
                      type="button"
                      onClick={() => {
                        const cells = Array.from(
                          { length: primaryTable.columnCount },
                          (_, column) => ({
                            id: crypto.randomUUID(),
                            row: primaryTable.rowCount,
                            column,
                            rowSpan: 1,
                            columnSpan: 1,
                            content: plainParagraph(''),
                            style: {
                              fill: null,
                              textColor: '#172033',
                              horizontalAlignment: 'left' as const,
                              verticalAlignment: 'middle' as const,
                              paddingPt: 8,
                            },
                          }),
                        );
                        void mutateTable('Add table row', (slideId, tableId) => ({
                          type: 'table.insert-row',
                          slideId,
                          tableId,
                          index: primaryTable.rowCount,
                          heightPt: 42,
                          cells,
                        }));
                      }}
                    >
                      <Rows3 size={14} /> Add row
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const cells = Array.from({ length: primaryTable.rowCount }, (_, row) => ({
                          id: crypto.randomUUID(),
                          row,
                          column: primaryTable.columnCount,
                          rowSpan: 1,
                          columnSpan: 1,
                          content: plainParagraph(''),
                          style: {
                            fill: null,
                            textColor: '#172033',
                            horizontalAlignment: 'left' as const,
                            verticalAlignment: 'middle' as const,
                            paddingPt: 8,
                          },
                        }));
                        void mutateTable('Add table column', (slideId, tableId) => ({
                          type: 'table.insert-column',
                          slideId,
                          tableId,
                          index: primaryTable.columnCount,
                          widthPt: 120,
                          cells,
                        }));
                      }}
                    >
                      <Columns3 size={14} /> Add column
                    </button>
                    <button
                      type="button"
                      disabled={primaryTable.rowCount <= 1}
                      onClick={() =>
                        void mutateTable('Delete table row', (slideId, tableId) => ({
                          type: 'table.delete-row',
                          slideId,
                          tableId,
                          index: primaryTable.rowCount - 1,
                        }))
                      }
                    >
                      <Trash2 size={14} /> Last row
                    </button>
                    <button
                      type="button"
                      disabled={primaryTable.columnCount <= 1}
                      onClick={() =>
                        void mutateTable('Delete table column', (slideId, tableId) => ({
                          type: 'table.delete-column',
                          slideId,
                          tableId,
                          index: primaryTable.columnCount - 1,
                        }))
                      }
                    >
                      <Trash2 size={14} /> Last column
                    </button>
                  </div>
                  <div className="table-style-grid">
                    <label className="color-field">
                      Border
                      <input
                        type="color"
                        value={primaryTable.border.color}
                        onChange={(event) =>
                          void mutateTable('Change table border', (slideId, tableId) => ({
                            type: 'table.update-style',
                            slideId,
                            tableId,
                            border: {
                              ...primaryTable.border,
                              color: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="stacked-field">
                      <span>Border width</span>
                      <input
                        key={`${primaryTable.id}-border`}
                        type="number"
                        min="0"
                        max="24"
                        step="0.25"
                        defaultValue={primaryTable.border.widthPt}
                        onBlur={(event) => {
                          const target = event.currentTarget;
                          void commitOnBlur(target, () => {
                            if (
                              target.value.trim() === '' ||
                              !Number.isFinite(target.valueAsNumber)
                            )
                              return restoreBlurValue(
                                target,
                                primaryTable.border.widthPt,
                                'Enter a valid table border width.',
                              );
                            const widthPt = clamp(target.valueAsNumber, 0, 24);
                            if (widthPt === primaryTable.border.widthPt)
                              return restoreBlurValue(target, primaryTable.border.widthPt);
                            target.value = String(widthPt);
                            return mutateTable('Change table border width', (slideId, tableId) => ({
                              type: 'table.update-style',
                              slideId,
                              tableId,
                              border: { ...primaryTable.border, widthPt },
                            }));
                          });
                        }}
                      />
                    </label>
                    <label className="color-field">
                      Header fill
                      <input
                        type="color"
                        value={primaryTable.style?.headerFill ?? '#e8ecf7'}
                        onChange={(event) =>
                          void mutateTable('Change table header', (slideId, tableId) => ({
                            type: 'table.update-style',
                            slideId,
                            tableId,
                            style: {
                              ...primaryTable.style,
                              headerFill: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={primaryTable.style?.bandedRows ?? false}
                        onChange={(event) =>
                          void mutateTable('Toggle banded rows', (slideId, tableId) => ({
                            type: 'table.update-style',
                            slideId,
                            tableId,
                            style: {
                              ...primaryTable.style,
                              bandedRows: event.currentTarget.checked,
                            },
                          }))
                        }
                      />
                      Banded rows
                    </label>
                  </div>
                  {selectedTableCell !== undefined ? (
                    <div className="table-cell-style">
                      <strong>
                        Cell {selectedTableCell.row + 1}, {selectedTableCell.column + 1}
                      </strong>
                      <label className="color-field">
                        Fill
                        <input
                          type="color"
                          value={selectedTableCell.style.fill ?? '#ffffff'}
                          onChange={(event) =>
                            void mutateTable('Change cell fill', (slideId, tableId) => ({
                              type: 'table.update-cell',
                              slideId,
                              tableId,
                              cellId: selectedTableCell.id,
                              style: {
                                ...selectedTableCell.style,
                                fill: event.currentTarget.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="color-field">
                        Text
                        <input
                          type="color"
                          value={selectedTableCell.style.textColor}
                          onChange={(event) =>
                            void mutateTable('Change cell text color', (slideId, tableId) => ({
                              type: 'table.update-cell',
                              slideId,
                              tableId,
                              cellId: selectedTableCell.id,
                              style: {
                                ...selectedTableCell.style,
                                textColor: event.currentTarget.value,
                              },
                            }))
                          }
                        />
                      </label>
                      <label className="stacked-field">
                        <span>Horizontal</span>
                        <select
                          value={selectedTableCell.style.horizontalAlignment}
                          onChange={(event) =>
                            void mutateTable('Align cell text', (slideId, tableId) => ({
                              type: 'table.update-cell',
                              slideId,
                              tableId,
                              cellId: selectedTableCell.id,
                              style: {
                                ...selectedTableCell.style,
                                horizontalAlignment: event.currentTarget.value as TextAlignment,
                              },
                            }))
                          }
                        >
                          <option value="left">Left</option>
                          <option value="center">Center</option>
                          <option value="right">Right</option>
                          <option value="justify">Justify</option>
                        </select>
                      </label>
                      <label className="stacked-field">
                        <span>Vertical</span>
                        <select
                          value={selectedTableCell.style.verticalAlignment}
                          onChange={(event) =>
                            void mutateTable('Align cell vertically', (slideId, tableId) => ({
                              type: 'table.update-cell',
                              slideId,
                              tableId,
                              cellId: selectedTableCell.id,
                              style: {
                                ...selectedTableCell.style,
                                verticalAlignment: event.currentTarget.value as
                                  'top' | 'middle' | 'bottom',
                              },
                            }))
                          }
                        >
                          <option value="top">Top</option>
                          <option value="middle">Middle</option>
                          <option value="bottom">Bottom</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="secondary-action"
                        onClick={() =>
                          void mutateTable('Clear cell fill', (slideId, tableId) => ({
                            type: 'table.update-cell',
                            slideId,
                            tableId,
                            cellId: selectedTableCell.id,
                            style: { ...selectedTableCell.style, fill: null },
                          }))
                        }
                      >
                        Clear cell fill
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Arrange</h3>
                  <Layers3 size={14} />
                </div>
                <div className="arrange-actions">
                  <button
                    type="button"
                    disabled={primaryElement === undefined}
                    onClick={() => reorder('front')}
                  >
                    <BringToFront size={15} /> Bring to front
                  </button>
                  <button
                    type="button"
                    disabled={primaryElement === undefined}
                    onClick={() => reorder('back')}
                  >
                    <SendToBack size={15} /> Send to back
                  </button>
                </div>
                <div className="arrange-actions">
                  <button
                    type="button"
                    disabled={
                      activeAuthoringSurface !== 'slide' ||
                      selectedIds.length < 2 ||
                      selectedElements.some((element) => element.locked)
                    }
                    onClick={() => void groupSelection()}
                  >
                    <Group size={15} /> Group
                  </button>
                  <button
                    type="button"
                    disabled={
                      activeAuthoringSurface !== 'slide' ||
                      primaryElement?.type !== 'group' ||
                      primaryElement.locked
                    }
                    onClick={() => void ungroupSelection()}
                  >
                    <Ungroup size={15} /> Ungroup
                  </button>
                </div>
                <div className="object-actions">
                  <button
                    type="button"
                    disabled={primaryElement === undefined}
                    onClick={toggleVisible}
                  >
                    {primaryElement?.visible === false ? <Eye size={14} /> : <EyeOff size={14} />}{' '}
                    {primaryElement?.visible === false ? 'Show' : 'Hide'}
                  </button>
                  <button
                    type="button"
                    disabled={primaryElement === undefined}
                    onClick={() => void duplicateSelection()}
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    disabled={primaryElement === undefined}
                    onClick={() => void deleteSelection()}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </section>
            </div>
          )}
        </aside>
      </main>

      <footer className="status-bar">
        <div className="status-left">
          <span>
            Slide {document.slides.findIndex((slide) => slide.id === activeSlide.id) + 1} of{' '}
            {document.slides.length}
          </span>
          <span className="status-divider" />
          <span>
            {selectedIds.length === 0 ? 'No selection' : `${selectedIds.length} selected`}
          </span>
          <span className="status-divider" />
          <button
            type="button"
            className={gridEnabled ? 'is-active' : ''}
            aria-pressed={gridEnabled}
            onClick={() => setGridEnabled((value) => !value)}
          >
            <Grid3X3 size={13} /> Grid {gridEnabled ? 'on' : 'off'}
          </button>
        </div>
        <div className="status-center">
          <span className={`durability-indicator state-${session.snapshot.durability}`} />
          {session.snapshot.durability}
        </div>
        <div className="zoom-controls" role="group" aria-label="Canvas zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => stepCanvasZoom(value, fitScale, -1))}
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            min={MANUAL_ZOOM_MIN_PERCENT}
            max={MANUAL_ZOOM_MAX_PERCENT}
            step="5"
            value={clampManualZoomPercent(zoomPercent)}
            aria-label="Zoom percentage"
            aria-valuetext={zoom.mode === 'fit' ? `Fit slide, ${zoomPercent}%` : `${zoomPercent}%`}
            onChange={(event) =>
              setZoom({ mode: 'manual', percent: Number(event.currentTarget.value) })
            }
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => stepCanvasZoom(value, fitScale, 1))}
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            className="zoom-value"
            title="Actual size"
            onClick={() => setZoom({ mode: 'manual', percent: 100 })}
          >
            {zoomPercent}%
          </button>
          <button
            type="button"
            className={zoom.mode === 'fit' ? 'is-active' : ''}
            aria-label="Fit slide"
            aria-pressed={zoom.mode === 'fit'}
            title={`Fit slide (${zoomPercent}%)`}
            onClick={() => setZoom({ mode: 'fit' })}
          >
            <Minus size={14} />
          </button>
        </div>
      </footer>

      {contentPicker !== null ? (
        <ContentCatalogPicker
          initialCatalog={contentPicker.initialCatalog}
          catalogs={contentPicker.catalogs}
          locale={document.metadata.locale.toLowerCase().startsWith('fr') ? 'fr' : 'en'}
          onDismiss={() => setContentPicker(null)}
          onSelect={(entry) => void selectContentCatalogEntry(entry)}
        />
      ) : null}

      {objectContextMenu !== null ? (
        <div
          ref={objectContextMenuRef}
          className="object-context-menu"
          role="menu"
          aria-label="Object actions"
          style={{ left: objectContextMenu.x, top: objectContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={navigateObjectContextMenu}
        >
          <button
            type="button"
            role="menuitem"
            disabled={selectedElements.length === 0}
            onClick={() => {
              copySelectionToInternalClipboard();
              dismissObjectContextMenu(true);
            }}
          >
            <Copy size={15} /> Copy <kbd>Ctrl C</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              selectedElements.length === 0 || selectedElements.some((element) => element.locked)
            }
            onClick={() => {
              dismissObjectContextMenu(false);
              void cutSelectionToInternalClipboard();
            }}
          >
            <Scissors size={15} /> Cut <kbd>Ctrl X</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={objectClipboardRef.current === null}
            onClick={() => {
              const serialized = objectClipboardRef.current;
              dismissObjectContextMenu(false);
              if (serialized !== null) void pasteSerializedObjects(serialized);
            }}
          >
            <ClipboardPaste size={15} /> Paste <kbd>Ctrl V</kbd>
          </button>
          <span className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              dismissObjectContextMenu(false);
              void duplicateSelection();
            }}
          >
            <Copy size={15} /> Duplicate <kbd>Ctrl D</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={primaryElement === undefined || primaryElement.locked}
            onClick={() => {
              dismissObjectContextMenu(true);
              reorder('front');
            }}
          >
            <BringToFront size={15} /> Bring to front
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={primaryElement === undefined || primaryElement.locked}
            onClick={() => {
              dismissObjectContextMenu(true);
              reorder('back');
            }}
          >
            <SendToBack size={15} /> Send to back
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={primaryElement === undefined}
            onClick={() => {
              dismissObjectContextMenu(true);
              toggleLock();
            }}
          >
            {primaryElement?.locked ? <Unlock size={15} /> : <Lock size={15} />}
            {primaryElement?.locked ? 'Unlock' : 'Lock'}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={primaryElement === undefined || primaryElement.locked}
            onClick={() => {
              dismissObjectContextMenu(true);
              toggleVisible();
            }}
          >
            {primaryElement?.visible === false ? <Eye size={15} /> : <EyeOff size={15} />}
            {primaryElement?.visible === false ? 'Show' : 'Hide'}
          </button>
          <span className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            disabled={
              activeAuthoringSurface !== 'slide' ||
              selectedIds.length < 2 ||
              selectedElements.some((element) => element.locked)
            }
            onClick={() => {
              dismissObjectContextMenu(false);
              void groupSelection();
            }}
          >
            <Group size={15} /> Group <kbd>Ctrl G</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              activeAuthoringSurface !== 'slide' ||
              primaryElement?.type !== 'group' ||
              primaryElement.locked
            }
            onClick={() => {
              dismissObjectContextMenu(false);
              void ungroupSelection();
            }}
          >
            <Ungroup size={15} /> Ungroup <kbd>Ctrl Shift G</kbd>
          </button>
          <span className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={
              selectedElements.length === 0 || selectedElements.some((element) => element.locked)
            }
            onClick={() => {
              dismissObjectContextMenu(false);
              void deleteSelection();
            }}
          >
            <Trash2 size={15} /> Delete <kbd>Del</kbd>
          </button>
        </div>
      ) : null}

      {toast !== null ? (
        <div className={`toast toast-${toast.kind}`} role="status">
          <span>{toast.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}
      {busy ? <div className="busy-bar" aria-hidden="true" /> : null}

      {recoveryOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setRecoveryOpen(false);
          }}
        >
          <section
            className="share-dialog recovery-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recovery-title"
          >
            <header>
              <div>
                <span className="eyebrow">CRASH RECOVERY</span>
                <h2 id="recovery-title">Recover local work</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setRecoveryOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <p>
              HTMLlelujah journals every accepted edit locally. Open a recovered copy, verify it,
              then choose Save As to keep it.
            </p>
            <div className="recovery-list">
              {recoveryCandidates.map((candidate, index) => (
                <article key={candidate.candidateId}>
                  <div>
                    <strong>Recovery {index + 1}</strong>
                    <span>
                      {candidate.recordCount} journaled change
                      {candidate.recordCount === 1 ? '' : 's'} ·{' '}
                      {candidate.complete ? 'complete journal' : 'repaired safe prefix'}
                    </span>
                    <code>{candidate.documentId}</code>
                  </div>
                  <button
                    type="button"
                    className="primary-inspector-action"
                    onClick={() => void recoverPresentation(candidate.candidateId)}
                  >
                    Open recovered copy
                  </button>
                </article>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {mcpOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setMcpOpen(false);
          }}
        >
          <section
            className="share-dialog mcp-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-title"
          >
            <header>
              <div>
                <span className="eyebrow">LOCAL AGENT BRIDGE</span>
                <h2 id="mcp-title">Work with Codex through MCP</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setMcpOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <p>
              The installed local agent has a persistent, revocable identity. Codex or Claude can
              inspect the authoritative theme, masters, layouts and slides, then apply ordinary
              typed edits without a new approval for every action.
            </p>
            <div className="collaboration-status">
              <Code2 size={18} />
              <div>
                <strong>{mcpStatus?.available ? 'Bridge ready' : 'Bridge unavailable'}</strong>
                <span>
                  {mcpStatus?.visibleDocuments ?? 0} visible presentation
                  {(mcpStatus?.visibleDocuments ?? 0) === 1 ? '' : 's'} ·{' '}
                  {mcpStatus?.pendingApprovals ?? 0} pending approval
                  {(mcpStatus?.pendingApprovals ?? 0) === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div className="mcp-command-card">
              <span>Persistent local MCP launcher</span>
              <code>HTMLlelujah-MCP.cmd</code>
              <small>
                Keep HTMLlelujah open. Every edit remains revision-checked, attributed and undoable;
                arbitrary files, remote URLs and executable HTML remain inaccessible.
              </small>
            </div>
            <p className="dialog-footnote">
              Sensitive external operations such as importing a local file or exporting a
              deliverable stay under desktop control. Ordinary presentation authoring does not
              require a one-time token.
            </p>
          </section>
        </div>
      ) : null}

      {shareOpen ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setShareOpen(false);
          }}
        >
          <section
            className="share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-title"
          >
            <header>
              <div>
                <span className="eyebrow">LOCAL COLLABORATION</span>
                <h2 id="share-title">Edit together on your LAN</h2>
              </div>
              <button type="button" aria-label="Close" onClick={() => setShareOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <p>
              Everyone opens the same <strong>.hdeck</strong> from the shared drive. One person
              hosts the authoritative live session; only that host writes the shared file.
            </p>
            <div className="collaboration-status">
              <Users size={18} />
              <div>
                <strong>
                  {shareStatus?.mode === 'host'
                    ? 'Hosting'
                    : shareStatus?.mode === 'guest'
                      ? 'Joined'
                      : 'Offline'}
                </strong>
                <span>{shareStatus?.note ?? 'Checking local collaboration…'}</span>
              </div>
            </div>
            {shareStatus === null ? null : (
              <CollaborationParticipants
                status={shareStatus}
                decidingJoinId={decidingJoinId}
                decisionError={collaborationDecisionError}
                nowMs={collaborationNowMs}
                onDecideJoin={(joinRequestId, decision) =>
                  void decideCollaborationJoin(joinRequestId, decision)
                }
              />
            )}
            <label className="stacked-field">
              <span>Your name</span>
              <input
                value={displayName}
                maxLength={64}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
            <div className="share-columns">
              <div>
                <h3>Host</h3>
                <label className="stacked-field">
                  <span>Network address</span>
                  <select
                    value={hostAddress}
                    disabled={startingCollaboration || joiningCollaboration}
                    onChange={(event) => {
                      hostAddressNeedsConfirmationRef.current = false;
                      setHostAddress(event.currentTarget.value);
                    }}
                  >
                    {(shareStatus?.availableHostAddresses ?? []).length === 0 ? (
                      <option value="">No private network detected</option>
                    ) : (
                      <>
                        <option value="" disabled>
                          Choose a network...
                        </option>
                        {(shareStatus?.availableHostAddresses ?? []).map((adapter) => (
                          <option key={adapter.address} value={adapter.address}>
                            {adapter.name} - {adapter.address}
                          </option>
                        ))}
                      </>
                    )}
                  </select>
                  <small>
                    {shareStatus?.availableHostAddresses !== undefined &&
                    shareStatus.availableHostAddresses.length > 1
                      ? 'Choose the network your collaborators are using.'
                      : 'HTMLlelujah binds only to this private address.'}
                  </small>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={discovery}
                    onChange={(event) => setDiscovery(event.currentTarget.checked)}
                  />{' '}
                  Advertise on private networks
                </label>
                <button
                  type="button"
                  className="primary-inspector-action"
                  disabled={
                    shareStatus?.mode !== 'offline' ||
                    hostAddress === '' ||
                    startingCollaboration ||
                    joiningCollaboration
                  }
                  onClick={() => void hostCollaboration()}
                >
                  {startingCollaboration ? 'Starting…' : 'Start LAN session'}
                </button>
                {shareStatus?.sessionCode !== undefined ? (
                  <div className="session-secret">
                    <span>Host address</span>
                    <code>{shareStatus.endpoint}</code>
                    <span>Session code</span>
                    <code>{shareStatus.sessionCode}</code>
                    <span>Fingerprint</span>
                    <code>{shareStatus.hostFingerprint}</code>
                  </div>
                ) : null}
              </div>
              <div>
                <h3>Join</h3>
                <label className="stacked-field">
                  <span>Host address</span>
                  <input
                    value={joinEndpoint}
                    disabled={joiningCollaboration}
                    placeholder="wss://192.168.1.20:…"
                    onChange={(event) => setJoinEndpoint(event.currentTarget.value)}
                  />
                </label>
                <label className="stacked-field">
                  <span>Session code</span>
                  <input
                    value={joinCode}
                    disabled={joiningCollaboration}
                    onChange={(event) => setJoinCode(event.currentTarget.value)}
                  />
                </label>
                <label className="stacked-field">
                  <span>Fingerprint</span>
                  <input
                    value={joinFingerprint}
                    disabled={joiningCollaboration}
                    onChange={(event) => setJoinFingerprint(event.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={
                    shareStatus?.mode !== 'offline' ||
                    !joinEndpoint ||
                    !joinCode ||
                    !joinFingerprint ||
                    joiningCollaboration ||
                    startingCollaboration
                  }
                  onClick={() => void joinCollaboration()}
                >
                  {joiningCollaboration ? 'Waiting for host…' : 'Join session'}
                </button>
              </div>
            </div>
            {shareStatus?.mode !== undefined && shareStatus.mode !== 'offline' ? (
              <button
                type="button"
                className="secondary-action end-session-action"
                onClick={() => void leaveCollaboration()}
              >
                End LAN session on this device
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function App() {
  const mode = new URLSearchParams(window.location.search).get('mode');
  return mode === 'presentation' ? <PresentationMode /> : <EditorApp />;
}
