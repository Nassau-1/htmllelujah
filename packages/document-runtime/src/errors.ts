export type DocumentRuntimeErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXISTS'
  | 'REVISION_CONFLICT'
  | 'DIRTY_DOCUMENT'
  | 'NO_SAVE_TARGET'
  | 'TARGET_CHANGED'
  | 'JOURNAL_FAILED'
  | 'SAVE_FAILED'
  | 'INVALID_REQUEST'
  | 'ASSET_BYTES_MISSING'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_STALE'
  | 'PROPOSAL_CAPACITY'
  | 'AGENT_UNDO_CONFLICT'
  | 'RECOVERY_NOT_FOUND'
  | 'RECOVERY_INVALID';

export class DocumentRuntimeError extends Error {
  public constructor(
    public readonly code: DocumentRuntimeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'DocumentRuntimeError';
  }
}
