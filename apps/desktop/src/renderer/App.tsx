import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignStartHorizontal,
  AlignStartVertical,
  Bold,
  BringToFront,
  Check,
  ChevronDown,
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
  SendToBack,
  Share2,
  SlidersHorizontal,
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
  createDuplicateSlide,
  resolveSlide,
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
  type TextAlignment,
  type TextElement,
  type TextMarks,
  type TextStyleRole,
} from '@htmllelujah/document-core';
import { LOCAL_ICON_PATHS, SlideSurface } from '@htmllelujah/renderer';
import type { RecoveryCandidate } from '@htmllelujah/document-runtime';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type {
  CollaborationStatus,
  CollaborationTextLeaseInput,
  CollaborationTextLeaseStatus,
  DesktopResult,
  McpApproval,
  McpApprovalAction,
  McpStatus,
  SessionView,
} from '../shared/desktop-api';
import { EditorButton } from './components/EditorButton';
import { CanonicalSlideCanvas } from './components/CanonicalSlideCanvas';
import {
  contentFromPlainText,
  contentToPlainText,
  createConnectorElement,
  createFlagElement,
  createIconElement,
  createShapeElement,
  createSlide,
  createTableElement,
  createTextElement,
  duplicateElements,
  emptyMarks,
  plainParagraph,
  replacePlainTextPreservingStyles,
  updateRichTextPresentation,
} from './editor/canonical-factories';

const menuItems = ['File', 'Edit', 'View', 'Insert', 'Arrange', 'Help'] as const;
const commonCountryCodes = [
  'AR',
  'AU',
  'BE',
  'BR',
  'CA',
  'CH',
  'CN',
  'DE',
  'DK',
  'ES',
  'EU',
  'FI',
  'FR',
  'GB',
  'GR',
  'IE',
  'IN',
  'IT',
  'JP',
  'KR',
  'LU',
  'MX',
  'NL',
  'NO',
  'PL',
  'PT',
  'SE',
  'SG',
  'US',
] as const;
type MenuItem = (typeof menuItems)[number];
type InspectorTab = 'properties' | 'design';
type Toast = { readonly kind: 'success' | 'error' | 'info'; readonly message: string };
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

