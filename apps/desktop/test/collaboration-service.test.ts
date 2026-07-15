import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { DesktopCollaborationCoordinator } from '../src/main/collaboration-service.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for collaboration convergence.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const closeRuntime = async (runtime: DocumentSessionManager): Promise<void> => {
  await Promise.all(
    runtime
      .listSessions()
      .map((session) => runtime.close(session.sessionId, { discardUnsaved: true })),
  );
};

describe('DesktopCollaborationCoordinator', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanup
        .splice(0)
        .reverse()
        .map((operation) => operation()),
    );
  });

  it('keeps a host and guest converged while only the host writes the shared file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-collaboration-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'host-recovery'),
      autosaveDelayMs: 0,
    });
    const guestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-recovery'),
      autosaveDelayMs: 0,
    });
    const verifierRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'verifier-recovery'),
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
    });
    const guest = new DesktopCollaborationCoordinator(guestRuntime);
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(verifierRuntime));
    cleanup.push(() => closeRuntime(guestRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => guest.shutdownAll());
    cleanup.push(() => host.shutdownAll());

    const hostSource = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(hostSource.sessionId, {
      targetPath,
      expectedFingerprint: null,
      allowOverwrite: true,
    });
    const guestSource = await guestRuntime.openMainOnly({ targetPath });

    const hosted = await host.host({
      sessionId: hostSource.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    expect(hosted.status).toMatchObject({ mode: 'host', connectedPeers: 0 });
    expect(hosted.status.endpoint).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/u);
    expect(hosted.status.sessionCode).toBeTruthy();
    expect(hosted.status.hostFingerprint).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/u);

    const joined = await guest.join({
      sessionId: guestSource.sessionId,
      targetPath,
      endpoint: hosted.status.endpoint!,
      sessionCode: hosted.status.sessionCode!,
      expectedFingerprint: hosted.status.hostFingerprint!,
      displayName: 'Guest',
    });
    expect(joined.status).toMatchObject({ mode: 'guest', connectedPeers: 1 });
    expect(host.status(hosted.snapshot.sessionId).connectedPeers).toBe(1);

    const renamedByHost = await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Rename from host',
      commands: [{ type: 'deck.rename', name: 'Shared from host' }],
    });
    expect(renamedByHost?.document.name).toBe('Shared from host');
    await waitFor(
      () =>
        guestRuntime.getSnapshot(joined.snapshot.sessionId).document.name === 'Shared from host',
    );

    const guestBefore = guestRuntime.getSnapshot(joined.snapshot.sessionId);
    const renamedByGuest = await guest.execute({
      sessionId: joined.snapshot.sessionId,
      expectedRevision: guestBefore.revision,
      label: 'Rename from guest',
      commands: [{ type: 'deck.rename', name: 'Converged V1' }],
    });
    expect(renamedByGuest?.document.name).toBe('Converged V1');
    await waitFor(
      () => hostRuntime.getSnapshot(hosted.snapshot.sessionId).document.name === 'Converged V1',
    );
    expect(hostRuntime.getSnapshot(hosted.snapshot.sessionId).revision).toBe(
      guestRuntime.getSnapshot(joined.snapshot.sessionId).revision,
    );

    await expect(guest.saveHost(joined.snapshot.sessionId)).rejects.toMatchObject({
      code: 'WRITER_LEASE_ACTIVE',
    });
    await host.saveHost(hosted.snapshot.sessionId);
    const persisted = await verifierRuntime.openMainOnly({ targetPath });
    expect(persisted.document.name).toBe('Converged V1');

    await expect(
      guest.join({
        sessionId: joined.snapshot.sessionId,
        targetPath,
        endpoint: 'wss://8.8.8.8:443',
        sessionCode: hosted.status.sessionCode!,
        expectedFingerprint: hosted.status.hostFingerprint!,
        displayName: 'Guest',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

    expect((await guest.leave(joined.snapshot.sessionId))?.mode).toBe('guest');
    expect((await host.leave(hosted.snapshot.sessionId))?.mode).toBe('host');
  }, 30_000);
});
