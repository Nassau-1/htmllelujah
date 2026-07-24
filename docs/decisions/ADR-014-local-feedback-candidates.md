# ADR-014: Separate local feedback candidates from public releases

Date: 2026-07-24  
Status: Accepted

## Context

HTMLlelujah needs installable Windows candidates for local hands-on feedback before
the separate Electron/FFmpeg corresponding-source mechanism, complete notices review,
and qualified public-distribution approval are finished. Requiring those publication
decisions to install a build locally prevents useful product testing. Silently
weakening the public release gate would create a materially different risk.

## Decision

Keep `pnpm make:win` and the release finalizer fail-closed on the complete
public-distribution record. Add the explicit `pnpm make:win:local` command for local
feedback candidates.

The local path uses the same clean detached source commit, frozen dependency graph,
sequential builds, provenance capture, artifact inventory, dependency SBOM,
release-evidence integrity checks, and crash-safe promotion. It omits only the
assertion that the public-distribution compliance record has already passed. The
record remains present and visibly pending, so the resulting candidate cannot be
finalized or published as a release.

## Consequences

- Product feedback can run against an exact, reproducible local binary.
- Public distribution remains blocked until the existing legal/compliance evidence is
  complete.
- Documentation and validation evidence must always label the local candidate as
  non-public and not release-ready.

## Rejected options

- Mark pending compliance fields as passed for local builds: rejected because it would
  create false evidence.
- Remove `--require-ready` from the default build and finalizer: rejected because local
  convenience must not weaken publication controls.
- Copy an unverified installer directly from staging: rejected because it would bypass
  provenance, SBOM, evidence, and atomic promotion checks.
