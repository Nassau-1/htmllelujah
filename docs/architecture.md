# Architecture

Status: V1 release-candidate implementation baseline, 2026-07-20.

## System objective

HTMLlelujah is a Windows-first, offline-first presentation editor. A typed structured
document is the only mutable authoring source; DOM, SVG, standalone HTML, and PDF are
derived views. Human input, local MCP tools, recovery, imports, and authenticated LAN
peers all submit validated commands to one main-process authority.

```text
Human gestures ---------+
Local MCP proposals ----+--> typed command engine --> canonical DeckDocument
Recovery replay --------+             |                        |
LAN host commands ------+             +--> audit / undo        +--> recovery journal
                                                               +--> .hdeck snapshot
                                                               +--> shared renderer
                                                                    +--> editor
                                                                    +--> thumbnails
                                                                    +--> presentation
                                                                    +--> HTML export
                                                                    +--> PDF export
```

This architecture is implemented across the current packages. The release test
matrix remains the authority for proving a particular artifact, platform, or
performance claim.

## Repository boundaries

- `apps/desktop` owns Electron lifecycle, windows, the visual editor, validated IPC,
  OS dialogs, PDF printing, file associations, collaboration lifecycle, the desktop
  MCP bridge, and Windows packaging.
- `packages/document-core` owns the versioned model, closed element union, commands,
  immutable transactions, revisions, validation, style inheritance, grouping,
  alignment, distribution, and command-level undo contracts.
- `packages/document-runtime` owns main-process sessions, revision-checked execution,
  durable recovery, proposals, agent audit records, file fingerprints, assets, and
  undo/redo history.
- `packages/hdeck` owns deterministic `.hdeck` encoding, strict archive parsing,
  checksummed journals, external-change detection, and atomic persistence.
- `packages/geometry` owns pure transforms, bounds, snapping, guides, alignment, and
  distribution independently of UI state.
- `packages/renderer` owns the shared DOM/SVG slide projection and render-readiness
  contract used by every visual surface.
- `packages/exporter` owns restrictive standalone HTML, exact page surfaces, and
  atomic HTML output.
- `packages/mcp-server` owns typed local MCP tools, bounded stdio framing, and the
  authenticated local RPC client/server.
- `packages/collaboration` owns private-network discovery, TLS transport,
  authentication, host ordering, replicas, reconnect state, and writer leases. It
  does not own document semantics.

## Desktop process and trust model

The application has three privilege levels:

1. The Electron main process owns each `DocumentSessionManager`, approved file
   dialogs, archive reads and writes, private recovery storage, presentation and print
   windows, collaboration listeners, and the local MCP RPC endpoint.
2. The preload bridge exposes a small versioned capability API. Inputs are runtime
   validated and results use typed safe errors. There is no generic IPC sender,
   filesystem API, shell command, or unrestricted URL loader.
3. Renderer processes are sandboxed and context-isolated, with Node.js integration
   disabled. They hold immutable document snapshots plus ephemeral selection, zoom,
   scroll, pointer preview, inspector, and text-composition state.

A completed gesture, inspector action, edit session, paste, or agent batch commits as
one revision-checked transaction. Renderer preview state cannot become persistent
without a successful command. Navigation, popups, permission requests, and remote
document resources are denied.

## Canonical document and styles

The core entities are `DeckDocument`, `Theme`, `Master`, `Layout`, `Slide`,
`Element`, and `AssetRef`. Stable UUIDs identify mutable entities. Elements are a
closed discriminated union for text, image, table, shape, connector, icon, group, and
placeholder objects. Unknown fields and unknown element types fail validation rather
than becoming executable extension points.

Geometry uses points. The complete page scales as one coordinate space at different
editor zoom levels and presentation viewport sizes. Style resolution is deterministic:

```text
theme -> master -> layout -> slide -> local element override
```

Connector endpoints use final coordinates in their immediate container; the shared
renderer never applies the connector frame rotation a second time. Live bindings are
resolved through nested group transforms, while intentional connector relocation
materializes and releases the affected bindings atomically. The full invariant and
rejected alternatives are recorded in
[`ADR-009`](decisions/ADR-009-canonical-connector-geometry.md).

Rich text is represented as typed blocks, spans, and marks. Tables persist native
rows, columns, cells, and style data. Images reference embedded content-addressed
assets. The model never stores arbitrary HTML, JavaScript, active remote URLs,
unrestricted CSS, or shell instructions.

Validation also enforces the byte size of the complete canonical document before a
transaction commits. Component limits for text, tables, commands, assets, and other
collections remain narrower where their processing cost requires it. This makes one
representability contract apply to editing, recovery, MCP, collaboration, archive
encoding, and export rather than allowing a document that one surface accepts and
another cannot safely process.

Human image import validates a bounded header before pixel decode, verifies decoded
dimensions, then registers the content-addressed bytes and inserts or replaces the
image in one runtime transaction. The document revision, recovery journal, asset
reference, and undo history therefore advance together or not at all.

