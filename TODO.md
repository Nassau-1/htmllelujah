# Roadmap and TODO

Status: **V1 source hardening complete in the working tree; consolidated opened-app
and refreshed installed-candidate verification pending**, last reviewed 2026-07-24.

The current working tree contains the source checkpoints described below. The installed
preview at source commit `63ad60d` remains useful for feedback, but it does not include
the final close-harness and desktop MCP error-boundary hardening below. One consolidated
opened-app smoke, refreshed Windows packaging, and durable reinstall remain before that
local candidate represents the complete working tree.

## Hands-on authoring and agent remediation

Authoritative scope, sequencing, and acceptance evidence:
[`specs/003-editor-authoring-and-agent-access/`](specs/003-editor-authoring-and-agent-access/spec.md).

### Blocking interactions

- [ ] Add a contextual object menu on right-click with cut, copy, paste, duplicate,
      delete, lock, visibility, layer, grouping, and relevant insert commands.
      Checkpoint complete: pointer right-click and the keyboard context-menu gesture
      open copy, cut, paste, duplicate, layer, lock, visibility, grouping, and delete;
      focus enters the menu, arrow/Home/End/Escape navigation works, and focus returns
      to the canvas. Contextual insertion shortcuts remain an optional follow-up.
- [x] Add object-level `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` with bounded private object
      serialization, fresh identifiers, plain-text fallback, and detached
      out-of-selection connector bindings.
- [ ] Complete external clipboard routing for rich text, pasted images, and TSV, and
      wire the safe rejection path for cross-presentation images whose local asset
      bytes are not present in the destination deck.
      Safe cross-presentation rejection is wired, including images nested in groups;
      same-presentation images remain pasteable and connector bindings outside the
      copied selection are detached. External image-byte routing remains open.
- [x] Fix duplication of placeholder-bound text boxes by detaching copied bindings,
      generating every nested identifier afresh, and updating selection only after a
      successful transaction.
- [x] Separate the application menu from the authoring toolbar so Edit, View, Insert,
      Arrange, and Help expose real command groups and shortcut discovery rather than
      repeating the same insertion buttons.

### Slides, layouts, and masters

- [x] Make the full valid insertion palette available on slides, layouts, and masters:
      text, shape, image, table, connector, local icon, Twemoji, and circular flag.
- [x] Make transform, align, distribute, layer, duplicate, delete, visibility, and lock
      operate consistently on the active slide/layout/master surface.
      The active-container adapter routes the shared transform and arrange commands to
      all three surfaces, and every direct template-object delete path respects locks.
- [x] Route rich-text, shape, table, connector, image, and icon property editing to the
      active slide, layout, or master instead of silently falling back to slide mode.
- [x] Make layout and master updates authoritative for every inheriting slide while
      preserving explicit supported local overrides.
- [x] Expose persistent locks for layout and master furniture; locked inherited
      objects must not be editable from slide mode.
      Lock state is canonical, inherited by projections, exposed in layout/master
      controls, and honored by shared transforms, properties, keyboard commands, list
      actions, image replacement, and direct delete paths.

### Themes and page furniture

- [x] Add explicit creation of blank and derived themes rather than hiding creation
      behind a copy-only action.
- [x] Add one-transaction theme enforcement so switching theme changes all managed
      fonts and colors across text, shapes, connectors, icons, tables, backgrounds,
      masters, layouts, and slides.
      Checkpoint complete: one strict `theme.enforce-deck` command now handles the
      complete deck atomically and remains valid beyond 100 styled objects, with
      standard revision checks, durable history, collaboration conflicts, and undo.
- [x] Distinguish inherited, theme-managed, and local style values and add reset to
      theme/layout actions.
      The Properties panel reports style authority and exposes reset-to-theme and
      reset-to-layout actions. The canonical reset preserves content, geometry,
      identifiers, bindings, and unrelated styling.
- [x] Enable bounded custom page width and height.
- [x] Add dynamic current-page, page-count, deck-title, date, and time fields.
- [x] Add master-level page numbering with left, center, and right placement.
- [x] Add editable text and image watermarks that default to locked master furniture.
      Image asset registration and final locked watermark creation share one atomic,
      single-Undo transaction.

