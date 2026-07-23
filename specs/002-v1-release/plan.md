# Implementation Plan: Usable V1 Release

**Branch**: `codex/v1-release` | **Date**: 2026-07-15 | **Spec**: [spec.md](spec.md)

## Summary

Complete the platform-fidelity work, make one main-process document session the
authoritative source for every human, MCP, import, recovery, and LAN operation, and
replace the desktop fixture state without changing the approved editor chrome.
Introduce a bounded `.hdeck` codec, journaled atomic persistence, deterministic
theme/master/layout projection, shared DOM/SVG rendering, presentation and export,
local stdio MCP, authoritative-host LAN collaboration, and a tested Windows
distribution.

V1 deliberately uses no CRDT. The collaboration host serializes validated commands
into one revision order. Peers do not edit while disconnected, and direct editing of
one text element is protected by an expiring soft lock.

## Technical context

- **Language**: strict TypeScript across first-party packages.
- **Desktop**: Electron main, preload, sandboxed renderer, and isolated presentation
  and print windows.
- **UI**: React with the existing approved chrome and CSS token system.
- **Canonical model**: versioned `DeckDocument`, point geometry, stable UUIDs, closed
  element union, typed rich text, and deterministic style resolution.
- **Runtime authority**: main-process `DocumentSessionManager`; renderers hold only
  read-only snapshots and ephemeral interaction state.
- **Persistence**: ZIP-based `.hdeck`, content-addressed assets, SHA-256 integrity,
  local recovery journal, verified temporary output, and atomic replacement.
- **Rendering**: one pure DOM/SVG renderer with editor, thumbnail, presentation,
  standalone HTML, and print modes.
- **MCP**: local child process over stdio with JSON-RPC framing and a current-user-only
  authenticated connection to the running desktop session.
- **Collaboration**: authenticated encrypted private-LAN channel; one authoritative
  host and one shared-file snapshot writer.
- **Packaging**: per-user Windows 11 x64 installer, `.hdeck` association, checksums,
  provenance, and optional Authenticode signing when a certificate is supplied.
- **Testing**: unit, property, component, packaged Electron integration, visual,
  PDF, archive-adversarial, recovery fault injection, MCP protocol, LAN multi-process,
  accessibility, installer, license, SBOM, and public-hygiene suites.

## Constitution check

| Principle                    | Plan evidence                                                          | Result |
| ---------------------------- | ---------------------------------------------------------------------- | ------ |
| Structured source of truth   | Main-owned typed document session; all surfaces are projections        | Pass   |
| Local-first and safe         | Offline core workflows, opaque IPC, bounded archives, no remote assets | Pass   |
| Human and agent parity       | UI, MCP, imports, recovery, and peers share commands and revisions     | Pass   |
| Verifiable fidelity          | One renderer and inherited `001` geometry/visual gates                 | Pass   |
| Public hygiene and licensing | Synthetic fixtures, source-available terms, provenance and SBOM gates  | Pass   |

Re-run the check when a persistent type, IPC method, MCP tool, LAN message, renderer
mode, asset source, dependency, or installer capability changes.

## Relationship to existing work

- `001-platform-fidelity` remains open and owns its still-unmet shared-renderer,
  presentation, PDF, Windows visual, and security evidence.
- The existing desktop workspace is an approved interaction and visual prototype. Its
  fixture model, direct array mutation, and fake saved state are not V1 foundations.
- The existing `document-core` is retained and extended through migrations rather
  than bypassed.
- A V1 checklist may reference a completed `001` task, but this plan does not change
  the status of `001/tasks.md`.

## Target boundaries

