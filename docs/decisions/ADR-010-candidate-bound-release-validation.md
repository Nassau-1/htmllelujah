# ADR-010: Separate Candidate Build, Functional Validation, and Publication

- Status: Accepted
- Date: 2026-07-16
- Last reviewed: 2026-07-16

## Context

A successful source test or installer build does not prove that the exact promoted
Windows application opens, exports, serves MCP, collaborates, installs, repairs, and
uninstalls correctly. Conversely, writing dynamic test results into tracked release
notes would change the source commit and force a new binary, creating a
self-referential release loop. The build, validation, and publication processes also
share one crash-recoverable release lock; nesting the long validation inside the
builder would deadlock or weaken lock ownership.

## Decision

Use three explicit phases against one immutable candidate:

1. `pnpm make:win` builds in a clean detached worktree, attests the complete Windows
   x64 artifact and source provenance, then promotes the artifact and integrity
   evidence as one recoverable generation.
2. `pnpm validate:candidate` runs only after promotion under a new acquisition of the
   same release lock. It requires the current clean source tree, lockfile, candidate
   manifest, and complete artifact inventory to match. It executes the packaged and
   installed gates plus explicitly labelled source benchmarks and WSS loopback soak.
   After cleanup, it publishes a canonical JSON commit marker and deterministic ZIP
   containing privacy-screened evidence. The manifest is written last and a failed
   rerun removes any prior success.
3. `finalize-windows-release.mjs` requires that exact JSON/ZIP pair. It independently
   reconstructs the bundle, recomputes the Windows platform, architecture and build,
   Node and pnpm runtime identity, and every candidate binding, then repeats the check
   around record creation and each GitHub mutation or download. Both files are public
   assets. The generated final record is ignored source output, so it can bind
   observed hashes without changing the tagged commit.

The functional manifest distinguishes `packaged-unpacked`, `installed-lifecycle`,
`source-harness`, and `loopback-source-harness` scopes. Tests that require separate
machines, a clean secondary Windows account, physical displays, Narrator or NVDA,
SMB/NAS infrastructure, or a physically disconnected machine remain explicit
non-automated limitations rather than inferred passes.

## Consequences

- Packaging alone is never a publishable state.
- Validation can be rerun without rebuilding only while every source and artifact
  identity remains unchanged.
- Publication is slower because it rehashes the complete artifact repeatedly, but a
  remote mutation can never proceed on a partially revalidated candidate.
- The public evidence bundle contains bounded reports and screenshots, not local
  paths, addresses, credentials, document identifiers, or raw user data.
- The release remains unsigned unless a separately configured and verified
  Authenticode identity is available.

## Rejected options

- Run validation inside `make:win`: the parent owns the release lock, and a long child
  either deadlocks or requires an unsafe lock bypass.
- Trust loose screenshots and reports: stale or substituted files would not be bound
  to one candidate or protected by a deterministic aggregate.
- Trust `manifest.environment` as its own expected value: that comparison is
  tautological; the finalizer rebuilds the expected Windows platform, architecture
  and build plus the Node and pnpm identity.
- Commit observed hashes into the tagged source: the commit would change after every
  observation and invalidate the binary provenance it was meant to record.
- Describe source benchmarks or one-process loopback as packaged or multi-machine
  coverage: scope is part of the evidence contract and must remain exact.
