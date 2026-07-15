export type CollaborationErrorCode =
  | 'INVALID_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'SESSION_MISMATCH'
  | 'DOCUMENT_MISMATCH'
  | 'FUTURE_BASE'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'IDEMPOTENCY_CAPACITY'
  | 'TEXT_LEASE_HELD'
  | 'LOCK_TOKEN_REQUIRED'
  | 'INVALID_LOCK_TOKEN'
  | 'NOT_TEXT_ELEMENT'
  | 'NOT_FOUND'
  | 'PRESENCE_CAPACITY'
  | 'RESYNC_RANGE'
  | 'SIDECAR_TAMPERED'
  | 'WRITER_LEASE_ACTIVE'
  | 'WRITER_LEASE_STALE'
  | 'SPLIT_BRAIN'
  | 'TARGET_CHANGED'
  | 'LEASE_NOT_OWNED'
  | 'PATH_NOT_ALLOWED';

export class CollaborationError extends Error {
  public readonly code: CollaborationErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: CollaborationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'CollaborationError';
    this.code = code;
    this.details = details;
  }
}

export const measureJsonBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new CollaborationError('INVALID_REQUEST', 'The request must be JSON-serializable.');
  }
};
