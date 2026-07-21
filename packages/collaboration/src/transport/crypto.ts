import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';

import { canonicalSerialize } from '@htmllelujah/document-core';
import { generate } from 'selfsigned';

import { CollaborationError } from '../errors.js';

export interface EphemeralCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly fingerprint: string;
}

export interface AuthProofInput {
  readonly sessionId: string;
  readonly documentId: string;
  readonly certificateFingerprint: string;
  readonly challengeId: string;
  readonly serverNonce: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly clientNonce: string;
  readonly reconnectToken?: string;
  readonly expiresAtMs: number;
}

const AUTH_DOMAIN = 'htmllelujah-auth-v1';
const DISCOVERY_DOMAIN = 'htmllelujah-discovery-v1';
const SIGNATURE_DOMAIN = 'htmllelujah-signed-payload-v1';

export const normalizeDocumentSecret = (secret: Uint8Array): Buffer => {
  const normalized = Buffer.from(secret);
  if (normalized.byteLength < 32) {
    throw new CollaborationError(
      'INVALID_REQUEST',
      'A document collaboration secret must contain at least 32 bytes.',
    );
  }
  return normalized;
};

export const createNonce = (): string => randomBytes(32).toString('base64url');

export const fingerprintCertificate = (certificate: string | Uint8Array): string => {
  const raw = new X509Certificate(certificate).raw;
  return `sha256-${createHash('sha256').update(raw).digest('base64url')}`;
};

export const fingerprintBytes = (bytes: Uint8Array): string =>
  `sha256-${createHash('sha256').update(bytes).digest('base64url')}`;

export const generateEphemeralCertificate = async (): Promise<EphemeralCertificate> => {
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
  const generated = await generate(
    [{ name: 'commonName', value: 'HTMLlelujah local collaboration' }],
    {
      algorithm: 'sha256',
      keyType: 'ec',
      curve: 'P-256',
      notBeforeDate: new Date(now.getTime() - 60_000),
      notAfterDate: expires,
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '::1' },
          ],
        },
      ],
    },
  );
  return {
    certificatePem: generated.cert,
    privateKeyPem: generated.private,
    fingerprint: fingerprintCertificate(generated.cert),
  };
};

export const createAuthProof = (secret: Uint8Array, input: AuthProofInput): string =>
  createHmac('sha256', normalizeDocumentSecret(secret))
    .update(canonicalSerialize({ domain: AUTH_DOMAIN, ...input }))
    .digest('base64url');

export const createDiscoveryHint = (
  secret: Uint8Array,
  input: {
    readonly sessionId: string;
    readonly certificateFingerprint: string;
    readonly host: string;
    readonly port: number;
    readonly expiresAtMs: number;
  },
): string =>
  createHmac('sha256', normalizeDocumentSecret(secret))
    .update(canonicalSerialize({ domain: DISCOVERY_DOMAIN, ...input }))
    .digest()
    .subarray(0, 16)
    .toString('base64url');

export const signCanonicalPayload = (secret: Uint8Array, payload: unknown): string =>
  createHmac('sha256', normalizeDocumentSecret(secret))
    .update(canonicalSerialize({ domain: SIGNATURE_DOMAIN, payload }))
    .digest('base64url');

export const constantTimeEqual = (left: string, right: string): boolean => {
  let leftBytes: Buffer;
  let rightBytes: Buffer;
  try {
    leftBytes = Buffer.from(left, 'base64url');
    rightBytes = Buffer.from(right, 'base64url');
  } catch {
    return false;
  }
  // Node accepts non-canonical base64url encodings whose unused trailing bits
  // decode to the same bytes. Reject those aliases so pinned fingerprints and
  // signed protocol values have exactly one wire representation.
  if (leftBytes.toString('base64url') !== left || rightBytes.toString('base64url') !== right) {
    return false;
  }
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};
