# Useful PowerPoint Parity

Status: **In progress**, last reviewed 2026-07-24.

## Objective

Make HTMLlelujah feel familiar to a professional presentation author without copying
PowerPoint's entire feature set. The next product cycle must fix misleading editor chrome,
make every bundled business visual discoverable, add the missing vector and image-editing
operations that materially affect day-to-day slide work, support review comments, and
establish a safe path from an existing PowerPoint template to an authoritative
HTMLlelujah theme/master/layout.

## Non-goals

- Transitions, animations, recording, presenter coaching, or a full slideshow-production
  suite.
- A complete flowchart, equation, callout, action-button, star, banner, novelty-shape, or
  decorative WordArt catalog.
- A native spreadsheet or chart engine, linked charts, formulas, or live Excel links.
  Excel ranges and charts should instead paste as deterministic embedded visuals.
- `.pptx`/`.potx` export or round-trip editing. This cycle imports into native `.hdeck`
  only.
- Full 3D modelling, meshes, cameras, or lighting. A bounded vector-style 2.5D extrusion
  may be supported.
- AI subject segmentation or a cloud background-removal service. The proposed first
  image phase is deterministic color-key removal for simple white, black, or flat-color
  backgrounds.
- Cloud accounts, internet sharing, or an internet collaboration relay.
- An embedded chatbot or subscription-account bridge. Agent work in this cycle uses the
  vendor-neutral local MCP; an integrated conversational surface requires a separate
  product/authentication decision.
- Perfect import of every PowerPoint feature. Unsupported content must be reported, never
  silently discarded or misrepresented.

## Current product truth

| Surface           | Implemented checkpoint                                                                                                                                       | Remaining gap                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Emoji             | Paged Business/All scopes expose the complete 3,720-vector catalog; Business excludes faces, animals, food, and sport by default.                            | Final installed-candidate interaction check.                          |
| Flags             | All 265 circular flags are pageable, searchable, and grouped by region.                                                                                      | Final installed-candidate interaction check.                          |
| Shapes            | The bounded business catalog, hosted shape text, open/closed freeform editing, and five guarded Boolean operations are implemented.                          | Optional deterministic extrusion evaluation.                          |
| Connectors        | Straight/elbow/curved endpoints, both caps, five anchors, canvas snap/detach, and target-following bindings are directly editable.                           | Final installed-candidate interaction check.                          |
| Images            | Embedded images support bounded clipboard import, direct crop handles, and deterministic non-destructive color-key removal in the shared renderer.           | Final installed-candidate interaction check.                          |
| Design            | Theme enforcement, masters, layouts, locks, page size/furniture, semantic roles, hosted shape text, and Phase 1 import share native authority.               | Final installed-candidate interaction check.                          |
| Review            | Persisted slide/object comment threads support replies, unread state, resolve/reopen, LAN synchronization, and render/export exclusion.                      | Final integrated interaction check.                                   |
| Spelling          | Deck/text language and the native editable-text correction menu support replace, session ignore, and the local personal dictionary.                          | Final installed-candidate interaction check.                          |
| PowerPoint import | Bounded `.pptx`/`.potx` ZIP/XML preview, fidelity report, and atomic native Phase 1 design plan are implemented without source mutation.                     | Phase 2 slide-content import and final integrated desktop acceptance. |
| Agent guidance    | The repository skill and persistent MCP workflow include authoritative design context, bounded save, protected launcher identity, summaries, and revocation. | Final packaged-launcher interaction check.                            |

## Affected surfaces

- `packages/renderer`: catalog query/paging, new deterministic SVG/path rendering, and
  editor/presentation/export parity.
- `packages/document-core`: optional path, image-mask, comment, and shape-effect schema;
  commands, validation, migration, undo, and design authority.
- `packages/hdeck`: backward-compatible persistence of new optional entities and derived
  assets.
- `apps/desktop`: catalog virtualization, direct-manipulation affordances, Design
  workspace, review UI, spelling UX, truthful save/recovery status, and agent/LAN
  onboarding.
- `packages/collaboration` and `packages/mcp-server`: comment synchronization and bounded
  design-aware read/write operations where appropriate.
- A bounded `.pptx` importer and a repository-owned HTMLlelujah presentation-authoring
  skill.

## Constraints

