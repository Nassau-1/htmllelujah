# Operations Guide

Status: V1 release-candidate packaging and operator guidance, 2026-07-16.

## Supported environment

The supported application target is Windows 11 x64. Installation and normal use are
per user and require no administrator privilege. Pure TypeScript packages may build
elsewhere, but that does not establish desktop, print, installer, file-association,
or visual support.

Development requirements:

- Git;
- Node.js 24 or later;
- pnpm 11.13.0 through Corepack; and
- PowerShell 7 recommended for release scripts.

Do not place credentials, certificates, private presentations, recovery records,
machine-specific paths, endpoint descriptors, or real collaboration codes in tracked
files or release evidence.

## Initial setup

Follow the repository freshness rules before changing source. Then install exactly
the locked graph:

```powershell
git status --porcelain
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

The application starts without a cloud credential or model API key. Release signing
credentials, when available, stay in the operating system or CI secret store and are
never added to `.env` or the repository.

## Development loop

```powershell
pnpm dev
```

Before a material change, read the repository constitution, the applicable feature
specification and contracts, and the relevant architecture records:

1. [`.specify/memory/constitution.md`](../.specify/memory/constitution.md);
2. [`specs/002-v1-release`](../specs/002-v1-release/spec.md); and
3. [`docs/decisions`](decisions/ADR-001-structured-document-source.md).

Add verification at the same boundary as the change. A document change needs model
and command tests; a visual change needs renderer and opened-app evidence; a desktop
capability needs validated IPC and packaged Electron coverage; a release change needs
inspection of the exact artifact.

The candidate audit checklist is
[`releases/v1.0.0.md`](releases/v1.0.0.md). Its `PENDING` fields are release blockers
or explicit residual limitations; do not replace them with inferred results. The
separate tracked public notes are
[`releases/v1.0.0-public.md`](releases/v1.0.0-public.md); they must contain no audit
placeholder and must match their exact blob in the candidate commit.

## Source verification

The complete source gate is:

```powershell
pnpm verify
```

It runs formatting checks, type checking, package tests, builds, and the dependency
license policy. Individual commands are available for diagnosis:

```powershell
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm licenses:check
```

Passing source tests is necessary but does not prove the installer, Windows UI,
printing, file association, packaged notices, or exact binary contents. Record those
separately against the candidate artifact.

## Windows packaging

Build the per-user NSIS installer and its exact unpacked companion:

```powershell
pnpm make:win
```

`pnpm package:win` is an alias for the same release-safe pipeline. The pipeline
refuses a dirty index or worktree, checks out the exact commit into a detached
temporary worktree, installs the locked dependencies offline, removes every
workspace package `dist/`, rebuilds all workspace packages sequentially, captures
provenance before the build, and revalidates source and package-output hashes after
packaging. If the pnpm store was intentionally not primed, use
`node scripts/build-windows-release.mjs --online-install` explicitly.

Electron Builder writes only into the detached staging worktree. The exact installer,
blockmap, and complete `win-unpacked/` inventory are attested before a transaction
promotes `apps/desktop/out/` and `artifacts/release-evidence/`. Before the first
rename, the transaction writes and flushes an immutable journal under the repository
parent. A single inter-process lock covers that exact parent. The lock owner includes
host, PID, and the operating system's exact process-start identity, so a live process
cannot be confused with a recycled PID. The journal records the complete source and
prior-destination identities for both directories. A failed build or attestation never
promotes a partial candidate.
The candidate manifest lives at
`artifacts/release-evidence/release-candidate-v1.json`, outside the artifact root, so
the artifact root contains only publishable payload. Do not publish an artifact merely
because packaging completed; run the installed-application lifecycle smoke against
the promoted candidate.

Run the complete candidate-bound matrix as a separate process after promotion:

```powershell
pnpm validate:candidate
```

The command acquires the shared release lock and refuses a dirty source tree, a
different tracked tree or lockfile, a changed artifact inventory, a non-Windows x64
host, or a LAN soak shorter than 30 minutes. It runs the exact unpacked and installed
application for UI, export, MCP, accessibility, text-lock, single-instance, and
installer gates. Source-scoped capacity benchmarks and the three-participant WSS
loopback soak are labelled explicitly rather than represented as packaged or
multi-machine coverage. Every loose report and screenshot is freshness-checked,
privacy-screened, moved into a deterministic ZIP, and removed after collection. The
durable commit marker is
`artifacts/release-evidence/v1-functional-validation.json`; it is written only after
cleanup and binds
`artifacts/release-evidence/v1-functional-validation-evidence.zip` to the exact
candidate, source tree, lockfile, Windows platform, x64 architecture and build, Node
runtime, and pnpm version. A failed rerun removes any prior functional success. Do not
run this command as a child of `make:win`, because the build intentionally owns the
same cross-process lock until promotion is complete.

Promotion is crash-recoverable; two independent directory renames are not presented
as one filesystem primitive. Every journal publication, backup, candidate move,
rollback, commit, and cleanup-tombstone rename is followed by a metadata flush of both
parent directories. On Windows this uses a writable directory handle because a
read-only handle cannot flush directory metadata. Until the journal-hash-bound commit
marker is durable, restart recovery rolls every destination back to the prior
generation. After that marker, recovery keeps the new pair only when both recorded
directory identities and the release-evidence verifier still pass. The verifier runs
after both new directories are in place and again before transaction cleanup. Cleanup
first atomically renames the transaction to a tombstone, so recursive deletion can
never erase the commit marker first. A missing/corrupt control file, unexpected file,
duplicate generation, reparse point, or identity mismatch leaves the transaction
intact and blocks the next build and final publication. Never delete a
`.htmllelujah-release-promotion-*` directory to bypass that failure; preserve it and
investigate the recorded paths and hashes.

Recovery of a previously committed transaction uses the verifier's internal-identity
mode rather than `--require-ready`: `HEAD` may legitimately have advanced after the
crash, but that must not make a self-consistent prior artifact/evidence pair
unrecoverable. This mode only permits cleanup of the committed transaction. It cannot
authorize publication; the finalizer still requires current `HEAD`, the annotated
local tag, and the peeled remote tag to equal the candidate manifest commit.

The packaged Electron fuses keep cookie encryption, embedded ASAR integrity,
ASAR-only loading, disabled `NODE_OPTIONS`, disabled CLI inspection, and restricted
file-protocol privileges. `RunAsNode` is enabled only to support the console stdio MCP
launcher; the accepted tradeoff is documented in
[`ADR-008`](decisions/ADR-008-local-stdio-mcp.md).

When no Authenticode certificate is configured, the filename and release notes must
say **unsigned** and explain that Windows may display a reputation warning. Do not
disable sandboxing, fuses, archive checks, or antivirus scanning to avoid that prompt.
When a certificate is configured, sign and timestamp the installer, application, and
uninstaller as applicable, then verify each signature on the candidate machine.

## Opened-application smoke tests

At minimum, test both the unpacked application and the installed application on
Windows 11 x64:

- launch, ready state, clean exit, and second-instance focus;
- create, edit, undo, redo, save, close, reopen, and Save As;
- open a `.hdeck` from both the app and Windows Explorer;
- recover a deliberately interrupted edit as an independent candidate;
- text, table TSV paste, image, shape, connector, icon, flag, grouping, layers,
  snapping, alignment, lock, visibility, theme, layout, and master controls;
- presentation start, slide navigation, hidden-slide behavior, Escape, and return to
  unchanged editor state;
- standalone HTML opened offline and PDF opened in an independent viewer;
- keyboard navigation, visible focus, reduced motion, display scaling, and basic
  screen-reader names;
- offline startup with network access unavailable; and
- normal exit with no hidden print window or orphaned process.

For the local MCP bridge, the desktop package exposes a focused Electron smoke:

```powershell
pnpm --filter @htmllelujah/desktop smoke:electron:mcp
```

The release gate must exercise the exact packaged companions, not the source fallback:

```powershell
$env:HTMLLELUJAH_EXECUTABLE = 'C:\path\to\HTMLlelujah.exe'
$env:HTMLLELUJAH_MCP_LAUNCHER = 'C:\path\to\HTMLlelujah-MCP.cmd'
node .\apps\desktop\scripts\smoke-mcp-electron.mjs
```

The harness performs valid launcher shutdown and restart, isolated authentication
failures, the complete V1 tool-catalogue check, bounded reads, non-mutating proposals,
approved commit and undo, stale and atomic rejection, capability denial, renderer/MCP
convergence, and the 64-proposal and 32-approval capacity boundaries. It atomically
writes `artifacts/evidence/mcp-v1.json`; a failed run replaces any prior success with a
redacted failure marker and exits non-zero. Evidence contains artifact hashes and
assertion summaries only, never document/session/revision IDs, endpoint material,
approval values, local paths, or stderr.

Long wall-clock TTL purge, execution from a distinct Windows account, and successful
native chooser import/export remain separate deterministic or Windows system gates.
The packaged MCP smoke verifies their fail-closed descriptor/capability paths without
waiting several minutes or opening a native chooser.

The native Save As, HTML, and PDF dialog workflow and the Electron accessibility and
scaling workflow have dedicated Windows harnesses:

```powershell
pnpm --filter @htmllelujah/desktop smoke:electron:exports
pnpm --filter @htmllelujah/desktop build
node .\apps\desktop\scripts\smoke-accessibility-scaling-windows.mjs
```

For an unpacked or installed candidate, set `HTMLLELUJAH_EXECUTABLE` to its exact
`HTMLlelujah.exe` before the accessibility command. The harness checks semantic
controls, keyboard focus, reduced motion, containment at a compact 1120 by 720
viewport, and 100%, 125%, 150%, and 200% forced device scaling. It does not simulate
spoken output, a real GPU/monitor combination, Narrator, or NVDA. A recorded manual
Narrator or NVDA pass remains necessary for release-level assistive-technology
confidence; if it is not performed, the release record must say so as a limitation.

The exact installed-launcher invocation above is still not a substitute for the
separate native import/export chooser smoke or a different-account Windows boundary
test.

## Installer and file-association tests

Run the following on a clean standard-user Windows account:

1. verify the candidate SHA-256 and signature state before execution;
2. install without elevation and launch from the final install directory;
3. open a synthetic `.hdeck` by double-click and confirm the existing single app
   instance receives it;
4. reject malformed file-open arguments and non-`.hdeck` protocols;
5. install the candidate over the preceding supported version while a deck and a
   recovery candidate exist;
6. repair or reinstall without deleting user decks or recovery data;
7. uninstall while the app is closed and verify presentations remain; and
8. confirm the uninstaller does not silently remove the recovery directory.

The release record must distinguish tests performed on an unpacked directory from
tests performed after NSIS installation.

## Runtime data and recovery

User-selected `.hdeck` files remain wherever the user saves them. Private application
state is rooted under `%APPDATA%\HTMLlelujah` and includes:

- `recovery/` for base snapshots, checksummed journals, metadata, and asset blobs; and
- `mcp/endpoint-v1.json` for the expiring local MCP endpoint while the desktop runs.

Every committed edit is appended to the private recovery journal before local
durability is acknowledged. Recovery blob cleanup uses bounded mark-and-sweep passes
that preserve document, journal, history, staged, and current-session references. The
journal is the recovery autosave; it does not silently replace the user-selected
`.hdeck`. Explicit Save or Save As creates the verified file snapshot.

Image import reads at most 25 MiB, parses a bounded PNG/JPEG/WebP header before pixel
decode, and requires decoded dimensions to match. Asset registration plus insertion
or replacement is one durable command transaction and one undo step; failed imports
do not leave an orphaned document reference.

Do not ask a user to delete recovery data as the first troubleshooting step. Preserve
the original `.hdeck`, list recovery candidates in the app, open the candidate, verify
its content, and use Save As. Delete or archive private recovery state only after the
user has confirmed a good independent file.

Explicit Save checks the target fingerprint, writes and validates a temporary sibling,
and atomically replaces the file. If a synchronized-folder service changed the target,
do not bypass the conflict. Reload the changed file, save the current state as an
independent copy, or cancel and reconcile deliberately.

## LAN collaboration operations

Collaboration is intended only for trusted participants on a private LAN. A
synchronized folder may hold the same `.hdeck`, but the direct WSS session is the
live command transport and the host is the only shared-file writer in that session.

Use the lease as an enforcement mechanism only on a coherent shared filesystem such
as SMB/NAS. With a consumer-synchronized local folder, designate one host out of band
and have everyone else join it. Do not start two host sessions: both local replicas
can acquire a lease before the synchronization service propagates either sidecar.

- Share the endpoint, session code, and certificate fingerprint through a trusted
  channel; treat all three as sensitive session data.
- Verify the fingerprint before joining. Do not accept a changed fingerprint without
  restarting and reconfirming the session.
- Enable discovery only on a private network. Discovery is convenience, not
  authentication.
- Guests must not use folder-sync conflict resolution to overwrite the host file.
- If a guest falls outside the retained command window or the host disappears, leave
  and rejoin. Do not attempt an offline merge in V1.
- To fork intentionally, leave the session and use Save As for an independent file.

Do not include join codes, endpoints, fingerprints, display names, filenames, or deck
content in diagnostics or public screenshots.

## Local MCP operations

The desktop must be running before `HTMLlelujah-MCP.cmd` starts. The MCP launcher
reads the current endpoint descriptor from the user's application-data directory and
authenticates to a random local named pipe. It does not listen on the LAN.

Only visible open documents are readable. A user issues short-lived approvals from
the desktop Codex panel for destructive commit, agent undo, import, HTML export, or
PDF export. Approval IDs and the endpoint descriptor are secrets: do not paste them
into logs, configuration examples, or issue reports.

V1 accepts at most 100 commands in a proposal and 2 MiB per MCP frame or encoded
result. The desktop retains at most 64 proposals (one-minute default expiry), 32
unconsumed approvals (two-minute expiry), and 64 consumed receipts (30-second expiry).
New work is rejected at capacity; expired entries are purged instead of accumulating.

If the bridge reports unavailable:

1. confirm the desktop is running under the same Windows account;
2. reopen the deck so it is visible;
3. stop stale MCP client processes and start a fresh launcher;
4. restart the desktop to rotate the endpoint descriptor; and
5. inspect only redacted stderr and safe error codes.

Do not hand-edit `endpoint-v1.json` or relax its validation. Agent mutations are
intentionally unavailable during an active LAN session in V1.

## Dependency, notice, and asset review

Dependency additions and upgrades must:

1. solve a documented requirement;
2. use an allowed runtime license or receive a scoped recorded review;
3. update the lockfile and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md);
4. update [`docs/legal/asset-provenance.md`](legal/asset-provenance.md) for visual
   assets;
5. regenerate the release SBOM; and
6. pass installed offline tests.

`policy/licenses.json` permits Python-2.0 only as the reviewed build-only
`electron-builder -> js-yaml -> argparse@2.0.1` chain. It remains blocked from the
production graph. LGPL remains blocked for npm runtime dependencies; Electron's
separate unmodified FFmpeg binary has its own narrow review in
[`docs/legal/electron-runtime-license-review.md`](legal/electron-runtime-license-review.md).
That document is an engineering compliance record, not legal advice. Qualified legal
approval of the corresponding-source mechanism remains pending and is required before
commercial distribution.

The installer and installed directory must contain `EULA.txt`, the project source
notice, `THIRD_PARTY_NOTICES.md`, `LICENSE.electron.txt`, and
`LICENSES.chromium.html`. Missing notices block publication.

## SBOM, inventory, and checksums

Generate the locked production npm SBOM:

```powershell
pnpm sbom:generate
```

That graph does not by itself enumerate Electron's Chromium and FFmpeg binaries, the
NSIS runtime, or every packaged file. The release record must also inventory the
exact installer and installed directory, identify Electron/Chromium/FFmpeg and NSIS,
and scan the final artifact for vulnerabilities and licenses.

Generate SHA-256 values only after the artifact is final:

```powershell
Get-FileHash -Algorithm SHA256 .\apps\desktop\out\<artifact-name>
Get-AuthenticodeSignature .\apps\desktop\out\<artifact-name>
```

Publish the checksum in a separate release file and in release notes. A checksum
detects accidental change; it does not replace an authenticated signature.

## Packaged-content inspection

Before publication, inspect the exact candidate for:

- source maps, tests, fixtures, development servers, debug ports, and duplicate source
  trees;
- `.env` files, tokens, keys, certificates, endpoint descriptors, recovery records,
  private paths, usernames, or real decks;
- missing EULA, project, dependency, Electron, Chromium, and asset notices;
- unexpected native binaries, DLLs, codecs, archives, or executables;
- a production dependency carrying a build-only exception; and
- artifact names or metadata that incorrectly imply signing.

Keep a machine-readable file list and hashes with the release evidence. Scan the
installer after it is built; source and lockfile scans alone are insufficient.

## Release checklist

1. Start from a clean, current commit and install with the committed lockfile.
2. Run `pnpm verify` and all feature-specific unit, integration, adversarial,
   recovery, MCP, LAN, accessibility, visual, PDF, soak, and performance gates.
3. Build the unpacked directory and NSIS installer. Run `pnpm validate:candidate` to
   execute and record the opened-app, export, MCP, accessibility, performance, LAN,
   and installer checks against that exact promoted candidate.
4. Review packaged contents, notices, asset provenance, runtime licenses, SBOM, and
   vulnerability results.
5. Verify version, application identity, `.hdeck` association, signature state,
   checksums, and unsigned labelling when applicable.
6. Update `CHANGELOG.md`, `TODO.md`, release notes, and the release evidence with only
   observed results.
7. Tag and push exactly `release-candidate-v1.json.source.commit`, then generate the
   final publication record as described below. Publish only its listed assets plus
   that record under the verified remote tag.
8. Re-download the published installer, checksum, and final record; verify them,
   install once more, and retain the prior verified installer for rollback.

### Final tag and publication record

Perform this only after every candidate-specific smoke and review is complete. The
tag must already exist on the remote before the final record can be generated:

```powershell
$candidate = Get-Content .\artifacts\release-evidence\release-candidate-v1.json -Raw |
  ConvertFrom-Json
