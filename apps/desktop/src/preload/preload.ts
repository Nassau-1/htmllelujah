import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type AppInfo,
  type CollaborationHostInput,
  type CollaborationJoinInput,
  type CollaborationJoinDecisionInput,
  type CollaborationPresenceInput,
  type CollaborationStatus,
  type CollaborationTextLeaseInput,
  type CollaborationTextLeaseStatus,
  type DesktopResult,
  type ExecuteInput,
  type ExportInput,
  type ExportResult,
  type HistoryInput,
  type ImportImageInput,
  type ImageImportTarget,
  type HtmllelujahDesktopApi,
  type ImportImageResult,
  type InitializeResult,
  isWindowCloseRelease,
  isWindowCloseRequest,
  type McpStatus,
  type McpApproval,
  type McpApprovalInput,
  type PresentationChangedEvent,
  type PresentationInput,
  type SafeDocumentChangedEvent,
  type SessionInput,
  type SessionView,
  settleWindowCloseListeners,
  type WindowCloseReleaseListener,
  type WindowCloseRequestListener,
} from '../shared/desktop-api.js';
import type { RecoveryCandidate } from '@htmllelujah/document-runtime';

const invoke = <T>(channel: string, input?: unknown): Promise<DesktopResult<T>> =>
  ipcRenderer.invoke(channel, input) as Promise<DesktopResult<T>>;

const copyImageImportTarget = (target: ImageImportTarget): ImageImportTarget => {
  switch (target.surface) {
    case 'slide':
      return { surface: 'slide', slideId: target.slideId };
    case 'layout':
      return { surface: 'layout', layoutId: target.layoutId };
    case 'master':
      return { surface: 'master', masterId: target.masterId };
  }
};

const windowCloseListeners = new Set<WindowCloseRequestListener>();
const windowCloseReleaseListeners = new Set<WindowCloseReleaseListener>();
const activeWindowCloseRequests = new Set<string>();

ipcRenderer.on(DESKTOP_IPC.windowCloseRequested, (_electronEvent, value: unknown): void => {
  if (!isWindowCloseRequest(value) || activeWindowCloseRequests.has(value.requestId)) return;
  const request = Object.freeze({
    requestId: value.requestId,
    deadlineAtMs: value.deadlineAtMs,
  });
  const listeners = [...windowCloseListeners];
  activeWindowCloseRequests.add(request.requestId);
  void settleWindowCloseListeners(listeners, request)
    .then((decision) => {
      try {
        ipcRenderer.send(DESKTOP_IPC.windowCloseResponse, {
          requestId: request.requestId,
          decision: Date.now() < request.deadlineAtMs ? decision : 'blocked',
        });
      } catch {
        // The main-process timeout remains the fail-closed authority if IPC is unavailable.
      }
    })
    .finally(() => activeWindowCloseRequests.delete(request.requestId));
});
ipcRenderer.on(DESKTOP_IPC.windowCloseReleased, (_electronEvent, value: unknown): void => {
  if (!isWindowCloseRelease(value)) return;
  const release = Object.freeze({ requestId: value.requestId });
  for (const listener of [...windowCloseReleaseListeners]) {
    try {
      listener(release);
    } catch {
      // One isolated renderer listener cannot prevent the correlated seal from being released.
    }
  }
});

const onWindowCloseReleased = (listener: WindowCloseReleaseListener): (() => void) => {
  if (typeof listener !== 'function')
    throw new TypeError('A window-close release listener is required.');
  windowCloseReleaseListeners.add(listener);
  return () => windowCloseReleaseListeners.delete(listener);
};

const onWindowCloseRequested = (listener: WindowCloseRequestListener): (() => void) => {
  if (typeof listener !== 'function') throw new TypeError('A window-close listener is required.');
  windowCloseListeners.add(listener);
  return () => windowCloseListeners.delete(listener);
};

const onDocumentChanged = (listener: (event: SafeDocumentChangedEvent) => void): (() => void) => {
  const wrapped = (_electronEvent: Electron.IpcRendererEvent, value: unknown): void => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      'revision' in value &&
      typeof value.revision === 'string' &&
      'reason' in value &&
      typeof value.reason === 'string'
    )
      listener(value as SafeDocumentChangedEvent);
  };
  ipcRenderer.on(DESKTOP_IPC.documentChanged, wrapped);
  return () => ipcRenderer.removeListener(DESKTOP_IPC.documentChanged, wrapped);
};

