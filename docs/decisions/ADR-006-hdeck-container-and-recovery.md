# ADR-006: Use a Bounded `.hdeck` Container with Journaled Atomic Save

- Status: Accepted
- Date: 2026-07-15

## Context

A presentation contains structured entities and binary assets, must remain editable
offline, and may live in a synchronized folder. A single unbounded JSON file cannot
efficiently carry assets, while writing a ZIP archive in place risks corruption.
Independent whole-file writes from multiple machines can also overwrite externally
changed content. Migrations and future compatibility require a stable envelope that is
separate from the document schema.

## Decision

The authoring file is a `.hdeck` ZIP container with:

- required `manifest.json` and `document.json` entries;
- content-addressed assets under generated `assets/` names;
- optional generated preview, collaboration recovery, and notice entries;
- independent `containerVersion` and `documentSchemaVersion`;
- SHA-256 hashes and declared byte lengths for the document and every asset.

The canonical semantic snapshot is the validated structured document JSON. Optional
collaboration recovery data is an implementation aid and cannot replace that readable
snapshot as the sole persisted meaning.

The codec operates on bounded byte streams and does not accept filesystem paths. It
rejects unsafe names, path traversal, absolute paths, backslashes, control characters,
symlinks, unsupported entry types, duplicate normalized names, case-insensitive
collisions, undeclared entries, excessive counts, expanded sizes, compression ratios,
model depth, text, image dimensions, and integrity mismatches.

Every accepted transaction enters a checksummed length-prefixed journal in the current
user's local application-data recovery area. The journal is not stored beside the deck
and is not synchronized as a collaboration transport. A truncated tail does not
invalidate its preceding valid records.

Save writes a unique temporary sibling, flushes it, reopens and validates it, compares
the destination fingerprint with the opened file, and atomically replaces the target.
External change stops in a conflict state and requires Reload, Save Copy, or Cancel.
Migration preserves the original before committing an editable migrated snapshot.
V1 refuses newer unsupported versions with a typed compatibility error and never
modifies them. Preview-only opening of a future unknown schema requires a separately
versioned projection contract and is deferred.

## Consequences

- Decks are portable, offline, inspectable, asset-complete, and migration-aware.
- Binary bytes are deduplicated by content hash and source paths are not persisted.
- The last verified target and local journal survive failed save stages.
- Synchronized-folder behavior is conflict-aware rather than last-writer-wins.
- Archive parsing, image decoding, migration, recovery, temporary cleanup, fingerprint,
  and fault-injection tests become hard release gates.
- A maximum supported deck size is a product contract, not a hidden implementation
  detail.

## Rejected options

- **Generated HTML as the authoring file**: lacks typed identity, safe migrations,
  bounded capabilities, and deterministic command semantics.
- **Loose directory as the only format**: is easy to partially synchronize and hard to
  move or fingerprint atomically.
- **In-place archive updates**: can destroy both old and new state on interruption.
- **Blind overwrite after autosave delay**: loses changes made by another machine or
  synchronization client.
- **Journal in the synchronized folder**: leaks transient state and creates additional
  writers and conflict files.

## Failure and containment

Invalid archives never create editable sessions. Save failure keeps the prior target
and journal. A base-revision or document-ID mismatch opens recovery as an independent
copy. Temporary files are removed when safe; unresolved cleanup is recorded without a
path in user-facing diagnostics. No migration failure overwrites its source.
