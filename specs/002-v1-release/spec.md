# Feature Specification: Usable V1 Release

**Feature Branch**: `codex/v1-release`

**Created**: 2026-07-15

**Status**: Approved for implementation

**Input**: Deliver a robust, offline-first Windows presentation editor whose
structured documents can be edited by people, automated through a local MCP server,
presented, exported, recovered after failure, and collaboratively edited by trusted
participants on the same local network.

## Relationship to the platform-fidelity spike

[`../001-platform-fidelity`](../001-platform-fidelity/spec.md) remains open. Its
renderer, presentation, PDF, security, and visual-fidelity evidence is a prerequisite
for the corresponding V1 release gates. Work completed under this specification does
not retroactively satisfy or close unchecked `001` tasks. Where the V1 implementation
extends a fidelity surface, both specifications must be verified.

## Objective

Ship a Windows V1 that a professional user can install and use without an
internet connection to create, open, edit, save, recover, present, and export
structured HTML-based presentations. Preserve a familiar direct-manipulation editor
while making the versioned document and typed command layer the sole authoring source
for human, MCP, import, and LAN-collaboration operations.

## V1 product scope

V1 includes:

- direct selection, multi-selection, drag, resize, rotate, duplicate, delete, group,
  ungroup, lock, visibility, layer ordering, keyboard nudging, grid snap, smart guides,
  alignment, and distribution;
- rich text with paragraphs, headings, ordered and unordered lists, nesting, bold,
  italic, underline, strikethrough, text color, font family, font size, weight,
  alignment, and line spacing;
- versioned themes, slide masters, layouts, placeholders, reusable style roles,
  layout switching, and reset-to-layout behavior that preserves user content;
- embedded PNG, JPEG, and WebP images with crop, fit, alt text, replacement, and
  bounded decoding;
- native editable tables with rows, columns, cells, header styling, fills, borders,
  alignment, and tab-separated clipboard interchange;
- rectangles, rounded rectangles, ellipses, triangles, diamonds, lines, arrows,
  straight and elbow connectors, groups, and a licensed built-in icon catalog based
  on Lucide plus a reviewed round-flag asset catalog;
- one shared DOM/SVG renderer for the editor, thumbnails, presentation, standalone
  HTML, and exact-page PDF;
- versioned `.hdeck` files, atomic save, autosave, migration, read-only handling of
  newer formats, crash recovery, and synchronized-folder conflict detection;
- a local stdio MCP server with typed, revision-aware, attributable document tools;
- authenticated same-LAN collaboration with one authoritative host, object-level
  concurrent editing, same-text soft locks, presence, reconnect, and one snapshot
  writer;
- a Windows 11 x64 installer, `.hdeck` file association, offline runtime,
  diagnostics redaction, checksums, provenance, and repeatable release verification;
  Authenticode signing is applied when a release certificate is supplied.

## Explicit non-goals

- Importing or exporting proprietary presentation-file formats.
- Treating arbitrary HTML, CSS, SVG, JavaScript, or exported HTML as editable source.
- Loading remote images, fonts, scripts, styles, icons, templates, or other document
  assets.
- Merging edits made offline to the same text range.
- Internet relay, hosted collaboration, cloud accounts, or cloud document storage.
- Transitions, animations, speaker notes, comments, or presenter coaching.
- Boolean vector operations, freeform path editing, or a general-purpose drawing app.
- Linked charts, formulas, live spreadsheet links, or embedded executable objects.
- An embedded chatbot, bundled model, hosted inference, or API-based AI service.
- Automatic overwrite of a changed synchronized-folder file or silent host takeover.

## User scenarios and acceptance

### User Story 1 - Create and edit a deck offline (Priority: P1)

A user installs the app, starts it without network access, creates a deck from a
built-in template, edits text and objects directly, uses masters and layouts, saves a
`.hdeck`, closes the app, and reopens the same editable result.

**Independent Test**: On a network-disabled Windows 11 machine, create a twelve-slide
deck containing every V1 element type, save, restart the machine, reopen, and compare
the canonical document, thumbnails, selection geometry, fonts, and visible output.

**Acceptance Scenarios**:

1. Every committed edit passes through the typed transaction layer and produces a
   new revision, attribution metadata, and one understandable undo step.
2. One completed drag, resize, rotation, rich-text edit session, paste, or inspector
   action produces one grouped history entry rather than intermediate pointer events.
3. Slides preserve point geometry at 25%, 50%, 75%, 100%, 125%, 150%, 200%, and Fit.
4. Changing a layout maps compatible placeholders by role, preserves content, and
   keeps unmatched content as local slide elements.
