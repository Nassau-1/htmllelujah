# Roadmap and TODO

Status: **V1 release candidate**, last reviewed 2026-07-21.

The usable V1 implementation is present. Publication remains gated by observed
release evidence for the exact Windows installer; unchecked items below must not be
reported as passed until their results are recorded.

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
- [x] Implement authenticated local stdio MCP with typed proposal/commit, revision
      conflicts, attribution, undo, bounded proposal/approval state, one-time
      approvals, import, and export.
- [x] Implement encrypted private-LAN authoritative-host collaboration, optional
      discovery, soft text locks with an owner/read-only editor state, reconnect
      handling, detached guest recovery, and one shared-file writer.
- [x] Implement Windows x64 packaging, `.hdeck` association, second-instance file
      opening, hardened Electron fuses, application icon, and console MCP launcher.

## Release-candidate verification

### Audit blockers closed in source (checkpoint 2026-07-16)

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

- [x] Separate the source-visible proprietary notice from the compiled-application
      license in `EULA.txt`.
- [x] Inventory every direct external dependency and retain the direct runtime
      license texts in `THIRD_PARTY_NOTICES.md`.
- [x] Scope Python-2.0 to the build-only
      `electron-builder -> js-yaml -> argparse@2.0.1` chain without relaxing the
      production allowlist.
- [x] Record application-icon, local-icon, Lucide, Unicode-flag, and font provenance.
- [x] Document the narrow Electron/FFmpeg LGPL runtime exception, evidence, duties,
      and re-review triggers.
- [ ] Obtain qualified legal approval for the Electron/FFmpeg corresponding-source
      mechanism before commercial distribution.
- [ ] Confirm the final installer and installed directory contain `EULA.txt`, the
      project source notice, `THIRD_PARTY_NOTICES.md`, `LICENSE.electron.txt`, and the
      complete `LICENSES.chromium.html`.
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

## Explicitly deferred

- Third-party presentation-file interchange.
- Advanced freeform paths and boolean vector operations.
- Simultaneous editing of one text range and disconnected text merge.
- Linked charts, formulas, and live spreadsheet links.
- Transitions, animations, speaker notes, comments, and presenter coaching.
- Cloud accounts, hosted templates, internet relay, and embedded model inference.
