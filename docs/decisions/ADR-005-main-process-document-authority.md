# ADR-005: Keep Document Authority in the Desktop Main Process

- Status: Accepted
- Date: 2026-07-15

## Context

The desktop renderer is an untrusted, reloadable UI process. Human interaction, local
MCP tools, imports, recovery, presentation, export, and LAN peers must nevertheless
observe and mutate one document revision and one undo history. Keeping authoritative
state in React would couple persistence to a window, require privileged file access in
the renderer, and invite separate mutation paths for agents and collaborators.

## Decision

The Electron main process owns a `DocumentSessionManager`. Each open document session
owns its canonical document adapter, opaque revision, actor-aware history, durability
state, recovery journal, asset store, file fingerprint, approvals, and collaboration
role.

Sandboxed renderers receive immutable snapshots and content-free change events through
a versioned runtime-validated preload bridge. They retain only ephemeral UI state such
as selection, zoom, scroll, caret, inspector view, pointer previews, and uncommitted
text composition. A completed user action is submitted as one revision-checked typed
command batch.

The MCP process, recovery engine, imports, and LAN transport submit the same command
contract to the same session. No caller receives a generic IPC sender, arbitrary path,
document-store reference, or bypass around validation and history.

## Consequences

- A renderer crash or reload does not destroy authoritative unsaved state.
- Human, MCP, import, recovery, and remote operations share revisions, validation,
  attribution, history, journal, and save behavior.
- Presentation and export can request immutable projections without becoming document
  owners.
- IPC snapshots and events require size limits, schema validation, ordering, teardown,
  and packaged-process integration tests.
- High-frequency gestures remain smooth through local previews and commit once at
  gesture completion.
- Rich text must define a bounded local composition window and flush/cancel behavior
  when an external revision arrives.

## Rejected options

- **Renderer-owned canonical state**: fails process isolation and makes renderer
  lifecycle a data-durability concern.
- **Separate document stores for UI, MCP, and collaboration**: creates ambiguous
  revisions, lost updates, and incompatible undo histories.
- **General-purpose IPC or filesystem bridge**: expands a renderer compromise into
  unrestricted machine access.

## Failure and containment

If the session manager cannot journal or validate a transaction, the transaction is
not published. If a renderer disconnects, its capabilities and subscriptions are
revoked while the main-owned session remains recoverable. If snapshot delivery falls
behind, the renderer fetches the newest complete snapshot rather than replaying an
unbounded event queue.

This decision may be revisited only with a new ADR that preserves one command authority,
crash recovery, process isolation, human/agent parity, and all associated tests.
