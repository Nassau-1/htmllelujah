import {
  deckDocumentSchema,
  documentCommandSchema,
  transactionMetadataSchema,
} from '@htmllelujah/document-core';
import { z } from 'zod';

export const COLLABORATION_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_MAX_COMMANDS_PER_BATCH = 100;
export const DEFAULT_MAX_COMMAND_PAYLOAD_BYTES = 512 * 1024;
export const DEFAULT_MAX_PRESENCE_PAYLOAD_BYTES = 16 * 1024;
export const DEFAULT_MAX_SELECTED_ELEMENTS = 100;
export const DEFAULT_TEXT_LEASE_TTL_MS = 15_000;
export const DEFAULT_PRESENCE_TTL_MS = 20_000;

const identifierSchema = z.string().uuid();
const clientIdSchema = z.string().trim().min(1).max(128);
const revisionSchema = z.string().trim().min(1).max(160);
const entityKeySchema = z.string().trim().min(1).max(256);
const lockTokenSchema = z.string().trim().min(16).max(256);

export const commandBatchMetadataSchema = z
  .object({
    origin: z.enum(['user', 'agent']),
    label: z.string().trim().min(1).max(200),
  })
  .strict();

export const commandBatchRequestSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    clientId: clientIdSchema,
    clientRequestId: identifierSchema,
    baseRevision: revisionSchema,
    baseSeq: z.number().int().min(0),
    commands: z.array(documentCommandSchema).min(1).max(DEFAULT_MAX_COMMANDS_PER_BATCH),
    metadata: commandBatchMetadataSchema,
    lockTokens: z.record(identifierSchema, lockTokenSchema).optional(),
  })
  .strict();

const sortedUniqueEntityKeysSchema = z
  .array(entityKeySchema)
  .refine((keys) => new Set(keys).size === keys.length, 'Entity keys must be unique.')
  .refine(
    (keys) => keys.every((key, index) => index === 0 || (keys[index - 1] ?? '') < key),
    'Entity keys must be sorted.',
  );

export const commandAccessSchema = z
  .object({
    readSet: sortedUniqueEntityKeysSchema,
    writeSet: sortedUniqueEntityKeysSchema,
  })
  .strict();

export const committedTransactionSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    sessionSeq: z.number().int().positive(),
    transactionId: identifierSchema,
    clientId: clientIdSchema,
    clientRequestId: identifierSchema,
    beforeRevision: revisionSchema,
    afterRevision: revisionSchema,
    rebasedFromRevision: revisionSchema.optional(),
    commands: z.array(documentCommandSchema).min(1).max(DEFAULT_MAX_COMMANDS_PER_BATCH),
    metadata: transactionMetadataSchema,
    access: commandAccessSchema,
  })
  .strict();

export const resyncRequestSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    afterSeq: z.number().int().min(0),
    knownRevision: revisionSchema.optional(),
  })
  .strict();

const documentSnapshotSchema = z
  .object({
    document: deckDocumentSchema,
    revision: revisionSchema,
  })
  .strict();

export const tailResyncResponseSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    kind: z.literal('tail'),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    fromSeq: z.number().int().min(0),
    toSeq: z.number().int().min(0),
    revision: revisionSchema,
    transactions: z.array(committedTransactionSchema),
  })
  .strict();

export const snapshotResyncResponseSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    kind: z.literal('snapshot'),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    sessionSeq: z.number().int().min(0),
    snapshot: documentSnapshotSchema,
  })
  .strict();

export const resyncResponseSchema = z.discriminatedUnion('kind', [
  tailResyncResponseSchema,
  snapshotResyncResponseSchema,
]);

const textLeaseBaseSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    clientId: clientIdSchema,
    slideId: identifierSchema,
    elementId: identifierSchema,
  })
  .strict();

export const acquireTextLeaseRequestSchema = textLeaseBaseSchema;

export const renewTextLeaseRequestSchema = textLeaseBaseSchema
  .safeExtend({ token: lockTokenSchema })
  .strict();

export const releaseTextLeaseRequestSchema = renewTextLeaseRequestSchema;

export const textLeaseSchema = textLeaseBaseSchema
  .safeExtend({
    token: lockTokenSchema,
    acquiredAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

const pointerSchema = z
  .object({
    xPt: z.number().finite(),
    yPt: z.number().finite(),
  })
  .strict();

const uniqueSelectionSchema = z
  .array(identifierSchema)
  .max(DEFAULT_MAX_SELECTED_ELEMENTS)
  .refine((ids) => new Set(ids).size === ids.length, 'Selected element IDs must be unique.');

export const presenceUpdateSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    clientId: clientIdSchema,
    sequence: z.number().int().min(0),
    displayName: z.string().trim().min(1).max(64),
    slideId: identifierSchema.optional(),
    selectedElementIds: uniqueSelectionSchema,
    editingElementId: identifierSchema.optional(),
    pointer: pointerSchema.optional(),
  })
  .strict();

export const presenceRecordSchema = presenceUpdateSchema
  .safeExtend({
    receivedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

export type CommandBatchMetadata = z.infer<typeof commandBatchMetadataSchema>;
export type CommandBatchRequest = z.infer<typeof commandBatchRequestSchema>;
export type CommandAccess = z.infer<typeof commandAccessSchema>;
export type CommittedTransaction = z.infer<typeof committedTransactionSchema>;
export type ResyncRequest = z.infer<typeof resyncRequestSchema>;
export type TailResyncResponse = z.infer<typeof tailResyncResponseSchema>;
export type SnapshotResyncResponse = z.infer<typeof snapshotResyncResponseSchema>;
export type ResyncResponse = z.infer<typeof resyncResponseSchema>;
export type AcquireTextLeaseRequest = z.infer<typeof acquireTextLeaseRequestSchema>;
export type RenewTextLeaseRequest = z.infer<typeof renewTextLeaseRequestSchema>;
export type ReleaseTextLeaseRequest = z.infer<typeof releaseTextLeaseRequestSchema>;
export type TextLease = z.infer<typeof textLeaseSchema>;
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;
export type PresenceRecord = z.infer<typeof presenceRecordSchema>;
