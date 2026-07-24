import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  generateTrustedClient,
  signTrustedClientChallenge,
  verifyTrustedClientChallenge,
} from '@htmllelujah/mcp-server';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadBootstrapTrustedClientCredential,
  TrustedMcpClientStore,
} from '../src/main/mcp-trusted-clients.js';

describe('TrustedMcpClientStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  const temporaryDirectory = async (): Promise<string> => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-mcp-trust-'));
    directories.push(directory);
    return directory;
  };

  it('persists one bounded client identity and reloads its matching private credential', async () => {
    const directory = await temporaryDirectory();
    const store = new TrustedMcpClientStore(directory, {
      now: () => new Date('2026-07-23T10:00:00.000Z'),
    });
    await store.initialize();

    const firstId = store.bootstrapClientId;
    const profile = store.resolve(firstId);
    const credential = await loadBootstrapTrustedClientCredential(directory);
    expect(profile).toMatchObject({
      clientId: firstId,
      displayName: 'Local MCP agent',
    });
    expect(profile).not.toHaveProperty('revokedAt');
    expect(credential.clientId).toBe(firstId);
    const challenge = 'persistent-client-test';
    expect(
      verifyTrustedClientChallenge(
        profile!,
        challenge,
        signTrustedClientChallenge(credential, challenge),
      ),
    ).toBe(true);

    const reloaded = new TrustedMcpClientStore(directory);
    await reloaded.initialize();
    expect(reloaded.bootstrapClientId).toBe(firstId);
    expect(reloaded.resolve(firstId)?.publicKeySpki).toBe(profile?.publicKeySpki);
  });

  it('protects the bootstrap client required by the local launcher', async () => {
    const directory = await temporaryDirectory();
    const store = new TrustedMcpClientStore(directory, {
      now: () => new Date('2026-07-23T10:00:00.000Z'),
    });
    await store.initialize();
    const clientId = store.bootstrapClientId;

    await expect(store.revoke(clientId)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CLIENT_PROTECTED',
    });
    expect(store.resolve(clientId)).toBeDefined();
    await expect(loadBootstrapTrustedClientCredential(directory)).resolves.toMatchObject({
      clientId,
    });

    const reloaded = new TrustedMcpClientStore(directory);
    await expect(reloaded.initialize()).resolves.toBeUndefined();
    expect(reloaded.resolve(clientId)).toBeDefined();
  });

  it('persists revocation of a non-bootstrap client without exposing credentials', async () => {
    const directory = await temporaryDirectory();
    const bootstrapStore = new TrustedMcpClientStore(directory, {
      now: () => new Date('2026-07-23T10:00:00.000Z'),
    });
    await bootstrapStore.initialize();
    const registryPath = path.join(directory, 'trusted-clients-v1.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      readonly schemaVersion: 1;
      readonly bootstrapClientId: string;
      readonly clients: readonly unknown[];
    };
    const secondary = generateTrustedClient({
      displayName: 'Secondary local agent',
      now: new Date('2026-07-23T10:05:00.000Z'),
    });
    await writeFile(
      registryPath,
      `${JSON.stringify({ ...registry, clients: [...registry.clients, secondary.profile] })}\n`,
      'utf8',
    );
    const secondaryCredentialPath = path.join(
      directory,
      'client-credentials-v1',
      `${secondary.profile.clientId}.json`,
    );
    await mkdir(path.dirname(secondaryCredentialPath), { recursive: true });
    await writeFile(secondaryCredentialPath, `${JSON.stringify(secondary.credential)}\n`, 'utf8');

    const store = new TrustedMcpClientStore(directory, {
      now: () => new Date('2026-07-23T11:00:00.000Z'),
    });
    await store.initialize();
    await expect(store.revoke(secondary.profile.clientId)).resolves.toBe(true);
    await expect(store.revoke(secondary.profile.clientId)).resolves.toBe(false);
    expect(store.resolve(secondary.profile.clientId)).toBeUndefined();
    await expect(readFile(secondaryCredentialPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.list()).toContainEqual(
      expect.objectContaining({
        clientId: secondary.profile.clientId,
        revokedAt: '2026-07-23T11:00:00.000Z',
      }),
    );
    await expect(loadBootstrapTrustedClientCredential(directory)).resolves.toMatchObject({
      clientId: registry.bootstrapClientId,
    });
  });

  it('does not replace malformed persisted trust state', async () => {
    const directory = await temporaryDirectory();
    const registryPath = path.join(directory, 'trusted-clients-v1.json');
    await writeFile(registryPath, '{"schemaVersion":1,"clients":[]}\n', 'utf8');
    const before = await readFile(registryPath, 'utf8');

    const store = new TrustedMcpClientStore(directory);
    await expect(store.initialize()).rejects.toThrow();
    await expect(readFile(registryPath, 'utf8')).resolves.toBe(before);
  });
});
