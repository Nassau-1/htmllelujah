# V1 Test Matrix

Status: Normative release matrix, 2026-07-15.

Passing unit tests or browser preview is insufficient. Every release candidate must
exercise the packaged Windows application and the exact installer artifact.

## Test levels

| Level               | Purpose                                                                      | Required environment                 |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| Unit                | Pure schemas, commands, migration, projection, geometry, framing             | Windows and CI runners               |
| Property            | Invariants over generated documents, transforms, command sequences, archives | Seeded and replayable CI             |
| Component           | Renderer, editor widgets, rich text, tables, masters, accessibility          | Bundled Chromium                     |
| Process integration | Main/preload/renderer isolation, IPC, windows, files, MCP                    | Packaged Electron app                |
| System              | Save/recovery, export, collaboration, installer, file association            | Clean Windows 11 x64 VMs             |
| Visual              | Cross-mode geometry, pixels, fonts, page boxes                               | Designated Windows reference machine |
| Adversarial         | Malformed archives, images, clipboard, IPC, MCP, LAN                         | Isolated test environment            |
| Manual              | Screen reader, signing, UX, recovery decisions, multi-display                | Recorded release checklist           |

## Reference environments

- Windows 11 x64, current supported update, standard non-administrator user.
- Display scaling at 100%, 125%, 150%, and 200%.
- 1440 × 900, 1920 × 1080, portrait, and ultrawide display configurations.
- Offline mode with all network adapters disabled.
- Private same-LAN mode with two physical or virtual Windows machines.
- Synchronized-folder simulation with delayed writes, locks, rename, and external
  modification.
- Clean VM snapshots for install, upgrade, rollback, and uninstall.

## Document schema, validation, and migration

| ID      | Scenario                             | Oracle                                                          | Edge coverage                               | Gate    |
| ------- | ------------------------------------ | --------------------------------------------------------------- | ------------------------------------------- | ------- |
| DOC-001 | Parse every valid V2 entity          | Exact typed round-trip and stable revision                      | All element unions, empty optional fields   | Merge   |
| DOC-002 | Reject unknown and incomplete fields | Stable validation codes and paths                               | Unknown discriminants, unknown keys         | Merge   |
| DOC-003 | Reference validation                 | No missing theme/master/layout/asset/connector/placeholder refs | Nested groups and deleted targets           | Merge   |
| DOC-004 | Limits                               | Reject before expensive traversal or allocation                 | 501 slides, deep group, huge strings/tables | Release |
| DOC-005 | V1 → V2 migration                    | Deterministic canonical V2 fixture                              | Empty content, legacy placeholder absence   | Release |
| DOC-006 | Migration chain repeat               | Same output and report for repeated source                      | Interrupted migration and retry             | Release |
| DOC-007 | Newer schema                         | Typed compatibility refusal; original unchanged                 | Unknown container/document versions         | Release |
| DOC-008 | Canonical serialization              | Identical hash for equivalent object-key order                  | Unicode normalization and array order       | Merge   |

Property suite generates bounded valid documents, applies arbitrary valid command
sequences, and asserts: input immutability, output validity, stable unique IDs,
reference closure, deterministic revision, and exact serialize/parse round-trip.

## Commands, history, and sessions

| ID      | Scenario                          | Oracle                                        | Edge coverage                             | Gate    |
| ------- | --------------------------------- | --------------------------------------------- | ----------------------------------------- | ------- |
| CMD-001 | Every command succeeds atomically | One revision and one event                    | Root and nested containers                | Merge   |
| CMD-002 | Invalid batch                     | No partial mutation or history step           | Failure on first, middle, final command   | Merge   |
| CMD-003 | Stale revision                    | `REVISION_CONFLICT`; unchanged session        | Local, MCP, remote origins                | Merge   |
| CMD-004 | History grouping                  | One action equals one undo item               | Drag events, text idle commits, TSV paste | Release |
| CMD-005 | Undo/redo                         | Exact semantic and visual round-trip          | Deletes, groups, layout switch, assets    | Release |
| CMD-006 | History bounds                    | Evicts oldest complete group only             | Count and 64 MiB memory limits            | Release |
| CMD-007 | Multiple sessions                 | No event, history, asset, or approval leakage | Same document ID in independent copy      | Release |
| CMD-008 | Close with pending work           | Save/Discard/Cancel decision is honored       | Journal pending and conflict states       | Release |

