# Operations Guide

Status: Alpha development guidance, 2026-07-15.

## Supported development environment

Desktop acceptance testing targets Windows 11 x64. Pure TypeScript packages may run
in other development environments, but that does not establish desktop support.

Required tools:

- Git;
- Node.js 24 or later;
- pnpm 11.13.0 through Corepack;
- PowerShell 7 recommended for repository scripts.

Do not place credentials, certificates, real presentation files, or machine-specific
paths in tracked files.

## Initial setup

```powershell
git status --porcelain
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

If no lockfile exists during initial bootstrapping, run `pnpm install` once, review
the dependency and license diff, and commit the resulting lockfile before treating
the repository as reproducible.

Create local configuration only from `.env.example`. The application must start
without cloud credentials or an API key.

## Development loop

```powershell
pnpm dev
```

Before a material change, read:

1. [the constitution](../.specify/memory/constitution.md);
2. the applicable `spec.md`, `plan.md`, and `tasks.md` under `specs/`;
3. relevant records under [`docs/decisions`](decisions/ADR-001-structured-document-source.md).

Keep one task checkbox in progress conceptually, make the smallest coherent change,
and add verification at the same layer as the changed behavior. If implementation
invalidates an assumption, update the spec or decision record before continuing.

## Verification

Run the complete local gate:

```powershell
pnpm verify
```

It must cover formatting, type checking, tests, and builds. Desktop changes also
require a Windows smoke test for:

- application start and clean exit;
- renderer sandbox and preload API availability;
- offline startup with network access disabled;
- keyboard navigation and visible focus;
- presentation and PDF output when those surfaces are affected.

At the current Alpha stage, the automated gate validates the source foundations,
including document-core unit tests and application builds. It does not by itself
prove a distributable Windows binary, `.hdeck` persistence, shared-renderer fidelity,
presentation, export, MCP, or collaboration. Do not report those capabilities as
verified until their feature-specific suites and manual Windows gates exist and pass.

Rendering changes require refreshed baselines only when the visual difference is
intentional and documented. Review the image diff before accepting a baseline; do
not use baseline regeneration to hide a regression.

## Diagnostic artifacts

Diagnostics are local and opt-in. Exported bundles may contain:

- application and operating-system versions;
- feature flags;
- sanitized error codes and stack frames;
- renderer timings and object counts;
- document schema version and content-free structural counts.

They must not contain slide text, notes, embedded assets, filenames, absolute paths,
collaboration capabilities, tokens, or document-state payloads. Add a test whenever
the diagnostic schema changes.

## Recovery

Recovery is not implemented in the current Alpha foundation. When introduced,
development and Alpha builds must maintain recovery state under the application data
directory, never inside the repository. Recovery records must be scoped by document
ID and build/schema version.

When opening a recovered document:

1. preserve the original snapshot;
2. validate the journal and asset hashes;
3. migrate into a new candidate rather than mutating the original;
4. show the user the candidate timestamp and validation result;
5. require an explicit Save or Save As before replacing the authoring file.

Never ask a user to delete recovery data as the first troubleshooting step. Preserve
and sanitize a copy for diagnosis when feasible.

## Dependency changes

Dependency additions and upgrades must:

1. solve a documented requirement in the active spec;
2. use an allowed license or receive a recorded review;
3. update the lockfile and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md);
4. regenerate the SBOM for release-bound changes;
5. pass tests with the network disabled after installation.

Packages under copyleft, source-available, field-of-use, commercial-key, or missing
licenses are blocked by default. Do not reproduce third-party source to avoid its
license. When behavior must be reimplemented, use independently written public
requirements and a documented clean-room process.

## Packaging and release

Alpha releases are versioned prereleases. A distributable Windows build must pass:

- `pnpm verify` from a clean checkout with the committed lockfile;
- desktop integration and visual-regression suites on Windows 11 x64;
- archive, SVG, rich-text, IPC, MCP, and collaboration security fixtures applicable
  to the release;
- dependency-license scan and CycloneDX SBOM generation;
- installer install, upgrade, uninstall, and file-association smoke tests;
- review of packaged files for source maps, secrets, real decks, and debug services;
- code-signature verification before distribution beyond maintainers.

The application must remain usable offline. Update checks may fail silently into a
non-blocking status; they must never prevent opening, editing, presenting, or
exporting a local deck.

Release checklist:

1. update `CHANGELOG.md`, `TODO.md`, notices, specs, and ADRs;
2. verify the version is consistent in manifests and generated metadata;
3. produce and archive checksums, SBOM, and signed installer;
4. install the artifact on a clean pilot machine;
5. publish as a prerelease with limitations and recovery guidance;
6. retain the prior signed installer for rollback.

## Incident containment

For a security or data-integrity issue:

1. stop publishing affected builds and updates;
2. preserve sanitized evidence and exact build identifiers;
3. disable the narrow affected boundary when a feature flag can contain it;
4. issue a fixed build or documented rollback path;
5. record user-visible impact in the changelog after coordinated disclosure;
6. add a regression fixture before restoring the feature.