### Direct content choice and offline catalogs

- [x] Replace rectangle-first shape insertion with a visual pre-insertion shape
      chooser.
- [x] Add a searchable pre-insertion local-icon chooser.
- [x] Bundle a searchable offline Twemoji catalog with stable Unicode/code-point
      identity and required attribution.
      The renderer bundles 3,720 pinned vectors and English/French metadata behind the
      closed `twemoji:<code-points>` identity.
- [x] Replace operating-system Unicode flags with bundled searchable Circle Flags SVG
      artwork and stable two-letter country codes.
      The renderer bundles 265 pinned circular flags behind
      `circle-flags:<alpha-2>` identities; legacy `flag`/`flags` values remain readable.
- [x] Keep catalog rendering deterministic across editor, thumbnail, presentation,
      standalone HTML, PDF, save/reopen, and collaboration without any CDN fallback.
      Source-level renderer, archive, and collaboration coverage is complete. The final
      opened-app smoke remains a separate delivery gate.

### Persistent trusted local agents

- [ ] Replace per-edit one-time approval with persisted current-user trusted-client
      grants scoped to read-only, ordinary reversible editing, or extended actions.
      Checkpoint complete: the packaged compatibility client has a persistent Ed25519
      identity, server-derived actor, and closed read/edit capability set. Explicit
      user-approved named-profile enrollment and profile management remain.
- [x] Let trusted local agents inspect the authoritative page, theme, master, layout,
      placeholder, lock, asset-metadata, slide, revision, constraint, and validation
      context.
      `documents_get_design_context` now returns the canonical inheritance chain and
      paginated authoritative/projection element provenance with effective locks.
- [x] Preserve bounded MCP-safe errors through the desktop result boundary, keeping
      authorization failures terminal and revision conflicts recoverable without
      exposing local capability or path details.
- [x] Add design-aware typed operations for themes, masters, layouts, page furniture,
      and ordinary slide editing.
      Strict page/theme/master/layout/slide-layout and deck-wide theme-enforcement
      operations expand through the canonical command engine; ordinary slide edits use
      the same typed proposal and transaction path.
- [ ] Keep explicit approval for imports, exports, overwrites, destructive bulk
      replacement, trust changes, and external targets.
      Authenticated-client binding is complete for destructive commit, undo, import,
      and export. Overwrite, trust-change, and external-target UX remain to be closed.
- [ ] Show and revoke trusted clients and retain attributable transaction-level undo.
      Persistent backend revocation and `mcp-client:<uuid>` attribution are complete;
      visible management and audit history remain.

### Verification discipline

- [x] Run focused code-level unit/integration checks for completed remediation
      checkpoints; these do not replace the final repository or opened-app gates.
- [x] Extend the packaged MCP smoke contract to require authoritative design context,
      a non-mutating semantic design proposal, and bounded safe rejection of unknown
      tools or schema-injected markup.
- [x] Close and await CDP WebSocket sessions before native-close probes, reuse the
      bounded process-tree drain for packaged MCP cleanup, and preserve the primary
      failure when cleanup also fails.
- [ ] Run one consolidated opened-Electron smoke covering all reported flows.
- [ ] Run one final complete `pnpm verify` after the implementation has converged.
- [ ] Build the refreshed Windows x64 candidate and durably install it on this machine
      after the opened-app smoke and final verification pass.
- [ ] Do not repeat the 30-minute LAN or complete Windows candidate campaign between
      individual fixes; run them once on the final candidate.

## V1 implementation

- [x] Use `DeckDocument` and the typed transaction engine as the only persistent
      authoring state for human, agent, import, recovery, and LAN operations.
- [x] Integrate the sandboxed editor with main-process sessions, revision checks,
      attribution, grouped undo/redo, snapping, alignment, grouping, layers, and
      direct content controls.
- [x] Implement themes, masters, layouts, placeholders, rich text, images, native
      tables, shapes, connectors, icons, flags, page formats, and hidden slides.
- [x] Use one DOM/SVG renderer for editor, thumbnails, presentation, standalone HTML,
      and PDF.