## Geometry and editor interactions

| ID      | Scenario                 | Oracle                                      | Edge coverage                             | Gate    |
| ------- | ------------------------ | ------------------------------------------- | ----------------------------------------- | ------- |
| GEO-001 | Move                     | Shared delta preserves relative spacing     | Page edge, negative start, mixed rotation | Merge   |
| GEO-002 | Resize                   | Positive finite frames and correct anchor   | Cross-over, min size, rotated element     | Merge   |
| GEO-003 | Rotate                   | Stable center and normalized angle          | 0/90/180/270 and wraparound               | Merge   |
| GEO-004 | Snap                     | Closest valid guide wins deterministically  | Equal candidates, zoom threshold          | Merge   |
| GEO-005 | Align/distribute         | Defined visual bounds and equal gaps        | Mixed dimensions and rotations            | Merge   |
| GEO-006 | Group/ungroup            | Visual frames and Z-order round-trip        | Nested rotations and non-uniform scale    | Release |
| UI-001  | Keyboard editing         | Named focus, selection, nudge, delete, undo | Locked object and native control focus    | Release |
| UI-002  | Approved chrome parity   | Reviewed baselines within threshold         | All responsive breakpoints                | Release |
| UI-003  | No fixture mutation path | Static check and runtime command spy        | All toolbar and inspector actions         | Hard    |

Property tests generate finite frames and gesture deltas and assert no NaN, Infinity,
negative size, spacing collapse, nondeterministic snap, or input mutation.

## Rich text and clipboard

| ID      | Scenario                 | Oracle                                         | Edge coverage                                 | Gate    |
| ------- | ------------------------ | ---------------------------------------------- | --------------------------------------------- | ------- |
| TXT-001 | Blocks and marks         | Canonical typed content round-trip             | Mixed marks, H1–H6, nested lists              | Release |
| TXT-002 | Element/block formatting | Typed marks apply without flattening structure | Mixed runs, lists, heading, entire element    | Release |
| TXT-003 | IME                      | No duplicate/lost composition                  | Accents, CJK, emoji, RTL                      | Release |
| TXT-004 | Undo boundary            | Local edit session becomes one document group  | Undo during edit and after blur               | Release |
| TXT-005 | Rich paste               | Allowlisted semantics only                     | Scripts, remote images, styles, unknown nodes | Hard    |
| TXT-006 | Long text                | Bounded behavior and visible overflow warning  | Unbroken string, maximum blocks/runs          | Release |
| TXT-007 | Font fallback            | Bundled font or explicit warning               | Missing or corrupt font asset                 | Release |

## Themes, masters, and layouts

| ID      | Scenario          | Oracle                                         | Edge coverage                           | Gate    |
| ------- | ----------------- | ---------------------------------------------- | --------------------------------------- | ------- |
| MST-001 | Projection order  | Master → layout → bound → local                | Hidden and locked inherited elements    | Merge   |
| MST-002 | Style resolution  | Exact effective style values                   | Partial local override and missing role | Merge   |
| MST-003 | Layout change     | Compatible content preserved                   | Duplicate roles and unmatched content   | Release |
| MST-004 | Reset to layout   | Overrides removed; content retained            | Moved/resized/restyled placeholder      | Release |
| MST-005 | Master update     | Non-overridden slides update deterministically | Existing local overrides                | Release |
| MST-006 | Delete dependency | Typed refusal or explicit remap                | Last theme/master/layout                | Release |

## Images, tables, shapes, connectors, icons, and flags

