# Feature Specification: Professional Authoring and Persistent Agent Access

**Created**: 2026-07-23

**Status**: In implementation

**Input**: Hands-on use of the installed Windows preview identified blocking gaps in
ordinary object editing, design-surface authoring, theme enforcement, page furniture,
content catalogs, and local agent access.

## Objective

Make the installed editor usable as a daily presentation authoring application:

- every selected object has familiar keyboard and context-menu operations;
- the same supported content can be inserted and edited on slides, layouts, and
  masters;
- themes, masters, layouts, locks, watermarks, and dynamic page fields behave as
  authoritative reusable design infrastructure;
- shapes, local icons, an offline Twemoji catalog, and offline circular country flags
  are chosen before insertion;
- a trusted local agent can inspect and edit an open presentation continuously,
  including its themes, masters, layouts, and constraints, without requesting a
  one-time approval for every ordinary reversible edit.

## Non-goals

- Arbitrary HTML, CSS, SVG, JavaScript, shell, URL, or filesystem authoring.
- Cloud accounts, a hosted relay, model inference, or API billing.
- Import or export of proprietary presentation formats.
- Boolean vector editing or an unrestricted path editor.
- Removing revision checks, attribution, transactional validation, undo, sandboxing,
  or approval for external/destructive operations.
- Repeating the complete release-candidate or LAN soak campaign during each focused
  implementation checkpoint.

## Affected surfaces

- `packages/document-core`: authoritative model projection and typed operations.
- `packages/renderer`: dynamic fields and deterministic offline icon/flag rendering.
- `apps/desktop`: menus, toolbar, context menu, clipboard, template editing, page
  settings, theme workflows, catalog pickers, and local bridge.
- `packages/mcp-server` and `apps/desktop/src/main/mcp-bridge.ts`: trusted-client
  sessions and design-aware tools.
- `.hdeck`, standalone HTML, PDF, presentation, thumbnails, and collaboration
  projections.
- licensing, asset provenance, third-party notices, architecture, decisions, tests,
  changelog, roadmap, and operator documentation.

## Constraints

- `DeckDocument` remains the only persistent authoring source.
- Every mutation is typed, bounded, transactional, attributable, revision-checked,
  and undoable.
- Master and layout elements are not copied into slides merely to render them.
- Existing supported `.hdeck` documents continue to open without semantic loss.
- Renderers stay sandboxed, context-isolated, and offline.
- Content catalogs are bundled; there is no runtime CDN or remote asset fallback.
- Twemoji graphics retain their required attribution and circular flag artwork
  retains its license notice.
- Catalog SVG is compile-time trusted application content only. Documents and agents
  cannot submit arbitrary SVG.

## User stories and acceptance

### 1. Familiar object editing

1. Right-clicking a selected object opens a bounded context menu with Cut, Copy,
   Paste, Duplicate, Delete, Lock/Unlock, Hide/Show, layer order, group/ungroup, and
   relevant insert commands.
2. `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` work for object selections. Copies are serialized
   to an application MIME type and plain-text fallback without leaking local paths.
3. Paste gives fresh object, child, block, list-item, cell, and binding identifiers;
   pasted or duplicated placeholder-bound objects become independent local objects.
4. External clipboard text creates or fills text; supported image bytes use the
   existing validated atomic asset path; rectangular TSV targets tables.
5. Duplicate succeeds for text, placeholder-bound text, image, table, shape, icon,
   connector, and nested group selections. Failure never creates a phantom selection.

### 2. One insertion system for every design surface

1. Text, shape, image, table, connector, local icon, Twemoji, and circular flag
   insertion is available on slides, layouts, and masters where semantically valid.
2. The insertion destination is explicit in the command label and breadcrumb.
3. Drag, resize, rotate, align, distribute, reorder, lock, visibility, duplicate, and
   delete operate consistently on the active surface.
4. A master or layout update is immediately reflected on every slide that inherits it
   unless an explicit supported local override applies.

