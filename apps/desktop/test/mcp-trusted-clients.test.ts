import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { signTrustedClientChallenge, verifyTrustedClientChallenge } from '@htmllelujah/mcp-server';
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

  it('persists revocation, deletes the credential, and fails closed after restart', async () => {
    const directory = await temporaryDirectory();
    const store = new TrustedMcpClientStore(directory, {
      now: () => new Date('2026-07-23T10:00:00.000Z'),
    });
    await store.initialize();
    const clientId = store.bootstrapClientId;

    await expect(store.revoke(clientId)).resolves.toBe(true);
    await expect(store.revoke(clientId)).resolves.toBe(false);
    expect(store.resolve(clientId)).toBeUndefined();
    await expect(loadBootstrapTrustedClientCredential(directory)).rejects.toThrow(/not trusted/u);

    const reloaded = new TrustedMcpClientStore(directory);
    await expect(reloaded.initialize()).rejects.toThrow(/not trusted/u);
    expect(reloaded.list()).toEqual([
      expect.objectContaining({ clientId, revokedAt: '2026-07-23T10:00:00.000Z' }),
    ]);
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
