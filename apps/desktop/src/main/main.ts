import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  documentCommandSchema,
  type Element,
  type ImageElement,
  type TransactionMetadata,
} from '@htmllelujah/document-core';
import { CollaborationError, RemoteTransportError } from '@htmllelujah/collaboration';
import {
  DocumentRuntimeError,
  DocumentSessionManager,
  type CloseSessionOptions,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';
import { createPrintHtml, createStandaloneHtml, ExporterError } from '@htmllelujah/exporter';
import { startLocalRpcServer, type LocalRpcServerHandle } from '@htmllelujah/mcp-server';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  session,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import { z } from 'zod';

import { DesktopCollaborationCoordinator } from './collaboration-service.js';
import {
  assertDecodedDimensions,
  ImageImportValidationError,
  imageFrameForPage,
  inspectImageBeforeDecode,
} from './image-import-validation.js';
import { DesktopMcpBridge, type McpApprovalAction } from './mcp-bridge.js';
import { isTrustedRendererUrl, resolveRendererEntryUrl } from './renderer-entry.js';
import { resolveSaveTarget } from './save-target.js';
import {
  runSerializedStandaloneCollaborationTransition,
  StandaloneSaveQueue,
  StandaloneWriterReservationAggregateError,
  withExplicitStandaloneWriterRecovery,
} from './standalone-writer-reservation.js';
import {
  cleanupSessionIfUnowned,
  initializeWindowSafely,
  RendererCloseHandshakeBroker,
  retainWindowOnFailure,
  runAuthorizedWindowClose,
} from './window-lifecycle.js';
import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type AppInfo,
  type CollaborationStatus,
  type CollaborationTextLeaseStatus,
  type DesktopResult,
  type ExportResult,
  type InitializeResult,
  type McpStatus,
  type SessionView,
} from '../shared/desktop-api.js';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'htmllelujah-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: 'htmllelujah-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: 'htmllelujah-export',
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
  },
]);

app.setName('HTMLlelujah');

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PDF_READINESS_DEADLINE_MS = 15_000;

const runtime = new DocumentSessionManager({
  recoveryDirectory: path.join(app.getPath('userData'), 'recovery'),
  // Every edit is journaled immediately. User-file writes remain explicit so a guest that
  // opens the same Drive file cannot race the authoritative LAN writer in the background.
  autosaveDelayMs: 0,
});
const collaboration = new DesktopCollaborationCoordinator(runtime);

type WindowMode = 'editor' | 'presentation';

interface ReplaceAuthorization {
  readonly sessionId?: string | undefined;
  readonly closeOptions?: CloseSessionOptions | undefined;
}

interface AssignSessionOptions {
  readonly preserveRecoveryOnFailure?: boolean | undefined;
}

const windowSessions = new Map<number, string>();
const windowModes = new Map<number, WindowMode>();
const standaloneSaveQueue = new StandaloneSaveQueue();
const assetTokens = new Map<
  string,
  { readonly sessionId: string; readonly webContentsId: number }
>();
const tokensByWebContents = new Map<number, Set<string>>();
const closingWindows = new Set<number>();
const closingDecisions = new Set<number>();
const rendererPreparedCloses = new Set<number>();
const rendererCloseHandshake = new RendererCloseHandshakeBroker();
let pendingOpenPath: string | undefined;

class DesktopMainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable = true,
  ) {
    super(message);
    this.name = 'DesktopMainError';
  }
}

const success = <T>(value: T): DesktopResult<T> => ({ ok: true, value });

const failure = (inputError: unknown): DesktopResult<never> => {
  const error =
    inputError instanceof StandaloneWriterReservationAggregateError
      ? inputError.actionableError
      : inputError;
  if (error instanceof DesktopMainError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message, recoverable: error.recoverable },
    };
  }
  if (error instanceof ExporterError) {
    const safeMessages: Partial<Record<ExporterError['code'], string>> = {
      INVALID_REQUEST: 'This presentation cannot be exported.',
      NOT_FOUND: 'One of the presentation resources is unavailable.',
      ASSET_INVALID: 'One of the presentation images is invalid.',
      ASSET_LIMIT_EXCEEDED: 'The presentation images are too large to export safely.',
      EXPORT_LIMIT_EXCEEDED: 'The presentation is too large to export safely.',
      RENDER_NOT_READY: 'The presentation did not become ready for export.',
      EXPORT_FAILED: 'The presentation could not be exported.',
    };
    return {
      ok: false,
      error: {
        code: error.code,
        message: safeMessages[error.code] ?? 'The presentation could not be exported.',
        recoverable: true,
      },
    };
  }
  if (error instanceof CollaborationError) {
    const safeMessages: Partial<Record<CollaborationError['code'], string>> = {
      INVALID_REQUEST: 'That collaboration action is not valid right now.',
      PAYLOAD_TOO_LARGE: 'The collaboration update is too large.',
      SESSION_MISMATCH: 'The collaboration invitation belongs to another session.',
      DOCUMENT_MISMATCH: 'Both devices must open the same .hdeck presentation.',
      FUTURE_BASE: 'The host is still synchronizing. Try the edit again.',
      REVISION_CONFLICT: 'The shared presentation changed. Rejoin the session to resynchronize.',
      IDEMPOTENCY_KEY_REUSE: 'A collaboration request could not be safely replayed.',
      IDEMPOTENCY_CAPACITY: 'This collaboration session has reached its request limit.',
      TEXT_LEASE_HELD: 'Another participant is editing this text block.',
      LOCK_TOKEN_REQUIRED: 'This text block must be reserved before editing.',
      INVALID_LOCK_TOKEN: 'The text editing reservation has expired.',
      NOT_TEXT_ELEMENT: 'The selected element is not editable text.',
      NOT_FOUND: 'The collaboration session is no longer available.',
      PRESENCE_CAPACITY: 'This collaboration session is full.',
      RESYNC_RANGE: 'The collaboration history is no longer available; rejoin the session.',
      SIDECAR_TAMPERED: 'The shared-file writer lease is invalid. Reopen the presentation.',
      WRITER_LEASE_ACTIVE: 'Another device is already the writer for this shared file.',
      WRITER_LEASE_STALE: 'The previous writer lease must expire before hosting again.',
      SPLIT_BRAIN: 'Two writers were detected. Editing stopped to protect the shared file.',
      TARGET_CHANGED: 'The shared file changed outside the host. Reopen it before continuing.',
      LEASE_NOT_OWNED: 'This device no longer owns the shared-file writer lease.',
      PATH_NOT_ALLOWED: 'Collaboration is restricted to private local-network addresses.',
    };
    return {
      ok: false,
      error: {
        code: error.code,
        message: safeMessages[error.code] ?? 'The collaboration action could not be completed.',
        recoverable: true,
      },
    };
  }
  if (error instanceof RemoteTransportError) {
    const safeMessages: Readonly<Record<string, string>> = {
      AUTH_FAILED: 'The host could not authenticate this device or session code.',
      AUTH_EXPIRED: 'The collaboration authentication request expired.',
      AUTH_REPLAY: 'This collaboration request was already used.',
      AUTH_TIMEOUT: 'The collaboration authentication request timed out.',
      BACKPRESSURE_LIMIT: 'The LAN connection is overloaded. Try again after it recovers.',
      CLIENT_ID_IN_USE: 'This device identity is already connected to the host.',
      CLIENT_MISMATCH: 'The host rejected a collaboration request from another device identity.',
      CONNECTION_CLOSED: 'The LAN connection closed before the operation completed.',
      DUPLICATE_REQUEST: 'That collaboration request is already pending.',
      FINGERPRINT_MISMATCH: 'The host certificate fingerprint does not match the invitation.',
      INVITATION_EXPIRED: 'The LAN invitation expired. Ask the host for a new session code.',
      JOIN_REJECTED: 'The host rejected this join request.',
      JOIN_TIMEOUT: 'The host did not answer the join request in time.',
      LOGICAL_PAYLOAD_TOO_LARGE: 'The collaboration update is too large for this LAN session.',
      NOT_CONNECTED: 'This device is not connected to the LAN session.',
      PEER_LIMIT: 'The LAN session has reached its participant limit.',
      PENDING_LIMIT: 'The host already has too many join requests waiting for approval.',
      PROTOCOL_ERROR: 'The LAN session returned an invalid protocol response.',
      REQUEST_TIMEOUT: 'The host did not answer the collaboration request in time.',
    };
    return {
      ok: false,
      error: {
        code: error.code,
        message:
          safeMessages[error.code] ?? 'The LAN collaboration request could not be completed.',
        recoverable: true,
      },
    };
  }
  if (error instanceof DocumentRuntimeError) {
    const safeMessages: Partial<Record<DocumentRuntimeError['code'], string>> = {
      REVISION_CONFLICT: 'The presentation changed. Your view has been refreshed; try again.',
      NO_SAVE_TARGET: 'Choose where to save this presentation.',
      TARGET_CHANGED: 'The file changed outside HTMLlelujah. Save a copy or reopen it.',
      SAVE_FAILED:
        'The presentation could not be saved. Check the destination and free disk space.',
      DIRTY_DOCUMENT: 'Save or discard your changes before closing the presentation.',
      ASSET_BYTES_MISSING: 'One of the presentation assets is unavailable.',
      PROPOSAL_CAPACITY: 'Too many pending agent proposals are open. Try again shortly.',
      INVALID_REQUEST: 'That operation is not valid for the current presentation.',
      SESSION_NOT_FOUND: 'This presentation is no longer open.',
    };
    return {
      ok: false,
      error: {
        code: error.code,
        message: safeMessages[error.code] ?? 'The presentation operation could not be completed.',
        recoverable: error.retryable,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'HTMLlelujah could not complete the operation.',
      recoverable: true,
    },
  };
};

