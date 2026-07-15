# Contributing

Thank you for your interest in HTMLlelujah.

## Current contribution policy

HTMLlelujah is a source-visible proprietary project. During Alpha, external code,
documentation, design, asset, and translation contributions are not accepted.
Please do not open a pull request or submit patches by another channel.

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

1. start material work from the applicable feature spec under `specs/`;
2. update the spec or ADR before changing an established contract;
3. keep mutations typed, transactional, attributable, and undoable;
4. add tests for schema, renderer, geometry, export, IPC, or collaboration changes;
5. run `pnpm verify` before merge;
6. update `CHANGELOG.md`, `TODO.md`, and third-party notices when applicable;
7. ensure every tracked artifact is safe for a public repository.

## Licensing

No contribution process in this file modifies [`LICENSE`](LICENSE). Original
HTMLlelujah code remains all rights reserved. Third-party material must not be copied
into the repository unless its license is approved, its provenance is recorded, and
all notice obligations are satisfied.
