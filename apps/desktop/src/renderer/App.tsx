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
  type RichTextDocument,
  type Slide,
  type TableElement,
  type TextAlignment,
  type TextElement,
  type TextMarks,
  type TextStyleRole,
} from '@htmllelujah/document-core';
import { SlideSurface } from '@htmllelujah/renderer';
import type { RecoveryCandidate } from '@htmllelujah/document-runtime';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type {
  CollaborationStatus,
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
  createImageElement,
  createShapeElement,
  createSlide,
  createTableElement,
  createTextElement,
  duplicateElements,
  emptyMarks,
  plainParagraph,
} from './editor/canonical-factories';

const menuItems = ['File', 'Edit', 'View', 'Insert', 'Arrange', 'Help'] as const;
type MenuItem = (typeof menuItems)[number];
type InspectorTab = 'properties' | 'design';
type Toast = { readonly kind: 'success' | 'error' | 'info'; readonly message: string };

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
  if (session === null || active === undefined)
    return <LoadingScreen message="Preparing presentation…" />;
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
  const width = 174;
  const scale = width / (document.page.widthPt * (4 / 3));
  const height = document.page.heightPt * (4 / 3) * scale;
  return (
    <button
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
  const [tableTsv, setTableTsv] = useState('');
  const workspaceRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

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
  const primaryTable = primaryElement?.type === 'table' ? primaryElement : undefined;
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
      return;
    }
    setTextDraft(initialTextDraft(primaryText, document));
  }, [document?.id, primaryText?.id, session?.snapshot.revision]);

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

  const execute = useCallback(
    async (
      label: string,
      commands: readonly DocumentCommand[],
      options: { readonly select?: readonly string[]; readonly message?: string } = {},
    ): Promise<boolean> => {
      const current = sessionRef.current;
      if (current === null || commands.length === 0 || busy) return false;
      setBusy(true);
      try {
        const result = await window.htmllelujah.execute({
          sessionId: current.snapshot.sessionId,
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
        setBusy(false);
      }
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

  const importImage = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    if (current === null || activeSlide === undefined || busy) return;
    setBusy(true);
    try {
      const imported = await window.htmllelujah.importImage({
        sessionId: current.snapshot.sessionId,
        expectedRevision: current.snapshot.revision,
      });
      if (!imported.ok) {
        showFailure(imported);
        return;
      }
      acceptSession(imported.value.session);
      const asset = imported.value.session.snapshot.document.assets.find(
        (candidate) => candidate.id === imported.value.assetId,
      );
      const element = createImageElement(imported.value.assetId, asset?.widthPx, asset?.heightPx);
      const inserted = await window.htmllelujah.execute({
        sessionId: imported.value.session.snapshot.sessionId,
        expectedRevision: imported.value.session.snapshot.revision,
        label: 'Insert image',
        commands: [{ type: 'element.insert', slideId: activeSlide.id, element }],
      });
      if (!inserted.ok) {
        showFailure(inserted);
        return;
      }
      acceptSession(inserted.value);
      setSelectedIds([element.id]);
      notify('Image added.', 'success');
    } finally {
      setBusy(false);
    }
  }, [acceptSession, activeSlide, busy, notify, showFailure]);

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
    if (activeSlide === undefined || primaryText === undefined || textDraft === null) return;
    const marks: TextMarks = {
      bold: textDraft.bold,
      italic: textDraft.italic,
      underline: textDraft.underline,
      strikethrough: false,
      fontFamily: textDraft.fontFamily,
      fontSizePt: textDraft.fontSizePt,
      fontWeight: textDraft.bold ? 700 : 400,
    };
    const content = contentFromPlainText(textDraft.text, {
      kind: textDraft.kind,
      alignment: textDraft.alignment,
      marks,
      headingLevel: 1,
    });
    await execute('Edit text', [
      { type: 'text.replace-content', slideId: activeSlide.id, textId: primaryText.id, content },
      {
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
          },
        },
      },
    ]);
  }, [activeSlide, execute, primaryText, textDraft]);

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
                    onChange={(event) =>
                      void execute('Change slide layout', [
                        {
                          type: 'slide.set-layout',
                          slideId: activeSlide.id,
                          layoutId: event.currentTarget.value,
                        },
                      ])
                    }
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
                    for (const placeholder of placeholders)
                      void execute('Reset placeholder', [
                        {
                          type: 'slide.reset-placeholder',
                          slideId: activeSlide.id,
                          placeholderId: placeholder.id,
                        },
                      ]);
                  }}
                >
                  Reset placeholders to layout
                </button>
              </section>
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Slide master</h3>
                  <Layers3 size={14} />
                </div>
                {document.masters.map((master) => (
                  <div key={master.id} className="master-card">
                    <strong>{master.name}</strong>
                    <span>
                      {master.elements.length} fixed object{master.elements.length === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => {
                    const layout = document.layouts.find(
                      (candidate) => candidate.id === activeSlide.layoutId,
                    );
                    const master = document.masters.find(
                      (candidate) => candidate.id === layout?.masterId,
                    );
                    if (master === undefined) return;
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
                    void execute('Add master footer', [
                      {
                        type: 'master.update',
                        masterId: master.id,
                        replacement: { ...master, elements: [...master.elements, footer] },
                      },
                    ]);
                  }}
                >
                  Add presentation footer to master
                </button>
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
                <section className="inspector-section text-editor-section">
                  <div className="section-heading-row">
                    <h3>Text</h3>
                    <span className="section-status">Double-click to focus</span>
                  </div>
                  <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
                    <button
                      type="button"
                      className={textDraft.bold ? 'is-active' : ''}
                      aria-pressed={textDraft.bold}
                      onClick={() => setTextDraft({ ...textDraft, bold: !textDraft.bold })}
                    >
                      <Bold size={14} />
                      <span className="sr-only">Bold</span>
                    </button>
                    <button
                      type="button"
                      className={textDraft.italic ? 'is-active' : ''}
                      aria-pressed={textDraft.italic}
                      onClick={() => setTextDraft({ ...textDraft, italic: !textDraft.italic })}
                    >
                      <Italic size={14} />
                      <span className="sr-only">Italic</span>
                    </button>
                    <button
                      type="button"
                      className={textDraft.underline ? 'is-active' : ''}
                      aria-pressed={textDraft.underline}
                      onClick={() =>
                        setTextDraft({ ...textDraft, underline: !textDraft.underline })
                      }
                    >
                      <Underline size={14} />
                      <span className="sr-only">Underline</span>
                    </button>
                    <button
                      type="button"
                      className={textDraft.kind === 'bullets' ? 'is-active' : ''}
                      aria-pressed={textDraft.kind === 'bullets'}
                      onClick={() =>
                        setTextDraft({
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
                        setTextDraft({
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
                    value={textDraft.text}
                    spellCheck
                    onChange={(event) =>
                      setTextDraft({ ...textDraft, text: event.currentTarget.value })
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
                        setTextDraft({
                          ...textDraft,
                          role: event.currentTarget.value as TextStyleRole,
                          kind: event.currentTarget.value === 'title' ? 'heading' : textDraft.kind,
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
                          setTextDraft({ ...textDraft, fontFamily: event.currentTarget.value })
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
                          setTextDraft({
                            ...textDraft,
                            fontSizePt: clamp(Number(event.currentTarget.value), 6, 240),
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
                        onClick={() => setTextDraft({ ...textDraft, alignment })}
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
                </section>
              ) : null}
              {primaryElement?.type === 'shape' ? (
                <section className="inspector-section">
                  <h3>Shape</h3>
                  <label className="color-field">
                    Fill{' '}
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
                  <label className="color-field">
                    Stroke{' '}
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
                </section>
              ) : null}
              {primaryTable !== undefined ? (
                <section className="inspector-section">
                  <h3>Table</h3>
                  <textarea
                    className="tsv-editor"
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
                  </div>
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