const mimeForAppPath = (filePath: string): string => {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
};

const notFound = (): Response =>
  new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const registerSecureProtocols = (): void => {
  protocol.handle('htmllelujah-app', async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.hostname !== 'app' || request.method !== 'GET') return notFound();
      const decoded = decodeURIComponent(requestUrl.pathname);
      const requested = decoded === '/' ? '/index.html' : decoded;
      if (requested.includes('\0') || requested.includes('\\')) return notFound();
      const root = path.resolve(app.getAppPath(), 'dist');
      const target = path.resolve(root, `.${requested}`);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return notFound();
      let bytes = await readFile(target);
      if (path.extname(target).toLowerCase() === '.html') {
        const html = bytes
          .toString('utf8')
          .replace(/\s+ws:\/\/127\.0\.0\.1:5173/g, '')
          .replace(/\s+ws:\/\/127\.0\.0\.1:\*/g, '');
        bytes = Buffer.from(html, 'utf8');
      }
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': mimeForAppPath(target),
          'Cache-Control':
            path.extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      });
    } catch {
      return notFound();
    }
  });

  protocol.handle('htmllelujah-asset', async (request) => {
    try {
      if (request.method !== 'GET') return notFound();
      const requestUrl = new URL(request.url);
      if (requestUrl.hostname !== 'asset') return notFound();
      const segments = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (segments.length !== 3) return notFound();
      const [token, assetId, expectedHash] = segments;
      if (token === undefined || assetId === undefined || expectedHash === undefined)
        return notFound();
      const capability = assetTokens.get(token);
      if (capability === undefined) return notFound();
      const asset = runtime.getAssetBytesMainOnly(capability.sessionId, assetId);
      if (asset.hash !== expectedHash) return notFound();
      return new Response(asset.bytes, {
        status: 200,
        headers: {
          'Content-Type': asset.mediaType,
          'Content-Length': String(asset.bytes.byteLength),
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        },
      });
    } catch {
      return notFound();
    }
  });
};

const revokeWebContentsTokens = (webContentsId: number): void => {
  for (const token of tokensByWebContents.get(webContentsId) ?? []) assetTokens.delete(token);
  tokensByWebContents.delete(webContentsId);
};

const mintAssetToken = (webContentsId: number, sessionId: string): string => {
  revokeWebContentsTokens(webContentsId);
  const token = randomBytes(24).toString('base64url');
  assetTokens.set(token, { sessionId, webContentsId });
  tokensByWebContents.set(webContentsId, new Set([token]));
  return token;
};

const sessionView = (webContentsId: number, snapshot: DocumentSessionSnapshot): SessionView => {
  const token = mintAssetToken(webContentsId, snapshot.sessionId);
  return {
    snapshot,
    assetUrls: Object.fromEntries(
      snapshot.document.assets.map((asset) => [
        asset.id,
        `htmllelujah-asset://asset/${token}/${asset.id}/${asset.hash}`,
      ]),
    ),
  };
};

const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) return false;
  return isTrustedRendererUrl(frame.url, app.isPackaged);
};

const assertSessionAccess = (
  event: IpcMainInvokeEvent,
  sessionId: string,
  editorOnly = true,
): void => {
  if (windowSessions.get(event.sender.id) !== sessionId) {
    throw new DesktopMainError(
      'UNAUTHORIZED',
      'This window cannot access that presentation.',
      false,
    );
  }
  if (editorOnly && windowModes.get(event.sender.id) !== 'editor') {
    throw new DesktopMainError('READ_ONLY', 'Presentation windows are read-only.');
  }
};

const handle = <TInput, TOutput>(
  channel: string,
  schema: z.ZodType<TInput>,
  operation: (event: IpcMainInvokeEvent, input: TInput) => Promise<TOutput> | TOutput,
): void => {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<DesktopResult<TOutput>> => {
    if (!isTrustedSender(event))
      return failure(new DesktopMainError('UNAUTHORIZED', 'Untrusted application window.', false));
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      return failure(new DesktopMainError('INVALID_REQUEST', 'The request is invalid.'));
    try {
      return success(await operation(event, parsed.data));
    } catch (error) {
      return failure(error);
    }
  });
};

const identifier = z.string().uuid();
const revision = z.string().min(1).max(160);
const collaborationDisplayName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
const sessionInputSchema = z.object({ sessionId: identifier }).strict();
const historyInputSchema = sessionInputSchema.extend({ expectedRevision: revision }).strict();
const collaborationTextLeaseInputSchema = sessionInputSchema
  .extend({ slideId: identifier, elementId: identifier })
  .strict();
const importImageInputSchema = historyInputSchema
  .extend({ slideId: identifier, replaceElementId: identifier.optional() })
  .strict();
const executeInputSchema = historyInputSchema
  .extend({
    label: z.string().trim().min(1).max(160),
    commands: z.array(documentCommandSchema).min(1).max(100),
    historyGroupId: z.string().uuid().optional(),
  })
  .strict();
const presentationInputSchema = sessionInputSchema
  .extend({ startSlideId: identifier.optional() })
  .strict();
const exportInputSchema = historyInputSchema
  .extend({ format: z.enum(['html', 'pdf']), includeHidden: z.boolean() })
  .strict();
const hostInputSchema = sessionInputSchema
  .extend({
    displayName: collaborationDisplayName,
    enableDiscovery: z.boolean(),
    hostAddress: z.string().trim().min(7).max(45),
  })
  .strict();
const joinInputSchema = sessionInputSchema
  .extend({
    endpoint: z.string().trim().min(1).max(512),
    sessionCode: z.string().trim().min(4).max(128),
    expectedFingerprint: z.string().trim().min(32).max(256),
    displayName: collaborationDisplayName,
  })
  .strict();
const collaborationJoinDecisionInputSchema = sessionInputSchema
  .extend({ joinRequestId: identifier, decision: z.enum(['accept', 'reject']) })
  .strict();
const collaborationPresenceInputSchema = sessionInputSchema
  .extend({
    slideId: identifier.optional(),
    selectedElementIds: z
      .array(identifier)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
    editingElementId: identifier.optional(),
  })
  .strict();
const mcpApprovalInputSchema = sessionInputSchema
  .extend({
    action: z.enum(['commit-destructive', 'undo', 'import', 'export-html', 'export-pdf']),
  })
  .strict();

const metadataFor = (event: IpcMainInvokeEvent, label: string): TransactionMetadata => ({
  transactionId: randomUUID(),
  actorId: `desktop-${event.sender.id}`,
  origin: 'user',
  label,
  timestamp: new Date().toISOString(),
});

const findWindow = (webContents: WebContents): BrowserWindow | undefined =>
  BrowserWindow.fromWebContents(webContents) ?? undefined;