```text
apps/desktop/
├── src/main/              lifecycle, session manager, files, assets, export, LAN
├── src/preload/           versioned validated capability bridge
├── src/renderer/          approved chrome, session client, ephemeral interaction UI
└── tests/                 packaged Electron and Windows integration

apps/mcp/
├── src/stdio/             protocol framing, lifecycle, content-free diagnostics
└── src/client/            authenticated current-user desktop connection

packages/document-core/    model v2, commands, migrations, validation, revisions
packages/document-runtime/ sessions, history, durability, journal and adapter ports
packages/geometry/         deterministic point transforms and snapping
packages/renderer/         shared DOM/SVG renderer and readiness
packages/hdeck/            archive contracts, codec, limits and asset integrity
packages/export/           standalone HTML and print projections
packages/collaboration/    discovery, auth, host ordering, locks and presence
packages/mcp-contracts/    tool and resource schemas shared by app and server

tests/fixtures/            synthetic canonical, legacy, hostile and load fixtures
tests/visual/              reviewed editor/presentation/HTML/PDF baselines
tests/recovery/            deterministic filesystem fault harness
tests/lan/                 multi-process and multi-machine collaboration harness
tests/installer/           clean-machine install, upgrade and uninstall automation
```

No package outside `apps/desktop/src/main` receives an arbitrary local path. No
renderer, export page, presentation page, MCP request, or LAN message can execute
document-provided code.

## Architecture

### 1. Main-process authority

The main process owns `DocumentSessionManager`, keyed by opaque session IDs. Each
session owns one document adapter, revision, actor-aware history, journal, durability
state, asset store, file fingerprint, and optional collaboration host/client.

The renderer subscribes through `useSyncExternalStore` to immutable snapshot events.
Selection, active inspector tab, zoom, scroll, caret, pointer gesture, and uncommitted
text-composition state remain local to the renderer. A completed user action becomes
one revision-checked command batch.

The desktop bridge exposes capability-specific methods and subscriptions. Requests
and responses are runtime validated on both sides. File dialogs return opaque handles;
the renderer never round-trips paths.

### 2. Document v2 and projection

Container version and document schema version are independent. Schema v2 adds
bounded content, local text/style overrides, layout-placeholder bindings, and commands
for deck, theme, master, layout, z-order, rich text, table, and asset operations.

The resolver produces a read-only `ResolvedSlide` in this order:

```text
theme tokens
→ master background and fixed elements
→ layout background and fixed elements
→ placeholder-bound slide content with explicit overrides
→ local slide elements
```

Changing layout maps placeholders by compatible role and ordinal. Unmatched content
becomes local. Reset clears overrides but retains content. Projection, not the UI,
implements these rules.

### 3. Interaction cutover without redesign

Before integration, capture approved visual and DOM baselines. Rebuild the public-safe
demo deck in the canonical schema. Introduce a temporary view projection so existing
chrome and interaction wrappers can read canonical data while actions are converted
to commands. Replace content rendering with the shared renderer only after command
cutover. Remove fixture types and the temporary projection after golden parity.

Pointer movement updates a local draft overlay. The core document receives one final
transform transaction at pointer release or keyboard completion. Rich text uses an
isolated editor state during active composition and commits a grouped canonical
content transaction on a bounded idle interval, blur, explicit save, or composition
completion.

### 4. Shared renderer

`ResolvedSlide` is the only content input. Semantic DOM renders text, images, and
tables. Inline SVG renders shapes, icons, flags, connectors, and guides. Interaction
overlays are sibling layers unavailable in presentation, HTML, and PDF modes.

`renderReady` waits for bundled fonts, image decoding, two stable animation frames,
and exact measured page geometry. It has a bounded deadline and content-free warnings.
All modes use the complete-page point transform rather than per-element reflow.

### 5. Assets and content

PNG, JPEG, and WebP are accepted only after signature, media type, byte size, image
dimensions, decode, and SHA-256 checks. Bytes are copied into the session asset store
and later into `.hdeck`; source paths are forgotten after import. The renderer receives
assets through session-scoped opaque URLs or transferable bytes.

V1 rich text persists typed blocks and marks rather than HTML. Clipboard HTML is
parsed in a sandboxed surface and normalized through an allowlist. TSV is parsed as
literal cells; formulas and links have no special execution behavior.

The built-in icon and round-flag catalogs are fixed, locally bundled, and covered by
provenance, license, notice, and asset-hash inventories. A deck stores catalog identity
and version for built-ins or embedded bytes for imported raster images.

### 6. `.hdeck`, journal, and save

