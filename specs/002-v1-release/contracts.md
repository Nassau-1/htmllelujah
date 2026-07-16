# V1 Contracts

Status: Normative release-candidate contract, last reviewed 2026-07-16.

This document defines the stable boundaries implementation must satisfy. TypeScript
snippets are descriptive public contracts; runtime schemas are mandatory at every
process and network boundary.

## Contract rules

- IDs are UUIDs unless declared opaque capabilities.
- Revisions are opaque strings. Callers must not parse or synthesize them.
- Every schema rejects unknown fields unless forward-compatible metadata is explicitly
  declared.
- Every byte payload, list, string, nesting level, and batch has a configured maximum.
- Renderer and peer inputs are untrusted even when produced by this application.
- Errors expose stable codes and safe metadata, never document content or local paths.
- Date/time values use ISO 8601 UTC. Timeouts use monotonic local clocks internally.

## Document session contract

```ts
type SessionId = string;
type DocumentId = string;
type Revision = string;

type TransactionOrigin = 'user' | 'mcp' | 'import' | 'recovery' | 'remote' | 'system';

type TransactionMetadata = Readonly<{
  transactionId: string;
  actorId: string;
  origin: TransactionOrigin;
  label: string;
  timestamp: string;
  historyGroupId?: string;
}>;

type DurabilityState =
  | 'clean'
  | 'journal-pending'
  | 'recovered-locally'
  | 'snapshot-pending'
  | 'saved'
  | 'conflict'
  | 'read-only';

type DocumentSnapshotEnvelope = Readonly<{
  sessionId: SessionId;
  documentId: DocumentId;
  document: DeckDocument;
  revision: Revision;
  durability: DurabilityState;
  canUndo: boolean;
  canRedo: boolean;
  readOnlyReason?: SafeErrorCode;
}>;

type ExecuteCommandsRequest = Readonly<{
  sessionId: SessionId;
  expectedRevision: Revision;
  commands: readonly DocumentCommand[];
  metadata: TransactionMetadata;
}>;

type TransactionAck = Readonly<{
  sessionId: SessionId;
  previousRevision: Revision;
  revision: Revision;
  transactionId: string;
  acceptedCommandCount: number;
  durability: DurabilityState;
}>;
```

An empty command batch is invalid. A stale expected revision rejects the whole batch.
Unknown commands, invalid metadata, unavailable assets, locked objects, and structural
invalidity reject the whole batch without emitting a document event.

### Session API

```ts
type DesktopDocumentsV1 = Readonly<{
  create(input: CreateDocumentRequest): Promise<OpenDocumentResult>;
  chooseAndOpen(): Promise<OpenDocumentResult | null>;
  openAssociated(input: AssociatedOpenCapability): Promise<OpenDocumentResult>;
  getSnapshot(sessionId: SessionId): Promise<DocumentSnapshotEnvelope>;
  execute(input: ExecuteCommandsRequest): Promise<TransactionAck>;
  undo(input: RevisionRequest): Promise<TransactionAck>;
  redo(input: RevisionRequest): Promise<TransactionAck>;
  save(input: SaveRequest): Promise<SaveResult>;
  chooseAndSaveAs(input: SaveAsRequest): Promise<SaveResult | null>;
  close(input: CloseRequest): Promise<void>;
  importImage(input: ImportImageRequest): Promise<ImportedImageResult | null>;
  subscribe(listener: (event: DocumentEvent) => void): () => void;
}>;
```

`chooseAndOpen`, `chooseAndSaveAs`, and `importImage` own their native dialogs. No API
accepts a renderer-supplied path. `openAssociated` accepts a short-lived capability
created by the single-instance main process, not a raw command-line string.
`ImportImageRequest` also carries the destination slide and optional image element to
replace. Asset registration and insertion or replacement commit as one revision and
one undo step; cancellation or rejection commits neither.

### Document events

```ts
type DocumentEvent =
  | Readonly<{ type: 'snapshot-changed'; sessionId: SessionId; revision: Revision }>
  | Readonly<{ type: 'durability-changed'; sessionId: SessionId; state: DurabilityState }>
  | Readonly<{ type: 'recovery-available'; sessionId: SessionId; candidateId: string }>
  | Readonly<{ type: 'external-conflict'; sessionId: SessionId; conflictId: string }>
  | Readonly<{ type: 'collaboration-changed'; sessionId: SessionId; state: CollaborationState }>;
```

Events carry no slide text, filenames, paths, or asset bytes. The renderer fetches the
next immutable snapshot after `snapshot-changed` and ignores out-of-order revisions.

## Command contract additions

The V1 command union includes at least:

