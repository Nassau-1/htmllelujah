# Roadmap and TODO

Status: **Alpha**, last reviewed 2026-07-15.

The feature specifications under `specs/` are authoritative for implementation.
This file is the short cross-feature roadmap, not a substitute for task lists.

## Active: platform fidelity

- [ ] Complete [`specs/001-platform-fidelity/tasks.md`](specs/001-platform-fidelity/tasks.md).
- [ ] Validate the secure desktop-process boundary on Windows 11 x64.
- [ ] Replace the desktop prototype's private fixture model with the specified shared
      renderer contract before treating editor visuals as fidelity evidence.
- [ ] Establish visual baselines for editor, presentation, and PDF surfaces.
- [ ] Record Alpha performance and rendering measurements.

## Parallel Alpha foundations

- [x] Add a tested document schema, validation, revision, transactional command,
      snapshot undo, and in-memory adapter foundation in `packages/document-core`.
- [x] Add an isolated in-memory desktop interaction prototype for selection, text
      editing, drag, resize, snapping, alignment, layers, and basic synthetic objects.
- [ ] Integrate the document core, editor interactions, and shared renderer through a
      specified projection and command boundary.
- [ ] Add persistence, migration, autosave, recovery, and compatibility tests before
      the document foundation is considered feature-complete.

## Targeted beta sequence

- [ ] `002-document-core`: complete the existing foundation with migrations, `.hdeck`,
      autosave, crash recovery, and integration contracts.
- [ ] `003-editor-interactions`: replace the isolated prototype with command-backed
      selection, resize, rotate, zoom, snapping, alignment, grouping, layers,
      keyboard control, and undo.
- [ ] `004-content-and-masters`: rich text, themes, masters, layouts, images, tables,
      shapes, connectors, and icons.
- [ ] `005-presentation-export`: offline presentation mode, standalone HTML output,
      faithful PDF output, and slide-format conversion.
- [ ] `006-mcp-cli`: local CLI, typed MCP tools, previews, revision checks, and audit
      metadata.
- [ ] `007-lan-collaboration`: discovery, authenticated sessions, presence, soft
      locks, writer ownership, reconnect, and recovery.
- [ ] `008-windows-pilot`: signed installer, `.hdeck` association, update policy,
      pilot documentation, and release checks.

## Cross-cutting release gates

- [ ] Generate and review a complete SBOM from the lockfile.
- [ ] Keep every direct and transitive dependency inside the approved license policy.
- [ ] Test malicious archives, SVG, rich text, IPC messages, and MCP requests.
- [ ] Confirm exported diagnostics contain no deck content or secrets.
- [ ] Complete visual, keyboard, and screen-reader smoke tests.
- [ ] Run an independent trademark review before commercial distribution.

## Explicitly deferred

- Presentation-file interchange.
- Linked-data charting.
- Advanced vector path editing and boolean operations.
- Speaker notes, comments, and transitions.
- Cloud accounts and internet relay collaboration.
- Embedded AI chat and a hosted asset marketplace.