5. Reset to layout removes local frame and style overrides without deleting content.
6. The user can save, close, reopen, and continue editing without network access or a
   missing bundled resource.

### User Story 2 - Author rich content (Priority: P1)

A user formats titles, paragraphs, lists, images, tables, shapes, connectors, icons,
and round flags without editing source code.

**Independent Test**: Build a public-safe content fixture using only UI operations,
copy and paste a tab-separated table, import each accepted image format, bind two
connectors, group objects, and edit the master and layout.

**Acceptance Scenarios**:

1. Mixed text styles survive caret movement, selection changes, undo, save, reopen,
   standalone HTML export, and PDF export.
2. Rich clipboard input is normalized into supported blocks and marks; scripts,
   remote references, arbitrary styles, and unknown nodes are discarded.
3. Pasted TSV creates or fills a rectangular table without formulas or live links.
4. Image bytes are embedded by content hash, validated before use, and never loaded
   from the original path after import.
5. Deleting a connector target leaves a valid unbound endpoint rather than a broken
   document reference.
6. Group and ungroup preserve visual geometry and stacking order within tolerance.

### User Story 3 - Save safely and recover after failure (Priority: P1)

A user expects their work to survive application termination, power loss, a busy
synced folder, or a partially written journal without corrupting the last good deck.

**Independent Test**: Inject failure at every journal and snapshot stage, forcibly
terminate the app during editing and save, then restart and recover the latest valid
state without overwriting a changed source file.

**Acceptance Scenarios**:

1. Committed transactions enter a checksummed local recovery journal before the UI
   reports them as locally durable.
2. Autosave writes a verified temporary sibling and atomically replaces the target;
   it never modifies an archive in place.
3. A truncated journal replays through its final complete valid record and ignores
   only the incomplete tail.
4. If the target fingerprint changed externally, save stops in `conflict` and offers
   Reload, Save Copy, or Cancel.
5. A newer unsupported container or document version is refused with a clear
   compatibility message; the original remains unchanged and can be opened by a
   compatible future version.
6. Recovery with a mismatched document identity or base revision opens as an explicit
   recovered copy.

### User Story 4 - Present and export faithfully (Priority: P1)

A user presents the deck full-screen and exports standalone HTML and PDF whose slide
content matches the editor.

**Independent Test**: Compare editor, presentation, standalone HTML, and rasterized
PDF output across 16:9, 4:3, and A4 landscape fixtures.

**Acceptance Scenarios**:

1. All surfaces call the same renderer and differ only by explicit render mode,
   scale, and editor-overlay inclusion.
2. Presentation letterboxes without reflow and exits via Escape without losing editor
   zoom, scroll, selection, or document state.
3. Standalone HTML contains only bundled deck assets and static application runtime;
   it works offline and has no authoring or filesystem capabilities.
4. PDF waits for fonts, decoded images, and stable geometry, uses declared page boxes,
   includes backgrounds, and leaves no partial file on cancellation or failure.
5. Hidden slides are omitted by default and can be explicitly included.

### User Story 5 - Automate through local MCP (Priority: P1)

A user launches an MCP client locally and asks it to inspect, edit, validate, preview,
and export an open deck without granting arbitrary filesystem or shell access.

**Independent Test**: Start the packaged MCP executable over stdio, initialize the
protocol, list open documents, inspect an outline, apply a revision-checked command
batch, render a preview, validate, and request an approved export.

**Acceptance Scenarios**:

1. MCP communicates over stdio only and writes protocol frames, never logs, to stdout.
2. Mutating calls require a document ID, expected revision, actor identity, and
   transaction label.
3. Stale revisions return a typed conflict and do not partially mutate the document.
4. Destructive, overwrite, import, or export operations require a short-lived user
   approval capability issued by the running desktop app.
5. MCP cannot submit raw HTML, scripts, arbitrary paths, arbitrary URLs, or untyped
   document patches.
6. The user's undo history identifies MCP transactions and can undo them as batches.

### User Story 6 - Collaborate on the same LAN (Priority: P2)

A host opens a `.hdeck`, starts a trusted LAN session, and nearby participants opening
the same document join after confirmation. The host orders commands and is the only
writer of the shared snapshot.

**Independent Test**: Run three packaged instances on two Windows machines, edit
different objects concurrently, contend for the same text element, disconnect and
reconnect one peer, save, close, and reopen the host snapshot.

**Acceptance Scenarios**:

