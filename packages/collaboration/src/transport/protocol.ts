import { z } from 'zod';

import {
  acquireTextLeaseRequestSchema,
  COLLABORATION_PROTOCOL_VERSION,
  commandBatchRequestSchema,
  committedTransactionSchema,
  presenceRecordSchema,
  presenceUpdateSchema,
  releaseTextLeaseRequestSchema,
  renewTextLeaseRequestSchema,
  resyncRequestSchema,
  resyncResponseSchema,
  textLeaseSchema,
} from '../contracts.js';

const identifierSchema = z.string().uuid();
const clientIdSchema = z.string().trim().min(1).max(128);
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
export const certificateFingerprintSchema = z.string().regex(/^sha256-[A-Za-z0-9_-]{43}$/);
const proofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const chunkDataSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const authChallengeSchema = z
  .object({
    type: z.literal('auth.challenge'),
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    challengeId: identifierSchema,
    serverNonce: nonceSchema,
    certificateFingerprint: certificateFingerprintSchema,
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

export const authResponseSchema = z
  .object({
    type: z.literal('auth.response'),
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    documentId: identifierSchema,
    challengeId: identifierSchema,
    clientId: clientIdSchema,
    clientNonce: nonceSchema,
    proof: proofSchema,
  })
  .strict();

export const authAcceptedSchema = z
  .object({
    type: z.literal('auth.accepted'),
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    sessionId: identifierSchema,
    clientId: clientIdSchema,
    sessionSeq: z.number().int().nonnegative(),
    revision: z.string().trim().min(1).max(160),
  })
  .strict();

export const authRejectedSchema = z
  .object({
    type: z.literal('auth.rejected'),
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    code: z.enum([
      'AUTH_FAILED',
      'AUTH_EXPIRED',
      'AUTH_REPLAY',
      'CLIENT_ID_IN_USE',
      'INVITATION_EXPIRED',
      'PENDING_LIMIT',
      'PEER_LIMIT',
      'PROTOCOL_ERROR',
    ]),
    message: z.string().trim().min(1).max(300),
  })
  .strict();

const requestBase = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  requestId: identifierSchema,
} as const;

export const commandSubmitMessageSchema = z
  .object({ ...requestBase, type: z.literal('command.submit'), payload: commandBatchRequestSchema })
  .strict();
export const resyncRequestMessageSchema = z
  .object({ ...requestBase, type: z.literal('resync.request'), payload: resyncRequestSchema })
  .strict();
export const presenceUpdateMessageSchema = z
  .object({ ...requestBase, type: z.literal('presence.update'), payload: presenceUpdateSchema })
  .strict();
export const leaseAcquireMessageSchema = z
  .object({
    ...requestBase,
    type: z.literal('lease.acquire'),
    payload: acquireTextLeaseRequestSchema,
  })
  .strict();
export const leaseRenewMessageSchema = z
  .object({ ...requestBase, type: z.literal('lease.renew'), payload: renewTextLeaseRequestSchema })
  .strict();
export const leaseReleaseMessageSchema = z
  .object({
    ...requestBase,
    type: z.literal('lease.release'),
    payload: releaseTextLeaseRequestSchema,
  })
  .strict();

export const clientRequestMessageSchema = z.discriminatedUnion('type', [
  commandSubmitMessageSchema,
  resyncRequestMessageSchema,
  presenceUpdateMessageSchema,
  leaseAcquireMessageSchema,
  leaseRenewMessageSchema,
  leaseReleaseMessageSchema,
]);

const responseBase = {
  protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
  requestId: identifierSchema,
} as const;

export const commandResultMessageSchema = z
  .object({
    ...responseBase,
    type: z.literal('command.result'),
    payload: committedTransactionSchema,
  })
  .strict();
export const resyncResultMessageSchema = z
  .object({ ...responseBase, type: z.literal('resync.result'), payload: resyncResponseSchema })
  .strict();
export const presenceResultMessageSchema = z
  .object({ ...responseBase, type: z.literal('presence.result'), payload: presenceRecordSchema })
  .strict();
export const leaseResultMessageSchema = z
  .object({ ...responseBase, type: z.literal('lease.result'), payload: textLeaseSchema })
  .strict();
export const leaseReleaseResultMessageSchema = z
  .object({ ...responseBase, type: z.literal('lease.release.result'), released: z.boolean() })
  .strict();

export const requestErrorMessageSchema = z
  .object({
    ...responseBase,
    type: z.literal('request.error'),
    code: z.string().trim().min(1).max(64),
    message: z.string().trim().min(1).max(500),
    details: z
      .record(
        z.string().trim().min(1).max(64),
        z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

export const transactionBroadcastSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    type: z.literal('transaction.committed'),
    payload: committedTransactionSchema,
  })
  .strict();
export const presenceBroadcastSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    type: z.literal('presence.changed'),
    payload: presenceRecordSchema,
  })
  .strict();

export const transportChunkSchema = z
  .object({
    type: z.literal('transport.chunk'),
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    stream: z.enum(['client', 'server']),
    transferId: identifierSchema,
    index: z.number().int().nonnegative().max(65_535),
    totalChunks: z.number().int().min(1).max(65_536),
    totalBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: proofSchema,
    data: chunkDataSchema,
    mac: proofSchema,
  })
  .strict()
  .superRefine((chunk, context) => {
    if (chunk.index >= chunk.totalChunks) {
      context.addIssue({ code: 'custom', message: 'Chunk index exceeds transfer length.' });
    }
  });

export const serverMessageSchema = z.discriminatedUnion('type', [
  authChallengeSchema,
  authAcceptedSchema,
  authRejectedSchema,
  commandResultMessageSchema,
  resyncResultMessageSchema,
  presenceResultMessageSchema,
  leaseResultMessageSchema,
  leaseReleaseResultMessageSchema,
  requestErrorMessageSchema,
  transactionBroadcastSchema,
  presenceBroadcastSchema,
]);

export const manualInvitationSchema = z
  .object({
    protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    sessionId: identifierSchema,
    certificateFingerprint: certificateFingerprintSchema,
    expiresAtMs: z.number().int().positive(),
  })
  .strict();

export type AuthChallenge = z.infer<typeof authChallengeSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type AuthAccepted = z.infer<typeof authAcceptedSchema>;
export type ClientRequestMessage = z.infer<typeof clientRequestMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ManualInvitation = z.infer<typeof manualInvitationSchema>;
export type TransportChunk = z.infer<typeof transportChunkSchema>;
