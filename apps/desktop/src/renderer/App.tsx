import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignStartHorizontal,
  AlignStartVertical,
  BringToFront,
  Check,
  ChevronDown,
  Columns3,
  Copy,
  Grid3X3,
  Hand,
  Image,
  Layers3,
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
  Square,
  Table2,
  Trash2,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { EditorButton } from './components/EditorButton';
import { SlideCanvas } from './components/SlideCanvas';
import { SlidePreview } from './components/SlidePreview';
import {
  createBlankSlide,
  createId,
  createImageElement,
  createShapeElement,
  createTableElement,
  createTextElement,
  initialDeck,
} from './editor/fixture';
import { alignElements, clamp, roundGeometry } from './editor/geometry';
import type { AlignMode, Deck, ElementFill, SlideElement, TextElement } from './editor/model';

const menuItems = ['File', 'Edit', 'View', 'Insert', 'Arrange', 'Help'];
const fillChoices: Array<{ value: ElementFill; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'accent', label: 'Cobalt' },
  { value: 'accent-soft', label: 'Mist' },
  { value: 'ink', label: 'Ink' },
  { value: 'mint', label: 'Mint' },
  { value: 'warm', label: 'Warm' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT')
  );
}

function isNativeButtonTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('button') !== null;
}

export function App() {
  const [deck, setDeck] = useState<Deck>(initialDeck);
  const [activeSlideId, setActiveSlideId] = useState(initialDeck.slides[0]?.id ?? '');
  const [selectedIds, setSelectedIds] = useState<string[]>(['cover-title']);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [fitScale, setFitScale] = useState(0.72);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'properties' | 'design'>('properties');
  const [saved, setSaved] = useState(true);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const activeSlide = useMemo(
    () => deck.slides.find((slide) => slide.id === activeSlideId) ?? deck.slides[0],
    [activeSlideId, deck.slides],
  );

  const selectedElements = useMemo(
    () => activeSlide?.elements.filter((element) => selectedIds.includes(element.id)) ?? [],
    [activeSlide, selectedIds],
  );
  const primaryElement = selectedElements.at(-1);
  const canvasScale = fitScale * (zoom / 100);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const availableWidth = Math.max(entry.contentRect.width - 104, 320);
      const availableHeight = Math.max(entry.contentRect.height - 80, 240);
      setFitScale(Math.min(availableWidth / 960, availableHeight / 540, 1));
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const editable = document.querySelector<HTMLElement>(
      `[data-element-id="${editingId}"] .text-content`,
    );
    editable?.focus();
    const selection = window.getSelection();
    if (!editable || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [editingId]);

  const updateActiveSlide = useCallback(
    (updater: (elements: SlideElement[]) => SlideElement[]) => {
      setDeck((current) => ({
        ...current,
        slides: current.slides.map((slide) =>
          slide.id === activeSlideId ? { ...slide, elements: updater(slide.elements) } : slide,
        ),
      }));
      setSaved(false);
    },
    [activeSlideId],
  );

  const replaceElements = useCallback(
    (elements: SlideElement[]) => updateActiveSlide(() => elements),
    [updateActiveSlide],
  );

  const patchSelection = useCallback(
    (patch: Partial<SlideElement>) => {
      updateActiveSlide((elements) =>
        elements.map((element) =>
          selectedIds.includes(element.id) ? ({ ...element, ...patch } as SlideElement) : element,
        ),
      );
    },
    [selectedIds, updateActiveSlide],
  );

  const updateTextSelection = useCallback(
    (patch: Partial<TextElement>) => {
      updateActiveSlide((elements) =>
        elements.map((element) =>
          selectedIds.includes(element.id) && element.kind === 'text'
            ? ({ ...element, ...patch } as TextElement)
            : element,
        ),
      );
    },
    [selectedIds, updateActiveSlide],
  );

  const addElement = useCallback(
    (element: SlideElement) => {
      updateActiveSlide((elements) => [...elements, element]);
      setSelectedIds([element.id]);
      if (element.kind === 'text') setEditingId(element.id);
    },
    [updateActiveSlide],
  );

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    updateActiveSlide((elements) =>
      elements.filter((element) => !selectedIds.includes(element.id)),
    );
    setSelectedIds([]);
    setEditingId(null);
  }, [selectedIds, updateActiveSlide]);

  const duplicateSelection = useCallback(() => {
    if (selectedIds.length === 0 || !activeSlide) return;
    const copies = activeSlide.elements
      .filter((element) => selectedIds.includes(element.id))
      .map(
        (element) =>
          ({
            ...element,
            id: createId(element.kind),
            x: clamp(element.x + 18, 0, 960 - element.width),
            y: clamp(element.y + 18, 0, 540 - element.height),
          }) as SlideElement,
      );
    updateActiveSlide((elements) => [...elements, ...copies]);
    setSelectedIds(copies.map((element) => element.id));
  }, [activeSlide, selectedIds, updateActiveSlide]);

  const applyAlignment = useCallback(
    (mode: AlignMode) => {
      updateActiveSlide((elements) => alignElements(elements, selectedIds, mode));
    },
    [selectedIds, updateActiveSlide],
  );

  const addSlide = useCallback(() => {
    const slide = createBlankSlide();
    setDeck((current) => ({ ...current, slides: [...current.slides, slide] }));
    setActiveSlideId(slide.id);
    setSelectedIds(slide.elements[0] ? [slide.elements[0].id] : []);
    setSaved(false);
  }, []);

  const openSlide = useCallback((slideId: string) => {
    setActiveSlideId(slideId);
    setSelectedIds([]);
    setEditingId(null);
  }, []);

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      updateActiveSlide((elements) =>
        elements.map((element) =>
          selectedIds.includes(element.id)
            ? {
                ...element,
                x: roundGeometry(clamp(element.x + dx, 0, 960 - element.width)),
                y: roundGeometry(clamp(element.y + dy, 0, 540 - element.height)),
              }
            : element,
        ),
      );
    },
    [selectedIds, updateActiveSlide],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target) || editingId) return;
      if (
        isNativeButtonTarget(event.target) &&
        (event.key === 'Delete' || event.key === 'Backspace' || event.key.startsWith('Arrow'))
      ) {
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length > 0) {
        event.preventDefault();
        deleteSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        setSaved(true);
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      const direction = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[event.key];
      if (direction && selectedIds.length > 0) {
        event.preventDefault();
        nudgeSelection(direction[0] ?? 0, direction[1] ?? 0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelection, duplicateSelection, editingId, nudgeSelection, selectedIds.length]);

  if (!activeSlide) return null;

  const updateGeometry = (property: 'x' | 'y' | 'width' | 'height', rawValue: string) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || !primaryElement) return;
    const limits = {
      x: [0, 960 - primaryElement.width],
      y: [0, 540 - primaryElement.height],
      width: [24, 960 - primaryElement.x],
      height: [24, 540 - primaryElement.y],
    } as const;
    patchSelection({ [property]: clamp(value, limits[property][0], limits[property][1]) });
  };

  const handleInspectorTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextTab: 'properties' | 'design' | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextTab = event.currentTarget.id.endsWith('properties') ? 'design' : 'properties';
    }
    if (event.key === 'Home') nextTab = 'properties';
    if (event.key === 'End') nextTab = 'design';
    if (!nextTab) return;

    event.preventDefault();
    setInspectorTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${nextTab}`)?.focus());
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="title-row">
          <div className="brand-lockup" aria-label="HTMLlelujah home">
            <span className="brand-mark" aria-hidden="true">
              H
            </span>
            <span className="brand-name">HTMLlelujah</span>
          </div>
          <button type="button" className="document-title" title="Rename document">
            <span>{deck.title}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <span className={`save-state ${saved ? 'is-saved' : ''}`} aria-live="polite">
            {saved ? <Check size={13} aria-hidden="true" /> : <span className="save-dot" />}
            {saved ? 'Saved locally' : 'Local changes'}
          </span>
          <div className="title-actions">
            <EditorButton label="Save locally" onClick={() => setSaved(true)}>
              <Save size={16} />
            </EditorButton>
            <button type="button" className="share-button">
              <Share2 size={15} aria-hidden="true" />
              Share
            </button>
            <button type="button" className="present-button">
              <Play size={14} fill="currentColor" aria-hidden="true" />
              Present
            </button>
          </div>
        </div>

        <div className="menu-row">
          <nav aria-label="Application menu" className="application-menu">
            {menuItems.map((item) => (
              <button type="button" key={item}>
                {item}
              </button>
            ))}
          </nav>
          <span className="local-badge">LOCAL FIXTURE</span>
        </div>

        <div className="toolbar" role="toolbar" aria-label="Editing tools">
          <div className="toolbar-group">
            <EditorButton label="Undo" shortcut="Ctrl+Z" disabled>
              <Undo2 size={17} />
            </EditorButton>
            <EditorButton label="Redo" shortcut="Ctrl+Shift+Z" disabled>
              <Redo2 size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group">
            <EditorButton label="Select" active>
              <MousePointer2 size={17} />
            </EditorButton>
            <EditorButton label="Pan">
              <Hand size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group add-tools">
            <EditorButton
              label="Add text"
              text="Text"
              onClick={() => addElement(createTextElement())}
            >
              <Type size={17} />
            </EditorButton>
            <EditorButton
              label="Add shape"
              text="Shape"
              onClick={() => addElement(createShapeElement())}
            >
              <Square size={17} />
            </EditorButton>
            <EditorButton
              label="Add image placeholder"
              text="Image"
              onClick={() => addElement(createImageElement())}
            >
              <Image size={17} />
            </EditorButton>
            <EditorButton
              label="Add table"
              text="Table"
              onClick={() => addElement(createTableElement())}
            >
              <Table2 size={17} />
            </EditorButton>
          </div>
          <div className="toolbar-group">
            <EditorButton
              label="Align left"
              disabled={selectedIds.length < 2}
              onClick={() => applyAlignment('left')}
            >
              <AlignStartVertical size={17} />
            </EditorButton>
            <EditorButton
              label="Align centers"
              disabled={selectedIds.length < 2}
              onClick={() => applyAlignment('center')}
            >
              <AlignCenterVertical size={17} />
            </EditorButton>
            <EditorButton
              label="Align right"
              disabled={selectedIds.length < 2}
              onClick={() => applyAlignment('right')}
            >
              <AlignEndHorizontal size={17} />
            </EditorButton>
            <EditorButton
              label="Distribute horizontally"
              disabled={selectedIds.length < 3}
              onClick={() => applyAlignment('distribute-horizontal')}
            >
              <Columns3 size={17} />
            </EditorButton>
            <EditorButton
              label="Distribute vertically"
              disabled={selectedIds.length < 3}
              onClick={() => applyAlignment('distribute-vertical')}
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
            <EditorButton label="More tools">
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
            <EditorButton label="Add slide" compact onClick={addSlide}>
              <Plus size={16} />
            </EditorButton>
          </div>
          <div className="slide-list">
            {deck.slides.map((slide, index) => (
              <div className="thumbnail-group" key={slide.id}>
                {(index === 0 || slide.section !== deck.slides[index - 1]?.section) && (
                  <span className="section-label">{slide.section}</span>
                )}
                <SlidePreview
                  slide={slide}
                  index={index}
                  selected={slide.id === activeSlide.id}
                  onSelect={() => openSlide(slide.id)}
                />
              </div>
            ))}
          </div>
          <button type="button" className="new-slide-button" onClick={addSlide}>
            <Plus size={15} aria-hidden="true" />
            New slide
          </button>
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
          <SlideCanvas
            elements={activeSlide.elements}
            selectedIds={selectedIds}
            editingId={editingId}
            scale={canvasScale}
            gridEnabled={gridEnabled}
            onSelect={(ids) => {
              setSelectedIds(ids);
              if (!ids.includes(editingId ?? '')) setEditingId(null);
            }}
            onEditStart={setEditingId}
            onEditEnd={(id, value) => {
              updateActiveSlide((elements) =>
                elements.map((element) =>
                  element.id === id && element.kind === 'text'
                    ? { ...element, text: value }
                    : element,
                ),
              );
              setEditingId(null);
            }}
            onElementsChange={replaceElements}
          />
          <div className="canvas-caption" aria-hidden="true">
            <span>{activeSlide.title}</span>
            <span>960 × 540</span>
          </div>
        </section>

        <aside className="inspector" aria-label="Inspector">
          <div className="inspector-tabs" role="tablist" aria-label="Inspector view">
            <button
              id="inspector-tab-properties"
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'properties'}
              aria-controls="inspector-panel-properties"
              tabIndex={inspectorTab === 'properties' ? 0 : -1}
              className={inspectorTab === 'properties' ? 'is-active' : ''}
              onClick={() => setInspectorTab('properties')}
              onKeyDown={handleInspectorTabKeyDown}
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              Properties
            </button>
            <button
              id="inspector-tab-design"
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'design'}
              aria-controls="inspector-panel-design"
              tabIndex={inspectorTab === 'design' ? 0 : -1}
              className={inspectorTab === 'design' ? 'is-active' : ''}
              onClick={() => setInspectorTab('design')}
              onKeyDown={handleInspectorTabKeyDown}
            >
              <Palette size={14} aria-hidden="true" />
              Design
            </button>
          </div>

          {inspectorTab === 'design' ? (
            <div
              id="inspector-panel-design"
              className="inspector-scroll"
              role="tabpanel"
              aria-labelledby="inspector-tab-design"
            >
              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Theme</h3>
                  <span className="section-status">Strategy light</span>
                </div>
                <div className="theme-card">
                  <div className="theme-swatch-row">
                    {fillChoices.slice(1).map((choice) => (
                      <span key={choice.value} className={`theme-swatch fill-${choice.value}`} />
                    ))}
                  </div>
                  <strong>Confident clarity</strong>
                  <span>System sans · Cobalt accent</span>
                </div>
              </section>
              <section className="inspector-section">
                <h3>Slide layout</h3>
                <button type="button" className="layout-choice is-selected" aria-pressed="true">
                  <span className="layout-miniature" />
                  <span>
                    <strong>Title + content</strong>
                    <small>Master layout</small>
                  </span>
                  <Check size={15} aria-hidden="true" />
                </button>
                <button type="button" className="secondary-action">
                  Reset to layout
                </button>
              </section>
            </div>
          ) : (
            <div
              id="inspector-panel-properties"
              className="inspector-scroll"
              role="tabpanel"
              aria-labelledby="inspector-tab-properties"
            >
              <section className="selection-summary">
                <div className={`selection-icon kind-${primaryElement?.kind ?? 'none'}`}>
                  {primaryElement?.kind === 'text' ? (
                    <Type size={17} aria-hidden="true" />
                  ) : (
                    <Square size={17} aria-hidden="true" />
                  )}
                </div>
                <div>
                  <strong>
                    {selectedElements.length === 0
                      ? 'Nothing selected'
                      : selectedElements.length === 1
                        ? `${primaryElement?.kind ?? 'Element'} element`
                        : `${selectedElements.length} elements`}
                  </strong>
                  <span>
                    {selectedElements.length === 0 ? 'Select an object to edit' : 'Slide object'}
                  </span>
                </div>
                <EditorButton label="Lock selection" compact disabled={!primaryElement}>
                  <Lock size={14} />
                </EditorButton>
              </section>

              <section className="inspector-section">
                <h3>Position & size</h3>
                <div className="field-grid">
                  {(['x', 'y', 'width', 'height'] as const).map((property) => (
                    <label key={property}>
                      <span>
                        {property === 'width'
                          ? 'W'
                          : property === 'height'
                            ? 'H'
                            : property.toUpperCase()}
                      </span>
                      <div className="number-input">
                        <input
                          type="number"
                          value={primaryElement ? Math.round(primaryElement[property]) : ''}
                          disabled={!primaryElement}
                          onChange={(event) => updateGeometry(property, event.currentTarget.value)}
                        />
                        <small>pt</small>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="align-grid" role="group" aria-label="Align selected elements">
                  <EditorButton
                    label="Align left"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => applyAlignment('left')}
                  >
                    <AlignStartVertical size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align center"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => applyAlignment('center')}
                  >
                    <AlignCenterVertical size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align right"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => applyAlignment('right')}
                  >
                    <AlignEndHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align top"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => applyAlignment('top')}
                  >
                    <AlignStartHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Align middle"
                    compact
                    disabled={selectedIds.length < 2}
                    onClick={() => applyAlignment('middle')}
                  >
                    <AlignCenterHorizontal size={16} />
                  </EditorButton>
                  <EditorButton
                    label="Distribute horizontally"
                    compact
                    disabled={selectedIds.length < 3}
                    onClick={() => applyAlignment('distribute-horizontal')}
                  >
                    <Columns3 size={16} />
                  </EditorButton>
                </div>
              </section>

              {primaryElement?.kind === 'text' ? (
                <section className="inspector-section">
                  <h3>Typography</h3>
                  <label className="stacked-field">
                    <span>Style</span>
                    <select
                      value={primaryElement.role}
                      onChange={(event) =>
                        updateTextSelection({
                          role: event.currentTarget.value as TextElement['role'],
                        })
                      }
                    >
                      <option value="title">Title</option>
                      <option value="subtitle">Subtitle</option>
                      <option value="body">Body</option>
                      <option value="caption">Caption</option>
                      <option value="metric">Metric</option>
                    </select>
                  </label>
                  <div className="font-controls">
                    <label className="stacked-field font-family">
                      <span>Font</span>
                      <select defaultValue="system">
                        <option value="system">Inter / System</option>
                      </select>
                    </label>
                    <label className="stacked-field font-size">
                      <span>Size</span>
                      <input
                        type="number"
                        min="8"
                        max="160"
                        value={primaryElement.fontSize}
                        onChange={(event) =>
                          updateTextSelection({ fontSize: Number(event.currentTarget.value) })
                        }
                      />
                    </label>
                  </div>
                  <div className="segmented-control" role="group" aria-label="Text alignment">
                    {(['left', 'center', 'right'] as const).map((alignment) => (
                      <button
                        type="button"
                        key={alignment}
                        className={primaryElement.align === alignment ? 'is-active' : ''}
                        aria-pressed={primaryElement.align === alignment}
                        onClick={() => updateTextSelection({ align: alignment })}
                      >
                        {alignment === 'left' ? <AlignStartVertical size={15} /> : null}
                        {alignment === 'center' ? <AlignCenterVertical size={15} /> : null}
                        {alignment === 'right' ? <AlignEndHorizontal size={15} /> : null}
                        <span className="sr-only">Align text {alignment}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              {primaryElement && primaryElement.kind !== 'text' ? (
                <section className="inspector-section">
                  <h3>Fill</h3>
                  <div className="fill-choices">
                    {fillChoices.map((choice) => (
                      <button
                        type="button"
                        key={choice.value}
                        className={primaryElement.fill === choice.value ? 'is-selected' : ''}
                        onClick={() => patchSelection({ fill: choice.value })}
                        aria-label={`Fill: ${choice.label}`}
                        aria-pressed={primaryElement.fill === choice.value}
                        title={choice.label}
                      >
                        <span className={`fill-swatch fill-${choice.value}`} />
                        {primaryElement.fill === choice.value ? <Check size={12} /> : null}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="inspector-section">
                <div className="section-heading-row">
                  <h3>Arrange</h3>
                  <Layers3 size={14} aria-hidden="true" />
                </div>
                <div className="arrange-actions">
                  <button type="button" disabled={!primaryElement}>
                    <BringToFront size={15} aria-hidden="true" />
                    Bring forward
                  </button>
                  <button type="button" disabled={!primaryElement}>
                    <SendToBack size={15} aria-hidden="true" />
                    Send backward
                  </button>
                </div>
                <div className="object-actions">
                  <button type="button" disabled={!primaryElement} onClick={duplicateSelection}>
                    <Copy size={14} aria-hidden="true" />
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="danger-action"
                    disabled={!primaryElement}
                    onClick={deleteSelection}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
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
            Slide {deck.slides.findIndex((slide) => slide.id === activeSlide.id) + 1} of{' '}
            {deck.slides.length}
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
            onClick={() => setGridEnabled((current) => !current)}
          >
            <Grid3X3 size={13} aria-hidden="true" />
            Grid {gridEnabled ? 'on' : 'off'}
          </button>
        </div>
        <div className="zoom-controls" role="group" aria-label="Canvas zoom">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((value) => clamp(value - 10, 25, 160))}
          >
            <ZoomOut size={14} aria-hidden="true" />
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
            <ZoomIn size={14} aria-hidden="true" />
          </button>
          <button type="button" className="zoom-value" onClick={() => setZoom(100)}>
            {zoom}%
          </button>
          <button type="button" aria-label="Fit slide" onClick={() => setZoom(100)}>
            <Minus size={14} aria-hidden="true" />
          </button>
        </div>
      </footer>
    </div>
  );
}
