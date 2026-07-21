# ADR-011: Bounded representability and save authority

- Status: Accepted
- Date: 2026-07-21

## Context

The V1 editor accepts the same structured presentation through human editing,
recovery, local agents, archive reopening, export, and LAN collaboration. Checking
individual fields was not sufficient if their combined canonical representation could
still exceed a downstream archive, journal, renderer, or transport boundary.

Explicit Save also crosses several asynchronous boundaries: an OS-selected path, a
main-process session, archive encoding, a temporary sibling, an expected file
fingerprint, and an optional shared-writer lease. Concurrent Save and Save As requests
could not be made safe by renderer state or by a path cache outside the session that
owns the document.

## Decision

`document-core` defines the canonical representability budget. A command is accepted
only when the resulting typed document is valid and its canonical encoded bytes fit
that budget. Rich text, tables, assets, archive entries, export projections, clipboard
input, collaboration messages, history, and idempotency state also retain narrower
component limits where necessary. Validation happens before mutation or expensive
decoding; archive and export work account for aggregate input as well as individual
entries.

Each desktop document session is the authority for its current save target. Save,
Save As, and the complete standalone-to-host or standalone-to-guest transition are
serialized per session. Immediately before replacement, the runtime confirms that the
reserved target is still the session target. The persistence layer rechecks the
expected destination fingerprint and the exact one-link temporary-file identity after
asynchronous commit guards. The operation fails closed if any identity changed.

Standalone writers use a one-link regular-file sidecar reservation. A one-link
mutation-lock file, created exclusively and pinned by its open-handle identity plus a
random owner token, serializes cooperative create, compare/replace, and delete steps
across processes. Sidecar updates replace a fully persisted sibling atomically without
exposing an absent pathname; failed creation cleans up only the exact created file
identity. Release and provisional claim cleanup are exact-byte operations and can be
retried.

The mutation lock has no clock-based automatic takeover. An abandoned lock is
recovered only inside the existing explicit expired-writer flow: the user confirms
that the prior app is closed, then the sidecar and current target remain unchanged for
a full lease window before identity-checked quarantine/removal. This also recovers a
prior save that committed before its old-fingerprint sidecar could be released. A
lock with no readable writer sidecar is not considered free: the first claim fails
closed and the same explicit, stable-observation recovery flow is required.

Collaboration adds the document-scoped writer lease and a host-side commit fence.
Bootstrap state is lossless, admission quotas are reserved before asynchronous work,
and hosting binds to a user-selected named private-network adapter rather than a
wildcard interface. Discovery signs that selected address and guests require it to be
a private literal present in the advertised address set. Loss of the selected adapter
clears the choice and requires confirmation rather than silently choosing another
interface. Host departure closes admission, drains admitted work, persists the final
snapshot, and then releases the lease; a failed join cleans up its detached clone.

Asset bytes remain private and immutable behind an opaque validation proof. Repeated
imports compare exact bytes and reuse the canonical content-addressed identifier in
one queued transaction. Transactions, history traversal, and save preparation reuse
the proof rather than rehashing all retained asset bytes.

## Rejected alternatives

- Treating validation as only a collection of per-field maximums. This leaves
  combinatorial documents that fit every field but exceed their canonical or exported
  representation.
- Letting renderer state or a separate main-process path map decide the save target.
  Either can be stale relative to the queued session operation.
- Silently replacing an expired writer sidecar. Expiry alone does not prove that the
  previous writer is gone or that all participants observe the same namespace.
- Selecting the lexically first private address or silently failing over when an
  adapter disappears. VPNs and virtual adapters can be valid private interfaces but
  are not evidence of the user's intended collaboration network.
- Checking the destination or temporary sibling only before the commit guard. The
  asynchronous authority check leaves a later observation window that must also be
  fenced.

## Consequences

Large or malformed inputs fail before persistent state changes and return bounded,
actionable errors. Legitimate V1 documents remain editable and exportable within one
shared contract. Save conflicts may require the user to reopen, choose Save As, or
explicitly take over a stale reservation. A non-cooperating external process can still
change a Windows file outside the application's reservation protocol; the application
detects every observable mismatch but does not claim a universal conditional rename
or cross-machine compare-and-swap primitive that the platform does not provide.