The runtime derives one opaque validation proof from the private immutable bytes of
each asset. Later transactions, undo, redo, and save preparation can reuse that proof
without rehashing every retained image. Import is content-identity aware: identical
bytes reuse the existing canonical asset identifier and dependent `assetId` fields are
remapped inside the same queued transaction. An identifier alias or a hash match with
different bytes fails before journaling.

## Shared rendering

`packages/renderer` resolves a canonical slide projection and renders semantic text,
images, and tables in the DOM. Shapes, connectors, local icons, guides, and selection
geometry use inline SVG. Editor-only overlays are separate from presentation and
export modes.

Editor canvas, thumbnails, full-screen presentation, standalone HTML, and PDF print
surfaces consume the same renderer contract. Differences are explicit mode, scale,
slide filtering, and overlay inclusion. Export waits for fonts, images, and layout
readiness before printing.

Round flags are Unicode regional-indicator glyphs inside a circular frame, not a
bundled image catalog. Interface icons come from the reviewed Lucide dependency;
slide-content vector paths are local project source. See
[`legal/asset-provenance.md`](legal/asset-provenance.md).

The desktop shell keeps a three-pane editor at a supported minimum width of 1080 CSS
pixels, compacts panel widths and toolbar labels below 1260 pixels, and sizes slide
thumbnails from their observed container. Semantic controls, natural tab order,
visible focus, reduced motion, contained overflow, and Windows scaling are tested at
the Electron boundary; CDP/DOM checks do not substitute for Narrator or NVDA.

## `.hdeck`, persistence, and recovery

A `.hdeck` is a deterministic STORE-only ZIP container. It contains required
`manifest.json` and `document.json` entries plus content-addressed `assets/` entries.
The manifest records independent container and document schema versions, declared
lengths, media types, and SHA-256 hashes.

The decoder rejects unsafe or case-colliding names, absolute paths, traversal,
backslashes, control characters, symlinks, encrypted or streamed entries,
compression, undeclared entries, duplicate entries, invalid UTF-8, inconsistent ZIP
records, bad CRCs, hash mismatches, excessive counts or sizes, and unsupported
versions. Asset media type and document references are validated before exposure to
a renderer.

Every committed edit is appended to a checksummed private recovery journal. The UI
acknowledges local durability only after the journal write completes. Recovery data
lives under the current user's application-data directory and is not the shared file
transport.

Recovery asset blobs are collected by bounded mark-and-sweep passes. The collector
marks assets referenced by current documents, journals, history, staged imports, and
active sessions, and removes only old unreferenced blobs. A persisted base with no
new journal record is not surfaced as a false recovery candidate.

V1 deliberately separates recovery autosave from shared-file replacement: edits are
journaled immediately, while replacing a user-selected `.hdeck` requires explicit
Save. Save writes and validates a temporary sibling, checks the expected file
fingerprint, then atomically replaces the target. An external change produces a
conflict when it is observed before replacement. The application verifies the written
snapshot after replacement, but Node and Windows expose no universal conditional
rename against an arbitrary non-cooperating writer; users must not bypass a reported
conflict. A recovered state opens as an independent candidate and requires explicit
Save or Save As.

Save, Save As, and the complete transition into hosting or joining are serialized in
the owning document session. The session's current target is authoritative; a queued
write or collaboration handoff must still match the exact reserved target at commit
time. A one-link sidecar coordinates cooperating standalone writers. A one-link
mutation-lock file is created exclusively and bound to an open-handle identity plus a
random owner token, serializing sidecar creation, replacement, and deletion across
processes. Persisted replacement never intentionally removes the active pathname,
cleanup compares exact bytes or file identity, and release is retryable. Mutation-lock
recovery is never clock-automatic: it occurs only after explicit expired-writer
confirmation and a full stable-observation window. A mutation lock whose writer
sidecar is missing is treated as the same explicit-recovery condition rather than as
proof that no writer exists.

Archive persistence rechecks both the destination fingerprint and the exact one-link
temporary-file identity after asynchronous commit guards and before replacement. These
controls and their remaining platform limit are recorded in
[`ADR-011`](decisions/ADR-011-bounded-representability-and-save-authority.md).

## LAN collaboration and synchronized folders

V1 uses an authoritative host rather than a CRDT. A synchronized folder carries the
last `.hdeck` snapshot, while a direct encrypted LAN session carries live commands.
The host validates and serializes each command, assigns a total order, journals the
accepted transaction, broadcasts it, and is the only participant allowed to replace
the shared file within that authenticated session.

The writer sidecar is a filesystem lease, not a cloud coordination service. It is
authoritative only when participants observe one coherent namespace (for example an
SMB/NAS share). Separate consumer-synchronization replicas may both create a local
lease before synchronization, so V1 requires one explicitly chosen host and does not
claim to prevent a second independent host on another replica.

