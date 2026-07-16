# ADR-007: Use an Authoritative Host for V1 LAN Collaboration

- Status: Accepted
- Date: 2026-07-15
- Last reviewed: 2026-07-16

## Context

Nearby users want to open the same deck from a synchronized folder and edit together.
Using the folder as a real-time protocol would create independent whole-file writers,
conflict copies, and silent overwrites. A fully decentralized merge model would add
substantial schema, history, migration, text, recovery, and security complexity before
the first supported release. Direct concurrent editing of the same text is especially
difficult to make predictable and undoable.

## Decision

V1 uses no CRDT. A participant explicitly starts a private-LAN session and becomes the
authoritative host. The host owns the current document revision, validates all command
batches, assigns one monotonically increasing host sequence, journals accepted
transactions, and broadcasts them in one total order.

Peers keep read-only canonical snapshots plus ephemeral interaction drafts. Independent
objects may be edited concurrently by submitting revision-aware commands. Direct text
editing acquires an expiring soft lock for one element; conflicting participants see
the owner and remain read-only for that element. The desktop text inspector requests,
renews, releases, and visibly reports that lease; it disables text controls while a
peer owns the element.

Discovery advertises only an ephemeral service identity, protocol major version,
expiry, and nonce-derived document proof. It advertises no deck title, filename, path,
slide text, asset, actor name, or reusable secret. Joining uses an authenticated
encrypted private-network channel, a document-scoped expiring capability, and explicit
user confirmation. Hosting defaults off on public or unknown networks.

Only the host replaces the shared `.hdeck` within the authenticated session. Peers
cannot save that target. A peer may explicitly leave and save an independent copy
with a new document identity. Writer-lease enforcement across machines additionally
requires one coherent filesystem namespace; replicated cloud folders do not supply
that primitive and therefore require one host to be designated out of band.

A disconnected peer attempts bounded reconnect and does not accept new persistent
edits. After expiry it becomes read-only. V1 does not queue offline edits, merge
disconnected text, elect a host automatically, or transfer shared-file ownership
silently. If the host disappears, peers preserve acknowledged recovery records and may
save independent copies, but they do not overwrite the shared file.

## Consequences

- Every participant observes one accepted command order and revision sequence.
- The existing command engine, attribution, undo grouping, journal, and validation are
  reused rather than duplicated by a collaboration data model.
- Same-file synchronization transports verified snapshots, not real-time operations.
- Host availability is required for continued editing; this is an explicit V1 tradeoff.
- Soft-lock leases, peer backpressure, snapshot resync, reconnect, host loss, private-
  network classification, encryption, and discovery privacy need hard tests.
- A future decentralized or relayed provider requires a new ADR and compatibility plan.

## Rejected options

- **Folder synchronization as collaboration transport**: provides no operation order,
  lock, presence, or single writer.
- **Peer-to-peer merge in V1**: materially expands format, migration, undo, recovery,
  and same-text conflict scope.
- **Simultaneous direct editing of one text element**: lacks an understandable V1 merge
  and undo contract.
- **Automatic host election or takeover**: can create two writers during network
  partitions or delayed synchronized-folder visibility.
- **Internet relay**: contradicts the local-network V1 scope and adds hosted identity,
  operations, and privacy obligations.

## Failure and containment

Malformed, stale, oversized, duplicate, reordered, or unauthorized peer messages are
rejected before the document session. Slow peers are disconnected without slowing the
host. Network-class change stops or reconfirms hosting. Host loss makes peers read-only
after bounded reconnect. No recovery path silently changes the shared-file writer.
