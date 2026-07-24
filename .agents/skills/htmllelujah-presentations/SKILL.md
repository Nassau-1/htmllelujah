---
name: htmllelujah-presentations
description: Create, restructure, restyle, save, and quality-check presentations in the HTMLlelujah desktop editor through its persistent local MCP bridge. Use for outline-to-deck work, slide edits, themes, masters, layouts, placeholders, page furniture, alignment, tables, images already approved in the desktop, validation, save-to-existing-target, and export handoff on visible `.hdeck` presentations.
---

# HTMLlelujah Presentations

Operate on the canonical structured document through the local HTMLlelujah MCP server. Keep the
desktop app running and the target presentation visible.

Read [references/mcp-contract.md](references/mcp-contract.md) before the first tool call. Read
[references/design-model.md](references/design-model.md) before changing themes, masters,
layouts, placeholders, locks, or recurring page furniture.

## Guardrails

- Treat the theme → master → layout → slide chain as authoritative.
- Use only schemas exposed by the connected MCP tools. Never guess a field or command shape.
- Never edit a `.hdeck` archive, recovery data, endpoint descriptor, or credential file directly.
- Never introduce arbitrary HTML, CSS, SVG, JavaScript, shell commands, filesystem paths, or
  remote URLs into a proposal.
- Keep every mutation typed, revision-checked, attributable, transactional, and undoable.
- Preserve IDs and nested structure when a command requires complete replacement. Generate fresh
  UUIDs only for genuinely new resources, elements, blocks, cells, slides, or groups.
- Do not bypass a lock or replace an inherited object on a slide. Change its authoritative master
  or layout, or ask the user whether to create a deliberate slide override.
- Do not request, display, paste, log, or retain approval IDs or local client credentials.
- Do not mutate while LAN collaboration is active. Reads remain useful; wait until the session
  returns offline before proposing edits.

## Start every task

1. Call `app_status`, then `documents_list`.
2. Match the visible deck by name. If ambiguous, ask the user to identify it; never guess.
3. Call `documents_get_outline` and retain its current `revision`.
4. Call `documents_get_styles` before design-sensitive work. It returns the complete canonical
   themes, masters, layouts, and their authoritative elements.
5. Call `documents_get_design_context` for the target slide before design-sensitive work.
6. Page through `elements` or `assets` when `hasMore` is true. Do not assume the first page is the
   complete deck.
7. Call `documents_validate` and record pre-existing issues separately from changes you introduce.

## Choose the editing surface

- Use `documents_propose_design_operations` for page size, theme, master, layout, slide-layout,
  and deck-wide theme enforcement.
- Use `documents_propose_commands` for slides, content, geometry, alignment, distribution,
  grouping, visibility, locks, rich text, tables, connectors, and comments exposed by the current
  tool schema.
- Prefer semantic commands such as `element.align`, `element.distribute`,
  `text.replace-content`, `element.update-style`, and `element.transform` over complete
  `element.update` replacements.
- Use a complete replacement only when no narrower command exists. Start from the latest object
  returned by `slides_get` or design context and preserve every unrelated field and child.

## Outline to deck

1. Convert the brief into a slide plan with one purpose per slide: message, evidence, visual
   structure, and intended layout.
2. Inspect available layouts and semantic text roles. Reuse them before creating new design
   infrastructure.
3. Create or reorder slides in one coherent batch when practical. Give slides meaningful names;
   do not use visible title copy as the only slide identity.
4. Populate layout placeholders first. Bind slide elements to the matching placeholder and keep
   `overrides` minimal so later theme and layout changes remain authoritative.
5. Use theme text roles (`title`, `subtitle`, `body`, `caption`, `label`, `quote`) rather than
   hard-coded fonts and colors. Use local marks only for deliberate emphasis.
6. Build tables with explicit rows, columns, cell IDs, rich-text blocks, and accessible contrast.
7. Propose, inspect the returned summary and warnings, then commit once. A proposal is a preview,
   not a saved edit.

## Theme, master, and layout