### 3. Authoritative design infrastructure

1. Users can create a blank theme, duplicate one, rename it, edit semantic colors and
   typography, apply it to one master, or enforce it across the whole deck.
2. Enforcing a theme changes heading/body fonts and every supported theme-managed
   color in text, shapes, connectors, icons, tables, backgrounds, masters, layouts,
   and slides in one undoable transaction.
3. The interface distinguishes inherited values, theme-managed values, and explicit
   local overrides, and offers reset-to-theme/reset-to-layout.
4. Master and layout objects expose a persistent lock. Locked inherited objects
   cannot be changed from slide mode.
5. Custom page width and height are editable within canonical safe limits.

### 4. Page furniture

1. A dedicated watermark command creates editable master text or image furniture,
   defaults to locked and non-interactive, and exposes opacity, rotation, and layer.
2. Dynamic fields include current page, page count, deck title, date, and time. The
   canonical text remains a token while every rendered surface resolves it.
3. Page numbers can be enabled on the selected master and positioned left, center, or
   right. Reorder, hide, insert, and delete update numbering without rewriting every
   slide.
4. Page furniture is visible in editor, thumbnail, presentation, standalone HTML, and
   PDF, and remains editable only from its authoritative surface.

### 5. Direct content choice

1. Shape insertion opens a visual dropdown before creating an object.
2. Icon and flag insertion open searchable pickers before creating an object.
3. Circular flags use bundled SVG artwork and stable two-letter country codes.
4. Twemoji uses bundled, searchable artwork with stable Unicode/code-point identity.
5. Inserted catalog content renders identically offline across every output surface.

### 6. Persistent trusted local agents

1. A local client registers once with a stable client identity and an explicit
   user-approved trust profile.
2. Trust can be scoped to read-only, ordinary reversible editing, or extended
   operations, and can be revoked from the app.
3. Ordinary typed edits to an already open trusted deck do not require one-time
   approval receipts. Import, export, overwrite, destructive bulk replacement, trust
   changes, and external targets remain separately approved.
4. The agent can inspect an authoritative design context containing page settings,
   themes, semantic tokens, masters, layouts, placeholders, locks, slides, asset
   metadata, revision, constraints, and validation warnings.
5. Mutations use expected revision, client/actor attribution, transaction labels, and
   typed operations. Stale or invalid batches fail atomically.
6. The app records active trusted clients and recent agent transactions; user undo
   works at transaction granularity.

## Main risks

- Schema drift or inconsistent rendering across editor/export surfaces.
- Breaking old documents when dynamic fields or theme management are introduced.
- Clipboard identity collisions or duplication of placeholder bindings.
- Template mutations bypassing the command engine or collaboration leases.
- Treating bundled SVG as if arbitrary document SVG were safe.
- Trusted-agent persistence becoming an ambient machine-wide write capability.
- Large catalogs increasing startup, export size, or build time.

## Verification

- Unit tests for clipboard envelopes, fresh-ID cloning, dynamic fields, theme
  enforcement, page bounds, template locks, catalog lookup, trusted-client grants,
  revision conflicts, and approval classification.
- Desktop integration tests for each action on slide, layout, and master.
- Shared-renderer tests for editor, thumbnail, presentation, HTML, and PDF inputs.
- Focused Electron smoke covering the reported flows after source tests pass.
- One final full `pnpm verify` and one final installed-candidate campaign after the
  complete remediation lands; no repeated 30-minute campaign between subfeatures.

## Rollback and containment

- Keep new document fields optional and preserve literal legacy styles.
- Treat unknown dynamic tokens as literal text.
- Keep catalog sets closed and application-owned; unknown items render a typed
  warning without remote fallback.
- Fail closed on unknown trusted clients, expired/revoked grants, revision mismatch,
  or operations outside the granted profile.
- If a focused feature fails, disable only its UI entry point while retaining the
  last valid document and prior renderer behavior.
