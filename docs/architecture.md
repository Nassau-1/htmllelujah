# Architecture

Status: Alpha architecture baseline, 2026-07-15.

## System objective

HTMLlelujah is a Windows-first, local-first presentation editor. Its core design
separates a safe structured authoring model from derived DOM, SVG, HTML, and PDF
views. The same deterministic renderer serves human editing, presentation, export,
testing, and agent previews.

## Current Alpha implementation

The current repository is an architectural foundation, not an integrated authoring
application:

- `apps/desktop` implements the sandboxed desktop boundary and an isolated,
  in-memory interaction prototype over synthetic fixtures. It demonstrates editor
  chrome and selected interactions, but it does not consume `document-core`, persist
  a deck, or provide a shared presentation/export renderer.
- `packages/document-core` implements runtime-validated structured entities,
  deterministic revisions, immutable command transactions, alignment, distribution,
  grouping, snapshot undo, and an in-memory adapter. It does not yet implement
  migrations, `.hdeck` storage, autosave, recovery, or collaborative state.
- Shared rendering, presentation mode, standalone HTML and PDF export, MCP, LAN
  collaboration, installers, and supported binaries remain unimplemented.

The diagram and boundaries below describe the target architecture. Existing
prototypes must be integrated through these boundaries rather than treated as their
completed implementation.

```text
Human input ───────┐
Agent command ─────┼─> typed command bus ─> document core ─> local journal
Remote peer update ┘          │                    │              │
                              │                    ├─> .hdeck snapshot
                              │                    │
                              └─> audit/undo       └─> shared renderer
                                                       ├─> editor canvas
                                                       ├─> thumbnails
                                                       ├─> presentation
                                                       ├─> standalone HTML
                                                       └─> PDF
```

## Current and intended repository boundaries

- `apps/desktop` owns desktop lifecycle, windows, trusted operating-system
  capabilities, preload bridges, packaging, and update behavior. The current shell
  implements only a subset of this boundary.
- `packages/document-core` owns schema versions, commands, transactions, revision
  tokens, undo origins, migrations, and persistence contracts. Its current
  foundation implements the schema, command, revision, undo, and adapter portions;
  migrations and persistence behavior remain planned.
- `packages/renderer` owns the pure DOM/SVG projection and render-ready signaling.
- `packages/geometry` owns selection bounds, transforms, snapping, alignment, and
  distribution math independently of UI interaction libraries.
- `packages/export` owns print surfaces, standalone HTML packaging, and fidelity
  checks.
- `packages/mcp` owns the local agent protocol and maps validated requests to the
  command bus.
- `packages/collaboration` owns peer discovery, authentication, awareness, and
  transport; it never owns document semantics or file snapshots.

Packages other than `document-core` are planned and appear as their corresponding
feature specs are implemented. Once integrated, `document-core` remains authoritative
even when a derived surface is easier to inspect.

## Desktop trust boundary

The desktop application has three privilege levels:

1. **Main process:** owns windows, approved file dialogs, atomic writes, printing,
   packaging integration, and network-session lifecycle.
2. **Preload bridge:** exposes a small versioned API. Every request and response is
   runtime validated. It exposes no general IPC sender, shell, or filesystem API.
3. **Renderer:** sandboxed, context-isolated, and unable to use Node.js. It renders
   only normalized application data and sanitized imported content.

External navigation, unapproved popups, permission prompts, and remote content are
blocked. Content Security Policy permits bundled application resources only.

## Target canonical document

The planned `.hdeck` authoring file is a ZIP container with a versioned manifest,
serialized collaborative document state, content-addressed assets, optional embedded
fonts, previews, and required asset notices.

Core entities are `Deck`, `Theme`, `Master`, `Layout`, `Slide`, `Element`, and
`AssetRef`. Elements are a closed discriminated union: text, image, table, shape,
connector, icon, group, and placeholder. Stable UUIDs identify all mutable entities.