1. LAN discovery advertises no deck text, filename, asset, path, or reusable secret.
2. Joining requires a document-scoped expiring capability and explicit confirmation.
3. The host validates and serializes every command against the current revision, then
   broadcasts accepted transactions in one total order.
4. Independent objects can be edited concurrently; direct text editing uses a soft
   lock with owner presence and expiry.
5. A disconnected peer becomes read-only after its bounded reconnect window. V1 does
   not queue offline text edits for later merge.
6. If the host disappears, peers preserve acknowledged recovery records but do not
   elect a writer or overwrite the shared file silently.
7. Only the host saves the shared `.hdeck`; a peer may explicitly save an independent
   copy after leaving the session.

### User Story 7 - Install and operate a supported Windows build (Priority: P1)

A user downloads a checksummed installer, installs per user, opens `.hdeck` files from
Explorer, receives clear recovery and compatibility messages, and can uninstall
without deleting presentations.

**Independent Test**: Install, launch, associate, repair, upgrade, and uninstall the
release candidate on clean Windows 11 x64 virtual machines with standard and
non-administrator accounts.

**Acceptance Scenarios**:

1. Installation and normal use require no administrator privilege.
2. The binary, installer, and uninstaller have recorded provenance and SHA-256
   checksums. When a configured Authenticode certificate is available, all applicable
   artifacts are signed and timestamped; otherwise the release is labelled unsigned
   and documents the Windows reputation warning without weakening runtime security.
3. File association passes an opaque open request into the existing single app
   instance; malformed requests cannot open arbitrary protocols.
4. Upgrade preserves user decks and recovery data and can be rolled back to the prior
   verified installer when no document migration has been committed.
5. Uninstall preserves `.hdeck` files and offers a separate explicit recovery-cache
   cleanup action.

## Functional requirements

- **FR-001**: `DeckDocument` MUST be the sole mutable authoring source.
- **FR-002**: Every persistent human, MCP, import, recovery, and remote mutation MUST
  use the same validated command and transaction engine.
- **FR-003**: The authoritative document session MUST run outside the sandboxed
  renderer and expose only a versioned validated bridge.
- **FR-004**: Document revisions MUST be opaque, deterministic for the active adapter,
  and required for externally initiated mutations.
- **FR-005**: Undo and redo MUST be actor-aware, origin-aware, grouped by user action,
  bounded by count and memory, and unable to cross an intervening incompatible state.
- **FR-006**: The document schema MUST have independent container and document
  versions, deterministic migrations, safe refusal of newer unsupported versions,
  and complete reference validation. A future preview-only compatibility surface is
  outside V1.
- **FR-007**: `.hdeck` archives MUST enforce entry, name, type, expanded-size,
  compression-ratio, model-depth, text-length, image-dimension, and asset-count limits.
- **FR-008**: Assets MUST be addressed and verified by SHA-256 and served to renderers
  through an opaque session-scoped capability.
- **FR-009**: Theme, master, layout, placeholder, slide, and local-element resolution
  MUST be deterministic and independently testable.
- **FR-010**: Rich text MUST persist typed blocks and marks, never arbitrary HTML.
- **FR-011**: Editor gestures MAY use local previews but MUST commit one validated
  command batch at gesture completion.
- **FR-012**: Geometry MUST use points and preserve group relationships and selected
  object spacing at every zoom.
- **FR-013**: Editor, thumbnails, presentation, HTML, and PDF MUST use one renderer.
- **FR-014**: Presentation and export MUST exclude selection, guides, caret, locks,
  collaborator presence, and other editor-only overlays.
- **FR-015**: Saving MUST use journaled recovery, verified temporary output, atomic
  replacement, external-change detection, and typed durability state.
- **FR-016**: Diagnostics MUST omit deck content, filenames, paths, asset bytes,
  capabilities, network addresses, and serialized state by default.
- **FR-017**: The MCP server MUST use local stdio, bounded message sizes, typed tools,
  revision checks, attributable transactions, and desktop-issued approvals.
- **FR-018**: LAN collaboration MUST use an authenticated encrypted private-network
  channel with one authoritative host and one shared-file writer.
- **FR-019**: Collaboration discovery MUST disclose only an ephemeral service identity
  and document proof that cannot be reused after expiry.
- **FR-020**: V1 MUST NOT merge edits made while disconnected or accept concurrent
  direct editing of the same text element.
- **FR-021**: The application MUST remain fully usable for local authoring,
  presentation, save, recovery, HTML export, and PDF export without internet access.
- **FR-022**: Runtime dependencies, fonts, icons, and flag assets MUST pass license,
  provenance, notice, and SBOM gates before distribution.

## Non-functional requirements