1. Read all authoritative elements before replacing a master or layout. Full replacement that
   omits an existing nested object is destructive.
2. Put palette and typography in the theme.
3. Put brand marks, recurring background art, watermarks, footer fields, and fixed furniture on
   the master. Set fixed furniture `locked: true`.
4. Put composition-specific guides and placeholders on layouts. Keep recurring content out of
   individual slides.
5. Use `theme.enforce-deck` only when the user wants theme-managed fonts and colors reset across
   the deck. Explain that local font/color overrides are removed while content, geometry, IDs,
   opacity, and image assets are preserved.
6. After a master, layout, or theme change, inspect at least one representative slide per layout
   and validate the whole document.

## Page furniture

- Implement text page numbers, total pages, deck title, date, and time with canonical fields
  `{{page}}`, `{{pages}}`, `{{title}}`, `{{date}}`, and `{{time}}`.
- Keep field source text intact; rendering resolves it for each slide.
- Place footer and slide-number furniture on a master or layout, align it relative to the page,
  and lock it.
- Use a low-opacity locked master text or desktop-approved image as a watermark.
- Use `assets_request_import` only after the user selects and approves an image in the desktop.
  MCP accepts no image path or remote URL.

## Alignment and overflow pass

1. Work in points using the deck `page.widthPt` and `page.heightPt`.
2. Keep frames within page bounds unless the user explicitly requests bleed.
3. Use alignment commands for two or more objects and distribution commands for three or more.
   Align to `container` for page/group authority and to `selection` for peer alignment.
4. Preserve readable margins, consistent gaps, and a stable baseline across related slides.
5. Review text volume against its frame, table contents against cell sizes, and connectors against
   their bound targets. Shorten copy or enlarge the frame before reducing type.
6. MCP currently exposes no rendered text-metrics or screenshot tool. Use conservative spacing,
   validate structurally, and ask for a human visual check when exact line wrapping matters.

## Transaction loop

1. Use the latest revision in `expectedRevision`.
2. Group one user-visible intent into one labelled proposal. Keep unrelated edits separate.
3. Inspect `requiresApproval`, `warnings`, `affectedSlideIds`, and the proposal summary.
4. Commit immediately enough to stay within the returned `expiresAt`.
5. If the commit reports `REVISION_CONFLICT`, discard the proposal, reread outline/slide/design
   context, rebuild against the new revision, and propose again. Never replay stale replacements.
6. After commit, retain the returned `transactionId` until verification completes.
7. Re-read affected slides and call `documents_validate`. Check that the revision advanced once
   and that no pre-existing issue was silently attributed to the transaction.

## Approval and undo

- Ordinary reversible proposals normally commit without per-edit approval.
- `documents_save` also needs no one-time approval. It saves only the exact requested revision to
  the deck's existing desktop-authorized target; it accepts no path and never performs Save As.
- Deletion, page changes, slide-layout remapping, and replacements that remove nested structure
  can return `requiresApproval: true`. Stop and let the user authorize the exact action in the
  desktop; never seek a workaround.
- Import, HTML/PDF export, and agent-transaction undo always require separate short-lived,
  single-use desktop authorization.
- Use `documents_undo_agent_transaction` only when the user asks to revert the agent transaction
  and the desktop has issued the matching authorization. Supply the current revision and the
  exact transaction ID.

## Deliverable

1. Call `documents_validate` and resolve new issues.
2. Re-read the outline and representative slides; confirm ordering, names, hidden state, layout
   assignments, semantic roles, locks, and recurring furniture.
3. Tell the user which single transaction(s) were committed and which visual checks still need
   human eyes.
4. If the user asks to persist the deck and `documents_list` reports `hasSaveTarget: true`, call
   `documents_save` with the latest verified revision. Claim disk persistence only from its
   `saved: true`, `dirty: false`, `durability: "clean"` response. If no target exists, ask the user
   to perform desktop Save As once; MCP must not choose a path.
5. Prefer desktop File export. If the user explicitly requests MCP export, wait for the scoped
   desktop authorization, call `documents_request_export`, and claim success only from its
   confirmed response.
