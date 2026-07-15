# Feature Specification: Platform Fidelity

**Feature Branch**: `001-platform-fidelity`

**Created**: 2026-07-15

**Status**: Draft

**Input**: Establish the secure Windows desktop shell, approved editor workspace,
shared DOM/SVG slide renderer, presentation surface, and faithful PDF proof before
integrating document editing.

## Objective

Prove that one secure desktop runtime and one renderer can display a fixed structured
slide consistently in the editor, presentation mode, and PDF at exact page geometry.
This spike must remove rendering and process-boundary uncertainty before the document
model and editing tools are integrated into the desktop application.

**Repository-state note**: Parallel isolated foundations now exist in
`packages/document-core` and `apps/desktop`. The former provides a tested structured
command model; the latter provides an in-memory interaction prototype over its own
synthetic fixtures. Neither is part of this feature's acceptance evidence, and this
spec does not authorize persistence, presentation, export, MCP, or collaboration.

## Non-goals

- Persistent document schema, `.hdeck` read/write, migrations, or autosave.
- Object creation, text editing, drag, resize, snapping, alignment, undo, or clipboard.
- Themes, masters, tables, asset management, or font embedding.
- MCP, collaboration, installers, updates, or file associations.
- Standalone HTML packaging beyond the shared render contract.

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Inspect a slide in the editor workspace (Priority: P1)

A user launches the desktop app offline and sees a professional presentation-editor
workspace with a slide list, fixed-ratio slide canvas, contextual toolbar, inspector,
and status bar. The fixture slide stays geometrically stable when the viewport or
zoom changes.

**Why this priority**: Every editing capability depends on a trustworthy coordinate
space and a usable desktop layout.

**Independent Test**: Launch the packaged development app with networking disabled,
load the built-in fidelity fixture, compare the workspace at reference viewport
sizes, and verify the slide's measured aspect ratio and object bounds.

**Acceptance Scenarios**:

1. **Given** a 1440 x 900 application window, **When** the fixture opens, **Then** the
   slide is centered between the thumbnail rail and inspector without horizontal
   application overflow.
2. **Given** the same fixture, **When** zoom changes to 25%, 50%, 100%, 200%, and Fit,
   **Then** all slide objects preserve their canonical bounds relative to the slide.
3. **Given** no network connection, **When** the application starts, **Then** every
   visible icon, font, style, and fixture asset loads from bundled resources.
4. **Given** keyboard navigation, **When** focus moves through editor chrome, **Then**
   the focus location is visible and controls have accessible names.

---

### User Story 2 - Present the same rendered slide (Priority: P2)

A user enters presentation mode and sees the same slide without editor chrome,
selection handles, guides, or layout changes.

**Why this priority**: A shared renderer is valuable only if presentation mode does
not create a second visual implementation.

**Independent Test**: Capture the fixture in canvas-only editor mode and presentation
mode at the same raster dimensions, mask the surrounding background, and compare the
slide pixels and measured object rectangles.

**Acceptance Scenarios**:

1. **Given** the editor fixture, **When** presentation mode opens, **Then** the same
   renderer displays the slide without editor overlays.
2. **Given** a viewport with a different aspect ratio, **When** presentation mode
   scales the slide, **Then** it letterboxes without cropping or object reflow.
3. **Given** Escape or a presentation-window close request, **When** presentation
   mode exits, **Then** the editor remains open at its previous zoom and scroll state.

---

### User Story 3 - Produce a faithful PDF proof (Priority: P3)

A user exports the fidelity fixture to PDF and receives one page at the requested
slide dimensions with backgrounds, fonts, images, and SVG objects present.

**Why this priority**: PDF fidelity is a defining reason for choosing a desktop
runtime with one rendering engine.

**Independent Test**: Export 16:9, 4:3, and A4-landscape fixture variants; inspect
page count and page boxes, rasterize each page, and compare it with a renderer capture
at the same aspect ratio.

**Acceptance Scenarios**:

1. **Given** a 16:9 fixture, **When** export completes, **Then** the PDF has exactly one
   960 x 540 point page with print backgrounds enabled.
2. **Given** 4:3 and A4-landscape fixtures, **When** each exports, **Then** its page box
   matches the declared dimensions and no object is clipped.
3. **Given** delayed font or image readiness, **When** export starts, **Then** printing
   waits for `renderReady` rather than producing a partial page.
4. **Given** a failed or cancelled export, **When** control returns, **Then** no partial
   target file remains and the editor reports a non-sensitive error.

### Edge Cases

- The application window is narrower than 1024 pixels or shorter than 640 pixels.
- Operating-system display scaling is 125%, 150%, or 200%.
- A fixture font is unavailable or fails to load.
- An image decodes slowly or fails validation.
- Presentation mode opens on a display with a portrait or ultrawide aspect ratio.
- The chosen PDF target is read-only, disappears, or already exists.
- The render-ready deadline expires.
- A renderer tries to navigate, create a popup, or request a remote resource.

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST launch as a Windows desktop application whose renderer
  is sandboxed, context-isolated, and has Node.js integration disabled.
- **FR-002**: The preload bridge MUST expose only versioned, runtime-validated methods
  needed for application metadata, presentation-window lifecycle, and PDF export.