const saveDialog = (
  parent: BrowserWindow | undefined,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> =>
  parent === undefined ? dialog.showSaveDialog(options) : dialog.showSaveDialog(parent, options);

const openDialog = (
  parent: BrowserWindow | undefined,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> =>
  parent === undefined ? dialog.showOpenDialog(options) : dialog.showOpenDialog(parent, options);

const messageBox = (
  parent: BrowserWindow | undefined,
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> =>
  parent === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(parent, options);

interface ExportTargetState {
  readonly exists: boolean;
  readonly device?: number | undefined;
  readonly inode?: number | undefined;
  readonly size?: number | undefined;
  readonly modifiedMs?: number | undefined;
  readonly changedMs?: number | undefined;
  readonly fingerprint?: string | undefined;
}

interface ApprovedExportTarget {
  readonly path: string;
  readonly state: ExportTargetState;
}

const exportTargetState = async (targetPath: string): Promise<ExportTargetState> => {
  try {
    const metadata = await lstat(targetPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new DesktopMainError(
        'TARGET_UNAVAILABLE',
        'The export destination must be a regular file.',
      );
    }
    return {
      exists: true,
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      modifiedMs: metadata.mtimeMs,
      changedMs: metadata.ctimeMs,
      fingerprint: await sha256File(targetPath),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw error;
  }
};

const sameExportTargetState = (left: ExportTargetState, right: ExportTargetState): boolean =>
  left.exists === right.exists &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.size === right.size &&
  left.modifiedMs === right.modifiedMs &&
  left.changedMs === right.changedMs &&
  left.fingerprint === right.fingerprint;

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const sha256File = async (filePath: string): Promise<string> => {
  const handle = await open(filePath, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return digest.digest('hex');
};

const mapExportFilesystemError = (error: unknown): DesktopMainError => {
  if (error instanceof DesktopMainError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new DesktopMainError('DISK_FULL', 'There is not enough free space for this export.');
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new DesktopMainError('TARGET_UNAVAILABLE', 'The export destination is not writable.');
  }
  return new DesktopMainError('EXPORT_FAILED', 'The export could not be written.');
};

const syncDirectoryBestEffort = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r').catch(() => undefined);
  if (handle === undefined) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const writeExportAtomically = async (
  target: ApprovedExportTarget,
  bytes: Uint8Array,
): Promise<number> => {
  const targetPath = target.path;
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    const observedTarget = await exportTargetState(targetPath);
    if (!sameExportTargetState(target.state, observedTarget)) {
      throw new DesktopMainError(
        'TARGET_CHANGED',
        'The export destination changed. Choose it again.',
      );
    }
    const expectedHash = sha256Bytes(bytes);
    const handle = await open(temporaryPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stagedMetadata = await stat(temporaryPath);
    if (!stagedMetadata.isFile() || stagedMetadata.size !== bytes.byteLength) {
      throw new DesktopMainError('EXPORT_FAILED', 'The staged export failed validation.');
    }
    if ((await sha256File(temporaryPath)) !== expectedHash) {
      throw new DesktopMainError('EXPORT_FAILED', 'The staged export failed validation.');
    }
    const currentTarget = await exportTargetState(targetPath);
    if (!sameExportTargetState(observedTarget, currentTarget)) {
      throw new DesktopMainError(
        'TARGET_CHANGED',
        'The export destination changed. Choose it again.',
      );
    }
    await rename(temporaryPath, targetPath);
    temporaryExists = false;
    await syncDirectoryBestEffort(path.dirname(targetPath));
    if ((await sha256File(targetPath)) !== expectedHash) {
      throw new DesktopMainError('EXPORT_FAILED', 'The committed export failed validation.');
    }
    return bytes.byteLength;
  } catch (error: unknown) {
    throw mapExportFilesystemError(error);
  } finally {
    if (temporaryExists) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const safeExportBaseName = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .trim()
    .slice(0, 100) || 'Untitled';

const chooseExportPath = async (
  parent: BrowserWindow | undefined,
  documentName: string,
  format: 'html' | 'pdf',
): Promise<ApprovedExportTarget> => {
  const extension = format === 'html' ? 'html' : 'pdf';
  const result = await saveDialog(parent, {
    title: format === 'html' ? 'Export standalone HTML' : 'Export PDF',
    defaultPath: `${safeExportBaseName(documentName)}.${extension}`,
    filters: [
      format === 'html'
        ? { name: 'Standalone HTML', extensions: ['html'] }
        : { name: 'PDF document', extensions: ['pdf'] },
    ],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (result.canceled || result.filePath === undefined) {
    throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
  }
  if (!path.isAbsolute(result.filePath)) {
    throw new DesktopMainError('TARGET_UNAVAILABLE', 'The export destination is invalid.');
  }
  const targetPath = result.filePath.toLowerCase().endsWith(`.${extension}`)
    ? result.filePath
    : `${result.filePath}.${extension}`;
  const state = await exportTargetState(targetPath);
  if (targetPath !== result.filePath && state.exists) {
    const confirmation = await messageBox(parent, {
      type: 'warning',
      title: 'Replace export?',
      message: `“${path.basename(targetPath)}” already exists. Replace it?`,
      buttons: ['Replace', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) {
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    }
  }
  return { path: targetPath, state };
};

const collectExportAssets = (
  sessionId: string,
  snapshot: DocumentSessionSnapshot,
): ReadonlyMap<string, Uint8Array> => {
  const assets = new Map<string, Uint8Array>();
  for (const asset of snapshot.document.assets) {
    try {
      assets.set(asset.id, runtime.getAssetBytesMainOnly(sessionId, asset.id).bytes);
    } catch (error: unknown) {
      if (!(error instanceof DocumentRuntimeError) || error.code !== 'ASSET_BYTES_MISSING') {
        throw error;
      }
    }
  }
  return assets;
};

const exportWarnings = (html: string): readonly string[] =>
  [...html.matchAll(/data-render-warning="([A-Z0-9_]+)"/g)]
    .map((match) => match[1])
    .filter((warning): warning is string => warning !== undefined)
    .filter((warning, index, warnings) => warnings.indexOf(warning) === index)
    .sort();

const PRINT_READY_WAIT_SCRIPT = `new Promise((resolve) => {
  const root = document.documentElement;
  const current = () => root.dataset.renderReady || "pending";
  if (current() !== "pending") { resolve(current()); return; }
  const done = () => {
    root.removeEventListener("htmllelujah:render-ready", done);
    root.removeEventListener("htmllelujah:render-failed", done);
    resolve(current());
  };
  root.addEventListener("htmllelujah:render-ready", done, { once: true });
  root.addEventListener("htmllelujah:render-failed", done, { once: true });
  const requested = Number(root.dataset.readinessDeadlineMs);
  const deadline = Number.isFinite(requested) ? Math.min(60000, Math.max(100, requested)) : 10000;
  setTimeout(() => resolve(current()), deadline + 1000);
})`;

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  error: DesktopMainError,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(error), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const assertPdfBytes = (bytes: Uint8Array): void => {
  const prefix = Buffer.from(bytes.subarray(0, 5)).toString('ascii');
  const trailer = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 1024))).toString(
    'ascii',
  );
  if (bytes.byteLength < 64 || prefix !== '%PDF-' || !trailer.includes('%%EOF')) {
    throw new DesktopMainError('EXPORT_FAILED', 'The generated PDF failed validation.');
  }
};

const printDocuments = new Map<string, string>();
let sharedPrintSession: Electron.Session | undefined;
let pdfExportQueue: Promise<void> = Promise.resolve();

const printTokenFromUrl = (rawUrl: string): string | undefined => {
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'htmllelujah-export:' ||
      url.hostname !== 'print' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return undefined;
    }
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    return segments.length === 1 ? segments[0] : undefined;
  } catch {
    return undefined;
  }
};

const getPrintSession = (): Electron.Session => {
  if (sharedPrintSession !== undefined) return sharedPrintSession;
  const isolated = session.fromPartition('htmllelujah-export', { cache: false });
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const token = printTokenFromUrl(details.url);
    const allowed =
      (token !== undefined && printDocuments.has(token)) || details.url.startsWith('data:image/');
    callback({ cancel: !allowed });
  });
  isolated.protocol.handle('htmllelujah-export', (request) => {
    const token = request.method === 'GET' ? printTokenFromUrl(request.url) : undefined;
    const printHtml = token === undefined ? undefined : printDocuments.get(token);
    if (printHtml === undefined) return notFound();
    return new Response(printHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
      },
    });
  });
  sharedPrintSession = isolated;
  return isolated;
};

const enqueuePdfExport = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = pdfExportQueue.then(operation, operation);
  pdfExportQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const createPdfBytesIsolated = async (printHtml: string): Promise<Uint8Array> => {
  const token = randomBytes(24).toString('base64url');
  const printUrl = `htmllelujah-export://print/${token}`;
  const printSession = getPrintSession();
  printDocuments.set(token, printHtml);
  let printWindow: BrowserWindow | undefined;
  try {
    printWindow = new BrowserWindow({
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: printSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        navigateOnDragDrop: false,
      },
    });
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    printWindow.webContents.on('will-navigate', (event, navigationUrl) => {
      if (navigationUrl !== printUrl) event.preventDefault();
    });
    printWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    await withTimeout(
      printWindow.loadURL(printUrl),
      PDF_READINESS_DEADLINE_MS,
      new DesktopMainError('RENDER_NOT_READY', 'The PDF render surface did not load.'),
    );
    const readiness = await withTimeout(
      printWindow.webContents.executeJavaScript(PRINT_READY_WAIT_SCRIPT, true) as Promise<unknown>,
      PDF_READINESS_DEADLINE_MS + 2_000,
      new DesktopMainError('RENDER_NOT_READY', 'The PDF render surface timed out.'),
    );
    if (readiness !== 'ready') {
      throw new DesktopMainError('RENDER_NOT_READY', 'The PDF render surface is not ready.');
    }
    const pdf = await withTimeout(
      printWindow.webContents.printToPDF({
        displayHeaderFooter: false,
        printBackground: true,
        scale: 1,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: true,
        generateTaggedPDF: true,
        generateDocumentOutline: false,
      }),
      30_000,
      new DesktopMainError('EXPORT_FAILED', 'PDF generation timed out.'),
    );
    assertPdfBytes(pdf);
    return Uint8Array.from(pdf);
  } finally {
    if (printWindow !== undefined && !printWindow.isDestroyed()) printWindow.destroy();
    printDocuments.delete(token);
  }
};

const createPdfBytes = (printHtml: string): Promise<Uint8Array> =>
  enqueuePdfExport(() => createPdfBytesIsolated(printHtml));

const exportSessionDocument = async (
  sessionId: string,
  input: {
    readonly expectedRevision: string;
    readonly format: 'html' | 'pdf';
    readonly includeHidden: boolean;
  },
  parent: BrowserWindow | undefined,
): Promise<ExportResult> => {
  const initialSnapshot = runtime.getSnapshot(sessionId);
  if (initialSnapshot.revision !== input.expectedRevision) {
    throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
  }
  const target = await chooseExportPath(parent, initialSnapshot.document.name, input.format);
  const snapshot = runtime.getSnapshot(sessionId);
  if (snapshot.revision !== input.expectedRevision) {
    throw new DocumentRuntimeError('REVISION_CONFLICT', 'Expected revision does not match.');
  }
  const startedAt = Date.now();
  const assets = collectExportAssets(sessionId, snapshot);
  const hiddenSlides = input.includeHidden ? 'include' : 'exclude';
  const pageCount = snapshot.document.slides.filter(
    (slide) => input.includeHidden || !slide.hidden,
  ).length;
  let html: string;
  let bytesWritten: number;
  if (input.format === 'html') {
    html = createStandaloneHtml(snapshot.document, assets, {
      hiddenSlides,
      title: snapshot.document.name,
      clickNavigation: true,
    });
    bytesWritten = await writeExportAtomically(target, Buffer.from(html, 'utf8'));
  } else {
    html = createPrintHtml(snapshot.document, assets, {
      hiddenSlides,
      title: snapshot.document.name,
      readinessDeadlineMs: PDF_READINESS_DEADLINE_MS,
    });
    const pdf = await createPdfBytes(html);
    bytesWritten = await writeExportAtomically(target, pdf);
  }
  return {
    format: input.format,
    pageCount,
    page: snapshot.document.page,
    bytesWritten,
    durationMs: Math.max(0, Date.now() - startedAt),
    warnings: exportWarnings(html),
  };
};

const confirmStandaloneWriterRecovery = async (
  parent: BrowserWindow | undefined,
): Promise<boolean> => {
  const choice = await messageBox(parent, {
    type: 'warning',
    title: 'Recover expired writer reservation?',
    message: 'A previous HTMLlelujah writer stopped renewing its file reservation.',
    detail:
      'Continue only if the other app or device is closed. HTMLlelujah will verify the reservation and observe an untrusted prior writer for a full lease window before taking ownership; any change cancels recovery.',
    buttons: ['Verify and recover', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (choice.response !== 0) {
    throw new DesktopMainError('CANCELLED', 'Writer reservation recovery was cancelled.');
  }
  return true;
};

const saveAsSerialized = async (
  event: IpcMainInvokeEvent,
  sessionId: string,
): Promise<DocumentSessionSnapshot | undefined> => {
  collaboration.assertStandaloneOperation(sessionId, 'Save As');
  const parent = findWindow(event.sender);
  const snapshot = runtime.getSnapshot(sessionId);
  const safeName =
    snapshot.document.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 100) || 'Untitled';
  const result = await saveDialog(parent ?? BrowserWindow.getFocusedWindow() ?? undefined, {
    title: 'Save presentation',
    defaultPath: `${safeName}.hdeck`,
    filters: [{ name: 'HTMLlelujah presentation', extensions: ['hdeck'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  });
  if (result.canceled || result.filePath === undefined) return undefined;
  const approved = await resolveSaveTarget({
    selectedPath: result.filePath,
    extension: '.hdeck',
    inspect: exportTargetState,
    confirmAddedExtensionOverwrite: async (targetPath) => {
      const confirmation = await messageBox(
        parent ?? BrowserWindow.getFocusedWindow() ?? undefined,
        {
          type: 'warning',
          title: 'Replace presentation?',
          message: `“${path.basename(targetPath)}” already exists. Replace it?`,
          buttons: ['Replace', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        },
      );
      return confirmation.response === 0;
    },
  });
  if (approved === undefined) return undefined;
  const targetPath = approved.path;
  return withExplicitStandaloneWriterRecovery(
    {
      targetPath,
      documentId: snapshot.documentId,
      sessionId,
    },
    () => confirmStandaloneWriterRecovery(parent ?? BrowserWindow.getFocusedWindow() ?? undefined),
    (guard) =>
      runtime.saveAsMainOnly(sessionId, {
        targetPath,
        // The relevant dialog supplied overwrite consent; pin that exact post-dialog file so a
        // later external change is rejected instead of being mistaken for the approved bytes.
        expectedFingerprint: approved.state.fingerprint ?? null,
        beforeCommit: guard.beforeCommit,
      }),
  );
};

const saveAs = (
  event: IpcMainInvokeEvent,
  sessionId: string,
): Promise<DocumentSessionSnapshot | undefined> =>
  standaloneSaveQueue.run(sessionId, () => {
    assertSessionAccess(event, sessionId);
    collaboration.assertStandaloneOperation(sessionId, 'Save As');
    return saveAsSerialized(event, sessionId);
  });

const saveStandaloneWithTargetFallbackSerialized = async (
  event: IpcMainInvokeEvent,
  sessionId: string,
): Promise<DocumentSessionSnapshot | undefined> => {
  assertSessionAccess(event, sessionId);
  collaboration.assertStandaloneOperation(sessionId, 'Save');
  const snapshot = runtime.getSnapshot(sessionId);
  if (!snapshot.hasSaveTarget) return saveAsSerialized(event, sessionId);
  const targetPath = await runtime.getSaveTargetMainOnly(sessionId);
  if (targetPath === undefined) {
    throw new DesktopMainError('NO_SAVE_TARGET', 'Choose where to save this presentation.');
  }
  const parent = findWindow(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  return withExplicitStandaloneWriterRecovery(
    {
      targetPath,
      documentId: snapshot.documentId,
      sessionId,
    },
    () => confirmStandaloneWriterRecovery(parent),
    (guard) =>
      runtime.save(sessionId, {
        expectedTargetPath: targetPath,
        beforeCommit: guard.beforeCommit,
      }),
  );
};

const saveWithTargetFallback = async (
  event: IpcMainInvokeEvent,
  sessionId: string,
): Promise<DocumentSessionSnapshot | undefined> => {
  const collaborative = await collaboration.saveHost(sessionId);
  if (collaborative !== undefined) return collaborative;
  return standaloneSaveQueue.run(sessionId, () =>
    saveStandaloneWithTargetFallbackSerialized(event, sessionId),
  );
};

const confirmReplace = async (event: IpcMainInvokeEvent): Promise<ReplaceAuthorization | null> => {
  const currentId = windowSessions.get(event.sender.id);
  if (currentId === undefined) return {};
  const collaborationMode = collaboration.mode(currentId);
  if (collaborationMode !== 'offline') {
    const parent = findWindow(event.sender);
    const choice = await messageBox(parent ?? BrowserWindow.getFocusedWindow() ?? undefined, {
      type: 'warning',
      title: 'End collaboration session?',
      message: 'This action will end the live LAN session on this device.',
      detail:
        collaborationMode === 'host'
          ? 'HTMLlelujah will save the authoritative presentation before continuing.'
          : 'All accepted edits are already held by the host. This guest never writes the shared file.',
      buttons: ['End session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response !== 0) return null;
    const ended = await collaboration.leave(currentId);
    if (ended?.preserveDetached === true) {
      await messageBox(parent ?? BrowserWindow.getFocusedWindow() ?? undefined, {
        type: 'warning',
        title: 'Save a recovery copy first',
        message:
          ended.preservationReason === 'guest-copy'
            ? 'Your detached guest copy contains unsaved work.'
            : 'Unsaved edits were detached from the unsafe shared-file writer.',
        detail:
          'The copy remains open and journaled. Use Save As before replacing this presentation.',
        buttons: ['OK'],
        noLink: true,
      });
      return null;
    }
    const finalSnapshot = runtime.getSnapshot(currentId);
    return {
      sessionId: currentId,
      closeOptions: { expectedRevision: finalSnapshot.revision },
    };
  }
  const snapshot = runtime.getSnapshot(currentId);
  if (!snapshot.dirty) {
    return {
      sessionId: currentId,
      closeOptions: { expectedRevision: snapshot.revision },
    };
  }
  const parent = findWindow(event.sender);
  const choice = await messageBox(parent ?? BrowserWindow.getFocusedWindow() ?? undefined, {
    type: 'warning',
    title: 'Unsaved changes',
    message: `Save changes to “${snapshot.document.name}”?`,
    detail:
      'Your recovery journal remains available until you explicitly discard this presentation.',
    buttons: ['Save', 'Discard', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (choice.response !== 0 && choice.response !== 1) return null;
  if (choice.response === 0) {
    const saved = await saveWithTargetFallback(event, currentId);
    if (saved === undefined) return null;
    return {
      sessionId: currentId,
      closeOptions: { expectedRevision: saved.revision },
    };
  }
  return {
    sessionId: currentId,
    closeOptions: {
      discardUnsaved: true,
      expectedRevision: snapshot.revision,
    },
  };
};

const assignSession = async (
  event: IpcMainInvokeEvent,
  snapshot: DocumentSessionSnapshot,
  authorization: ReplaceAuthorization,
  options: AssignSessionOptions = {},
): Promise<SessionView> => {
  const previous = windowSessions.get(event.sender.id);
  const cleanupReplacement = async (): Promise<void> => {
    await cleanupSessionIfUnowned(
      () => [...windowSessions.values()].includes(snapshot.sessionId),
      () => collaboration.shutdown(snapshot.sessionId),
      () =>
        runtime.close(snapshot.sessionId, {
          discardUnsaved: true,
          ...(options.preserveRecoveryOnFailure === true ? { preserveRecovery: true } : {}),
        }),
    );
  };
  if (authorization.sessionId !== previous) {
    await cleanupReplacement();
    throw new DesktopMainError(
      'REVISION_CONFLICT',
      'The presentation changed before it could be replaced.',
    );
  }
  if (previous !== undefined && previous !== snapshot.sessionId) {
    const siblingOwnerIds = [...windowSessions.entries()]
      .filter(
        ([candidateId, candidateSessionId]) =>
          candidateId !== event.sender.id && candidateSessionId === previous,
      )
      .map(([candidateId]) => candidateId);
    if (siblingOwnerIds.some((candidateId) => windowModes.get(candidateId) !== 'presentation')) {
      await cleanupReplacement();
      throw new DesktopMainError(
        'REVISION_CONFLICT',
        'Another editor still owns the presentation being replaced.',
      );
    }
    if (authorization.closeOptions === undefined) {
      await cleanupReplacement();
      throw new DesktopMainError(
        'REVISION_CONFLICT',
        'The presentation changed before it could be replaced.',
      );
    }
    try {
      await collaboration.shutdown(previous);
      await runtime.close(previous, authorization.closeOptions);
    } catch (error) {
      await cleanupReplacement();
      throw error;
    }
    const remainingOwnerIds = [...windowSessions.entries()]
      .filter(
        ([candidateId, candidateSessionId]) =>
          candidateId !== event.sender.id && candidateSessionId === previous,
      )
      .map(([candidateId]) => candidateId);
    for (const candidate of BrowserWindow.getAllWindows()) {
      if (remainingOwnerIds.includes(candidate.webContents.id) && !candidate.isDestroyed()) {
        try {
          candidate.destroy();
        } catch {
          // A stale native presentation window cannot be allowed to block the authorized handoff.
        }
      }
    }
    for (const remainingOwnerId of remainingOwnerIds) {
      revokeWebContentsTokens(remainingOwnerId);
      windowSessions.delete(remainingOwnerId);
      windowModes.delete(remainingOwnerId);
    }
  }
  windowSessions.set(event.sender.id, snapshot.sessionId);
  const window = findWindow(event.sender);
  window?.setTitle(`${snapshot.document.name}${snapshot.dirty ? ' •' : ''} — HTMLlelujah`);
  event.sender.send(DESKTOP_IPC.documentChanged, {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    reason: 'opened',
  });
  return sessionView(event.sender.id, snapshot);
};

const openPathInEditorWindow = async (window: BrowserWindow, targetPath: string): Promise<void> => {
  const syntheticEvent = { sender: window.webContents } as IpcMainInvokeEvent;
  const authorization = await confirmReplace(syntheticEvent);
  if (authorization === null) return;
  const opened = await runtime.openMainOnly({ targetPath });
  await assignSession(syntheticEvent, opened, authorization);
};

interface SelectedImageFile {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  readonly fileName: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

const selectImageFile = async (parent: BrowserWindow | undefined): Promise<SelectedImageFile> => {
  const result = await openDialog(parent, {
    title: 'Insert image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  const targetPath = result.filePaths[0];
  if (result.canceled || targetPath === undefined) {
    throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
  }
  const targetStat = await lstat(targetPath);
  if (
    !targetStat.isFile() ||
    targetStat.isSymbolicLink() ||
    targetStat.size <= 0 ||
    targetStat.size > MAX_IMAGE_BYTES
  ) {
    throw new DesktopMainError(
      'INVALID_ASSET',
      'Choose a PNG, JPEG, or WebP image smaller than 25 MB.',
    );
  }
  const bytes = await readFile(targetPath);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new DesktopMainError(
      'INVALID_ASSET',
      'Choose a PNG, JPEG, or WebP image smaller than 25 MB.',
    );
  }
  let header;
  try {
    // Header parsing is bounded and happens before Chromium is asked to decode any pixels.
    header = inspectImageBeforeDecode(bytes);
  } catch (error) {
    if (error instanceof ImageImportValidationError) {
      throw new DesktopMainError('INVALID_ASSET', error.message);
    }
    throw error;
  }
  const decoded = nativeImage.createFromBuffer(bytes);
  const dimensions = decoded.getSize();
  try {
    assertDecodedDimensions(header, {
      empty: decoded.isEmpty(),
      widthPx: dimensions.width,
      heightPx: dimensions.height,
    });
  } catch (error) {
    if (error instanceof ImageImportValidationError) {
      throw new DesktopMainError('INVALID_ASSET', error.message);
    }
    throw error;
  }
  return {
    bytes,
    mediaType: header.mediaType,
    fileName: path.basename(targetPath).slice(0, 255),
    widthPx: header.widthPx,
    heightPx: header.heightPx,
  };
};

const findElementById = (elements: readonly Element[], elementId: string): Element | undefined => {
  for (const element of elements) {
    if (element.id === elementId) return element;
    if (element.type === 'group') {
      const nested = findElementById(element.children, elementId);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const defaultImageElement = (
  assetId: string,
  widthPx: number,
  heightPx: number,
  page: DocumentSessionSnapshot['document']['page'],
): ImageElement => {
  return {
    id: randomUUID(),
    type: 'image',
    name: 'Image',
    frame: imageFrameForPage(widthPx, heightPx, page),
    opacity: 1,
    visible: true,
    locked: false,
    assetId,
    altText: 'Presentation image',
    fit: 'cover',
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
  };
};

const importImageAssetForSession = async (input: {
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly parent: BrowserWindow | undefined;
  readonly metadata: TransactionMetadata;
}): Promise<{ readonly snapshot: DocumentSessionSnapshot; readonly assetId: string }> => {
  collaboration.assertStandaloneOperation(input.sessionId, 'Image import');
  const selected = await selectImageFile(input.parent);
  const imported = await runtime.importAssetAndExecute(input.sessionId, {
    id: randomUUID(),
    ...selected,
    expectedRevision: input.expectedRevision,
    metadata: input.metadata,
    commands: [],
  });
  return { snapshot: imported.snapshot, assetId: imported.assetId };
};

const importImageForSession = async (input: {
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly slideId: string;
  readonly replaceElementId?: string | undefined;
  readonly parent: BrowserWindow | undefined;
  readonly metadata: TransactionMetadata;
}): Promise<{
  readonly snapshot: DocumentSessionSnapshot;
  readonly assetId: string;
  readonly elementId: string;
}> => {
  collaboration.assertStandaloneOperation(input.sessionId, 'Image import');
  const selected = await selectImageFile(input.parent);
  const current = runtime.getSnapshot(input.sessionId);
  const slide = current.document.slides.find((candidate) => candidate.id === input.slideId);
  if (slide === undefined) {
    throw new DesktopMainError('INVALID_REQUEST', 'The destination slide no longer exists.');
  }
  const assetId = randomUUID();
  let element: ImageElement;
  if (input.replaceElementId === undefined) {
    element = defaultImageElement(
      assetId,
      selected.widthPx,
      selected.heightPx,
      current.document.page,
    );
  } else {
    const existing = findElementById(slide.elements, input.replaceElementId);
    if (existing?.type !== 'image') {
      throw new DesktopMainError('INVALID_REQUEST', 'The image to replace no longer exists.');
    }
    element = { ...existing, assetId };
  }
  const imported = await runtime.importAssetAndExecute(input.sessionId, {
    id: assetId,
    ...selected,
    expectedRevision: input.expectedRevision,
    metadata: input.metadata,
    commands: [
      input.replaceElementId === undefined
        ? { type: 'element.insert', slideId: slide.id, element }
        : {
            type: 'element.update',
            slideId: slide.id,
            elementId: input.replaceElementId,
            replacement: element,
          },
    ],
  });
  return {
    snapshot: imported.snapshot,
    assetId: imported.assetId,
    elementId: element.id,
  };
};

const visibleEditorSessionIds = (): readonly string[] => [
  ...new Set(
    BrowserWindow.getAllWindows()
      .filter((window) => windowModes.get(window.webContents.id) === 'editor')
      .map((window) => windowSessions.get(window.webContents.id))
      .filter((sessionId): sessionId is string => sessionId !== undefined),
  ),
];

const mcpBridge = new DesktopMcpBridge({
  runtime,
  appVersion: () => app.getVersion(),
  visibleSessionIds: visibleEditorSessionIds,
  collaborationStatus: (sessionId) => collaboration.status(sessionId),
  importAsset: async (sessionId, expectedRevision) => {
    const imported = await importImageAssetForSession({
      sessionId,
      expectedRevision,
      parent: BrowserWindow.getFocusedWindow() ?? undefined,
      metadata: {
        transactionId: randomUUID(),
        actorId: 'mcp-local-agent',
        origin: 'agent',
        label: 'Import approved image',
        timestamp: new Date().toISOString(),
      },
    });
    const asset = imported.snapshot.document.assets.find(
      (candidate) => candidate.id === imported.assetId,
    );
    return {
      documentId: imported.snapshot.documentId,
      revision: imported.snapshot.revision,
      assetId: imported.assetId,
      mediaType: asset?.mediaType ?? 'unknown',
      byteLength: asset?.byteLength ?? 0,
    };
  },
  exportDocument: async (sessionId, input) => ({
    documentId: input.documentId,
    ...(await exportSessionDocument(
      sessionId,
      input,
      BrowserWindow.getFocusedWindow() ?? undefined,
    )),
  }),
});

let mcpRpcServer: LocalRpcServerHandle | undefined;
let gracefulShutdownStarted = false;

const reportCloseFailure = async (window: BrowserWindow): Promise<void> => {
  await dialog.showMessageBox(window, {
    type: 'error',
    title: 'Presentation remains open',
    message: 'HTMLlelujah could not safely complete the close operation.',
    detail:
      'The window, current session, and recovery journal were kept. Resolve the save or collaboration issue and try again.',
    buttons: ['OK'],
    noLink: true,
  });
};

const createEditorWindow = async (initialPath?: string): Promise<BrowserWindow> => {
  const window = new BrowserWindow({
    width: 1540,
    height: 970,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: 'HTMLlelujah',
    autoHideMenuBar: true,
    backgroundColor: '#f5f3ee',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
      navigateOnDragDrop: false,
    },
  });
  const webContentsId = window.webContents.id;
  let createdSessionId: string | undefined;
  return initializeWindowSafely(
    window,
    async () => {
      windowModes.set(webContentsId, 'editor');
      const snapshot =
        initialPath === undefined
          ? await runtime.createMainOnly()
          : await runtime.openMainOnly({ targetPath: initialPath });
      windowSessions.set(window.webContents.id, snapshot.sessionId);
      createdSessionId = snapshot.sessionId;
      window.setTitle(`${snapshot.document.name}${snapshot.dirty ? ' •' : ''} — HTMLlelujah`);

      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.webContents.on('destroyed', () => {
        revokeWebContentsTokens(webContentsId);
        windowModes.delete(webContentsId);
        windowSessions.delete(webContentsId);
        closingWindows.delete(webContentsId);
        closingDecisions.delete(webContentsId);
        rendererPreparedCloses.delete(webContentsId);
        rendererCloseHandshake.cancel(webContentsId);
      });
      window.once('ready-to-show', () => window.show());
      window.on('close', (event) => {
        const webContentsId = window.webContents.id;
        if (closingWindows.has(webContentsId)) return;
        const rendererPrepared = rendererPreparedCloses.delete(webContentsId);
        if (!rendererPrepared) {
          event.preventDefault();
          if (closingDecisions.has(webContentsId)) return;
          closingDecisions.add(webContentsId);
          void (async (): Promise<void> => {
            let handedOff = false;
            try {
              const result = await rendererCloseHandshake.request(webContentsId, (request) => {
                if (window.isDestroyed() || window.webContents.isDestroyed()) {
                  throw new Error('The editor window closed before its draft could be flushed.');
                }
                window.webContents.send(DESKTOP_IPC.windowCloseRequested, request);
              });
              if (result.decision !== 'ready') {
                if (!window.isDestroyed()) {
                  await reportCloseFailure(window).catch(() => undefined);
                }
                return;
              }
              if (window.isDestroyed()) return;
              closingDecisions.delete(webContentsId);
              handedOff = true;
              runAuthorizedWindowClose(rendererPreparedCloses, webContentsId, () => window.close());
            } catch {
              if (!window.isDestroyed()) await reportCloseFailure(window).catch(() => undefined);
            } finally {
              if (!handedOff) closingDecisions.delete(webContentsId);
            }
          })();
          return;
        }
        if (closingDecisions.has(webContentsId)) {
          event.preventDefault();
          return;
        }
        const sessionId = windowSessions.get(webContentsId);
        if (sessionId === undefined) return;
        const collaborationMode = collaboration.mode(sessionId);
        if (collaborationMode !== 'offline') {
          event.preventDefault();
          closingDecisions.add(webContentsId);
          void retainWindowOnFailure(
            window,
            async () => {
              let discardDetachedChanges = false;
              let closeRevision: string | undefined;
              try {
                const ended = await collaboration.leave(sessionId);
                closeRevision = runtime.getSnapshot(sessionId).revision;
                if (ended?.preserveDetached === true) {
                  const choice = await dialog.showMessageBox(window, {
                    type: 'warning',
                    title: 'Save detached collaboration copy?',
                    message:
                      ended.preservationReason === 'guest-copy'
                        ? 'The guest copy is not stored in the shared file.'
                        : 'The shared-file writer became unsafe, so HTMLlelujah detached your edits.',
                    detail:
                      'Save a separate .hdeck to keep these edits, or explicitly discard them. Cancel keeps the recovery copy open and journaled.',
                    buttons: ['Save Copy', 'Discard', 'Cancel'],
                    defaultId: 0,
                    cancelId: 2,
                    noLink: true,
                  });
                  if (choice.response !== 0 && choice.response !== 1) return;
                  discardDetachedChanges = choice.response === 1;
                  if (choice.response === 0) {
                    const syntheticEvent = { sender: window.webContents } as IpcMainInvokeEvent;
                    const saved = await saveAs(syntheticEvent, sessionId);
                    if (saved === undefined) return;
                    closeRevision = saved.revision;
                  }
                }
              } catch {
                await dialog.showMessageBox(window, {
                  type: 'error',
                  title: 'Collaboration could not close safely',
                  message:
                    collaborationMode === 'host'
                      ? 'The authoritative presentation could not be saved. Resolve the shared-file issue and try again.'
                      : 'The guest connection could not be closed cleanly. Try again.',
                  buttons: ['OK'],
                  noLink: true,
                });
                return;
              }
              if (closeRevision === undefined) {
                throw new DesktopMainError(
                  'REVISION_CONFLICT',
                  'The presentation changed before it could close.',
                );
              }
              await runtime.close(sessionId, {
                expectedRevision: closeRevision,
                ...(discardDetachedChanges ? { discardUnsaved: true } : {}),
              });
              closingWindows.add(webContentsId);
              for (const candidate of BrowserWindow.getAllWindows()) {
                if (candidate === window) continue;
                if (windowSessions.get(candidate.webContents.id) === sessionId) candidate.destroy();
              }
              window.destroy();
            },
            () => reportCloseFailure(window),
          ).finally(() => closingDecisions.delete(webContentsId));
          return;
        }
        const snapshot = runtime.getSnapshot(sessionId);
        if (!snapshot.dirty) {
          event.preventDefault();
          closingDecisions.add(webContentsId);
          void retainWindowOnFailure(
            window,
            async () => {
              await collaboration.shutdown(sessionId);
              await runtime.close(sessionId, { expectedRevision: snapshot.revision });
              closingWindows.add(webContentsId);
              for (const candidate of BrowserWindow.getAllWindows()) {
                if (candidate === window) continue;
                if (windowSessions.get(candidate.webContents.id) === sessionId) candidate.destroy();
              }
              window.destroy();
            },
            () => reportCloseFailure(window),
          ).finally(() => closingDecisions.delete(webContentsId));
          return;
        }
        event.preventDefault();
        closingDecisions.add(webContentsId);
        void retainWindowOnFailure(
          window,
          async () => {
            const choice = await dialog.showMessageBox(window, {
              type: 'warning',
              title: 'Unsaved changes',
              message: `Save changes to “${snapshot.document.name}”?`,
              buttons: ['Save', 'Discard', 'Cancel'],
              defaultId: 0,
              cancelId: 2,
              noLink: true,
            });
            if (choice.response !== 0 && choice.response !== 1) return;
            let closeOptions: CloseSessionOptions;
            if (choice.response === 0) {
              const syntheticEvent = { sender: window.webContents } as IpcMainInvokeEvent;
              const saved = await saveWithTargetFallback(syntheticEvent, sessionId);
              if (saved === undefined) return;
              closeOptions = { expectedRevision: saved.revision };
            } else {
              closeOptions = {
                discardUnsaved: true,
                expectedRevision: snapshot.revision,
              };
            }
            await runtime.close(sessionId, closeOptions);
            closingWindows.add(webContentsId);
            for (const candidate of BrowserWindow.getAllWindows()) {
              if (candidate === window) continue;
              if (windowSessions.get(candidate.webContents.id) === sessionId) candidate.destroy();
            }
            window.destroy();
          },
          () => reportCloseFailure(window),
        ).finally(() => closingDecisions.delete(webContentsId));
      });

      await window.loadURL(
        resolveRendererEntryUrl({
          packaged: app.isPackaged,
          ...(process.env.VITE_DEV_SERVER_URL === undefined
            ? {}
            : { devServerUrl: process.env.VITE_DEV_SERVER_URL }),
        }),
      );
      return window;
    },
    async () => {
      revokeWebContentsTokens(webContentsId);
      windowModes.delete(webContentsId);
      windowSessions.delete(webContentsId);
      if (createdSessionId !== undefined) {
        await collaboration.shutdown(createdSessionId).catch(() => undefined);
        await runtime.close(createdSessionId, { discardUnsaved: true }).catch(() => undefined);
      }
    },
  );
};

const reportOpenFailure = async (parent?: BrowserWindow): Promise<void> => {
  await messageBox(parent, {
    type: 'error',
    title: 'Presentation could not be opened',
    message: 'The selected .hdeck could not be opened safely.',
    detail: 'No existing presentation or recovery journal was replaced.',
    buttons: ['OK'],
    noLink: true,
  }).catch(() => undefined);
};

const openPathInEditorWindowSafely = async (
  window: BrowserWindow,
  targetPath: string,
): Promise<void> => {
  try {
    await openPathInEditorWindow(window, targetPath);
  } catch {
    if (!window.isDestroyed()) await reportOpenFailure(window);
  }
};

const createEditorWindowSafely = async (
  initialPath?: string,
): Promise<BrowserWindow | undefined> => {
  try {
    return await createEditorWindow(initialPath);
  } catch {
    if (initialPath !== undefined) {
      await reportOpenFailure();
      try {
        return await createEditorWindow();
      } catch {
        await messageBox(undefined, {
          type: 'error',
          title: 'HTMLlelujah could not start',
          message: 'The editor window could not be initialized safely.',
          buttons: ['Close'],
          noLink: true,
        }).catch(() => undefined);
      }
    } else {
      await messageBox(undefined, {
        type: 'error',
        title: 'HTMLlelujah could not start',
        message: 'The editor window could not be initialized safely.',
        buttons: ['Close'],
        noLink: true,
      }).catch(() => undefined);
    }
    return undefined;
  }
};

const createPresentationWindow = async (
  sessionId: string,
  startSlideId?: string,
): Promise<BrowserWindow> => {
  const source = runtime.getSnapshot(sessionId);
  const window = new BrowserWindow({
    show: false,
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: `${source.document.name} — Presentation`,
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  const webContentsId = window.webContents.id;
  return initializeWindowSafely(
    window,
    async () => {
      windowModes.set(webContentsId, 'presentation');
      windowSessions.set(webContentsId, sessionId);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.webContents.on('destroyed', () => {
        revokeWebContentsTokens(webContentsId);
        windowModes.delete(webContentsId);
        windowSessions.delete(webContentsId);
      });
      window.once('ready-to-show', () => window.show());
      const query = new URLSearchParams({ mode: 'presentation' });
      if (startSlideId !== undefined) query.set('startSlideId', startSlideId);
      await window.loadURL(
        resolveRendererEntryUrl({
          packaged: app.isPackaged,
          ...(process.env.VITE_DEV_SERVER_URL === undefined
            ? {}
            : { devServerUrl: process.env.VITE_DEV_SERVER_URL }),
          query,
        }),
      );
      return window;
    },
    async () => {
      revokeWebContentsTokens(webContentsId);
      windowModes.delete(webContentsId);
      windowSessions.delete(webContentsId);
    },
  );
};

const configureIpc = (): void => {
  ipcMain.on(DESKTOP_IPC.windowCloseResponse, (event, value: unknown) => {
    rendererCloseHandshake.receive(event.sender.id, value);
  });

  handle(DESKTOP_IPC.getAppInfo, z.undefined(), (): AppInfo => ({
    apiVersion: DESKTOP_API_VERSION,
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
  }));

  handle(DESKTOP_IPC.initialize, z.undefined(), async (event): Promise<InitializeResult> => {
    const sessionId = windowSessions.get(event.sender.id);
    const mode = windowModes.get(event.sender.id);
    if (sessionId === undefined || mode === undefined)
      throw new DesktopMainError('SESSION_NOT_FOUND', 'This window has no presentation.');
    return {
      session: sessionView(event.sender.id, runtime.getSnapshot(sessionId)),
      recoveryCandidates: mode === 'editor' ? await runtime.listRecoveryCandidatesMainOnly() : [],
      mode,
    };
  });

  handle(DESKTOP_IPC.createDocument, z.undefined(), async (event) => {
    if (windowModes.get(event.sender.id) !== 'editor')
      throw new DesktopMainError('READ_ONLY', 'Presentation windows are read-only.');
    const authorization = await confirmReplace(event);
    if (authorization === null)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return assignSession(event, await runtime.createMainOnly(), authorization);
  });

  handle(DESKTOP_IPC.openDocument, z.undefined(), async (event) => {
    if (windowModes.get(event.sender.id) !== 'editor')
      throw new DesktopMainError('READ_ONLY', 'Presentation windows are read-only.');
    const parent = findWindow(event.sender);
    const result = await openDialog(parent ?? BrowserWindow.getFocusedWindow() ?? undefined, {
      title: 'Open presentation',
      filters: [{ name: 'HTMLlelujah presentation', extensions: ['hdeck'] }],
      properties: ['openFile'],
    });
    const targetPath = result.filePaths[0];
    if (result.canceled || targetPath === undefined)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    const authorization = await confirmReplace(event);
    if (authorization === null)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return assignSession(event, await runtime.openMainOnly({ targetPath }), authorization);
  });

  handle(DESKTOP_IPC.execute, executeInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    const collaborative = await collaboration.execute(input);
    const snapshot =
      collaborative ??
      (await runtime.execute(input.sessionId, {
        expectedRevision: input.expectedRevision,
        commands: input.commands,
        metadata: metadataFor(event, input.label),
        ...(input.historyGroupId === undefined ? {} : { historyGroupId: input.historyGroupId }),
      }));
    return sessionView(event.sender.id, snapshot);
  });

  handle(DESKTOP_IPC.undo, historyInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    collaboration.assertStandaloneOperation(input.sessionId, 'Undo');
    const snapshot = await runtime.undo(input.sessionId, {
      expectedRevision: input.expectedRevision,
      metadata: metadataFor(event, 'Undo'),
    });
    return sessionView(event.sender.id, snapshot);
  });

  handle(DESKTOP_IPC.redo, historyInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    collaboration.assertStandaloneOperation(input.sessionId, 'Redo');
    const snapshot = await runtime.redo(input.sessionId, {
      expectedRevision: input.expectedRevision,
      metadata: metadataFor(event, 'Redo'),
    });
    return sessionView(event.sender.id, snapshot);
  });

  handle(DESKTOP_IPC.save, sessionInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    const snapshot = await saveWithTargetFallback(event, input.sessionId);
    if (snapshot === undefined)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return sessionView(event.sender.id, snapshot);
  });

  handle(DESKTOP_IPC.saveAs, sessionInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    collaboration.assertStandaloneOperation(input.sessionId, 'Save As');
    const snapshot = await saveAs(event, input.sessionId);
    if (snapshot === undefined)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return sessionView(event.sender.id, snapshot);
  });

  handle(DESKTOP_IPC.importImage, importImageInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    const imported = await importImageForSession({
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      slideId: input.slideId,
      ...(input.replaceElementId === undefined ? {} : { replaceElementId: input.replaceElementId }),
      parent: findWindow(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined,
      metadata: metadataFor(event, 'Import image'),
    });
    return {
      session: sessionView(event.sender.id, imported.snapshot),
      assetId: imported.assetId,
      elementId: imported.elementId,
    };
  });

  handle(DESKTOP_IPC.listRecovery, z.undefined(), () => runtime.listRecoveryCandidatesMainOnly());

  handle(DESKTOP_IPC.recover, identifier, async (event, candidateId) => {
    if (windowModes.get(event.sender.id) !== 'editor')
      throw new DesktopMainError('READ_ONLY', 'Presentation windows are read-only.');
    const authorization = await confirmReplace(event);
    if (authorization === null)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return assignSession(event, await runtime.recoverMainOnly(candidateId), authorization, {
      preserveRecoveryOnFailure: true,
    });
  });

  handle(DESKTOP_IPC.present, presentationInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    await createPresentationWindow(input.sessionId, input.startSlideId);
    return null;
  });

  handle(DESKTOP_IPC.exportDocument, exportInputSchema, (event, input): Promise<ExportResult> => {
    assertSessionAccess(event, input.sessionId);
    return exportSessionDocument(
      input.sessionId,
      input,
      findWindow(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined,
    );
  });

  handle(DESKTOP_IPC.collaborationStatus, sessionInputSchema, (event, input) => {
    assertSessionAccess(event, input.sessionId, false);
    return collaboration.status(input.sessionId);
  });
  handle(
    DESKTOP_IPC.collaborationDecideJoin,
    collaborationJoinDecisionInputSchema,
    async (event, input) => {
      assertSessionAccess(event, input.sessionId);
      return collaboration.decideJoin(input);
    },
  );
  handle(
    DESKTOP_IPC.collaborationUpdatePresence,
    collaborationPresenceInputSchema,
    async (event, input) => {
      assertSessionAccess(event, input.sessionId);
      return collaboration.updatePresence(input);
    },
  );
  handle(
    DESKTOP_IPC.collaborationTextLeaseStatus,
    collaborationTextLeaseInputSchema,
    (event, input): CollaborationTextLeaseStatus => {
      assertSessionAccess(event, input.sessionId, false);
      return collaboration.textLeaseStatus(input);
    },
  );
  handle(
    DESKTOP_IPC.collaborationTextLeaseBegin,
    collaborationTextLeaseInputSchema,
    async (event, input): Promise<CollaborationTextLeaseStatus> => {
      assertSessionAccess(event, input.sessionId);
      if (collaboration.mode(input.sessionId) === 'offline') {
        return collaboration.textLeaseStatus(input);
      }
      return collaboration.beginTextLease(input);
    },
  );
  handle(
    DESKTOP_IPC.collaborationTextLeaseRenew,
    collaborationTextLeaseInputSchema,
    async (event, input): Promise<CollaborationTextLeaseStatus> => {
      assertSessionAccess(event, input.sessionId);
      if (collaboration.mode(input.sessionId) === 'offline') {
        return collaboration.textLeaseStatus(input);
      }
      return collaboration.renewTextLease(input);
    },
  );
  handle(
    DESKTOP_IPC.collaborationTextLeaseEnd,
    collaborationTextLeaseInputSchema,
    async (event, input): Promise<CollaborationTextLeaseStatus> => {
      assertSessionAccess(event, input.sessionId, false);
      return collaboration.endTextLease(input);
    },
  );
  handle(DESKTOP_IPC.collaborationHost, hostInputSchema, async (event, input) => {
    const result = await runSerializedStandaloneCollaborationTransition(standaloneSaveQueue, {
      sessionId: input.sessionId,
      assertCurrent: () => {
        assertSessionAccess(event, input.sessionId);
        collaboration.assertStandaloneOperation(input.sessionId, 'Start collaboration');
      },
      getSnapshot: () => runtime.getSnapshot(input.sessionId),
      getTargetPath: () => runtime.getSaveTargetMainOnly(input.sessionId),
      saveDirty: () => saveStandaloneWithTargetFallbackSerialized(event, input.sessionId),
      missingTarget: () => {
        throw new DesktopMainError(
          'COLLABORATION_REQUIRES_SAVED_FILE',
          'Save this presentation as a .hdeck before hosting.',
        );
      },
      transition: async ({ source, targetPath }) => {
        let transition;
        try {
          transition = await collaboration.host({ ...input, targetPath });
        } catch (error) {
          if (!(error instanceof CollaborationError) || error.code !== 'WRITER_LEASE_STALE') {
            throw error;
          }
          const parent = findWindow(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
          const choice = await messageBox(parent, {
            type: 'warning',
            title: 'Take over expired writer lease?',
            message: 'The previous collaboration host stopped renewing its writer lease.',
            detail:
              'Continue only if that host is closed. HTMLlelujah will observe the shared file for a full lease window before taking ownership; any active heartbeat cancels the takeover.',
            buttons: ['Verify and take over', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
          });
          if (choice.response !== 0) {
            throw new DesktopMainError('CANCELLED', 'Writer takeover was cancelled.');
          }
          transition = await collaboration.host({
            ...input,
            targetPath,
            allowExpiredTakeover: true,
          });
        }
        await assignSession(event, transition.snapshot, {
          sessionId: transition.previousSessionId,
          closeOptions: { expectedRevision: source.revision },
        });
        return transition.status;
      },
    });
    if (result === undefined)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return result;
  });
  handle(DESKTOP_IPC.collaborationJoin, joinInputSchema, async (event, input) => {
    const result = await runSerializedStandaloneCollaborationTransition(standaloneSaveQueue, {
      sessionId: input.sessionId,
      assertCurrent: () => {
        assertSessionAccess(event, input.sessionId);
        collaboration.assertStandaloneOperation(input.sessionId, 'Join collaboration');
      },
      getSnapshot: () => runtime.getSnapshot(input.sessionId),
      getTargetPath: () => runtime.getSaveTargetMainOnly(input.sessionId),
      saveDirty: async () => {
        throw new DesktopMainError(
          'DIRTY_DOCUMENT',
          'Reopen the shared .hdeck before joining so local unsaved edits are not discarded.',
        );
      },
      missingTarget: () => {
        throw new DesktopMainError(
          'COLLABORATION_REQUIRES_SAVED_FILE',
          "Open the host's shared .hdeck before joining.",
        );
      },
      transition: async ({ source, targetPath }) => {
        const transition = await collaboration.join({ ...input, targetPath });
        await assignSession(event, transition.snapshot, {
          sessionId: transition.previousSessionId,
          closeOptions: { expectedRevision: source.revision },
        });
        return transition.status;
      },
    });
    if (result === undefined)
      throw new DesktopMainError('CANCELLED', 'The operation was cancelled.');
    return result;
  });
  handle(DESKTOP_IPC.collaborationLeave, sessionInputSchema, async (event, input) => {
    assertSessionAccess(event, input.sessionId);
    const ended = await collaboration.leave(input.sessionId);
    if (ended === undefined) return collaboration.status(input.sessionId);
    if (ended.mode === 'host' && !ended.preserveDetached) {
      const previousSnapshot = runtime.getSnapshot(input.sessionId);
      const reopened = await runtime.openMainOnly({ targetPath: ended.targetPath });
      await assignSession(event, reopened, {
        sessionId: input.sessionId,
        closeOptions: { expectedRevision: previousSnapshot.revision },
      });
    }
    // Every other transition keeps the converged detached copy open. Reopening the shared target
    // here could regress to the host's last explicit save.
    return collaboration.status(windowSessions.get(event.sender.id) ?? input.sessionId);
  });

  handle(DESKTOP_IPC.mcpStatus, z.undefined(), (): McpStatus => ({
    available: mcpRpcServer !== undefined,
    connected: (mcpRpcServer?.connectionCount ?? 0) > 0,
    visibleDocuments: visibleEditorSessionIds().length,
    pendingApprovals: mcpBridge.pendingApprovalCount(),
    transport: 'local-stdio',
  }));
  handle(DESKTOP_IPC.mcpCreateApproval, mcpApprovalInputSchema, (event, input) => {
    assertSessionAccess(event, input.sessionId);
    const snapshot = runtime.getSnapshot(input.sessionId);
    const approval = mcpBridge.issueApproval(
      snapshot.documentId,
      input.action as McpApprovalAction,
    );
    return {
      approvalId: approval.approvalId,
      action: approval.action,
      expiresAt: approval.expiresAt,
    };
  });
};

runtime.subscribe((event) => {
  if (
    event.type === 'document-changed' ||
    event.type === 'document-saved' ||
    event.type === 'session-opened'
  ) {
    const reason =
      event.type === 'document-saved'
        ? 'saved'
        : event.type === 'session-opened'
          ? event.recovered
            ? 'recovered'
            : 'opened'
          : 'changed';
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        windowSessions.get(window.webContents.id) !== event.sessionId ||
        window.webContents.isDestroyed()
      )
        continue;
      window.webContents.send(DESKTOP_IPC.documentChanged, {
        sessionId: event.sessionId,
        revision: event.revision,
        reason,
      });
      if (windowModes.get(window.webContents.id) === 'editor') {
        const snapshot = runtime.getSnapshot(event.sessionId);
        window.setTitle(`${snapshot.document.name}${snapshot.dirty ? ' •' : ''} — HTMLlelujah`);
      }
    }
  }
});

const hdeckArgument = (arguments_: readonly string[]): string | undefined =>
  arguments_.find(
    (argument) => path.isAbsolute(argument) && path.extname(argument).toLowerCase() === '.hdeck',
  );

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', (_event, commandLine) => {
    const filePath = hdeckArgument(commandLine);
    const editor = BrowserWindow.getAllWindows().find(
      (window) => windowModes.get(window.webContents.id) === 'editor',
    );
    if (editor !== undefined) {
      if (editor.isMinimized()) editor.restore();
      editor.show();
      editor.focus();
      if (filePath !== undefined) {
        void openPathInEditorWindowSafely(editor, filePath);
      }
    } else {
      void createEditorWindowSafely(filePath);
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    const editor = BrowserWindow.getAllWindows().find(
      (window) => windowModes.get(window.webContents.id) === 'editor',
    );
    if (!app.isReady() || editor === undefined) pendingOpenPath = filePath;
    else void openPathInEditorWindowSafely(editor, filePath);
  });

  void app
    .whenReady()
    .then(async () => {
      registerSecureProtocols();
      configureIpc();
      try {
        mcpRpcServer = await startLocalRpcServer({
          service: mcpBridge,
          permissions: mcpBridge,
          descriptorPath: path.join(app.getPath('userData'), 'mcp', 'endpoint-v1.json'),
        });
      } catch {
        // The editor remains usable if local automation cannot start. No path or secret is logged.
        console.error('[MCP] The authenticated local bridge is unavailable.');
      }
      session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'X-Content-Type-Options': ['nosniff'],
            'Cross-Origin-Opener-Policy': ['same-origin'],
            'Cross-Origin-Resource-Policy': ['same-origin'],
            'Referrer-Policy': ['no-referrer'],
          },
        });
      });
      const initialPath = pendingOpenPath ?? hdeckArgument(process.argv);
      pendingOpenPath = undefined;
      const created = await createEditorWindowSafely(initialPath);
      if (created === undefined) {
        app.quit();
        return;
      }
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) void createEditorWindowSafely();
      });
    })
    .catch(async () => {
      await messageBox(undefined, {
        type: 'error',
        title: 'HTMLlelujah could not start',
        message: 'The application could not initialize safely.',
        buttons: ['Close'],
        noLink: true,
      }).catch(() => undefined);
      app.quit();
    });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', (event) => {
    if (gracefulShutdownStarted) return;
    gracefulShutdownStarted = true;
    event.preventDefault();
    rendererCloseHandshake.dispose();
    mcpBridge.revokeApprovals();
    void Promise.allSettled([collaboration.shutdownAll(), mcpRpcServer?.close()]).finally(() => {
      app.exit(0);
    });
  });
}
