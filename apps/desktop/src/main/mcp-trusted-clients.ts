import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  generateTrustedClient,
  signTrustedClientChallenge,
  trustedClientCredentialSchema,
  trustedClientProfileSchema,
  verifyTrustedClientChallenge,
  type TrustedClientCredential,
  type TrustedClientProfile,
} from '@htmllelujah/mcp-server';
import { z } from 'zod';

const REGISTRY_FILE_NAME = 'trusted-clients-v1.json';
const CREDENTIAL_DIRECTORY_NAME = 'client-credentials-v1';
const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_TRUSTED_CLIENTS = 32;

const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    bootstrapClientId: z.string().uuid(),
    clients: z.array(trustedClientProfileSchema).min(1).max(MAX_TRUSTED_CLIENTS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.clients.map((client) => client.clientId)).size !== value.clients.length) {
      context.addIssue({ code: 'custom', message: 'Trusted client identifiers must be unique.' });
    }
    if (!value.clients.some((client) => client.clientId === value.bootstrapClientId)) {
      context.addIssue({ code: 'custom', message: 'The bootstrap trusted client is missing.' });
    }
  });

type TrustedClientRegistry = z.infer<typeof registrySchema>;

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === 'ENOENT';

const readBoundedJson = async (filePath: string, maximumBytes: number): Promise<unknown> => {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maximumBytes) throw new Error('Trusted client state exceeds limits.');
  return JSON.parse(bytes.toString('utf8')) as unknown;
};

const writeAtomicPrivateJson = async (filePath: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const credentialPathFor = (directory: string, clientId: string): string =>
  path.join(directory, CREDENTIAL_DIRECTORY_NAME, `${clientId}.json`);

const validateCredentialPair = (
  profile: TrustedClientProfile,
  credential: TrustedClientCredential,
): void => {
  if (profile.clientId !== credential.clientId) {
    throw new Error('Trusted client credential identity does not match.');
  }
  const challenge = 'htmllelujah-trusted-client-credential-check-v1';
  if (
    !verifyTrustedClientChallenge(
      profile,
      challenge,
      signTrustedClientChallenge(credential, challenge),
    )
  ) {
    throw new Error('Trusted client credential does not match its registered public key.');
  }
};

const readRegistry = async (directory: string): Promise<TrustedClientRegistry> =>
  registrySchema.parse(
    await readBoundedJson(path.join(directory, REGISTRY_FILE_NAME), MAX_REGISTRY_BYTES),
  );

export const loadBootstrapTrustedClientCredential = async (
  directory: string,
): Promise<TrustedClientCredential> => {
  if (!path.isAbsolute(directory)) throw new Error('Trusted client directory must be absolute.');
  const registry = await readRegistry(directory);
  const profile = registry.clients.find(
    (candidate) => candidate.clientId === registry.bootstrapClientId,
  );
  if (profile === undefined || profile.revokedAt !== undefined) {
    throw new Error('The local MCP client is not trusted.');
  }
  const credential = trustedClientCredentialSchema.parse(
    await readBoundedJson(
      credentialPathFor(directory, registry.bootstrapClientId),
      MAX_CREDENTIAL_BYTES,
    ),
  );
  validateCredentialPair(profile, credential);
  return credential;
};

export class TrustedMcpClientStore {
  readonly #directory: string;
  readonly #now: () => Date;
  #registry: TrustedClientRegistry | undefined;

  public constructor(directory: string, options: { readonly now?: () => Date } = {}) {
    if (!path.isAbsolute(directory)) throw new Error('Trusted client directory must be absolute.');
    this.#directory = directory;
    this.#now = options.now ?? (() => new Date());
  }

  public async initialize(): Promise<void> {
    try {
      this.#registry = await readRegistry(this.#directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const generated = generateTrustedClient({
        displayName: 'Local MCP agent',
        now: this.#now(),
      });
      const registry = registrySchema.parse({
        schemaVersion: 1,
        bootstrapClientId: generated.profile.clientId,
        clients: [generated.profile],
      });
      await writeAtomicPrivateJson(
        credentialPathFor(this.#directory, generated.credential.clientId),
        generated.credential,
      );
      await writeAtomicPrivateJson(path.join(this.#directory, REGISTRY_FILE_NAME), registry);
      this.#registry = registry;
    }
    await loadBootstrapTrustedClientCredential(this.#directory);
  }

  public get bootstrapClientId(): string {
    return this.#requireRegistry().bootstrapClientId;
  }

  public resolve(clientId: string): TrustedClientProfile | undefined {
    const profile = this.#requireRegistry().clients.find(
      (candidate) => candidate.clientId === clientId,
    );
    return profile === undefined || profile.revokedAt !== undefined
      ? undefined
      : structuredClone(profile);
  }

  public list(): readonly TrustedClientProfile[] {
    return structuredClone(this.#requireRegistry().clients);
  }

  public async revoke(clientId: string): Promise<boolean> {
    const registry = this.#requireRegistry();
    const existing = registry.clients.find((candidate) => candidate.clientId === clientId);
    if (existing === undefined || existing.revokedAt !== undefined) return false;
    const replacement = registrySchema.parse({
      ...registry,
      clients: registry.clients.map((candidate) =>
        candidate.clientId === clientId
          ? { ...candidate, revokedAt: this.#now().toISOString() }
          : candidate,
      ),
    });
    await writeAtomicPrivateJson(path.join(this.#directory, REGISTRY_FILE_NAME), replacement);
    this.#registry = replacement;
    await rm(credentialPathFor(this.#directory, clientId), { force: true });
    return true;
  }

  #requireRegistry(): TrustedClientRegistry {
    if (this.#registry === undefined) throw new Error('Trusted client store is not initialized.');
    return this.#registry;
  }
}