const onPresentationChanged = (
  listener: (event: PresentationChangedEvent) => void,
): (() => void) => {
  const wrapped = (_electronEvent: Electron.IpcRendererEvent, value: unknown): void => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'sessionId' in value &&
      typeof value.sessionId === 'string' &&
      'closed' in value &&
      typeof value.closed === 'boolean'
    )
      listener(value as PresentationChangedEvent);
  };
  ipcRenderer.on(DESKTOP_IPC.presentationChanged, wrapped);
  return () => ipcRenderer.removeListener(DESKTOP_IPC.presentationChanged, wrapped);
};

const desktopApi: HtmllelujahDesktopApi = Object.freeze({
  version: DESKTOP_API_VERSION,
  getAppInfo: (): Promise<DesktopResult<AppInfo>> => invoke(DESKTOP_IPC.getAppInfo),
  initialize: (): Promise<DesktopResult<InitializeResult>> => invoke(DESKTOP_IPC.initialize),
  createDocument: (): Promise<DesktopResult<SessionView>> => invoke(DESKTOP_IPC.createDocument),
  openDocument: (): Promise<DesktopResult<SessionView>> => invoke(DESKTOP_IPC.openDocument),
  execute: (input: ExecuteInput): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.execute, input),
  undo: (input: HistoryInput): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.undo, input),
  redo: (input: HistoryInput): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.redo, input),
  save: (input: SessionInput): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.save, input),
  saveAs: (input: SessionInput): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.saveAs, input),
  importImage: (input: ImportImageInput): Promise<DesktopResult<ImportImageResult>> =>
    invoke(DESKTOP_IPC.importImage, {
      sessionId: input.sessionId,
      expectedRevision: input.expectedRevision,
      target: copyImageImportTarget(input.target),
      ...(input.replaceElementId === undefined ? {} : { replaceElementId: input.replaceElementId }),
      ...(input.preset === undefined ? {} : { preset: input.preset }),
    } satisfies ImportImageInput),
  listRecovery: (): Promise<DesktopResult<readonly RecoveryCandidate[]>> =>
    invoke(DESKTOP_IPC.listRecovery),
  recover: (candidateId: string): Promise<DesktopResult<SessionView>> =>
    invoke(DESKTOP_IPC.recover, candidateId),
  present: (input: PresentationInput): Promise<DesktopResult<null>> =>
    invoke(DESKTOP_IPC.present, input),
  exportDocument: (input: ExportInput): Promise<DesktopResult<ExportResult>> =>
    invoke(DESKTOP_IPC.exportDocument, input),
  collaborationStatus: (input: SessionInput): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationStatus, input),
  collaborationHost: (input: CollaborationHostInput): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationHost, input),
  collaborationJoin: (input: CollaborationJoinInput): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationJoin, input),
  collaborationDecideJoin: (
    input: CollaborationJoinDecisionInput,
  ): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationDecideJoin, input),
  collaborationUpdatePresence: (
    input: CollaborationPresenceInput,
  ): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationUpdatePresence, input),
  collaborationLeave: (input: SessionInput): Promise<DesktopResult<CollaborationStatus>> =>
    invoke(DESKTOP_IPC.collaborationLeave, input),
  collaborationTextLeaseStatus: (
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>> =>
    invoke(DESKTOP_IPC.collaborationTextLeaseStatus, input),
  collaborationTextLeaseBegin: (
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>> =>
    invoke(DESKTOP_IPC.collaborationTextLeaseBegin, input),
  collaborationTextLeaseRenew: (
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>> =>
    invoke(DESKTOP_IPC.collaborationTextLeaseRenew, input),
  collaborationTextLeaseEnd: (
    input: CollaborationTextLeaseInput,
  ): Promise<DesktopResult<CollaborationTextLeaseStatus>> =>
    invoke(DESKTOP_IPC.collaborationTextLeaseEnd, input),
  mcpStatus: (): Promise<DesktopResult<McpStatus>> => invoke(DESKTOP_IPC.mcpStatus),
  mcpCreateApproval: (input: McpApprovalInput): Promise<DesktopResult<McpApproval>> =>
    invoke(DESKTOP_IPC.mcpCreateApproval, input),
  onWindowCloseReleased,
  onWindowCloseRequested,
  onDocumentChanged,
  onPresentationChanged,
});

contextBridge.exposeInMainWorld('htmllelujah', desktopApi);