The archive contains a manifest, canonical document JSON, content-addressed assets,
optional previews, optional collaboration recovery data, and required notices. The
codec is pathless and operates on bounded byte streams. It validates normalized names,
entry types, counts, expanded sizes, compression ratios, hashes, model depth, and
references before producing a document.

Each accepted transaction is appended to a checksummed length-prefixed journal under
the current user's local application-data recovery area. A partial tail is ignored;
earlier valid records survive. The journal is compacted only after a verified snapshot.

Saving writes a unique temporary sibling, flushes it, reopens and validates it, checks
that the destination fingerprint still matches the opened version, and atomically
replaces the target. Bounded retries cover transient Windows file locks. Failures keep
the last verified target and recovery journal intact.

### 7. MCP over local stdio

The packaged MCP process reads and writes protocol frames over stdio. Logs go only to
stderr and contain no document content. It authenticates to the running desktop app
through a current-user-only local channel using a per-launch nonce inherited through
a protected mechanism.

Read tools list open documents, inspect outlines and selected projections, validate,
and request previews. Mutation tools submit typed command batches with document ID,
expected revision, actor, and label. Import, destructive overwrite, and export require
an expiring desktop approval. No tool accepts raw HTML, script, URL, shell command, or
arbitrary path.

### 8. Authoritative-host LAN collaboration

Starting collaboration turns the current session into the authoritative host. Private
LAN discovery publishes only an ephemeral service identity and document proof.
Joining requires a document-scoped expiring capability and user confirmation.

The host validates commands against the current revision, assigns sequence numbers,
persists accepted records, and broadcasts one ordered transaction stream. Peers keep
read-only canonical snapshots and ephemeral drafts. Independent objects may be edited
concurrently. Direct text editing acquires an expiring soft lock; a conflicting editor
is read-only until release or expiry.

Only the host replaces the shared `.hdeck`. A disconnected peer attempts bounded
reconnect and then becomes read-only. V1 neither elects a new host nor merges queued
offline edits. An explicit `Save Independent Copy` leaves the session and creates a
new document identity.

### 9. Presentation and export

Presentation is a dedicated sandboxed window using the shared renderer and immutable
snapshot. Standalone HTML packages only the static renderer, normalized document
projection, bundled assets, and a restrictive CSP. It exposes no authoring bridge.

PDF uses a hidden trusted print controller and sandboxed render window. Printing waits
for `renderReady`, applies exact page size, writes a temporary sibling, and commits only
after validation and user-approved overwrite behavior.

### 10. Windows packaging

Build a per-user x64 installer and application binaries. Register the
`.hdeck` association and a single-instance open path. The updater is not permitted to
download silently in V1; releases are installed explicitly from a verified package.
Generate SHA-256 checksums and provenance unconditionally. Sign and timestamp artifacts
only when release credentials are configured; an unsigned build remains testable and
usable but is labelled clearly and documents the expected Windows reputation warning.
Upgrade preserves decks and recovery. Uninstall never deletes presentations and
requires a separate confirmation to remove recovery data.

## Contract surfaces

The normative contracts are in [contracts.md](contracts.md). Any implementation
change to those contracts must update the schemas, negative tests, and relevant ADR
before merge.

## Dependency and asset policy

- Prefer platform APIs and existing approved dependencies.
- Pin exact versions in the lockfile.
- Runtime dependencies require an approved permissive license and complete transitive
  scan before merge.
- Fonts require OFL or another explicitly approved license and bundled notices.
- Flag and icon assets require per-source provenance, deterministic hashes, and
  distribution permission.
- No third-party paid, source-available, copyleft, network-hosted, or
  runtime-token-gated dependency or service may become necessary for V1 operation.
- Every release regenerates and reviews its CycloneDX SBOM and third-party notices.

## Risk register and containment