```text
deck.rename, deck.set-page
theme.create, theme.update, theme.delete
master.create, master.update, master.delete
layout.create, layout.update, layout.delete
slide.create, slide.duplicate, slide.update, slide.delete, slide.reorder, slide.set-layout
slide.reset-placeholder, slide.set-hidden
element.insert, element.delete, element.transform, element.update-style
element.set-locked, element.set-visible, element.reorder
element.align, element.distribute, element.group, element.ungroup
text.replace-content
table.insert-row, table.delete-row, table.insert-column, table.delete-column
table.update-cell, table.update-style, table.paste-tsv
asset.register, asset.remove
connector.update-endpoint
```

Commands target IDs and semantic intent. They do not contain DOM nodes, CSS, HTML,
filesystem paths, URLs, shell fragments, executable expressions, or functions.

## Rich-text contract

```ts
type RichTextDocument = Readonly<{
  blocks: readonly RichTextBlock[];
}>;

type RichTextBlock = ParagraphBlock | HeadingBlock | ListBlock;

type TextMarks = Readonly<{
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  color?: HexColor;
  fontFamily?: SupportedSystemFontFamily;
  fontSizePt?: number;
  fontWeight?: number;
}>;
```

Heading levels are 1–6. List nesting is 0–8. Font-family values are bounded strings
selected from the supported desktop UI catalog and resolve through the operating
system's installed fonts and explicit CSS fallbacks; V1 bundles no presentation font
files. Clipboard conversion normalizes supported nodes and marks into this contract
and drops unsupported content.

## Theme, master, layout, and placeholder contract

```ts
type PlaceholderBinding = Readonly<{
  placeholderId: string;
  overrides: readonly ('frame' | 'style' | 'visibility')[];
}>;

type ResolvedSlide = Readonly<{
  documentId: string;
  slideId: string;
  revision: Revision;
  page: PageSize;
  background: HexColor;
  elements: readonly ResolvedElement[];
  guides: readonly Guide[];
  warnings: readonly SafeProjectionWarning[];
}>;
```

Master and layout placeholder IDs are stable. A slide-bound element references a
placeholder present in its selected layout or inherited master. `reset-placeholder`
clears named overrides only. Layout switching maps content by compatible placeholder
role and ordinal; unmatched content becomes an unbound local element.

Projection stacking is master fixed elements, layout fixed elements, placeholder-
bound slide content, then local slide elements. Array order within each level is back
to front. Placeholder prompts appear only in editor mode.

## Geometry contract

```ts
type GeometryRequest = Readonly<{
  page: PageSize;
  selected: readonly ElementFrame[];
  otherFrames: readonly ElementFrame[];
  draft: TransformDraft;
  grid: GridSettings;
  smartGuides: SmartGuideSettings;
}>;

type GeometryResult = Readonly<{
  frames: readonly ElementFrame[];
  guides: readonly ResolvedGuide[];
  snapped: boolean;
}>;
```

Geometry is pure and point-based. A multi-selection is clipped by one shared delta so
relative spacing never collapses. Rotation uses a defined axis-aligned visual bounds
calculation for snapping and alignment. Resize never produces non-finite or non-
positive dimensions. Partially off-page objects are allowed within configured
recoverability bounds.

## Renderer contract

```ts
type RenderMode = 'editor' | 'thumbnail' | 'presentation' | 'html' | 'pdf';

type RenderRequest = Readonly<{
  projection: ResolvedSlide;
  mode: RenderMode;
  scale: number;
  readinessDeadlineMs: number;
  includeHidden: boolean;
}>;

type RenderResult = Readonly<{
  rendererVersion: 1;
  revision: Revision;
  ready: boolean;
  page: PageSize;
  warnings: readonly SafeRenderWarning[];
  durationMs: number;
}>;
```

The slide content root is deterministic and never reads desktop state. Editor overlays
are outside that root. `renderReady` requires the browser font set, decoded images, two stable
frames, and measured page geometry. In V1, font readiness means the browser's system
font set and fallbacks have settled; the application bundles no presentation fonts.
Failure is typed; export never proceeds on a partial render.

## `.hdeck` container contract

Required logical entries:

```text
manifest.json
document.json
```

Optional logical entries:

```text
assets/<sha256>.<approved-extension>
previews/thumbnail.webp
collaboration/recovery.bin
META-INF/notices.json
```

### Manifest