- Offline-first: no runtime CDN, cloud API, hosted model, or mandatory account.
- One canonical document and one renderer across editor, thumbnails, presentation,
  standalone HTML, PDF, save/reopen, collaboration, and MCP.
- Existing `.hdeck` files remain readable; schema additions are optional and migrated at
  the open boundary.
- Every mutation is revision-checked, attributable, one-transaction undoable, bounded,
  and safe under collaboration.
- Imported archives, XML, images, paths, comments, and derived assets receive explicit
  size, count, nesting, coordinate, and decode limits.
- Catalog completeness must not mount thousands of DOM nodes or regress keyboard and
  screen-reader navigation.
- New public or distributed dependencies require license and commercial-use review before
  adoption.
- A synchronized OneDrive/Google Drive replica is not treated as a coherent shared
  filesystem or locking service. Automatic LAN discovery may use canonical source identity
  only when every participant can prove the same authoritative shared target.

## Main risks and containment

- **Vector geometry divergence:** define one canonical path representation and exercise it
  through every renderer before enabling creation UI.
- **Boolean-operation data loss:** compute a preview and commit replacement paths in one
  transaction; Undo must restore the exact source objects.
- **Image-mask bloat:** store a compact, bounded mask/operation where deterministic, or one
  content-addressed derived asset; never duplicate source bytes per slide.
- **Catalog performance:** keep a bounded rendered window and separate total-match count
  from mounted result count.
- **PowerPoint parser exposure:** treat `.pptx` as hostile ZIP/XML, reject macros and
  external relationships, and perform no Office automation or script execution.
- **Import fidelity ambiguity:** preserve the source file unchanged and emit a structured
  supported/substituted/unsupported report before the user accepts the imported deck.
- **Comment privacy:** comments are presentation metadata, excluded from presentation,
  PDF, and standalone HTML unless a future explicit review export is requested.

## Product requirements

### Catalog discovery

1. Replace the fixed 72-card result with pagination, incremental loading, or
   virtualization. The `All` scope must reach every one of the 3,720 Twemoji vectors and
   all 265 circular flags.
2. Expose `Business` and `All` as explicit browse-and-search scopes. A query stays in the
   selected scope; an empty Business result may offer a deliberate `Search all` action
   but never changes scope silently.
3. Return a stable bounded result contract with `items`, exact `total`, cursor or offset,
   and `hasMore`. Show the logical visible/loaded range and total, for example
   `73–144 of 3,720`; do not describe mounted DOM nodes as search results.
4. Search the complete selected scope by English/French label, keywords, Unicode, stable
   ID, country name/code, and category. Normalize case, accents, Unicode forms, and
   whitespace; treat multi-term queries consistently and use stable score/source-order/ID
   tie-breaking.
5. Default emoji browsing to a reviewed `Business` collection covering transport,
   travel, places and buildings, office objects, documents, tools, cameras, finance,
   data and technology, clocks, status and alerts, arrows, operators, geometric markers,
   and common symbols. Exclude faces, animals, food, and sport from this default scope.
   Keep those entries reachable only through the explicit `All` scope. Use stable
   product-owned category IDs; an entry may belong to multiple categories.
6. Group flags with a deterministic ISO 3166/UN M49-derived region map and an explicit
   `Territories and organizations` fallback while keeping country-name and two-letter-code
   search exhaustive.
7. Keep at most 144 result cards mounted in the active picker, including virtualization
   overscan; recycled or hidden pages must not remain mounted. Preserve keyboard
   navigation, visible focus, logical `aria-posinset`/`aria-setsize`, `Home`, and `End`
   through the final result.
8. On the supported Windows target after warm code load, keep query-to-first-updated-grid
   latency at or below 100 ms p95 for empty, broad, and exact searches, and keep scrolling
   responsive without unbounded work per keystroke.

### Truthful application chrome

1. Remove the static `AI-NATIVE · LOCAL` marketing badge from the working toolbar, or
   replace it with a factual local-first explanation in Help/About.
2. Never expose raw durability enums such as `journaled`. Map document state to:
   `Not saved yet · Recovery protected`, `Unsaved changes · Recovery protected`,
   `Saving…`, `Saved`, `Recovered copy · Save As required`, or a clear error.