| Risk                                | Mitigation                                                             | Containment / rollback                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| UI regression during integration    | Freeze approved visual/DOM baselines; staged projection cutover        | Feature flag canonical session; retain fixture only on non-release dev path until parity |
| Schema corruption                   | Pure migrations and validation after every step                        | Preserve original; open read-only or recovered copy                                      |
| Save loss on synchronized folders   | Journal, fingerprint, verified temp, atomic replace                    | Stop in conflict; Save Copy / Reload / Cancel                                            |
| Archive or image denial of service  | Pre-allocation limits, stream accounting, decode bounds                | Reject before session creation                                                           |
| Rich-text clobber or duplicate undo | One edit-session grouping contract                                     | Flush or cancel local editor before external mutation                                    |
| Renderer/export drift               | One projection and one renderer                                        | Disable affected export mode; do not fork renderer                                       |
| MCP privilege expansion             | Typed tools, nonce, current-user channel, approval tokens              | Refuse connection and revoke launch nonce                                                |
| Host loss                           | Host journal, peer acknowledged sequence, no silent failover           | Peers read-only; save independent copy                                                   |
| LAN exposure                        | Private-network check, encryption, expiring capability, bounded frames | Stop session on network-class change                                                     |
| Installer regression                | Clean-machine matrix, verified prior installer retained                | Roll back binary if no migration committed; otherwise recover copies                     |
| License issue                       | Pre-merge scan, notices, SBOM, provenance ledger                       | Remove dependency/asset before release                                                   |

## Implementation sequence

1. Ratify contracts and ADRs; complete outstanding `001` prerequisites in parallel.
2. Extend document schema, commands, migrations, validation, history, and projection.
3. Extract geometry and implement the shared renderer with `001` evidence.
4. Implement session authority, desktop bridge, journal, `.hdeck`, assets, and recovery.
5. Cut the approved UI over to canonical sessions and commands.
6. Add rich text, tables, images, shapes, connectors, groups, layers, icons, flags,
   themes, masters, and layouts.
7. Complete presentation, standalone HTML, and PDF with cross-surface fidelity gates.
8. Implement local stdio MCP and its approval flow.
9. Implement authenticated authoritative-host LAN collaboration.
10. Package, sign, install, test on clean Windows machines, and run every release gate.

Detailed ordered work and rollback points are in [tasks.md](tasks.md).

## Verification plan

The normative matrix is [test-matrix.md](test-matrix.md). Minimum merge verification
for affected changes includes:

- unit and property tests for model, migrations, commands, projection, geometry,
  history, framing, locks, and archive limits;
- component tests for rich text, tables, masters, renderer modes, overlay exclusion,
  inspector state, and accessibility;
- packaged Electron tests for IPC, save/recovery, presentation, export, MCP connection,
  collaboration, and process lifecycle;
- reviewed Windows visual and PDF baselines inherited from `001`;
- adversarial archive, image, clipboard, IPC, MCP, and LAN fixtures;
- install, file association, upgrade, rollback, uninstall, offline, and display-scaling
  tests on clean Windows 11 x64 virtual machines;
- dependency license, asset provenance, SBOM, secret, diagnostics-redaction, and public
  fixture review.

## Rollout and rollback

Internal release candidates use synthetic decks only. Pilot builds require explicit
opt-in and always retain a recovery copy before the first schema migration. V1 does
not silently update itself.

Subsystem flags may disable LAN hosting, MCP mutations, standalone HTML, or PDF if a
late non-data defect appears. Local authoring and verified `.hdeck` save must not ship
behind an incomplete fallback. Once a V1 document migration is committed, binary
rollback may open that deck read-only unless the prior version explicitly supports it;
the original pre-migration file remains available in recovery.

## Definition of done

- Every requirement and hard blocker in `spec.md` has objective evidence.
- Every task in `tasks.md` is checked with its verification artifact recorded.
- `001-platform-fidelity` is still honest and all V1-claimed fidelity gates there pass.
- The packaged app, not only source or browser preview, passes the Windows matrix;
  checksum verification is mandatory and signature verification is conditional on a
  configured certificate.
- There is no fixture state, second renderer, unvalidated IPC, arbitrary path, remote
  asset, raw HTML authoring path, or silent collaboration/file takeover.
- Architecture, operations, changelog, roadmap, security, notices, SBOM, and recovery
  guidance describe actual shipped behavior.
