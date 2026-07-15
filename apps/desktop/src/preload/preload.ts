import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_API_VERSION,
  DESKTOP_IPC,
  type AppInfo,
  type CollaborationHostInput,
  type CollaborationJoinInput,
  type CollaborationStatus,
  type CollaborationTextLeaseInput,
  type CollaborationTextLeaseStatus,
  type DesktopResult,
  type ExecuteInput,
  type ExportInput,
  type ExportResult,
  type HistoryInput,
  type ImportImageInput,
  type HtmllelujahDesktopApi,
  type ImportImageResult,
  type InitializeResult,
  type McpStatus,
  type McpApproval,
  type McpApprovalInput,
  type PresentationChangedEvent,
  type PresentationInput,
  type SafeDocumentChangedEvent,
  type SessionInput,
  type SessionView,
} from '../shared/desktop-api.js';
import type { RecoveryCandidate } from '@htmllelujah/document-runtime';

const invoke = <T>(channel: string, input?: unknown): Promise<DesktopResult<T>> =>
  ipcRenderer.invoke(channel, input) as Promise<DesktopResult<T>>;

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
    invoke(DESKTOP_IPC.importImage, input),
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
  onDocumentChanged,
  onPresentationChanged,
});

contextBridge.exposeInMainWorld('htmllelujah', desktopApi);
