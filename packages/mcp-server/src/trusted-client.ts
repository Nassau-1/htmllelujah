import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';

import { z } from 'zod';

const CLIENT_NAME_MAX_LENGTH = 80;
const KEY_MAX_LENGTH = 512;

export const trustedClientCapabilitySchema = z.enum([
  'documents.read.visible',
  'documents.edit.ordinary',
]);

export type TrustedClientCapability = z.infer<typeof trustedClientCapabilitySchema>;

export const trustedClientProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    clientId: z.string().uuid(),
    displayName: z.string().trim().min(1).max(CLIENT_NAME_MAX_LENGTH),
    publicKeySpki: z.string().min(1).max(KEY_MAX_LENGTH),
    capabilities: z
      .array(trustedClientCapabilitySchema)
      .min(1)
      .max(2)
      .refine((value) => new Set(value).size === value.length, 'Capabilities must be unique.'),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().optional(),
  })
  .strict();

export type TrustedClientProfile = z.infer<typeof trustedClientProfileSchema>;

export const trustedClientCredentialSchema = z
  .object({
    schemaVersion: z.literal(1),
    clientId: z.string().uuid(),
    privateKeyPkcs8: z.string().min(1).max(KEY_MAX_LENGTH),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type TrustedClientCredential = z.infer<typeof trustedClientCredentialSchema>;

export interface TrustedClientContext {
  readonly clientId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly capabilities: readonly TrustedClientCapability[];
}

export interface GeneratedTrustedClient {
  readonly profile: TrustedClientProfile;
  readonly credential: TrustedClientCredential;
}

export const trustedClientActorId = (clientId: string): string => `mcp-client:${clientId}`;

export const trustedClientContext = (profile: TrustedClientProfile): TrustedClientContext => ({
  clientId: profile.clientId,
  actorId: trustedClientActorId(profile.clientId),
  displayName: profile.displayName,
  capabilities: [...profile.capabilities],
});

export const generateTrustedClient = (input: {
  readonly displayName: string;
  readonly now?: Date | undefined;
  readonly clientId?: string | undefined;
}): GeneratedTrustedClient => {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const clientId = input.clientId ?? randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    profile: trustedClientProfileSchema.parse({
      schemaVersion: 1,
      clientId,
      displayName: input.displayName,
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      capabilities: ['documents.read.visible', 'documents.edit.ordinary'],
      createdAt,
    }),
    credential: trustedClientCredentialSchema.parse({
      schemaVersion: 1,
      clientId,
      privateKeyPkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      createdAt,
    }),
  };
};

export const signTrustedClientChallenge = (
  credential: TrustedClientCredential,
  challenge: string,
): string => {
  const parsed = trustedClientCredentialSchema.parse(credential);
  const privateKey = createPrivateKey({
    key: Buffer.from(parsed.privateKeyPkcs8, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(challenge, 'utf8'), privateKey).toString('base64');
};

export const verifyTrustedClientChallenge = (
  profile: TrustedClientProfile,
  challenge: string,
  signature: string,
): boolean => {
  const parsed = trustedClientProfileSchema.parse(profile);
  if (parsed.revokedAt !== undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(parsed.publicKeySpki, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(challenge, 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
};