- [x] Implement bounded `.hdeck` archives, content-addressed assets, durable journals,
      recovery candidates, recovery-blob garbage collection, external-change
      detection, and atomic explicit save.
- [x] Implement offline presentation, standalone HTML export, and PDF export.
- [x] Implement authenticated local stdio MCP with persistent trusted-client identity,
      typed proposal/commit, revision conflicts, attribution, undo, bounded
      proposal/approval state, explicit approval for sensitive operations, import, and
      export.
- [x] Implement encrypted private-LAN authoritative-host collaboration, optional
      discovery, soft text locks with an owner/read-only editor state, reconnect
      handling, detached guest recovery, and one shared-file writer.
- [x] Implement Windows x64 packaging, `.hdeck` association, second-instance file
      opening, hardened Electron fuses, application icon, and console MCP launcher.

## Release-candidate verification

### Audit blockers closed in source (checkpoint 2026-07-16)

- [x] Keep the document-session queue usable after a stale discard rejection so an
      immediate revision-correct close retry succeeds without leaving a session or
      recovery candidate.
- [x] Preserve selected master/layout objects after accepted document revisions and
      cover drag/resize persistence in the opened-app smoke.
- [x] Define one backward-compatible connector geometry invariant, then make
      rendering, hit testing, align/distribute, grouping, ungrouping, bindings, and
      V2 archive reopening use it without clipping or double rotation.
- [x] Promote the candidate payload and its evidence with crash-consistent recovery;
      a flushed journal, commit marker, tombstone cleanup, and startup recovery cover
      exceptions plus process or machine termination between renames.
- [x] Compare the complete installed payload against the attested unpacked inventory
      after install, repair, and upgrade-like reinstall.
- [x] Bind the public tag and release upload to the candidate manifest's exact source
      commit and annotated tag objects, and generate the final observed release
      record as an artifact so recording hashes cannot change the producing commit.

### Security remediation closed in source (checkpoint 2026-07-21)

- [x] Enforce complete canonical-document representability, table-area, archive-range,
      export-projection, repeated-asset, decode-concurrency, and rich-clipboard budgets
      before mutation or expensive processing.
- [x] Serialize Save and Save As per document session, make the runtime target
      authoritative at commit time, recheck the destination after asynchronous guards,
      require explicit confirmation before stale or orphan-lock writer-reservation
      takeover, and keep sidecar cleanup identity-safe.
- [x] Reserve LAN admission and retained-state capacity before asynchronous work, bind
      to one explicitly selected named private address, authenticate that address in
      discovery, deliver lossless join bootstrap, drain admitted work before host
      departure, clean failed joins, extend leases to indirect master/layout writes,
      and fence shared-file commits with current host authority.
- [x] Reuse identical image imports atomically under one content-addressed asset and
      reuse immutable validation proofs across transactions, history, and save
      preparation without weakening archive verification.
- [x] Align the local security gate with pnpm 11 audit output and the signed Microsoft
      on-demand Defender policy, and exclude the unused installed elevation helper.
- [ ] Complete the final independent review, full repository verification, clean-build
      evidence, and scan fix report before classifying all remediations as verified.

### Final evidence gates

- [ ] Run the complete clean-checkout `pnpm verify` gate and record the exact commit,
      environment, command, and result.
- [ ] Run `pnpm validate:candidate` against the promoted Windows x64 candidate and
      retain its canonical functional manifest plus public evidence ZIP.
- [ ] Complete unit, integration, adversarial archive/recovery, IPC, MCP, and LAN
      suites against the final source and packaged binaries.
- [ ] Open the unpacked and installed application and complete create, edit, save,
      close, reopen, recover, present, HTML export, and PDF export flows.
- [ ] Review editor, presentation, standalone HTML, and rasterized PDF visual evidence
      at supported page formats and display scales.
- [ ] Complete keyboard, focus, reduced-motion, contrast, and screen-reader smoke
      checks on Windows 11 x64. The source-build CDP/DOM scaling smoke is preliminary;
      the exact installed candidate and a manual Narrator or NVDA pass remain pending.
- [ ] Run the multi-instance LAN convergence and reconnect soak required by
      [`specs/002-v1-release/test-matrix.md`](specs/002-v1-release/test-matrix.md).