| ID      | Scenario             | Oracle                                    | Edge coverage                                   | Gate    |
| ------- | -------------------- | ----------------------------------------- | ----------------------------------------------- | ------- |
| AST-001 | Import PNG/JPEG/WebP | Correct signature, hash, size, dimensions | Wrong extension, alpha, color profile           | Release |
| AST-002 | Invalid image        | Atomic rejection and no asset entry       | Truncated, huge dimensions, decode failure      | Hard    |
| AST-003 | Asset deduplication  | Same bytes reuse one content entry        | Different original names                        | Release |
| AST-004 | Crop/fit/replace     | Editor/export parity and stable alt text  | Extreme crop and aspect ratios                  | Release |
| TBL-001 | Native table editing | Cell text/style persists                  | Empty cells, header, large bounded table        | Release |
| TBL-002 | TSV paste            | Literal rectangular result                | Uneven rows, quotes, newlines, formula prefixes | Release |
| TBL-003 | Row/column mutation  | Spans and dimensions remain valid         | Delete final row/column and merged cells        | Release |
| VEC-001 | Shape catalog        | DOM/SVG parity across modes               | Every shape, stroke, fill, opacity              | Release |
| VEC-002 | Connectors           | Endpoint follows bound object             | Target delete, hide, group, rotate              | Release |
| VEC-003 | Built-in catalogs    | Correct ID/version and bundled asset      | Missing ID and catalog mismatch                 | Hard    |
| VEC-004 | Asset licensing      | Hash and notice match provenance ledger   | Icon and every round-flag entry                 | Hard    |

## `.hdeck`, save, and recovery

| ID      | Scenario              | Oracle                                         | Edge coverage                                     | Gate    |
| ------- | --------------------- | ---------------------------------------------- | ------------------------------------------------- | ------- |
| ARC-001 | Archive round-trip    | Exact document and asset hashes                | Optional preview/notices absent                   | Release |
| ARC-002 | Hostile names/types   | Reject before extraction/use                   | Traversal, absolute, NUL, symlink, case collision | Hard    |
| ARC-003 | Zip bomb/limits       | Bounded rejection without memory spike         | Count, size, ratio, nested compression            | Hard    |
| ARC-004 | Corrupt integrity     | Stable rejection                               | CRC, SHA, size, missing/extra entry               | Hard    |
| ARC-005 | Deterministic output  | Same logical input gives stable entries/hashes | Timestamps and entry ordering                     | Release |
| SAV-001 | Manual save           | Verified archive and clean durability          | Existing/new target                               | Release |
| SAV-002 | Autosave              | Idle and maximum interval respected            | Continuous typing and presentation                | Release |
| SAV-003 | Atomic failure matrix | Last target or valid recovery always remains   | Fail every write/flush/verify/replace step        | Hard    |
| SAV-004 | Windows locks         | Bounded retry and safe failure                 | Antivirus/sync lock, `EPERM`, `EBUSY`             | Release |
| SAV-005 | External change       | Conflict; no overwrite                         | Same timestamp/different hash                     | Hard    |
| REC-001 | Truncated journal     | Replay valid prefix only                       | Truncate every byte position of final frame       | Hard    |
| REC-002 | Recovery mismatch     | Independent recovered copy                     | Document ID/base revision mismatch                | Release |
| REC-003 | Compaction            | Only after verified snapshot                   | Crash during compaction                           | Hard    |
| REC-004 | Repeated reliability  | No leaked temp/journal corruption              | 100 saves and 25 forced terminations              | Hard    |

## Shared renderer, presentation, HTML, and PDF

| ID       | Scenario               | Oracle                                     | Edge coverage                             | Gate    |
| -------- | ---------------------- | ------------------------------------------ | ----------------------------------------- | ------- |
| RND-001  | One renderer           | Static dependency check and shared fixture | All five modes                            | Hard    |
| RND-002  | Geometry               | Object edges within 0.25 pt                | Every page preset and zoom                | Hard    |
| RND-003  | Overlay exclusion      | No editor-only node in non-editor modes    | Selection, caret, guides, locks, presence | Hard    |
| RND-004  | Readiness              | Waits for fonts/images/stable geometry     | Timeout, missing asset, decode failure    | Hard    |
| PRE-001  | Presentation lifecycle | Letterbox, navigate, Escape, state restore | Portrait/ultrawide/missing display        | Release |
| HTML-001 | Offline standalone     | Opens with network disabled                | Unicode, all assets, hidden slides        | Hard    |
| HTML-002 | Export security        | Restrictive CSP; no authoring capability   | Attempted navigation/fetch/script         | Hard    |
| PDF-001  | Page boxes             | Within 0.1 pt and correct page count       | 16:9, 4:3, A4 landscape                   | Hard    |
| PDF-002  | Raster fidelity        | Reviewed diff under inherited threshold    | Text, raster, vectors, tables             | Hard    |
| PDF-003  | Failure cleanup        | No partial target/window/process           | Cancel, timeout, disk full, lock          | Hard    |
| EXP-001  | Repeated export        | No leak after 50 mixed exports             | HTML and PDF alternating                  | Hard    |