```ts
type HdeckManifestV1 = Readonly<{
  format: 'htmllelujah.deck';
  containerVersion: 1;
  documentSchemaVersion: number;
  documentId: string;
  createdAt: string;
  modifiedAt: string;
  documentEntry: 'document.json';
  documentSha256: string;
  assets: readonly ManifestAsset[];
  optionalEntries: readonly ManifestOptionalEntry[];
}>;

type ManifestAsset = Readonly<{
  id: string;
  entry: string;
  sha256: string;
  byteLength: number;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | ApprovedFontMediaType;
  originalName?: string;
  widthPx?: number;
  heightPx?: number;
}>;
```

`originalName` is display metadata only, normalized and bounded, and is excluded from
diagnostics. Entry paths are generated by the application. On read, reject absolute
paths, backslashes, traversal, NUL/control characters, symlinks, unsupported entry
types, duplicate normalized names, case-insensitive collisions, undeclared entries,
hash mismatch, size mismatch, and unsupported versions.

### Read result

```ts
type HdeckOpenResult =
  | Readonly<{ status: 'editable'; manifest: HdeckManifestV1; document: DeckDocument }>
  | Readonly<{
      status: 'migrated-copy';
      manifest: HdeckManifestV1;
      document: DeckDocument;
      steps: readonly MigrationStep[];
    }>
  | Readonly<{
      status: 'rejected';
      code: ArchiveErrorCode | 'UNSUPPORTED_VERSION';
    }>;
```

Migrations are pure, ordered, deterministic, and validate after every step. The
original archive is retained in recovery before an editable migrated snapshot exists.
V1 has no future-schema preview projection: it returns `UNSUPPORTED_VERSION` and
leaves the original unchanged.

## Persistence and recovery contract

```ts
type JournalHeader = Readonly<{
  format: 'htmllelujah.journal';
  version: 1;
  documentId: string;
  baseDocumentSha256: string;
  sessionId: string;
}>;

type JournalRecord = Readonly<{
  sequence: number;
  previousRevision: Revision;
  revision: Revision;
  metadata: TransactionMetadata;
  commands: readonly DocumentCommand[];
  checksum: string;
}>;
```

Records use bounded length-prefix framing. Replay stops at the first incomplete or
invalid record. A valid prefix remains recoverable. Recovery never applies to a
different document ID or incompatible base without creating an independent copy.

```ts
type SaveResult =
  | Readonly<{ status: 'saved'; revision: Revision; fingerprint: string }>
  | Readonly<{ status: 'cancelled' }>
  | Readonly<{ status: 'conflict'; conflictId: string }>
  | Readonly<{ status: 'failed'; code: SaveErrorCode; retryable: boolean }>;
```

The final target is replaced only after temporary output is flushed, reopened,
validated, and matched to the expected destination fingerprint.

Journal append is the automatic recovery write. V1 does not replace the selected
`.hdeck` on an idle timer; only explicit Save or Save As enters the snapshot-replace
contract. Recovery candidates require at least one valid journal record after their
base. Bounded blob garbage collection preserves every hash reachable from a current
document, journal, history entry, staged import, or active session.

## Asset contract

```ts
type ImportedAssetResult = Readonly<{
  assetId: string;
  sha256: string;
  byteLength: number;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  widthPx: number;
  heightPx: number;
}>;

type ImportedImageResult = Readonly<{
  session: DocumentSnapshotEnvelope;
  assetId: string;
  elementId: string;
}>;
```

The import service validates magic bytes, extension-independent media type, byte
limit, image dimensions, decode success, and hash before registering an asset. Header
inspection occurs before pixel decode and decoded dimensions must agree. Duplicate
bytes reuse the existing asset. The source path is never persisted. Human insertion
or replacement registers the asset and changes the slide in one durable transaction;
the MCP asset tool registers bytes only for a later typed proposal.

## TSV table contract

TSV parsing treats every field as literal text. Tabs delimit columns and CRLF, LF, or
CR delimit rows. Quoted multiline cells follow a documented bounded CSV-style quoting
rule. Uneven rows are padded with empty cells. Input exceeding row, column, cell, or
text limits is rejected atomically. Strings beginning with `=`, `+`, `-`, or `@` have
no formula semantics and remain literal.

## MCP contract

The MCP executable uses stdio JSON-RPC framing. Stdout contains protocol only; stderr
contains redacted diagnostics. Maximum frame size and request concurrency are bounded.

### Read tools

```text
app_status
documents_list
documents_get_outline
slides_get
documents_get_styles
documents_validate
collaboration_status
```

### Mutation and output tools

```text
documents_propose_commands
documents_commit_proposal
documents_undo_agent_transaction
assets_request_import
documents_request_export
```

