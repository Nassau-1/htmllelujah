import type { DocumentSnapshot } from '@htmllelujah/document-core';

import { committedTransactionSchema, type CommittedTransaction } from './contracts.js';
import { CollaborationError } from './errors.js';
import type { CollaborationDocumentAdapter } from './host.js';

/** Applies a host-committed transaction to a replica and verifies deterministic convergence. */
export const applyCommittedTransaction = (
  adapter: CollaborationDocumentAdapter,
  rawTransaction: unknown,
): DocumentSnapshot => {
  let transaction: CommittedTransaction;
  try {
    transaction = committedTransactionSchema.parse(rawTransaction);
  } catch (error) {
    throw new CollaborationError('INVALID_REQUEST', 'Committed transaction validation failed.', {
      cause: error instanceof Error ? error.message : 'Unknown validation error',
    });
  }

  const snapshot = adapter.getSnapshot();
  if (snapshot.document.id !== transaction.documentId) {
    throw new CollaborationError(
      'DOCUMENT_MISMATCH',
      'The committed transaction targets another document.',
    );
  }
  if (snapshot.revision !== transaction.beforeRevision) {
    throw new CollaborationError(
      'REVISION_CONFLICT',
      'The replica must resynchronize before applying this transaction.',
      {
        expectedRevision: transaction.beforeRevision,
        actualRevision: snapshot.revision,
        sessionSeq: transaction.sessionSeq,
      },
    );
  }

  const result = adapter.transact(transaction.commands, {
    expectedRevision: transaction.beforeRevision,
    metadata: transaction.metadata,
  });
  if (result.revision !== transaction.afterRevision) {
    throw new CollaborationError(
      'REVISION_CONFLICT',
      'The replica produced a different revision from the authoritative host.',
      {
        expectedRevision: transaction.afterRevision,
        actualRevision: result.revision,
        sessionSeq: transaction.sessionSeq,
      },
    );
  }
  return {
    document: result.document,
    revision: result.revision,
  };
};