## Desktop security and IPC

| ID      | Scenario                   | Oracle                                       | Edge coverage                           | Gate |
| ------- | -------------------------- | -------------------------------------------- | --------------------------------------- | ---- |
| SEC-001 | Process preferences        | Sandbox/context isolation on; Node off       | Every renderer window                   | Hard |
| SEC-002 | Navigation/resource denial | Remote requests, popups, permissions denied  | Redirect and unsafe protocols           | Hard |
| SEC-003 | IPC validation             | Unknown/oversized/malformed request rejected | Every exposed method                    | Hard |
| SEC-004 | Opaque file capabilities   | Renderer never receives or submits path      | Open/save/import/export/association     | Hard |
| SEC-005 | Asset capability           | Session and expiry enforced                  | Cross-session and stale URL             | Hard |
| SEC-006 | Diagnostic redaction       | No content/environment data                  | Success, error, crash, export, LAN, MCP | Hard |
| SEC-007 | Offline startup            | No request leaves machine                    | Cold and warm start                     | Hard |

## MCP

| ID      | Scenario          | Oracle                                          | Edge coverage                      | Gate    |
| ------- | ----------------- | ----------------------------------------------- | ---------------------------------- | ------- |
| MCP-001 | Stdio lifecycle   | Initialize/list/call/shutdown succeeds          | Client exit and restart            | Release |
| MCP-002 | Stdout purity     | Protocol frames only                            | Warnings, crash, validation errors | Hard    |
| MCP-003 | Authentication    | Current launch nonce and user required          | Reuse, wrong user, expired nonce   | Hard    |
| MCP-004 | Read tools        | Correct bounded projections                     | Empty, large, closed document      | Release |
| MCP-005 | Mutation tools    | Revision-aware attributable one-batch edit      | Stale/invalid/mixed batch          | Hard    |
| MCP-006 | Approvals         | Purpose/session/expiry/single use enforced      | Reuse and operation mismatch       | Hard    |
| MCP-007 | Capability denial | No path, URL, shell, raw HTML, raw state access | Fuzzed tool names and schemas      | Hard    |
| MCP-008 | Undo parity       | MCP batch appears and undoes as one action      | Later human edit and stale undo    | Release |

## Authoritative-host LAN collaboration

| ID      | Scenario             | Oracle                                                                  | Edge coverage                            | Gate    |
| ------- | -------------------- | ----------------------------------------------------------------------- | ---------------------------------------- | ------- |
| LAN-001 | Private discovery    | Ephemeral metadata only                                                 | Packet inspection and expiry             | Hard    |
| LAN-002 | Join authentication  | Confirmed actor and encrypted channel                                   | Invalid/expired/replayed capability      | Hard    |
| LAN-003 | Ordered commands     | Identical host sequence and revision on peers                           | Simultaneous independent commands        | Hard    |
| LAN-004 | Stale peer command   | Atomic rejection and resync                                             | Gap, duplicate, reordered frame          | Hard    |
| LAN-005 | Text lock            | One editor; visible owner; lease expiry                                 | Race, disconnect, clock skew             | Hard    |
| LAN-006 | Presence             | Rate-limited and not persisted                                          | Slow peer and malformed presence         | Release |
| LAN-007 | Reconnect            | Resume acknowledged sequence within window                              | Missed transactions and snapshot refresh | Release |
| LAN-008 | Reconnect expiry     | Peer becomes read-only; no queued edit merge                            | Local draft and active composition       | Hard    |
| LAN-009 | Host loss            | No election or shared overwrite                                         | Kill, network loss, sleep                | Hard    |
| LAN-010 | One file writer      | Only host writes in-session; coherent-share lease rejects second writer | Peer save, SMB lease, replica warning    | Hard    |
| LAN-011 | Independent copy     | New document ID after explicit leave                                    | Recovery records and embedded assets     | Release |
| LAN-012 | Network-class change | Hosting stops or requires confirmation                                  | Private to public transition             | Hard    |