const initialTextDraft = (element: TextElement, document: DeckDocument): TextDraft => {
  const marks = firstMarks(element.content);
  const firstBlock = element.content.blocks[0];
  const theme =
    document.themes.find((candidate) =>
      document.masters.some((master) => master.themeId === candidate.id),
    ) ?? document.themes[0];
  const roleStyle = theme?.textStyles.find((style) => style.role === element.styleRole);
  return {
    text: contentToPlainText(element.content),
    kind: textKind(element.content),
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

const textEditingFingerprint = (element: TextElement): string =>
  JSON.stringify({
    styleRole: element.styleRole,
    verticalAlignment: element.verticalAlignment,
    content: element.content,
    style: element.style,
  });

const duplicateGuides = (guides: readonly Guide[]): readonly Guide[] =>
  guides.map((guide) => ({ ...guide, id: crypto.randomUUID() }));

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
      <span className="brand-mark loading-mark" aria-hidden="true">
        H
      </span>
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
  const projection = resolveSlide(session.snapshot.document, active.id);
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
}: {
  readonly document: DeckDocument;
  readonly slide: Slide;
  readonly assetUrls: Readonly<Record<string, string>>;
  readonly index: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
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
      aria-label={`Slide ${index + 1}: ${slide.name}${slide.hidden ? ', hidden' : ''}`}
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
  const [zoom, setZoom] = useState(100);
  const [fitScale, setFitScale] = useState(0.72);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('properties');
  const [activeMenu, setActiveMenu] = useState<MenuItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<CollaborationStatus | null>(null);
  const [displayName, setDisplayName] = useState('Presenter');
  const [discovery, setDiscovery] = useState(false);
  const [joinEndpoint, setJoinEndpoint] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joinFingerprint, setJoinFingerprint] = useState('');
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpApprovalAction, setMcpApprovalAction] =
    useState<McpApprovalAction>('commit-destructive');
  const [mcpApproval, setMcpApproval] = useState<McpApproval | null>(null);
  const [recoveryCandidates, setRecoveryCandidates] = useState<readonly RecoveryCandidate[]>([]);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [textDraftDirty, setTextDraftDirty] = useState(false);
  const [textDraftConflict, setTextDraftConflict] = useState(false);
  const [textLeaseStatus, setTextLeaseStatus] = useState<CollaborationTextLeaseStatus | null>(null);
  const [textLeasePending, setTextLeasePending] = useState(false);
  const textBaselineRef = useRef<{ readonly id: string; readonly value: string } | null>(null);
  const textApplyInFlightRef = useRef(false);
  const textLeasePendingRef = useRef(false);
  const textLeaseRequestRef = useRef<CollaborationTextLeaseInput | null>(null);
  const textEditorFocusedRef = useRef(false);
  const [tableTsv, setTableTsv] = useState('');
  const [selectedTableCellId, setSelectedTableCellId] = useState('');
  const [designMasterId, setDesignMasterId] = useState('');
  const [designLayoutId, setDesignLayoutId] = useState('');
  const workspaceRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const executeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExecuteCountRef = useRef(0);

  const acceptSession = useCallback((next: SessionView): void => {
    sessionRef.current = next;
    setSession(next);
    setActiveSlideId((current) =>
      next.snapshot.document.slides.some((slide) => slide.id === current)
        ? current
        : (next.snapshot.document.slides[0]?.id ?? ''),
    );
    setSelectedIds((current) => {
      const ids = new Set(
        next.snapshot.document.slides.flatMap((slide) =>
          slide.elements.map((element) => element.id),
        ),
      );
      return current.filter((id) => ids.has(id));
    });
  }, []);

  const notify = useCallback((message: string, kind: Toast['kind'] = 'info'): void => {
    setToast({ message, kind });
  }, []);

  const editTextDraft = useCallback((next: TextDraft): void => {
    setTextDraft(next);
    setTextDraftDirty(true);
  }, []);

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
          if (active && status.ok) setShareStatus(status.value);
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
  }, [acceptSession, notify]);

  const document = session?.snapshot.document;
  const activeSlide = useMemo(
    () => document?.slides.find((slide) => slide.id === activeSlideId) ?? document?.slides[0],
    [activeSlideId, document],
  );
  const selectedElements = useMemo(
    () => activeSlide?.elements.filter((element) => selectedIds.includes(element.id)) ?? [],
    [activeSlide, selectedIds],
  );
  const primaryElement = selectedElements.at(-1);
  const primaryText = primaryElement?.type === 'text' ? primaryElement : undefined;
  const primaryImage = primaryElement?.type === 'image' ? primaryElement : undefined;
  const primaryTable = primaryElement?.type === 'table' ? primaryElement : undefined;
  const selectedTableCell = primaryTable?.cells.find((cell) => cell.id === selectedTableCellId);
  const designMaster = document?.masters.find((master) => master.id === designMasterId);
  const designLayout = document?.layouts.find((layout) => layout.id === designLayoutId);
  const canvasScale = fitScale * (zoom / 100);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (workspace === null || document === undefined) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const availableWidth = Math.max(entry.contentRect.width - 104, 320);
      const availableHeight = Math.max(entry.contentRect.height - 80, 240);
      setFitScale(
        Math.min(
          availableWidth / document.page.widthPt,
          availableHeight / document.page.heightPt,
          1,
        ),
      );
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [document]);

  useEffect(() => {
    if (primaryText === undefined || document === undefined) {
      setTextDraft(null);
      setTextDraftDirty(false);
      setTextDraftConflict(false);
      textBaselineRef.current = null;
      return;
    }
    const value = textEditingFingerprint(primaryText);
    const baseline = textBaselineRef.current;
    if (baseline === null || baseline.id !== primaryText.id) {
      setTextDraft(initialTextDraft(primaryText, document));
      setTextDraftDirty(false);
      setTextDraftConflict(false);
      textBaselineRef.current = { id: primaryText.id, value };
      return;
    }
    if (baseline.value === value) return;
    if (textDraftDirty) {
      setTextDraftConflict(true);
      return;
    }
    setTextDraft(initialTextDraft(primaryText, document));
    setTextDraftConflict(false);
    textBaselineRef.current = { id: primaryText.id, value };
  }, [document, primaryText, textDraftDirty]);

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
      if (refreshed?.ok) setShareStatus(refreshed.value);
    }
    if (
      result.value.status === 'owned' &&
      window.document.activeElement instanceof HTMLElement &&
      window.document.activeElement.classList.contains('text-lease-gate')
    ) {
      window.setTimeout(() => textAreaRef.current?.focus(), 0);
    }
  }, [
    activeSlide,
    notify,
    primaryText,
    releaseTextLease,
    shareStatus?.mode,
    showFailure,
    textLeaseStatus,
  ]);

  const execute = useCallback(
    (
      label: string,
      commands: readonly DocumentCommand[],
      options: { readonly select?: readonly string[]; readonly message?: string } = {},
    ): Promise<boolean> => {
      const requestedSession = sessionRef.current;
      if (requestedSession === null || commands.length === 0) return Promise.resolve(false);
      if (busy && pendingExecuteCountRef.current === 0) return Promise.resolve(false);
      const requestedSessionId = requestedSession.snapshot.sessionId;
      const requestedRevision = requestedSession.snapshot.revision;
      pendingExecuteCountRef.current += 1;
      setBusy(true);
      const run = async (): Promise<boolean> => {
        try {
          const current = sessionRef.current;
          if (current === null || current.snapshot.sessionId !== requestedSessionId) return false;
          const result = await window.htmllelujah.execute({
            sessionId: requestedSessionId,
            expectedRevision: requestedRevision,
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
    },
    [acceptSession, busy, notify, showFailure],
  );

  const save = useCallback(
    async (saveAs = false): Promise<void> => {
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

  const addElement = useCallback(
    async (element: Element): Promise<void> => {
      if (activeSlide === undefined) return;
      await execute(
        'Insert element',
        [{ type: 'element.insert', slideId: activeSlide.id, element }],
        { select: [element.id] },
      );
    },
    [activeSlide, execute],
  );

  const importImage = useCallback(
    async (replace?: ImageElement): Promise<void> => {
      const current = sessionRef.current;
      if (current === null || activeSlide === undefined || busy) return;
      setBusy(true);
      try {
        const imported = await window.htmllelujah.importImage({
          sessionId: current.snapshot.sessionId,
          expectedRevision: current.snapshot.revision,
          slideId: activeSlide.id,
          ...(replace === undefined ? {} : { replaceElementId: replace.id }),
        });
        if (!imported.ok) {
          showFailure(imported);
          return;
        }
        acceptSession(imported.value.session);
        setSelectedIds([imported.value.elementId]);
        notify(replace === undefined ? 'Image added.' : 'Image replaced.', 'success');
      } finally {
        setBusy(false);
      }
    },
    [acceptSession, activeSlide, busy, notify, showFailure],
  );

  const addSlide = useCallback(async (): Promise<void> => {
    if (document === undefined) return;
    const layoutId = activeSlide?.layoutId ?? document.layouts[0]?.id;
    if (layoutId === undefined) return;
    const slide = createSlide(layoutId, document.slides.length);
    if (await execute('Add slide', [{ type: 'slide.create', slide }])) {
      setActiveSlideId(slide.id);
      setSelectedIds(slide.elements[0] === undefined ? [] : [slide.elements[0].id]);
    }
  }, [activeSlide?.layoutId, document, execute]);

  const duplicateSlide = useCallback(async (): Promise<void> => {
    if (document === undefined || activeSlide === undefined) return;
    const duplicate = createDuplicateSlide(document, activeSlide.id, () => crypto.randomUUID());
    if (
      await execute('Duplicate slide', [
        { type: 'slide.duplicate', slideId: activeSlide.id, duplicate },
      ])
    ) {
      setActiveSlideId(duplicate.id);
      setSelectedIds([]);
    }
  }, [activeSlide, document, execute]);

  const deleteSlide = useCallback(async (): Promise<void> => {
    if (document === undefined || activeSlide === undefined || document.slides.length <= 1) return;
    const index = document.slides.findIndex((slide) => slide.id === activeSlide.id);
    const next = document.slides[index + 1] ?? document.slides[index - 1];
    if (await execute('Delete slide', [{ type: 'slide.delete', slideId: activeSlide.id }])) {
      setActiveSlideId(next?.id ?? '');
      setSelectedIds([]);
    }
  }, [activeSlide, document, execute]);

  const deleteSelection = useCallback(async (): Promise<void> => {
    if (activeSlide === undefined || selectedIds.length === 0) return;
    if (
      await execute('Delete objects', [
        { type: 'element.delete', slideId: activeSlide.id, elementIds: selectedIds },
      ])
    )
      setSelectedIds([]);
  }, [activeSlide, execute, selectedIds]);

  const duplicateSelection = useCallback(async (): Promise<void> => {
    if (activeSlide === undefined || selectedElements.length === 0) return;
    const copies = duplicateElements(selectedElements);
    const commands = copies.map((element): DocumentCommand => ({
      type: 'element.insert',
      slideId: activeSlide.id,
      element,
    }));
    await execute('Duplicate objects', commands, { select: copies.map((element) => element.id) });
  }, [activeSlide, execute, selectedElements]);

  const transform = useCallback(
    (frames: readonly { readonly elementId: string; readonly frame: Frame }[]): void => {
      if (activeSlide === undefined || frames.length === 0) return;
      void execute('Move or resize objects', [
        { type: 'element.transform', slideId: activeSlide.id, transforms: frames },
      ]);
    },
    [activeSlide, execute],
  );

  const align = useCallback(
    (mode: 'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-middle' | 'bottom'): void => {
      if (activeSlide === undefined || selectedIds.length < 2) return;
      void execute('Align objects', [
        {
          type: 'element.align',
          slideId: activeSlide.id,
          elementIds: selectedIds,
          mode,
          relativeTo: 'selection',
        },
      ]);
    },
    [activeSlide, execute, selectedIds],
  );

  const distribute = useCallback(
    (axis: 'horizontal' | 'vertical'): void => {
      if (activeSlide === undefined || selectedIds.length < 3) return;
      void execute('Distribute objects', [
        {
          type: 'element.distribute',
          slideId: activeSlide.id,
          elementIds: selectedIds,
          axis,
          relativeTo: 'selection',
        },
      ]);
    },
    [activeSlide, execute, selectedIds],
  );

  const groupSelection = useCallback(async (): Promise<void> => {
    if (activeSlide === undefined || selectedIds.length < 2) return;
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
  }, [activeSlide, execute, selectedIds]);

  const ungroupSelection = useCallback(async (): Promise<void> => {
    if (activeSlide === undefined || primaryElement?.type !== 'group') return;
    const children = primaryElement.children.map((child) => child.id);
    await execute(
      'Ungroup objects',
      [{ type: 'element.ungroup', slideId: activeSlide.id, groupId: primaryElement.id }],
      { select: children },
    );
  }, [activeSlide, execute, primaryElement]);

  const reorder = useCallback(
    (to: 'front' | 'back'): void => {
      if (activeSlide === undefined || primaryElement === undefined) return;
      const toIndex = to === 'front' ? activeSlide.elements.length - 1 : 0;
      void execute(to === 'front' ? 'Bring to front' : 'Send to back', [
        { type: 'element.reorder', slideId: activeSlide.id, elementId: primaryElement.id, toIndex },
      ]);
    },
    [activeSlide, execute, primaryElement],
  );

  const patchElement = useCallback(
    (replacement: Element, label = 'Update object'): void => {
      if (activeSlide === undefined) return;
      void execute(label, [
        { type: 'element.update', slideId: activeSlide.id, elementId: replacement.id, replacement },
      ]);
    },
    [activeSlide, execute],
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

  const applyTextDraft = useCallback(async (): Promise<void> => {
    if (
      activeSlide === undefined ||
      primaryText === undefined ||
      textDraft === null ||
      document === undefined
    )
      return;
    if (
      textDraftConflict &&
      !window.confirm(
        'This text changed elsewhere while you were editing. Replace it with your draft?',
      )
    )
      return;
    const baseline = initialTextDraft(primaryText, document);
    const markPatch: MutableTextMarksPatch = {};
    if (textDraft.bold !== baseline.bold) {
      markPatch.bold = textDraft.bold;
      markPatch.fontWeight = textDraft.bold ? 700 : 400;
    }
    if (textDraft.italic !== baseline.italic) markPatch.italic = textDraft.italic;
    if (textDraft.underline !== baseline.underline) markPatch.underline = textDraft.underline;
    if (textDraft.strikethrough !== baseline.strikethrough)
      markPatch.strikethrough = textDraft.strikethrough;
    if (textDraft.color !== baseline.color) markPatch.color = textDraft.color;
    if (textDraft.fontFamily !== baseline.fontFamily) markPatch.fontFamily = textDraft.fontFamily;
    if (textDraft.fontSizePt !== baseline.fontSizePt) markPatch.fontSizePt = textDraft.fontSizePt;
    const marksChanged = Object.keys(markPatch).length > 0;
    const alignmentChanged = textDraft.alignment !== baseline.alignment;
    const kindChanged = textDraft.kind !== baseline.kind;
    const listLevelChanged = textDraft.listLevel !== baseline.listLevel;
    const textChanged = textDraft.text !== baseline.text;
    let content = primaryText.content;
    if (kindChanged) {
      const first = firstMarks(primaryText.content);
      content = contentFromPlainText(textDraft.text, {
        kind: textDraft.kind,
        alignment: textDraft.alignment,
        marks: {
          ...first,
          bold: textDraft.bold,
          italic: textDraft.italic,
          underline: textDraft.underline,
          strikethrough: textDraft.strikethrough,
          color: textDraft.color,
          fontFamily: textDraft.fontFamily,
          fontSizePt: textDraft.fontSizePt,
          fontWeight: textDraft.bold ? 700 : 400,
        },
        headingLevel: 1,
      });
    } else if (textChanged || marksChanged || alignmentChanged || listLevelChanged) {
      content = replacePlainTextPreservingStyles(primaryText.content, textDraft.text);
      content = updateRichTextPresentation(content, {
        ...(alignmentChanged ? { alignment: textDraft.alignment } : {}),
        ...(marksChanged ? { marks: markPatch } : {}),
      });
    }
    if (
      (listLevelChanged || kindChanged) &&
      textDraft.kind !== 'paragraph' &&
      textDraft.kind !== 'heading'
    ) {
      content = {
        blocks: content.blocks.map((block) =>
          block.type === 'list'
            ? {
                ...block,
                items: block.items.map((item) => ({ ...item, level: textDraft.listLevel })),
              }
            : block,
        ),
      };
    }

    const styleChanged =
      textDraft.role !== baseline.role ||
      alignmentChanged ||
      textDraft.fontFamily !== baseline.fontFamily ||
      textDraft.fontSizePt !== baseline.fontSizePt ||
      textDraft.bold !== baseline.bold ||
      textDraft.italic !== baseline.italic ||
      textDraft.color !== baseline.color ||
      textDraft.lineHeight !== baseline.lineHeight ||
      textDraft.letterSpacingPt !== baseline.letterSpacingPt;
    const commands: DocumentCommand[] = [];
    if (kindChanged || textChanged || marksChanged || alignmentChanged || listLevelChanged) {
      commands.push({
        type: 'text.replace-content',
        slideId: activeSlide.id,
        textId: primaryText.id,
        content,
      });
    }
    if (styleChanged) {
      commands.push({
        type: 'element.update-style',
        slideId: activeSlide.id,
        elementId: primaryText.id,
        patch: {
          kind: 'text',
          styleRole: textDraft.role,
          style: {
            alignment: textDraft.alignment,
            fontFamily: textDraft.fontFamily,
            fontSizePt: textDraft.fontSizePt,
            fontWeight: textDraft.bold ? 700 : 400,
            italic: textDraft.italic,
            color: textDraft.color,
            lineHeight: textDraft.lineHeight,
            letterSpacingPt: textDraft.letterSpacingPt,
          },
        },
      });
    }
    if (commands.length === 0) {
      setTextDraftDirty(false);
      setTextDraftConflict(false);
    } else if (!textApplyInFlightRef.current) {
      textApplyInFlightRef.current = true;
      try {
        if (await execute('Edit text', commands)) {
          setTextDraftDirty(false);
          setTextDraftConflict(false);
        }
      } finally {
        textApplyInFlightRef.current = false;
      }
    }
  }, [activeSlide, document, execute, primaryText, textDraft, textDraftConflict]);

  useEffect(() => {
    if (!textDraftDirty || textDraftConflict || primaryText === undefined) return;
    const timer = window.setTimeout(() => void applyTextDraft(), 800);
    return () => window.clearTimeout(timer);
  }, [applyTextDraft, primaryText, textDraftConflict, textDraftDirty]);

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
                if (status.ok) setShareStatus(status.value);
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
  }, [notify, shareStatus?.mode, showFailure, textLeaseStatus]);

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
        current.snapshot.sessionId !== requested.sessionId ||
        activeSlide?.id !== requested.slideId ||
        primaryText?.id !== requested.elementId)
    ) {
      textEditorFocusedRef.current = false;
      void releaseTextLease(requested);
    }
  }, [activeSlide?.id, primaryText?.id, releaseTextLease, session?.snapshot.sessionId]);

  useEffect(() => {
    if (shareStatus?.mode === 'offline' && textLeaseRequestRef.current !== null) {
      const requested = textLeaseRequestRef.current;
      textEditorFocusedRef.current = false;
      void releaseTextLease(requested);
    }
  }, [releaseTextLease, shareStatus?.mode]);

  const pasteTable = useCallback(async (): Promise<void> => {
    if (activeSlide === undefined || primaryTable === undefined || tableTsv.trim() === '') return;
    if (
      await execute('Paste table data', [
        {
          type: 'table.paste-tsv',
          slideId: activeSlide.id,
          tableId: primaryTable.id,
          startRow: 0,
          startColumn: 0,
          tsv: tableTsv,
        },
      ])
    )
      setTableTsv('');
  }, [activeSlide, execute, primaryTable, tableTsv]);

  const updateImageCrop = useCallback(
    (side: keyof ImageElement['crop'], raw: string): void => {
      if (primaryImage === undefined) return;
      const requested = Number(raw);
      if (!Number.isFinite(requested)) return;
      const opposite =
        side === 'left'
          ? primaryImage.crop.right
          : side === 'right'
            ? primaryImage.crop.left
            : side === 'top'
              ? primaryImage.crop.bottom
              : primaryImage.crop.top;
      patchElement(
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
    ): void => {
      if (activeSlide === undefined) return;
      void execute('Update connector endpoint', [
        {
          type: 'connector.update-endpoint',
          slideId: activeSlide.id,
          connectorId: connector.id,
          endpoint,
          value,
        },
      ]);
    },
    [activeSlide, execute],
  );

  const updateMaster = useCallback(
    (replacement: Master, label = 'Update master'): void => {
      void execute(label, [{ type: 'master.update', masterId: replacement.id, replacement }]);
    },
    [execute],
  );

  const updateLayout = useCallback(
    (replacement: Layout, label = 'Update layout'): void => {
      void execute(label, [{ type: 'layout.update', layoutId: replacement.id, replacement }]);
    },
    [execute],
  );

  const duplicateMaster = useCallback(async (): Promise<void> => {
    if (designMaster === undefined) return;
    const master: Master = {
      ...designMaster,
      id: crypto.randomUUID(),
      name: `${designMaster.name} copy`,
      elements: duplicateElements(designMaster.elements),
      guides: duplicateGuides(designMaster.guides),
    };
    if (await execute('Create master', [{ type: 'master.create', master }]))
      setDesignMasterId(master.id);
  }, [designMaster, execute]);

  const duplicateLayout = useCallback(async (): Promise<void> => {
    if (designLayout === undefined) return;
    const layout: Layout = {
      ...designLayout,
      id: crypto.randomUUID(),
      name: `${designLayout.name} copy`,
      elements: duplicateElements(designLayout.elements),
      guides: duplicateGuides(designLayout.guides),
    };
    if (await execute('Create layout', [{ type: 'layout.create', layout }]))
      setDesignLayoutId(layout.id);
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

  const toggleLock = useCallback((): void => {
    if (activeSlide === undefined || primaryElement === undefined) return;
    void execute(primaryElement.locked ? 'Unlock object' : 'Lock object', [
      {
        type: 'element.set-locked',
        slideId: activeSlide.id,
        elementId: primaryElement.id,
        locked: !primaryElement.locked,
      },
    ]);
  }, [activeSlide, execute, primaryElement]);

  const toggleVisible = useCallback((): void => {
    if (activeSlide === undefined || primaryElement === undefined) return;
    void execute(primaryElement.visible ? 'Hide object' : 'Show object', [
      {
        type: 'element.set-visible',
        slideId: activeSlide.id,
        elementId: primaryElement.id,
        visible: !primaryElement.visible,
      },
    ]);
  }, [activeSlide, execute, primaryElement]);

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
    const current = sessionRef.current;
    if (current === null) return;
    const result = await window.htmllelujah.present({
      sessionId: current.snapshot.sessionId,
      ...(activeSlide === undefined ? {} : { startSlideId: activeSlide.id }),
    });
    if (!result.ok) showFailure(result);
  }, [activeSlide, showFailure]);

  const openMcp = useCallback(async (): Promise<void> => {
    setMcpOpen(true);
    setMcpApproval(null);
    const result = await window.htmllelujah.mcpStatus();
    if (result.ok) setMcpStatus(result.value);
    else showFailure(result);
  }, [showFailure]);

  const createMcpApproval = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
    const result = await window.htmllelujah.mcpCreateApproval({
      sessionId: current.snapshot.sessionId,
      action: mcpApprovalAction,
    });
    if (!result.ok) {
      showFailure(result);
      return;
    }
    setMcpApproval(result.value);
    notify('One-time MCP approval created for two minutes.', 'success');
    const status = await window.htmllelujah.mcpStatus();
    if (status.ok) setMcpStatus(status.value);
  }, [mcpApprovalAction, notify, showFailure]);

  const openShare = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
    setShareOpen(true);
    const result = await window.htmllelujah.collaborationStatus({
      sessionId: current.snapshot.sessionId,
    });
    if (result.ok) setShareStatus(result.value);
    else showFailure(result);
  }, [showFailure]);

  const hostCollaboration = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
    const result = await window.htmllelujah.collaborationHost({
      sessionId: current.snapshot.sessionId,
      displayName,
      enableDiscovery: discovery,
    });
    if (!result.ok) {
      showFailure(result);
      return;
    }
    setShareStatus(result.value);
    const refresh = await window.htmllelujah.initialize();
    if (refresh.ok) acceptSession(refresh.value.session);
    else showFailure(refresh);
  }, [acceptSession, discovery, displayName, showFailure]);

  const joinCollaboration = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
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
    setShareStatus(result.value);
    const refresh = await window.htmllelujah.initialize();
    if (refresh.ok) acceptSession(refresh.value.session);
    else showFailure(refresh);
  }, [acceptSession, displayName, joinCode, joinEndpoint, joinFingerprint, showFailure]);

  const leaveCollaboration = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null) return;
    const result = await window.htmllelujah.collaborationLeave({
      sessionId: current.snapshot.sessionId,
    });
    if (!result.ok) {
      showFailure(result);
      return;
    }
    setShareStatus(result.value);
    const refresh = await window.htmllelujah.initialize();
    if (refresh.ok) acceptSession(refresh.value.session);
    else showFailure(refresh);
    notify('LAN session ended safely.', 'success');
  }, [acceptSession, notify, showFailure]);

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
      } else if (modifier && key === 'g') {
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
      } else if (event.key === 'Escape') setActiveMenu(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    deleteSelection,
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
      if (
        activeMenu !== null &&
        event.target instanceof HTMLElement &&
        event.target.closest('.application-menu') === null
      )
        setActiveMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [activeMenu]);

  if (fatalError !== null) return <LoadingScreen message={fatalError} />;
  if (session === null || document === undefined || activeSlide === undefined)
    return <LoadingScreen message="Opening your local workspace…" />;

  const collaborationTextActive = shareStatus?.mode === 'host' || shareStatus?.mode === 'guest';
  const currentTextLeaseRequest: CollaborationTextLeaseInput | null =
    primaryText === undefined
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
            <MenuButton onClick={closeThen(() => setZoom(100))}>Actual size</MenuButton>
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
            <MenuButton onClick={closeThen(() => void addElement(createShapeElement()))}>
              Shape
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createTableElement()))}>
              Table
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createIconElement()))}>
              Icon
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createFlagElement()))}>
              Flag
            </MenuButton>
            <MenuButton onClick={closeThen(() => void addElement(createConnectorElement()))}>
              Connector
            </MenuButton>
          </>
        ) : null}
        {activeMenu === 'Arrange' ? (
          <>
            <MenuButton disabled={selectedIds.length < 2} onClick={closeThen(groupSelection)}>
              Group <kbd>Ctrl G</kbd>
            </MenuButton>
            <MenuButton
              disabled={primaryElement?.type !== 'group'}
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
            <span className="brand-mark" aria-hidden="true">
              H
            </span>
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
            <button type="button" className="present-button" onClick={() => void present()}>
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
              onClick={() => void addElement(createShapeElement())}
            >
              <Square size={17} />
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
            <EditorButton label="Add icon" onClick={() => void addElement(createIconElement())}>
              <Sparkles size={17} />
            </EditorButton>
            <EditorButton label="Add flag" onClick={() => void addElement(createFlagElement())}>
              <Flag size={17} />
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
                  setActiveSlideId(slide.id);
                  setSelectedIds([]);
                }}
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
          <CanonicalSlideCanvas
            document={document}
            slide={activeSlide}
            assetUrls={session.assetUrls}
            scale={canvasScale}
            gridEnabled={gridEnabled}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onTransform={transform}
            onEditText={(elementId) => {
              setSelectedIds([elementId]);
              setInspectorTab('properties');
              window.setTimeout(() => textAreaRef.current?.focus(), 0);
            }}
          />
          <div className="canvas-caption">
            <button type="button" onClick={renameSlide}>
              {activeSlide.name}
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
              onClick={() => setInspectorTab('properties')}
            >
              <SlidersHorizontal size={14} /> Properties
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'design'}
              className={inspectorTab === 'design' ? 'is-active' : ''}
              onClick={() => setInspectorTab('design')}
            >
              <Palette size={14} /> Design
            </button>
          </div>
          {inspectorTab === 'design' ? (
            <div className="inspector-scroll" role="tabpanel">
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Theme</h3>
                  <span className="section-status">{document.themes[0]?.name}</span>
                </div>
                {document.themes[0] !== undefined ? (
                  <div className="theme-card">
                    <div className="theme-swatch-row">
                      {Object.values(document.themes[0].colors).map((color, index) => (
                        <span
                          key={`${color}-${index}`}
                          className="theme-color-dot"
                          style={{ background: color }}
                        />
                      ))}
                    </div>
                    <strong>{document.themes[0].name}</strong>
                    <span>
                      {document.themes[0].headingFontFamily} · {document.themes[0].bodyFontFamily}
                    </span>
                    <label className="color-field">
                      Accent{' '}
                      <input
                        type="color"
                        value={document.themes[0].colors.accent}
                        onChange={(event) => {
                          const theme = document.themes[0];
                          if (theme === undefined) return;
                          void execute('Update theme accent', [
                            {
                              type: 'theme.update',
                              themeId: theme.id,
                              replacement: {
                                ...theme,
                                colors: { ...theme.colors, accent: event.currentTarget.value },
                              },
                            },
                          ]);
                        }}
                      />
                    </label>
                    <label className="color-field">
                      Background{' '}
                      <input
                        type="color"
                        value={document.themes[0].colors.background}
                        onChange={(event) => {
                          const theme = document.themes[0];
                          if (theme === undefined) return;
                          void execute('Update theme background', [
                            {
                              type: 'theme.update',
                              themeId: theme.id,
                              replacement: {
                                ...theme,
                                colors: { ...theme.colors, background: event.currentTarget.value },
                              },
                            },
                          ]);
                        }}
                      />
                    </label>
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
                      setDesignLayoutId(layoutId);
                      if (layout !== undefined) setDesignMasterId(layout.masterId);
                      void execute('Change slide layout', [
                        {
                          type: 'slide.set-layout',
                          slideId: activeSlide.id,
                          layoutId,
                        },
                      ]);
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
                    const placeholders =
                      document.layouts
                        .find((layout) => layout.id === activeSlide.layoutId)
                        ?.elements.filter((element) => element.type === 'placeholder') ?? [];
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
                      const layout = document.layouts.find(
                        (candidate) => candidate.id === event.currentTarget.value,
                      );
                      setDesignLayoutId(event.currentTarget.value);
                      if (layout !== undefined) setDesignMasterId(layout.masterId);
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
                          const name = event.currentTarget.value.trim();
                          if (name !== '' && name !== designLayout.name)
                            updateLayout({ ...designLayout, name }, 'Rename layout');
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
                              onBlur={(event) => {
                                const prompt = event.currentTarget.value;
                                if (prompt === placeholder.prompt) return;
                                updateLayout(
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
                                  onBlur={(event) => {
                                    const value = Number(event.currentTarget.value);
                                    if (!Number.isFinite(value)) return;
                                    const maximum =
                                      property === 'xPt' || property === 'widthPt'
                                        ? document.page.widthPt
                                        : document.page.heightPt;
                                    const minimum =
                                      property === 'widthPt' || property === 'heightPt' ? 12 : 0;
                                    const replacement = {
                                      ...placeholder,
                                      frame: {
                                        ...placeholder.frame,
                                        [property]: clamp(value, minimum, maximum),
                                      },
                                    };
                                    updateLayout(
                                      {
                                        ...designLayout,
                                        elements: designLayout.elements.map((element) =>
                                          element.id === placeholder.id ? replacement : element,
                                        ),
                                      },
                                      'Resize layout placeholder',
                                    );
                                  }}
                                />
                              </label>
                            ))}
                          </div>
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
                            const positionPt = Number(event.currentTarget.value);
                            if (!Number.isFinite(positionPt)) return;
                            updateLayout(
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
                    onChange={(event) => setDesignMasterId(event.currentTarget.value)}
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
                          const name = event.currentTarget.value.trim();
                          if (name !== '' && name !== designMaster.name)
                            updateMaster({ ...designMaster, name }, 'Rename master');
                        }}
                      />
                    </label>
                    <label className="stacked-field">
                      <span>Theme</span>
                      <select
                        value={designMaster.themeId}
                        onChange={(event) =>
                          updateMaster(
                            { ...designMaster, themeId: event.currentTarget.value },
                            'Change master theme',
                          )
                        }
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
                      <div className="master-object-row" key={element.id}>
                        <span>
                          <strong>{element.name}</strong>
                          <small>{element.type}</small>
                        </span>
                        <button
                          type="button"
                          title="Delete master object"
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
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => {
                        const footer = {
                          ...createTextElement('caption', document.name),
                          name: 'Master footer',
                          frame: {
                            xPt: 72,
                            yPt: document.page.heightPt - 36,
                            widthPt: document.page.widthPt - 144,
                            heightPt: 20,
                            rotationDeg: 0,
                          },
                        };
                        updateMaster(
                          {
                            ...designMaster,
                            elements: [...designMaster.elements, footer],
                          },
                          'Add master footer',
                        );
                      }}
                    >
                      <Plus size={13} /> Add presentation footer
                    </button>
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
                            const positionPt = Number(event.currentTarget.value);
                            if (!Number.isFinite(positionPt)) return;
                            updateMaster(
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
                    Object.entries(STANDARD_PAGE_SIZES).find(
                      ([, page]) =>
                        page.widthPt === document.page.widthPt &&
                        page.heightPt === document.page.heightPt,
                    )?.[0] ?? 'custom'
                  }
                  onChange={(event) => {
                    const page =
                      STANDARD_PAGE_SIZES[
                        event.currentTarget.value as keyof typeof STANDARD_PAGE_SIZES
                      ];
                    if (page !== undefined)
                      void execute('Change page format', [{ type: 'deck.set-page', page }]);
                  }}
                >
                  <option value="widescreen">Widescreen 16:9</option>
                  <option value="standard">Standard 4:3</option>
                  <option value="a4Landscape">A4 landscape</option>
                  <option value="custom" disabled>
                    Custom
                  </option>
                </select>
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
                  Hide in presentation and export
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
              {primaryText !== undefined && textDraft !== null ? (
                <section
                  className="inspector-section text-editor-section"
                  onFocusCapture={() => {
                    textEditorFocusedRef.current = true;
                    if (collaborationTextActive) void beginTextLease();
                  }}
                  onBlurCapture={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget)) return;
                    textEditorFocusedRef.current = false;
                    const applied =
                      textDraftDirty && !textDraftConflict ? applyTextDraft() : Promise.resolve();
                    void applied.finally(() => releaseTextLease());
                  }}
                >
                  <div className="section-heading-row">
                    <h3>Text</h3>
                    <span className="section-status" aria-live="polite">
                      {textLeaseLabel}
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
                  <fieldset className="text-editor-controls" disabled={textLeaseBlocked}>
                    {textDraftConflict ? (
                      <div className="draft-conflict" role="alert">
                        <span>The same text changed elsewhere. Your draft has not been lost.</span>
                        <button
                          type="button"
                          onClick={() => {
                            setTextDraft(initialTextDraft(primaryText, document));
                            setTextDraftDirty(false);
                            setTextDraftConflict(false);
                            textBaselineRef.current = {
                              id: primaryText.id,
                              value: textEditingFingerprint(primaryText),
                            };
                          }}
                        >
                          Use latest
                        </button>
                      </div>
                    ) : null}
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
                          })
                        }
                      >
                        <ListOrdered size={14} />
                        <span className="sr-only">Numbered list</span>
                      </button>
                    </div>
                    <textarea
                      ref={textAreaRef}
                      className="text-content-editor"
                      aria-label="Text content"
                      value={textDraft.text}
                      spellCheck
                      onChange={(event) =>
                        editTextDraft({ ...textDraft, text: event.currentTarget.value })
                      }
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                          event.preventDefault();
                          void applyTextDraft();
                        }
                      }}
                    />
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
                      onClick={() => void applyTextDraft()}
                    >
                      Apply text <kbd>Ctrl Enter</kbd>
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
                        if (event.currentTarget.value !== primaryImage.altText)
                          patchElement(
                            { ...primaryImage, altText: event.currentTarget.value },
                            'Edit image description',
                          );
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
                          onBlur={(event) =>
                            updateImageCrop(side, String(Number(event.currentTarget.value) / 100))
                          }
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
                        const opacity = clamp(Number(event.currentTarget.value) / 100, 0, 1);
                        if (Number.isFinite(opacity) && opacity !== primaryImage.opacity)
                          patchElement({ ...primaryImage, opacity }, 'Change image opacity');
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
                        void execute('Change shape fill', [
                          {
                            type: 'element.update-style',
                            slideId: activeSlide.id,
                            elementId: primaryElement.id,
                            patch: { kind: 'shape', fill: event.currentTarget.value },
                          },
                        ])
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
                        void execute('Change shape stroke', [
                          {
                            type: 'element.update-style',
                            slideId: activeSlide.id,
                            elementId: primaryElement.id,
                            patch: {
                              kind: 'shape',
                              stroke: {
                                ...primaryElement.stroke,
                                color: event.currentTarget.value,
                              },
                            },
                          },
                        ])
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
                          const widthPt = clamp(Number(event.currentTarget.value), 0, 24);
                          if (!Number.isFinite(widthPt)) return;
                          patchElement(
                            {
                              ...primaryElement,
                              stroke: { ...primaryElement.stroke, widthPt },
                            },
                            'Change shape stroke width',
                          );
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
                          const cornerRadiusPt = clamp(Number(event.currentTarget.value), 0, 240);
                          if (!Number.isFinite(cornerRadiusPt)) return;
                          patchElement(
                            { ...primaryElement, cornerRadiusPt },
                            'Change corner radius',
                          );
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
                          const widthPt = clamp(Number(event.currentTarget.value), 0, 24);
                          if (!Number.isFinite(widthPt)) return;
                          patchElement(
                            {
                              ...primaryElement,
                              stroke: { ...primaryElement.stroke, widthPt },
                            },
                            'Change connector width',
                          );
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
                            {activeSlide.elements
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
                                  const value = Number(event.currentTarget.value);
                                  if (!Number.isFinite(value)) return;
                                  updateConnectorEndpoint(primaryElement, endpointName, {
                                    ...endpoint,
                                    [axis]: value,
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
                    <h3>{primaryElement.iconSet === 'flags' ? 'Flag' : 'Icon'}</h3>
                    <span className="section-status">Local vector catalog</span>
                  </div>
                  <label className="stacked-field">
                    <span>Catalog</span>
                    <select
                      value={primaryElement.iconSet === 'flags' ? 'flags' : 'htmllelujah-local'}
                      onChange={(event) => {
                        const iconSet = event.currentTarget.value;
                        patchElement(
                          {
                            ...primaryElement,
                            name: iconSet === 'flags' ? 'FR flag' : 'Icon',
                            iconSet,
                            iconName: iconSet === 'flags' ? 'FR' : 'star',
                          },
                          'Change icon catalog',
                        );
                      }}
                    >
                      <option value="htmllelujah-local">Icons</option>
                      <option value="flags">Round flags</option>
                    </select>
                  </label>
                  <label className="stacked-field">
                    <span>{primaryElement.iconSet === 'flags' ? 'Country' : 'Symbol'}</span>
                    <select
                      value={primaryElement.iconName}
                      onChange={(event) => {
                        const iconName = event.currentTarget.value;
                        patchElement(
                          {
                            ...primaryElement,
                            name:
                              primaryElement.iconSet === 'flags'
                                ? `${iconName} flag`
                                : `${iconName} icon`,
                            iconName,
                          },
                          primaryElement.iconSet === 'flags' ? 'Change flag' : 'Change icon',
                        );
                      }}
                    >
                      {(primaryElement.iconSet === 'flags'
                        ? commonCountryCodes
                        : Object.keys(LOCAL_ICON_PATHS)
                      ).map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {primaryElement.iconSet !== 'flags' ? (
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
                              const value = event.currentTarget.value;
                              if (value === contentToPlainText(cell.content)) return;
                              void execute('Edit table cell', [
                                {
                                  type: 'table.update-cell',
                                  slideId: activeSlide.id,
                                  tableId: primaryTable.id,
                                  cellId: cell.id,
                                  content: plainParagraph(value),
                                },
                              ]);
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
                    onChange={(event) => setTableTsv(event.currentTarget.value)}
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
                        void execute('Add table row', [
                          {
                            type: 'table.insert-row',
                            slideId: activeSlide.id,
                            tableId: primaryTable.id,
                            index: primaryTable.rowCount,
                            heightPt: 42,
                            cells,
                          },
                        ]);
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
                        void execute('Add table column', [
                          {
                            type: 'table.insert-column',
                            slideId: activeSlide.id,
                            tableId: primaryTable.id,
                            index: primaryTable.columnCount,
                            widthPt: 120,
                            cells,
                          },
                        ]);
                      }}
                    >
                      <Columns3 size={14} /> Add column
                    </button>
                    <button
                      type="button"
                      disabled={primaryTable.rowCount <= 1}
                      onClick={() =>
                        void execute('Delete table row', [
                          {
                            type: 'table.delete-row',
                            slideId: activeSlide.id,
                            tableId: primaryTable.id,
                            index: primaryTable.rowCount - 1,
                          },
                        ])
                      }
                    >
                      <Trash2 size={14} /> Last row
                    </button>
                    <button
                      type="button"
                      disabled={primaryTable.columnCount <= 1}
                      onClick={() =>
                        void execute('Delete table column', [
                          {
                            type: 'table.delete-column',
                            slideId: activeSlide.id,
                            tableId: primaryTable.id,
                            index: primaryTable.columnCount - 1,
                          },
                        ])
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
                          void execute('Change table border', [
                            {
                              type: 'table.update-style',
                              slideId: activeSlide.id,
                              tableId: primaryTable.id,
                              border: {
                                ...primaryTable.border,
                                color: event.currentTarget.value,
                              },
                            },
                          ])
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
                          const widthPt = clamp(Number(event.currentTarget.value), 0, 24);
                          if (!Number.isFinite(widthPt) || widthPt === primaryTable.border.widthPt)
                            return;
                          void execute('Change table border width', [
                            {
                              type: 'table.update-style',
                              slideId: activeSlide.id,
                              tableId: primaryTable.id,
                              border: { ...primaryTable.border, widthPt },
                            },
                          ]);
                        }}
                      />
                    </label>
                    <label className="color-field">
                      Header fill
                      <input
                        type="color"
                        value={primaryTable.style?.headerFill ?? '#e8ecf7'}
                        onChange={(event) =>
                          void execute('Change table header', [
                            {
                              type: 'table.update-style',
                              slideId: activeSlide.id,
                              tableId: primaryTable.id,
                              style: {
                                ...primaryTable.style,
                                headerFill: event.currentTarget.value,
                              },
                            },
                          ])
                        }
                      />
                    </label>
                    <label className="toggle-row">
                      <input
                        type="checkbox"
                        checked={primaryTable.style?.bandedRows ?? false}
                        onChange={(event) =>
                          void execute('Toggle banded rows', [
                            {
                              type: 'table.update-style',
                              slideId: activeSlide.id,
                              tableId: primaryTable.id,
                              style: {
                                ...primaryTable.style,
                                bandedRows: event.currentTarget.checked,
                              },
                            },
                          ])
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
                            void execute('Change cell fill', [
                              {
                                type: 'table.update-cell',
                                slideId: activeSlide.id,
                                tableId: primaryTable.id,
                                cellId: selectedTableCell.id,
                                style: {
                                  ...selectedTableCell.style,
                                  fill: event.currentTarget.value,
                                },
                              },
                            ])
                          }
                        />
                      </label>
                      <label className="color-field">
                        Text
                        <input
                          type="color"
                          value={selectedTableCell.style.textColor}
                          onChange={(event) =>
                            void execute('Change cell text color', [
                              {
                                type: 'table.update-cell',
                                slideId: activeSlide.id,
                                tableId: primaryTable.id,
                                cellId: selectedTableCell.id,
                                style: {
                                  ...selectedTableCell.style,
                                  textColor: event.currentTarget.value,
                                },
                              },
                            ])
                          }
                        />
                      </label>
                      <label className="stacked-field">
                        <span>Horizontal</span>
                        <select
                          value={selectedTableCell.style.horizontalAlignment}
                          onChange={(event) =>
                            void execute('Align cell text', [
                              {
                                type: 'table.update-cell',
                                slideId: activeSlide.id,
                                tableId: primaryTable.id,
                                cellId: selectedTableCell.id,
                                style: {
                                  ...selectedTableCell.style,
                                  horizontalAlignment: event.currentTarget.value as TextAlignment,
                                },
                              },
                            ])
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
                            void execute('Align cell vertically', [
                              {
                                type: 'table.update-cell',
                                slideId: activeSlide.id,
                                tableId: primaryTable.id,
                                cellId: selectedTableCell.id,
                                style: {
                                  ...selectedTableCell.style,
                                  verticalAlignment: event.currentTarget.value as
                                    'top' | 'middle' | 'bottom',
                                },
                              },
                            ])
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
                          void execute('Clear cell fill', [
                            {
                              type: 'table.update-cell',
                              slideId: activeSlide.id,
                              tableId: primaryTable.id,
                              cellId: selectedTableCell.id,
                              style: { ...selectedTableCell.style, fill: null },
                            },
                          ])
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
                    disabled={selectedIds.length < 2}
                    onClick={() => void groupSelection()}
                  >
                    <Group size={15} /> Group
                  </button>
                  <button
                    type="button"
                    disabled={primaryElement?.type !== 'group'}
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
            onClick={() => setZoom((value) => clamp(value - 10, 25, 160))}
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            min="25"
            max="160"
            step="5"
            value={zoom}
            aria-label="Zoom percentage"
            onChange={(event) => setZoom(Number(event.currentTarget.value))}
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((value) => clamp(value + 10, 25, 160))}
          >
            <ZoomIn size={14} />
          </button>
          <button type="button" className="zoom-value" onClick={() => setZoom(100)}>
            {zoom}%
          </button>
          <button type="button" aria-label="Fit slide" onClick={() => setZoom(100)}>
            <Minus size={14} />
          </button>
        </div>
      </footer>

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
              The local MCP process can inspect this open deck and propose typed edits. It cannot
              read arbitrary files, execute HTML, or export without a one-time approval.
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
              <span>Codex MCP command</span>
              <code>HTMLlelujah-MCP.cmd</code>
              <small>Keep the desktop app open while the MCP process is connected.</small>
            </div>
            <div className="mcp-approval-grid">
              <label className="stacked-field">
                <span>Approve one action</span>
                <select
                  value={mcpApprovalAction}
                  onChange={(event) =>
                    setMcpApprovalAction(event.currentTarget.value as McpApprovalAction)
                  }
                >
                  <option value="commit-destructive">Delete or change page format</option>
                  <option value="undo">Undo the latest agent transaction</option>
                  <option value="import">Choose and import one image</option>
                  <option value="export-html">Export one standalone HTML</option>
                  <option value="export-pdf">Export one PDF</option>
                </select>
              </label>
              <button
                type="button"
                className="primary-inspector-action"
                disabled={!mcpStatus?.available}
                onClick={() => void createMcpApproval()}
              >
                Create one-time approval
              </button>
            </div>
            {mcpApproval !== null ? (
              <div className="session-secret mcp-approval-secret">
                <span>
                  Approval capability · expires{' '}
                  {new Date(mcpApproval.expiresAt).toLocaleTimeString()}
                </span>
                <code>{mcpApproval.approvalId}</code>
                <small>Give this value only to the current local MCP request. It works once.</small>
              </div>
            ) : null}
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
            <label className="stacked-field">
              <span>Your name</span>
              <input
                value={displayName}
                maxLength={80}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
            <div className="share-columns">
              <div>
                <h3>Host</h3>
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
                  disabled={shareStatus?.mode !== 'offline'}
                  onClick={() => void hostCollaboration()}
                >
                  Start LAN session
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
                    placeholder="wss://192.168.1.20:…"
                    onChange={(event) => setJoinEndpoint(event.currentTarget.value)}
                  />
                </label>
                <label className="stacked-field">
                  <span>Session code</span>
                  <input
                    value={joinCode}
                    onChange={(event) => setJoinCode(event.currentTarget.value)}
                  />
                </label>
                <label className="stacked-field">
                  <span>Fingerprint</span>
                  <input
                    value={joinFingerprint}
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
                    !joinFingerprint
                  }
                  onClick={() => void joinCollaboration()}
                >
                  Join session
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