- **FR-003**: The renderer MUST deny remote content, navigation, unapproved popups,
  permission requests, and inline or evaluated scripts through both policy and
  application handlers.
- **FR-004**: The editor workspace MUST contain a title/menu row, contextual toolbar,
  left thumbnail rail, centered slide pasteboard, right inspector, and status bar.
- **FR-005**: The visual language MUST use white primary surfaces, a pale cool-gray
  pasteboard, charcoal text, cobalt-blue focus/selection accents, compact typography,
  thin dividers, 6-pixel control radii, restrained shadows, and outline icons.
- **FR-006**: The workspace MUST remain usable at 1024 x 640. Below that threshold,
  the inspector collapses before the slide rail, and no control may overlap the
  slide canvas.
- **FR-007**: The fixture renderer MUST accept a read-only slide projection, page
  dimensions in points, render mode, and scale; it MUST NOT read desktop state or
  mutate source data.
- **FR-008**: Text and images MUST render as DOM elements. Rectangles, lines, arrows,
  icons, and guides MUST render as inline SVG.
- **FR-009**: The fixture suite MUST cover 960 x 540 point 16:9, 720 x 540 point 4:3,
  and 841.89 x 595.28 point A4-landscape pages.
- **FR-010**: Screen zoom MUST support 25%, 50%, 75%, 100%, 125%, 150%, 200%, and Fit.
  Zoom MUST transform the whole page coordinate space and MUST NOT recalculate
  individual object geometry.
- **FR-011**: Editor-only overlays MUST be hosted outside the shared slide content
  root and MUST be absent in presentation and PDF modes.
- **FR-012**: Presentation mode MUST use the shared renderer, preserve aspect ratio,
  letterbox when necessary, and never reflow slide content.
- **FR-013**: The renderer MUST signal `renderReady` only after bundled fonts are
  ready, required images are decoded, two animation frames have completed, and the
  page geometry matches the requested dimensions.
- **FR-014**: PDF export MUST run in a hidden trusted print window using the shared
  renderer, exact CSS page size, print backgrounds, and CSS page-size preference.
- **FR-015**: PDF export MUST write to a temporary sibling file and atomically rename
  it after success; failure or cancellation MUST remove the temporary output.
- **FR-016**: The renderer MUST expose stable `data-testid` hooks for page root,
  fixture objects, presentation root, and render-ready state without encoding layout
  logic into tests.
- **FR-017**: All visible controls MUST be keyboard reachable, have accessible names,
  show visible focus, and meet AA contrast for text and focus indicators.
- **FR-018**: Application and export diagnostics MUST contain error codes and timings
  only; they MUST exclude fixture text, output paths, and rendered image data.

### Key Entities

- **FidelityFixture**: Immutable development-only slide projection containing page
  dimensions, test objects, and expected geometry. It is not the future authoring
  schema.
- **RenderRequest**: Read-only page projection plus render mode, scale, and readiness
  deadline.
- **RenderResult**: Page measurements, resource-readiness status, renderer version,
  warnings, and timing; no rendered content or filesystem path.
- **ExportRequest**: Approved target selected by the trusted process, page preset,
  fixture identifier, and overwrite approval.
- **ExportResult**: Success or typed error, page count, dimensions, and duration.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: The app reaches an interactive workspace within three seconds on the
  reference Windows 11 x64 pilot machine after a warm start.
- **SC-002**: At all required zoom values and 100%, 125%, 150%, and 200% OS scaling,
  every fixture object's measured canonical bounds differ from expected bounds by no
  more than 0.25 points per edge.
- **SC-003**: Editor canvas, presentation, and rasterized PDF comparisons stay within
  a 1.5% differing-pixel threshold at the agreed Windows reference environment,
  excluding only documented anti-aliasing masks.
- **SC-004**: Every PDF fixture has exactly one page and page-box dimensions within
  0.1 points of the declared page size.
- **SC-005**: A network-denied integration test observes zero external requests from
  launch through presentation and PDF export.
- **SC-006**: Automated security tests prove renderer code cannot access Node.js,
  invoke undeclared IPC channels, navigate away, or open an unapproved window.
- **SC-007**: Keyboard-only smoke tests reach every visible workspace control and
  exit presentation mode without pointer input.
- **SC-008**: Twenty consecutive fixture exports leave no partial files, hidden
  windows, or orphaned desktop processes.

## Assumptions

- Alpha validation targets Windows 11 x64 and bundled fonts; cross-platform behavior
  is not established by this feature.
- Fixture content is synthetic and safe to publish.
- The product name replaces any older concept labels in committed screenshots.
- Visual baselines are captured from the implemented product UI on the agreed
  reference machine, then reviewed before being accepted.

## Risks and containment

- **Font and GPU variance**: pin bundled fonts, capture Windows-only baselines, and
  retain geometry assertions separate from pixel comparisons.
- **PDF readiness race**: use a typed readiness protocol with a deadline and fail
  closed rather than printing partial content.
- **Privilege leakage**: keep a minimal preload contract and test undeclared channel,
  navigation, popup, permission, and remote-request denial.
- **Spike becoming a shadow document model**: name fixtures explicitly, keep them
  immutable, and replace them with a specified projection when the existing
  document-core foundation is integrated.
- **Visual baseline misuse**: require human review and an accompanying spec or
  changelog explanation for every accepted baseline update.