Run at least a thirty-minute three-participant soak with object edits, text lock
contention, asset insertion, save, reconnect, and host termination. Accepted sequence,
final canonical hash, and host snapshot must agree.

## Accessibility

| ID       | Scenario                    | Oracle                                                 | Gate    |
| -------- | --------------------------- | ------------------------------------------------------ | ------- |
| A11Y-001 | Keyboard-only full workflow | No trap; visible focus; all critical actions reachable | Hard    |
| A11Y-002 | Accessible names/states     | Automated scan plus manual inspection                  | Hard    |
| A11Y-003 | Screen-reader smoke         | Create/open/edit/save/export/recovery announcements    | Release |
| A11Y-004 | Contrast and scaling        | WCAG 2.2 AA at all supported scaling                   | Hard    |
| A11Y-005 | Reduced motion              | No essential motion or inaccessible animation          | Release |

## Packaging, upgrade, and uninstall

| ID      | Scenario                          | Oracle                                                                    | Edge coverage                                                      | Gate    |
| ------- | --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------- |
| PKG-001 | Provenance and optional signature | App and installer checksums verify; Authenticode verifies when configured | Tampered artifact rejection and explicitly labelled unsigned build | Hard    |
| PKG-002 | Per-user install                  | Standard user installs and launches                                       | Unicode user profile and long path                                 | Hard    |
| PKG-003 | File association                  | Existing single instance opens deck                                       | Malformed command line and missing file                            | Hard    |
| PKG-004 | Offline operation                 | All local workflows pass                                                  | First launch after install                                         | Hard    |
| PKG-005 | Upgrade                           | Decks/recovery/settings preserved                                         | Running app and pending recovery                                   | Hard    |
| PKG-006 | Rollback                          | Prior verified build restores when compatible                             | Migrated deck opens read-only if needed                            | Release |
| PKG-007 | Uninstall                         | Presentations remain; cache requires separate choice                      | Locked file and repair install                                     | Hard    |

## Performance and capacity

Measure on the reference pilot machine with release builds:

- warm interactive start under 3 seconds;
- local p95 command acknowledgement under 100 ms;
- gesture preview p95 under 16.7 ms with a 2,000-element deck;
- LAN p95 accepted-command round trip under 250 ms;
- open and validate a 500-slide supported-limit deck without unbounded memory growth;
- save and reopen a 500 MiB expanded-limit fixture within documented time and memory
  budgets;
- presentation navigation p95 under 100 ms after assets are ready.

Performance failure blocks release if it violates an NFR or creates lost input,
unresponsive recovery, watchdog termination, or memory exhaustion.

## License, provenance, SBOM, and public hygiene

- Production and build dependency license scans pass the repository policy.
- Every bundled font, icon, and round-flag asset has source, license, notice, version,
  and SHA-256 in the provenance ledger.
- CycloneDX SBOM matches the locked distributable dependency graph.
- No production dependency is fetched at runtime.
- Secret and private-context scans cover source, fixtures, screenshots, logs, symbols,
  installer metadata, and generated export baselines.
- Diagnostics fixtures prove slide text, filenames, paths, network addresses, tokens,
  capabilities, and bytes are absent.

Any missing provenance, unapproved license, secret, private context, or undeclared
runtime component is a hard release blocker.

## Required release record

The release candidate record must contain:

- commit and reproducible build identity;
- artifact hashes, provenance, unsigned/signed status, and signature verification when
  configured;
- test matrix results and replay seeds;
- reviewed visual/PDF baseline references;
- Windows environment and scaling coverage;
- archive/recovery/MCP/LAN adversarial results;
- thirty-minute LAN soak result;
- performance measurements;
- SBOM, license report, asset provenance, and notices;
- all deviations, waived tests, baseline changes, or residual risks.

No hard-gate waiver is permitted for V1. A failed hard gate returns the release to
implementation; it is not documented away.
