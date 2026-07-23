# Implementation Plan: Professional Authoring and Persistent Agent Access

## Sequence

1. **Interaction foundation**
   - Repair fresh-ID duplication and placeholder detachment in
     `canonical-factories.ts`.
   - Add bounded object clipboard helpers and focused tests.
   - Add context-menu and keyboard routing in the desktop renderer.
   - Verify the exact reported duplicate, copy, cut, paste, and right-click flows.

2. **Surface-neutral authoring**
   - Introduce one active-container adapter for slide, layout, and master selection.
   - Route insertion, transform, arrange, lock, visibility, duplicate, and delete
     through that adapter.
   - Extend validated image import so a chosen image can be inserted atomically into
     any supported surface.
   - Verify each content type on all three surfaces.

3. **Design authority and page furniture**
   - Add blank-theme creation and deterministic deck-wide theme enforcement.
   - Expose inheritance/override/reset state.
   - Complete layout/master locks.
   - Enable bounded custom page dimensions.
   - Add dynamic fields, dedicated page numbering, and watermark creation.
   - Verify reordering, layout changes, save/reopen, collaboration projection, and all
     render modes.

4. **Offline content catalogs**
   - Pin and ingest reviewed Twemoji and Circle Flags artwork.
   - Generate deterministic, searchable closed catalogs for the shared renderer.
   - Add shape, icon, emoji, and flag pickers that choose before insertion.
   - Update license policy, provenance ledger, notices, and catalog integrity tests.

5. **Persistent trusted-agent control**
   - Amend the local-agent ADR and contracts with persistent scoped client grants.
   - Store grants outside documents in current-user app state.
   - Classify read, ordinary reversible edit, and sensitive/external operations.
   - Add design-context and design-aware typed tools.
   - Add revocation, audit visibility, revision conflicts, and security tests.

6. **Information architecture and handoff**
   - Remove command duplication between the application menu and authoring toolbar.
   - Add shortcut labels, accessibility names, focus management, and context-specific
     enablement.
   - Update README, architecture, operations, changelog, TODO, and continuity.
   - Run focused source/UI verification, then a single complete repository gate.

## Checkpoints

- **A**: Context menu, clipboard, and duplicate regression tests pass.
- **B**: Every supported insertion and arrange action works on slide/layout/master.
- **C**: Theme switch, locks, page size, numbering, and watermark round-trip.
- **D**: Catalog assets are offline, searchable, provenance-bound, and cross-surface.
- **E**: A registered trusted client edits with no per-edit approval while sensitive
  operations still fail without explicit approval.
- **F**: Full repository verification is green and the installed app passes one
  consolidated hands-on smoke.