Geometry uses points in the canonical model. Common page presets are 960 x 540 for
16:9 and 720 x 540 for 4:3. The renderer scales the complete slide as one coordinate
space rather than recalculating individual positions at each zoom level.

Style resolution is explicit and deterministic:

```text
theme -> master -> layout -> slide -> local element override
```

The document does not carry executable scripts, unrestricted CSS, active remote
URLs, or arbitrary HTML. Markdown and rich-text clipboard input are parsed into
typed structures before entering a transaction.

## Target command, revision, and undo model

The current document-core foundation already enforces immutable typed commands,
metadata, expected revisions, atomic batches, validation, and snapshot undo. The
integrated target extends that boundary to every persistent human, agent, import,
and remote change.

Human, agent, import, and remote operations have distinct origins. Undo is scoped so
one agent batch or one completed drag becomes one understandable history step.
Intermediate drag presence stays ephemeral and only the final transform is committed.

The public revision token is derived from the collaborative state vector. Assets are
stored outside the collaborative structure by content hash and are synchronized by a
separate bounded transfer protocol.

## Target rendering

Text, images, and tables render as semantic DOM. Shapes, connectors, guides, and
icons render as inline SVG. An interaction overlay contains selection handles and
live guides; it is excluded from presentation and export.

One renderer contract receives a read-only slide projection plus an explicit render
mode. It emits a `renderReady` signal only after fonts, decoded images, and layout
have settled. Editor, presentation, thumbnails, HTML output, and PDF call this same
contract with different chrome and scale settings.

The first feature spec validates this boundary with fixture data. The current
desktop prototype is a separate interaction experiment and does not yet satisfy the
shared-renderer acceptance criteria.

## Planned persistence and recovery

Committed transactions enter a local append journal immediately. After a short idle
period, the designated writer creates a complete snapshot in the same directory and
atomically replaces the target `.hdeck`. A snapshot is never overwritten in place.

Migration first preserves the original in the recovery area. Newer unsupported
schema versions open read-only. Archive extraction rejects unsafe paths, unexpected
entry types, excessive entry counts, and expanded sizes above configured limits.

## Planned collaboration

Each participant runs the desktop application. A file may live in a synchronized
folder, but the folder-sync service is not the real-time transport.

The first local participant becomes the snapshot writer and advertises an
authenticated session on a private local network. Peers with the same document
capability join the collaborative state and persist their own recovery journals,
while only the writer replaces the shared `.hdeck`. A signed expiring sidecar records
writer ownership. Text being directly edited receives a soft lock; independent
objects remain concurrently editable.

If the writer disappears, peers retain updates but do not silently overwrite the
shared file. Recovery or writer transfer requires an explicit verified transition.
The transport implements a provider interface so a future relay does not alter the
document format.

## Planned agent boundary

The local MCP server exposes document-level tools, not implementation internals.
Tools list open documents, inspect outlines and slides, render previews, validate,
export, and apply typed command batches. Mutations require a document identifier and
expected revision. Destructive or overwrite operations require explicit approval.

The MCP process cannot evaluate scripts, fetch arbitrary URLs, access arbitrary
paths, or bypass the command bus. It connects to the running app through a
current-user-only local channel with a per-launch nonce.

## Target verification architecture

- Unit and property tests cover schema, command, migration, and geometry invariants.
- Component tests cover renderer modes and interaction-state exclusion.
- Desktop integration tests cover process isolation, IPC validation, file dialogs,
  print readiness, and multi-window lifecycle.
- Golden fixtures compare editor, presentation, standalone HTML, and rasterized PDF.
- Adversarial fixtures cover archives, SVG, rich text, IPC, MCP, and network peers.
- License scanning and SBOM generation gate distributable builds.

See [`operations.md`](operations.md) for commands and release gates, and
[`decisions`](decisions/ADR-001-structured-document-source.md) for the decision
history.