`documents_propose_commands` accepts at most 100 typed commands and creates a
revision-bound proposal. Delete, full replacement, layout/reset, and other classified
destructive batches require an unexpired `commit-destructive` approval at commit;
agent undo, imports, and exports require their own unexpired single-purpose approval.
V1 exposes no MCP save tool. Tool results return IDs, revisions, counts, dimensions,
warnings, and safe error codes, not paths or complete asset bytes.

Frames and encoded results are capped at 2 MiB. The desktop default proposal lifetime
is one minute and at most 64 proposals may be pending. At most 32 unconsumed desktop
approvals may exist for two minutes, and at most 64 consumed receipts are retained for
30 seconds. Admission reserves capacity before awaiting proposal work.

The MCP server exposes no raw file resource, shell tool, URL fetch, HTML injection,
script execution, arbitrary document patch, collaboration administration, or secret
retrieval method.

## LAN collaboration contract

### State

```ts
type CollaborationState =
  | 'off'
  | 'hosting'
  | 'joining'
  | 'connected-peer'
  | 'reconnecting'
  | 'read-only-disconnected'
  | 'ended';

type HostSequence = number;
```

### Discovery and join

Discovery advertises an ephemeral service ID, protocol major version, expiry, and
document proof derived with a session nonce. It advertises no title, filename, path,
slide text, asset, actor name, or reusable credential.

Joining proves a document-scoped expiring capability over an authenticated encrypted
channel. The host displays and records the joining actor before acceptance. Public or
unknown network classification disables hosting by default.

### Ordered messages

```ts
type ClientCommandMessage = Readonly<{
  type: 'command';
  clientMessageId: string;
  expectedRevision: Revision;
  commands: readonly DocumentCommand[];
  metadata: TransactionMetadata;
}>;

type HostAcceptedMessage = Readonly<{
  type: 'accepted';
  hostSequence: HostSequence;
  previousRevision: Revision;
  revision: Revision;
  transactionId: string;
  commands: readonly DocumentCommand[];
  metadata: TransactionMetadata;
}>;
```

The host is the only allocator of `hostSequence` and only writer of the shared file.
It rejects stale or invalid messages atomically. Peers apply accepted messages strictly
in sequence and request a bounded snapshot when a gap is detected.

Presence and pointer previews are ephemeral, rate-limited, and never journaled. A
direct-text soft lock names element ID, actor ID, lease ID, and expiry. Lock expiry or
disconnect makes uncommitted peer text invalid; it is not queued for merge.

The desktop inspector requests, renews, and releases the lease, displays owned or
peer-held state, and disables direct text controls while another participant owns the
element. The lock is advisory outside the authenticated command session; it is not a
filesystem lock.

V1 has no automatic host election, offline edit queue, disconnected merge, or
simultaneous direct editing of one text element. On host loss, peers become read-only
after bounded reconnect and may explicitly save independent copies with new IDs.
Only a coherent shared filesystem such as SMB/NAS can enforce the writer sidecar
across machines. Consumer-synchronization replicas carry snapshots but cannot
arbitrate independently started hosts.

## Presentation and export contracts

Presentation receives a session ID, immutable revision, starting slide ID, hidden-
slide policy, and target display capability. It never receives editor state or paths.

Standalone HTML contains a static manifest, renderer runtime, immutable deck
projection, local assets, and restrictive CSP. It contains no preload bridge, MCP,
collaboration, authoring command bus, service worker network fallback, or remote URL.

PDF export receives an opaque output capability, document revision, slide inclusion
policy, page preset, and overwrite approval. It returns page count, dimensions,
duration, warnings, and safe status.

## Safe error codes

```text
INVALID_REQUEST, REVISION_CONFLICT, NOT_FOUND, LOCKED, READ_ONLY,
UNSUPPORTED_VERSION, MIGRATION_FAILED, ARCHIVE_INVALID, ARCHIVE_LIMIT_EXCEEDED,
ASSET_INVALID, ASSET_LIMIT_EXCEEDED, JOURNAL_INVALID, RECOVERY_CONFLICT,
TARGET_UNAVAILABLE, TARGET_CHANGED, OVERWRITE_REQUIRES_APPROVAL, DISK_FULL,
RENDER_NOT_READY, EXPORT_FAILED, APPROVAL_REQUIRED, APPROVAL_EXPIRED,
MCP_UNAUTHORIZED, MCP_PROTOCOL_ERROR, NETWORK_NOT_PRIVATE, JOIN_REJECTED,
HOST_UNAVAILABLE, TEXT_LOCKED, RECONNECT_EXPIRED, INSTALLATION_INVALID
```

Internal exceptions map to these codes at trust boundaries. Safe diagnostics may
include component, operation, error code, retryability, duration, version, and counts;
they exclude document content and user-environment identifiers.