Transport uses WSS with an ephemeral session certificate, displayed fingerprint,
document-scoped session credential, HMAC-authenticated frames, bounded messages, and
private-address validation. Hosting requires the user to choose a named private-
network adapter. The listener binds to that exact address and discovery authenticates
the same address in its signed hint, so another adapter advertised by the operating
system cannot silently redirect a guest. If the selected adapter disappears, hosting
requires a new explicit selection. Optional discovery advertises only ephemeral
protocol information, not titles, filenames, paths, slide text, assets, or reusable
secrets.

The listener is bound to one validated private address. Admission, bootstrap,
idempotency, and retained-history budgets are reserved before asynchronous work.
Joining peers receive a lossless authoritative snapshot, and indirect master or layout
changes participate in the same edit-lease rules as direct element changes. The host
rechecks its writer authority at the shared-file commit boundary. Leaving first closes
command admission, drains every already admitted submission, persists the resulting
host snapshot, and only then closes transport and releases writer authority. A failed
join destroys its detached clone before returning control to the standalone session.

Guests maintain a detached local session and recovery record. Independent objects
may be edited concurrently through host ordering. A soft lock prevents concurrent
direct editing of the same text element. Focusing the editor requests the lease;
the text inspector exposes owned, pending, or peer-held state and disables controls
while a peer owns it. V1 does not queue disconnected edits, elect a new writer, or
merge divergent text. If the host becomes unavailable, the guest becomes non-editing
until an explicit rejoin or independent copy flow.

## Local MCP architecture

The installed `HTMLlelujah-MCP.cmd` starts the packaged MCP entrypoint as a console
stdio process. Standard output is reserved for MCP protocol frames; redacted startup
failure text goes to standard error. The process reads the current desktop endpoint
descriptor from `%APPDATA%\HTMLlelujah\mcp\endpoint-v1.json` and connects to a random
local named pipe.

The descriptor contains a random secret, instance identity, PID, and expiry. Client
and server authenticate with fresh nonces and HMAC proofs; nonces cannot be reused.
Frames, rates, authentication time, and service calls are bounded. The descriptor is
atomically created under the current user profile and removed only by its owning
desktop instance.

Only currently visible documents are exposed. Read tools return bounded structured
projections. Mutations use a propose/commit flow with document ID, expected revision,
actor attribution, and transaction label. Destructive commit, undo, import, and
export require a single-use desktop approval bound to action, document, and revision.
MCP edits are paused during a live LAN session in V1; reads and redacted collaboration
status remain available.

The V1 MCP boundary accepts at most 100 commands per proposal and 2 MiB frames/results.
Desktop proposals expire after one minute and are capped at 64; desktop approvals
expire after two minutes and are capped at 32; at most 64 consumed receipts remain
for 30 seconds. Capacity is reserved before asynchronous proposal work so concurrent
requests cannot overrun the limit.

The packaged launcher requires Electron's `RunAsNode` fuse. `NODE_OPTIONS` and CLI
inspection remain disabled, embedded ASAR integrity validation and ASAR-only loading
remain enabled, and the MCP entrypoint exposes only typed RPC-backed tools. Enabling
`RunAsNode` still means a user who already controls the local account can use the
packaged executable as a same-user Node runtime. This grants no elevation, but it is
an explicit V1 tradeoff; a dedicated signed helper should be evaluated for a later
release. ADR-008 records the decision.

## Packaging and distribution

The Windows x64 build is packaged as an ASAR application and a per-user NSIS
installer with `.hdeck` association. Installation and normal use do not require
elevation. User decks and recovery data are not deleted automatically by uninstall.

V1 does not include the packager's optional installed elevation helper: the product
has no automatic updater or per-machine installation path, and NSIS performs its own
installer UAC flow. Reintroducing automatic updates or per-machine installation must
revisit this packaging decision and the executable attestation set.

Release packaging must preserve the project source notice, binary terms,
third-party notices, Electron and Chromium license files, exact artifact checksums,
and the SBOM. Authenticode signing is applied when a certificate is configured;
otherwise the artifact is labelled unsigned without weakening runtime fuses.

## Security invariants

- No document, renderer, MCP request, or collaborator receives an arbitrary path,
  shell, raw HTML, script, active URL, or unrestricted network capability.
- Every persistent mutation is typed, revision-checked, attributable, transactional,
  journaled, and undoable.
- Only one participant writes the shared `.hdeck` during collaboration.
- Archive and network parsers fail closed on unknown or oversized input.
- Diagnostics omit deck content, asset bytes, filenames, paths, capabilities,
  endpoints, secrets, and serialized state by default.
- Packaging and dependency review operate on the exact distributable, not only source
  manifests.

See [`operations.md`](operations.md) for verification and release procedure and
[`decisions`](decisions/ADR-001-structured-document-source.md) for the decision
history.
