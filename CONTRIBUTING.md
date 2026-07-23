# Contributing

Thank you for your interest in HTMLlelujah.

## Current contribution policy

HTMLlelujah is a source-available project. During V1, external code,
documentation, design, asset, and translation contributions are not accepted.
Please do not open a pull request or submit patches by another channel.

This restriction preserves the licensor's ability to offer separate commercial
terms. A future contribution process must first adopt an explicit contributor
agreement that grants the rights needed for both the public noncommercial license
and separate commercial licensing.

Automated dependency-update pull requests are maintenance proposals, not an
exception for external authored code. An authorized maintainer must review the
upstream change, validate licensing and provenance, and apply or merge only the
mechanical manifest and lockfile update under the maintainer workflow.

Opening an issue, discussion, or security report does not grant HTMLlelujah a
license to unrelated code, designs, assets, confidential information, or patents.
Do not attach material that you do not have the right to disclose.

## Useful reports

Public issues may be used for:

- reproducible bugs based on synthetic content;
- accessibility problems;
- documentation errors;
- focused feature requests that describe the user need rather than copying another
  product's implementation.

Before filing an issue:

1. Search existing issues and the roadmap in [`TODO.md`](TODO.md).
2. Reproduce the problem on an unmodified build from this repository.
3. Remove presentation content, personal information, credentials, and private paths.
4. Include the revision, operating-system version, exact steps, and expected result.

Security issues must follow [`SECURITY.md`](SECURITY.md) and must not be reported in
public.

## Maintainer workflow

Authorized maintainers must:

1. confirm a written IP assignment or other applicable employment or contractor
   agreement gives the licensor the rights needed for both public noncommercial and
   separate commercial licensing;
2. start material work from the applicable feature spec under `specs/`;
3. update the spec or ADR before changing an established contract;
4. keep mutations typed, transactional, attributable, and undoable;
5. add tests for schema, renderer, geometry, export, IPC, or collaboration changes;
6. run `pnpm verify` before merge;
7. update `CHANGELOG.md`, `TODO.md`, and third-party notices when applicable;
8. ensure every tracked artifact is safe for a public repository.

## Licensing

No contribution process in this file modifies [`LICENSE`](LICENSE). Original
HTMLlelujah code is available under PolyForm Noncommercial 1.0.0; ordinary
commercial use requires separate written terms as described in
[`COMMERCIAL-LICENSING.md`](COMMERCIAL-LICENSING.md). Third-party material must not
be copied into the repository unless its license is approved, its provenance is
recorded, and all notice obligations are satisfied.