- **NFR-001 Performance**: warm start under 3 seconds; p95 command acknowledgement
  under 100 ms locally; p95 gesture preview under 16.7 ms; p95 LAN accepted-command
  round trip under 250 ms on the reference private network.
- **NFR-002 Capacity**: a supported deck contains up to 500 slides, 10,000 elements,
  2,048 archive entries, 500 MiB expanded archive data, 50 MiB per asset, 20 MiB
  document JSON, group depth 16, and image dimensions up to 100 megapixels.
- **NFR-003 Reliability**: 100 sequential saves and 50 sequential exports leave no
  partial targets, stale hidden windows, orphaned processes, or unrecoverable journal.
- **NFR-004 Accessibility**: editor chrome and critical flows meet WCAG 2.2 AA keyboard,
  focus, name, contrast, reduced-motion, and screen-reader smoke requirements.
- **NFR-005 Security**: renderers stay sandboxed, context-isolated, without Node.js;
  document content cannot navigate, open popups, request permissions, or fetch remote
  resources.
- **NFR-006 Compatibility**: V1 supports Windows 11 x64 and handles 100%, 125%, 150%,
  and 200% display scaling.
- **NFR-007 Public hygiene**: every fixture, screenshot, log sample, and document is
  synthetic, public-safe, and free of private organization or user context.

## Required edge cases

- Empty and whitespace-only text; very long unbroken text; nested lists at the maximum
  level; IME composition; emoji; right-to-left text; mixed line endings.
- Selection of locked, hidden, rotated, grouped, off-page, zero-opacity, and
  connector-bound elements.
- Negative object coordinates, objects larger than the page, mixed-size distribution,
  and multi-selection movement at page edges.
- TSV with trailing cells, quoted newlines, uneven rows, empty cells, and oversized
  dimensions.
- Corrupt, truncated, mislabeled, decompression-bomb, path-traversal, case-collision,
  duplicate-entry, oversized, and future-version archives.
- Mismatched image extension and signature; decode failure; extreme dimensions;
  alpha; color profile; missing asset; duplicate bytes under different filenames.
- Read-only, vanished, renamed, cloud-locked, externally changed, and full-disk save
  targets; application termination at every write stage.
- Presentation on portrait and ultrawide displays; unavailable display; render-ready
  timeout; missing bundled font; hidden slide; no slides eligible to present.
- MCP partial frames, oversized messages, invalid JSON-RPC, unknown tools, stale
  revisions, expired approvals, client termination, and stdout contamination.
- LAN duplicate host, expired join code, clock skew, reconnect expiry, conflicting text
  lock, slow peer, malformed frame, host termination, and public-network detection.
- Installer upgrade with running app, open document, pending recovery, locked files,
  low disk space, invalid signature, and existing file association.

## Success criteria

- **SC-001**: A clean-machine user completes create → edit → save → close → reopen →
  present → HTML export → PDF export without documentation or network access.
- **SC-002**: Every V1 element and formatting feature round-trips through `.hdeck`
  without semantic loss.
- **SC-003**: Fault injection at every journal and save step preserves either the last
  verified snapshot or a discoverable valid recovery candidate.
- **SC-004**: Editor, presentation, HTML, and rasterized PDF meet `001` geometry and
  reviewed visual thresholds.
- **SC-005**: Two peers edit independent objects for thirty minutes with identical
  accepted revision sequences and a host snapshot equal to the final authoritative
  document.
- **SC-006**: All MCP mutations appear as attributable, previewable, undoable document
  transactions and no tool can access an unapproved path or URL.
- **SC-007**: The release gate passes unit, property, component, Electron integration,
  visual, PDF, recovery, archive-adversarial, MCP, LAN, accessibility, packaging,
  license, SBOM, and public-hygiene checks.

## Hard release blockers

V1 MUST NOT ship if any of the following remains:

- an editor action mutates fixture or renderer state outside the command layer;
- a surface uses an independent slide renderer;
- save can overwrite an externally changed file without approval;
- a corrupt or hostile archive crosses configured limits or escapes its logical root;
- a crash can remove both the last verified snapshot and all valid recovery records;
- a renderer, MCP tool, collaborator, or document asset obtains arbitrary filesystem,
  shell, URL, or script capability;
- same-text concurrent editing or disconnected merge occurs without an explicit V1
  rejection path;
- release tests rely only on browser preview rather than the packaged Windows app;
- any shipped dependency or asset lacks an approved license, provenance, notice, or
  SBOM entry;
- `001-platform-fidelity` lacks evidence for renderer, presentation, and PDF gates
  claimed by V1.