- [ ] Record warm-start, command acknowledgement, export, large-deck, repeated-save,
      and repeated-export measurements without substituting synthetic estimates.
- [ ] Install, associate, upgrade, repair, and uninstall from a standard-user clean
      Windows account while preserving decks and recovery data.

## Distribution and compliance

- [x] Adopt PolyForm Noncommercial 1.0.0 for original source and official binaries,
      provide a separate commercial-licensing contact path, and keep the canonical
      terms in `LICENSE`.
- [x] Inventory every direct external dependency and retain the direct runtime
      license texts in `THIRD_PARTY_NOTICES.md`.
- [ ] Generate and package complete attribution and license notices for every
      third-party component actually present in the compiled application, not only
      direct dependencies or the SBOM inventory.
- [x] Scope Python-2.0 to the build-only
      `electron-builder -> js-yaml -> argparse@2.0.1` chain without relaxing the
      production allowlist.
- [x] Record application-icon, local-icon, Lucide, Unicode-flag, and font provenance.
- [x] Document the narrow Electron/FFmpeg LGPL runtime exception, evidence, duties,
      and re-review triggers.
- [ ] Establish and obtain qualified approval for the Electron/FFmpeg
      corresponding-source mechanism before any public binary distribution.
- [ ] Have the separate commercial agreement and contributor agreement reviewed
      before granting commercial rights or accepting external contributions.
- [ ] Confirm the legal licensor identity and retain private chain-of-title records
      before signing a commercial agreement.
- [ ] Confirm the final installer and installed directory contain `LICENSE.txt`,
      `COMMERCIAL-LICENSING.md`, `THIRD_PARTY_NOTICES.md`,
      `LICENSE.electron.txt`, and the complete `LICENSES.chromium.html`.
- [ ] Generate the locked production npm SBOM plus an exact packaged-file and native
      runtime inventory covering Electron, Chromium, FFmpeg, and NSIS.
- [ ] Audit the exact locked JavaScript graphs for known vulnerabilities, scan the
      installer and installed files for malware, and inspect licenses, secrets,
      private paths, source maps, debug services, and unexpected binaries. Native
      runtime CVE coverage is not claimed by the V1 inventory.
- [ ] Generate final SHA-256 checksums and verify Authenticode state. Label every
      artifact unsigned when no release certificate is supplied.
- [ ] Tag the verified commit, publish the release notes and artifacts, re-download
      them, verify checksums, and reinstall once from the public release.

## Post-V1 candidates

- [ ] Evaluate a dedicated signed MCP helper so Electron `RunAsNode` can be disabled.
- [ ] Add optional signed update delivery without making startup or local work depend
      on network availability.
- [ ] Add a relay provider only after a separate identity, authorization, privacy,
      abuse, availability, and recovery design.
- [ ] Expand templates, themes, layouts, accessibility automation, and licensed local
      asset catalogs without adding remote runtime dependencies.
- [ ] Evaluate additional desktop platforms after Windows V1 evidence is stable.
- [ ] Add a preview-only compatibility reader for future unknown document schemas;
      V1 rejects them safely and leaves the source unchanged.
- [ ] Add caret-range rich-text formatting and disconnected text merge after a
      separate editing/undo contract is approved.
- [ ] Return the instrumented packaged warm-start median to the three-second target
      by overlapping renderer loading with fail-safe session initialization and
      covering close-before-initialize plus orphan-journal cleanup races.
- [ ] Reuse already validated document projections and virtualize slide thumbnails
      so large decks do not repeat full-deck validation or mount every thumbnail at
      initial render.
- [ ] Harden exceptional Windows validation-harness cleanup by snapshotting descendant
      process IDs and proving pipe closure after a forced timeout; normal release probes
      already prove native close and complete process-tree exit.

## Explicitly deferred

- Third-party presentation-file interchange.
- Advanced freeform paths and boolean vector operations.
- Simultaneous editing of one text range and disconnected text merge.
- Linked charts, formulas, and live spreadsheet links.
- Transitions, animations, speaker notes, comments, and presenter coaching.
- Cloud accounts, hosted templates, internet relay, and embedded model inference.