git tag -a v1.0.0 $candidate.source.commit -m "HTMLlelujah 1.0.0"
git push origin refs/tags/v1.0.0
node scripts/finalize-windows-release.mjs --tag v1.0.0 --remote origin
# Or create and verify the exact draft:
node scripts/finalize-windows-release.mjs --tag v1.0.0 --remote origin --publish-draft
# Or verify the draft, publish it as Latest, and verify the public downloads:
node scripts/finalize-windows-release.mjs --tag v1.0.0 --remote origin --publish
```

The finalizer fails closed unless the worktree is clean, no promotion journal is
pending, the remote is exactly `github.com/Nassau-1/htmllelujah`, and `HEAD`, the
peeled annotated local tag, and the already-pushed peeled remote tag all equal
`candidateManifest.source.commit`. The direct local and remote annotated tag object
IDs must also be identical. The promoted candidate then passes the complete
release-evidence verifier again. The finalizer also requires the canonical functional
JSON and ZIP above, reconstructs every bundled proof, independently recalculates the
Windows platform/architecture/build, Node runtime, pnpm version, source tree,
lockfile, and full artifact inventory, and enforces the 30-minute LAN minimum. It
repeats that exact state check before and after record creation and around every remote
publication or download phase. Both functional files are mandatory public assets and
are re-downloaded by SHA-256. The
default notes file is the tracked
`docs/releases/v1.0.0-public.md`; ignored, untracked, modified, linked, or placeholder
notes are refused. The finalizer writes
`artifacts/release-assets/HTMLlelujah-<version>-<commit>-release-record.json` and its
SHA-256 to stdout. `artifacts/` is ignored, so the record is a release asset, not a
tracked-source edit. It references the immutable candidate/evidence hashes but is not
included in its own hash set; this avoids a generated-commit or self-hash loop. Record
creation is write-once and mode-independent: a draft-to-public rerun reuses only the
byte-identical record and never clobbers it.

Electron Builder always remains on `--publish never`, and release child processes do
not inherit token environment variables or `GH_HOST`. Before `--publish-draft` or
`--publish`, authenticate the GitHub CLI credential store explicitly:

```powershell
gh auth status --hostname github.com
```

Publication is pinned to the qualified `github.com/Nassau-1/htmllelujah` repository.
It refuses an ambiguous API error, uploads only the allowlisted paths plus the final
record, verifies title/body/state/API URLs/digests, and re-downloads every asset into
an isolated directory for size and SHA-256 comparison. An exact partial draft may be
resumed by uploading only missing allowlisted assets; extras or mismatches fail
closed. An exact existing draft can be promoted, and an exact existing public release
can be audited after an interrupted client. Public audit failure never automatically
returns a visible release to draft. Initial publication sets V1 as Latest; a later
rerun fails closed if another release has become Latest rather than silently
reordering releases. Source/tag/repository identities are rechecked before and after
each remote mutation and download phase.

## Incident containment

For a security or data-integrity issue:

1. stop publishing the affected artifact;
2. preserve sanitized evidence and exact build identifiers;
3. rotate or revoke the narrow affected session capability where possible;
4. issue a fixed build or documented rollback path;
5. coordinate disclosure through the private security-reporting channel;
6. record user-visible impact in the changelog; and
7. add a regression fixture before restoring the affected surface.