3. Apply this priority-ordered mapping:

   | Runtime state                            | User-facing state                      | Save behavior                                                                         |
   | ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
   | `durability = saving`                    | `Saving…`                              | Disable concurrent Save; retain safe close guard.                                     |
   | `durability = save-error`                | `Save failed · Recovery preserved`     | Show error and retry/Save As actions.                                                 |
   | `durability = recovered`                 | `Recovered copy · Save As required`    | Disable ordinary overwrite even if a historical target exists; require Save As first. |
   | `dirty = true`, `hasSaveTarget = false`  | `Not saved yet · Recovery protected`   | Offer Save As.                                                                        |
   | `dirty = true`, `hasSaveTarget = true`   | `Unsaved changes · Recovery protected` | Offer Save.                                                                           |
   | `dirty = false`, `hasSaveTarget = true`  | `Saved`                                | No action required.                                                                   |
   | `dirty = false`, `hasSaveTarget = false` | `Not saved yet`                        | Offer Save As without warning color.                                                  |

4. Fix the inverted recovery label: normal journaled edits are not `Recovered locally`;
   recovery wording appears only for an actually recovered session.
5. Replace the document-title prompt and decorative chevron with inline rename plus clear
   Save/Save As behavior. Initialize the deck name as `Untitled presentation` and the
   first title placeholder as empty/`Click to add title`; renaming a deck must never edit
   slide content.
6. Rename `Codex` to `MCP` or `Agent access`. Display `Unavailable`,
   `Ready — no agent connected`, or `Connected`, and provide copyable onboarding plus
   persistent-client listing/revocation.
7. Rename `Share` to `Collaborate (LAN)`. Before hosting, explain the same-file,
   same-private-network, one-authoritative-host model. During a session, show
   `Hosting · N` or `Joined · N`.

### Useful vector editing

1. Add a curated basic-shape set only: rectangles, ellipses, triangles, diamond,
   parallelogram, trapezoid, pentagon/hexagon, chevron, brackets, and simple arcs.
2. Let a compatible shape carry directly editable rich text with theme-managed role,
   margins, and horizontal/vertical alignment. Double-click edits the text without
   requiring a separate overlaid text box or group.
3. Close a scoped classic-editing baseline: multi-select, nudge, resize, rotate, flip,
   group/ungroup, align/distribute, layer, lock/hide, copy/cut/paste, duplicate, match
   size, format painter, and precise numeric geometry. `Swap positions` exchanges the
   positions of exactly two selected objects in one undoable transaction without
   exchanging their content or styles.
4. Treat a line as an editable line/connector with independent start/end cap, width,
   dash, color, and straight/elbow/curved routing. Converting a plain line to an arrow
   must not require reinsertion.
5. Show connection points when dragging an endpoint over a compatible object. Dropping
   binds to that anchor; moving/resizing/rotating the target keeps the endpoint attached.
   Dragging away detaches it without moving the other endpoint.
6. Add open and closed freeform paths with click-to-add points, optional Bézier handles,
   finish/cancel semantics, and post-creation edit-points mode.
7. Add Union, Combine, Fragment, Intersect, and Subtract for compatible selected closed
   paths. Commit once with explicit no-loss validation; Undo restores every original
   object exactly. Unsupported holes, content-bearing shapes, locks, and unrepresentable
   curves fail before mutation rather than receiving a lossy preview.
8. Evaluate a deterministic 2.5D extrusion effect with depth, direction, and side color.
   It is lower priority than freeform, connectors, and Boolean operations and must render
   identically in every output.

### Images and pasted charts

1. Add a proposed phase-one `Remove background color`: pick a color from the image or use
   white/black presets, tune a bounded tolerance, preview transparency, apply once, and
   reset to the source. Review hands-on quality before considering any broader
   segmentation workflow.
2. Keep the operation offline, deterministic, non-destructive, bounded by image
   dimensions/bytes, and identical in editor, presentation, HTML, and PDF.
3. Add direct crop handles and retain the existing numeric contain/cover/fill controls.
4. Accept a copied Excel range or chart as a bounded embedded image when the clipboard
   exposes a safe bitmap/vector preview. Do not create a linked or formula-bearing chart.

### Design, review, and spelling

1. Turn `Design` into the primary workspace for theme gallery, theme creation/enforcement,
   fonts, semantic colors, page format, masters, layouts, and page furniture.
2. Every new text box must expose and immediately apply a semantic role such as Title,
   Subtitle, Body, Caption, or Free text; changing the deck theme updates managed roles.
3. Add slide- and object-anchored comment threads with author, timestamp, replies,
   resolve/reopen, unread state, and optional mentions limited to known LAN participants.
4. Comments synchronize through the authoritative host but never appear in presentation,
   PDF, standalone HTML, or ordinary print.
5. Surface native offline spelling in text-edit mode with deck/text language, underlines,
   correction suggestions, add-to-dictionary, and ignore actions. Do not send text to a
   remote service. Deck language and optional text overrides are canonical,
   migrated, collaborative, and MCP-visible; personal dictionary additions remain
   local user preferences outside the `.hdeck`.

### PowerPoint template import

1. Add a standalone preview-first `.pptx` import path based on bounded ZIP and XML parsing;
   never automate PowerPoint, execute macros, fetch external relationships, or modify the
   source file. Offer `Import design only` independently from slide import and evaluate
   `.potx` input under the same safety contract.
2. Phase 1 imports page size, theme colors/fonts, slide masters, layouts, placeholders,
   backgrounds, page numbers, and supported header/footer furniture.
3. Phase 2 imports supported slides: styled text, supported basic shapes/lines/connectors,
   images, tables, groups, and z-order.
4. Unsupported effects remain listed in a fidelity report. The user may cancel, accept
   substitutions, or import a raster fallback; there is no silent omission.
5. Imported themes, masters, and layouts become authoritative native HTMLlelujah design
   objects that humans and MCP clients can inspect and reuse. Export or round-trip back to
   `.pptx`/`.potx` remains out of scope.

### Agent-native authoring skill

1. Add a repository-owned, vendor-neutral skill explaining the document hierarchy,
   theme/master/layout authority, semantic text roles, safe asset handling, and the MCP
   proposal/commit/undo workflow.
2. Include examples for creating a deck from a template, applying a theme, editing a
   layout/master, adding page furniture, checking validation, and exporting.
3. The skill must discover the authoritative design context instead of hard-coding one
   template and must work with Codex, Claude, or another compatible local MCP client.
4. Keep arbitrary HTML, shell access, remote URLs, and unbounded file access outside the
   MCP contract.
5. Do not promise direct save until a bounded `documents_save` operation exists for an
   already-authorized current target. Until then, the skill must clearly ask the human to
   save; Save As, import, export, and destructive operations keep their desktop approval.
6. Either route typed agent mutations through the authoritative host during a LAN session
   with the same attribution/revision/undo guarantees, or state that agent mutation is
   unavailable while LAN collaboration is active. The current silent suspension is not
   the desired human-plus-agent workflow.

## Verification

- Unit and property tests for paging/virtualization, search completeness, paths, Boolean
  operations, connector attachment, image masks, comments, migration, and bounded rejects.
  Catalog fixtures must cover matches after positions 72 and 200, both final entries,
  exact 3,720/265 totals, a broad query above one page, the 144-card DOM bound, stable
  ordering, logical accessibility positions, and focus retention while rows recycle.
- Focused real-window tests for inline rename, truthful save/recovery state, catalog
  navigation past result 72, direct connector binding, freeform finish/cancel, comment
  review, spelling suggestions, and MCP/LAN onboarding.
- Pixel or structural parity checks across editor, thumbnail, presentation, standalone
  HTML, and PDF for every new visual primitive.
- Save/reopen, undo/redo, collaboration convergence, MCP projection, and old-file
  compatibility checks for every schema addition.
- Public synthetic `.pptx` fixtures covering supported master/layout import, unsupported
  relationships, ZIP/XML limits, fidelity reporting, and cancellation without mutation.
- License, attribution, security, performance, accessibility, and offline-network gates
  before any new dependency or feature is classified as complete.

## Ordered delivery plan

1. Fix catalog completeness and misleading chrome without changing document schema.
2. Ship vendor-neutral MCP onboarding and the authoring skill, including an explicit
   save contract and the decision for agent edits during LAN collaboration.
3. Expose the existing connector/cap/binding capabilities directly on the canvas and
   expand only the curated basic-shape set.
4. Introduce canonical freeform paths and Boolean operations, then validate every output
   surface before exposing merge UI.
5. Add color-key background removal and robust clipboard-image ingestion.
6. Reframe the Design workspace and semantic text-role workflow.
7. Add comments and complete spelling UX.
8. Build preview-first PowerPoint theme/master/layout import, followed by the supported
   slide subset.
