import { mkdtemp, readFile, rm as remove, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  defaultArchiveDurability,
  DocumentSessionManager,
  type ArchiveDurabilityCapability,
} from '@htmllelujah/document-runtime';
import { createHdeckArchive, parseHdeckArchive } from '@htmllelujah/hdeck';
import { afterEach, describe, expect, it } from 'vitest';

import { DesktopCollaborationCoordinator } from '../src/main/collaboration-service.js';

const rm = (target: string, options: { readonly recursive: true; readonly force: true }) =>
  remove(target, { ...options, maxRetries: 5, retryDelay: 100 });

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
    const errors: unknown[] = [];
    for (const operation of cleanup.splice(0).reverse()) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Collaboration test cleanup failed.');
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

  it('coordinates text leases across a host and two guests through renew, disconnect, and expiry', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-text-leases-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    let now = Date.now();
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'host-recovery'),
      autosaveDelayMs: 0,
    });
    const firstGuestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-a-recovery'),
      autosaveDelayMs: 0,
    });
    const secondGuestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-b-recovery'),
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      clock: () => now,
      textLeaseTtlMs: 1_000,
    });
    const firstGuest = new DesktopCollaborationCoordinator(firstGuestRuntime, {
      clock: () => now,
    });
    const secondGuest = new DesktopCollaborationCoordinator(secondGuestRuntime, {
      clock: () => now,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(secondGuestRuntime));
    cleanup.push(() => closeRuntime(firstGuestRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => secondGuest.shutdownAll());
    cleanup.push(() => firstGuest.shutdownAll());
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const firstSource = await firstGuestRuntime.openMainOnly({ targetPath });
    const secondSource = await secondGuestRuntime.openMainOnly({ targetPath });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const firstJoined = await firstGuest.join({
      sessionId: firstSource.sessionId,
      targetPath,
      endpoint: hosted.status.endpoint!,
      sessionCode: hosted.status.sessionCode!,
      expectedFingerprint: hosted.status.hostFingerprint!,
      displayName: 'Guest A',
    });
    const secondJoined = await secondGuest.join({
      sessionId: secondSource.sessionId,
      targetPath,
      endpoint: hosted.status.endpoint!,
      sessionCode: hosted.status.sessionCode!,
      expectedFingerprint: hosted.status.hostFingerprint!,
      displayName: 'Guest B',
    });
    await waitFor(() => host.status(hosted.snapshot.sessionId).connectedPeers === 2);
    const slide = hosted.snapshot.document.slides[0]!;
    const text = slide.elements.find((element) => element.type === 'text')!;
    const target = { slideId: slide.id, elementId: text.id };

    const firstOwned = await firstGuest.beginTextLease({
      sessionId: firstJoined.snapshot.sessionId,
      ...target,
    });
    expect(firstOwned).toMatchObject({
      status: 'owned',
      owner: 'self',
      expiresAtMs: now + 1_000,
    });
    const secondHeld = await secondGuest.beginTextLease({
      sessionId: secondJoined.snapshot.sessionId,
      ...target,
    });
    const hostHeld = await host.beginTextLease({
      sessionId: hosted.snapshot.sessionId,
      ...target,
    });
    expect(secondHeld).toMatchObject({
      status: 'held',
      owner: 'peer',
      expiresAtMs: firstOwned.expiresAtMs,
    });
    expect(hostHeld).toMatchObject({
      status: 'held',
      owner: 'peer',
      expiresAtMs: firstOwned.expiresAtMs,
    });

    now += 250;
    const renewed = await firstGuest.renewTextLease({
      sessionId: firstJoined.snapshot.sessionId,
      ...target,
    });
    expect(renewed).toMatchObject({ status: 'owned', expiresAtMs: now + 1_000 });
    const edited = await firstGuest.execute({
      sessionId: firstJoined.snapshot.sessionId,
      expectedRevision: firstGuestRuntime.getSnapshot(firstJoined.snapshot.sessionId).revision,
      label: 'Edit leased text',
      commands: [
        {
          type: 'text.replace-content',
          slideId: slide.id,
          textId: text.id,
          content: {
            blocks: [
              {
                id: '97300000-0000-4000-8000-000000000001',
                type: 'paragraph',
                alignment: 'left',
                runs: [
                  {
                    text: 'Edited while holding the lease',
                    marks: {
                      bold: false,
                      italic: false,
                      underline: false,
                      strikethrough: false,
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(edited?.revision).not.toBe(firstJoined.snapshot.revision);
    await waitFor(
      () =>
        secondGuestRuntime.getSnapshot(secondJoined.snapshot.sessionId).revision ===
        edited?.revision,
    );

    await firstGuest.leave(firstJoined.snapshot.sessionId);
    await waitFor(() => host.status(hosted.snapshot.sessionId).connectedPeers === 1);
    const transferred = await secondGuest.beginTextLease({
      sessionId: secondJoined.snapshot.sessionId,
      ...target,
    });
    expect(transferred).toMatchObject({ status: 'owned', owner: 'self' });

    now = transferred.expiresAtMs!;
    const hostAfterExpiry = await host.beginTextLease({
      sessionId: hosted.snapshot.sessionId,
      ...target,
    });
    expect(hostAfterExpiry).toMatchObject({ status: 'owned', owner: 'self' });
    expect(await host.endTextLease({ sessionId: hosted.snapshot.sessionId, ...target })).toEqual({
      status: 'available',
      owner: 'none',
      slideId: slide.id,
      elementId: text.id,
      expiresAtMs: null,
    });
  }, 30_000);

  it('does not overwrite a target changed between lease preflight and atomic save', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-save-race-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    let interceptSave = false;
    let enteredSave: (() => void) | undefined;
    let releaseSave: (() => void) | undefined;
    const saveEntered = new Promise<void>((resolve) => {
      enteredSave = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const archive: ArchiveDurabilityCapability = {
      ...defaultArchiveDurability,
      save: async (target, bytes, options) => {
        if (interceptSave) {
          enteredSave?.();
          await saveGate;
        }
        return defaultArchiveDurability.save(target, bytes, options);
      },
    };
    const recoveryDirectory = path.join(directory, 'host-recovery');
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory,
      autosaveDelayMs: 0,
      archive,
    });
    const recoveredRuntime = new DocumentSessionManager({
      recoveryDirectory,
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(recoveredRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, {
      targetPath,
      expectedFingerprint: null,
    });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const edited = await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Unsaved authoritative edit',
      commands: [{ type: 'deck.rename', name: 'Must remain recoverable' }],
    });
    interceptSave = true;
    const pendingSave = host.saveHost(hosted.snapshot.sessionId);
    await saveEntered;
    const external = {
      ...edited!.document,
      name: 'External writer won',
      metadata: { ...edited!.document.metadata, modifiedAt: new Date().toISOString() },
    };
    await writeFile(targetPath, createHdeckArchive({ document: external }));
    releaseSave?.();
    await expect(pendingSave).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(parseHdeckArchive(await readFile(targetPath)).document.name).toBe('External writer won');
    expect(host.status(hosted.snapshot.sessionId)).toMatchObject({
      mode: 'host',
      connectedPeers: 0,
    });
    const ended = await host.leave(hosted.snapshot.sessionId);
    expect(ended).toMatchObject({ mode: 'host', preserveDetached: true });
    expect(hostRuntime.getSnapshot(hosted.snapshot.sessionId)).toMatchObject({
      dirty: true,
      hasSaveTarget: false,
    });
    const recovered = await recoveredRuntime.recoverMainOnly(hosted.snapshot.sessionId);
    expect(recovered.document.name).toBe('Must remain recoverable');
  }, 30_000);

  it('serializes heartbeat behind the complete target-commit and sidecar-record window', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-save-heartbeat-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    let interceptSave = false;
    let committedTarget: (() => void) | undefined;
    let releaseArchive: (() => void) | undefined;
    const targetCommitted = new Promise<void>((resolve) => {
      committedTarget = resolve;
    });
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive: ArchiveDurabilityCapability = {
      ...defaultArchiveDurability,
      save: async (target, bytes, options) => {
        const result = await defaultArchiveDurability.save(target, bytes, options);
        if (interceptSave) {
          committedTarget?.();
          await archiveGate;
        }
        return result;
      },
    };
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
      archive,
    });
    const host = new DesktopCollaborationCoordinator(runtime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      writerLeaseTtlMs: 250,
      heartbeatIntervalMs: 20,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(runtime));
    cleanup.push(() => host.shutdownAll());

    const source = await runtime.createMainOnly();
    await runtime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const edited = await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Serialized save',
      commands: [{ type: 'deck.rename', name: 'Serialized heartbeat save' }],
    });
    interceptSave = true;
    const pendingSave = host.saveHost(hosted.snapshot.sessionId);
    await targetCommitted;
    // Multiple heartbeat periods elapse while the target contains the new bytes but the
    // sidecar still names the prior fingerprint. A non-serialized heartbeat would fence host.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(host.status(hosted.snapshot.sessionId).sessionCode).toBeTruthy();
    releaseArchive?.();
    const saved = await pendingSave;
    expect(saved?.revision).toBe(edited?.revision);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.status(hosted.snapshot.sessionId).sessionCode).toBeTruthy();
    expect(parseHdeckArchive(await readFile(targetPath)).document.name).toBe(
      'Serialized heartbeat save',
    );
  }, 30_000);

  it('keeps a post-commit copy dirty when sidecar confirmation is lost', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-unconfirmed-save-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    let interceptSave = false;
    let committedTarget: (() => void) | undefined;
    let releaseArchive: (() => void) | undefined;
    const targetCommitted = new Promise<void>((resolve) => {
      committedTarget = resolve;
    });
    const archiveGate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const archive: ArchiveDurabilityCapability = {
      ...defaultArchiveDurability,
      save: async (target, bytes, options) => {
        const result = await defaultArchiveDurability.save(target, bytes, options);
        if (interceptSave) {
          committedTarget?.();
          await archiveGate;
        }
        return result;
      },
    };
    const recoveryDirectory = path.join(directory, 'recovery');
    const runtime = new DocumentSessionManager({
      recoveryDirectory,
      autosaveDelayMs: 0,
      archive,
    });
    const recoveredRuntime = new DocumentSessionManager({ recoveryDirectory, autosaveDelayMs: 0 });
    const host = new DesktopCollaborationCoordinator(runtime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      writerLeaseTtlMs: 500,
      heartbeatIntervalMs: 100,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(recoveredRuntime));
    cleanup.push(() => closeRuntime(runtime));
    cleanup.push(() => host.shutdownAll());

    const source = await runtime.createMainOnly();
    await runtime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Unconfirmed save',
      commands: [{ type: 'deck.rename', name: 'Post-commit recovery copy' }],
    });
    interceptSave = true;
    const pendingSave = host.saveHost(hosted.snapshot.sessionId);
    await targetCommitted;
    await writeFile(`${targetPath}.writer.json`, '{"tampered":true}', 'utf8');
    releaseArchive?.();
    await expect(pendingSave).rejects.toMatchObject({ code: 'SPLIT_BRAIN' });
    expect(runtime.getSnapshot(hosted.snapshot.sessionId)).toMatchObject({
      dirty: true,
      hasSaveTarget: false,
      durability: 'save-error',
    });
    const ended = await host.leave(hosted.snapshot.sessionId);
    expect(ended).toMatchObject({ preserveDetached: true });
    const recovered = await recoveredRuntime.recoverMainOnly(hosted.snapshot.sessionId);
    expect(recovered.document.name).toBe('Post-commit recovery copy');
    expect(recovered.dirty).toBe(true);
  }, 30_000);

  it('fences a host on heartbeat failure and preserves dirty detached recovery on leave', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-heartbeat-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    const recoveryDirectory = path.join(directory, 'host-recovery');
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory,
      autosaveDelayMs: 0,
    });
    const recoveredRuntime = new DocumentSessionManager({
      recoveryDirectory,
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      writerLeaseTtlMs: 200,
      heartbeatIntervalMs: 20,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(recoveredRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, {
      targetPath,
      expectedFingerprint: null,
    });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const local = await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Local edit before fence',
      commands: [{ type: 'deck.rename', name: 'Recovered after heartbeat fence' }],
    });
    const external = {
      ...local!.document,
      name: 'External heartbeat conflict',
      metadata: { ...local!.document.metadata, modifiedAt: new Date().toISOString() },
    };
    await writeFile(targetPath, createHdeckArchive({ document: external }));
    await waitFor(() =>
      host.status(hosted.snapshot.sessionId).note.includes('writer lease failed'),
    );
    await expect(
      host.execute({
        sessionId: hosted.snapshot.sessionId,
        expectedRevision: local!.revision,
        label: 'Must be fenced',
        commands: [{ type: 'deck.rename', name: 'Forbidden after fence' }],
      }),
    ).rejects.toMatchObject({ code: 'SPLIT_BRAIN' });
    const ended = await host.leave(hosted.snapshot.sessionId);
    expect(ended).toMatchObject({ preserveDetached: true });
    expect(hostRuntime.getSnapshot(hosted.snapshot.sessionId)).toMatchObject({
      dirty: true,
      hasSaveTarget: false,
    });
    const recovered = await recoveredRuntime.recoverMainOnly(hosted.snapshot.sessionId);
    expect(recovered.document.name).toBe('Recovered after heartbeat fence');
  }, 30_000);

  it('disconnects and fences a guest whose local replica cannot apply the host transaction', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-guest-fence-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'host-recovery'),
      autosaveDelayMs: 0,
    });
    const guestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-recovery'),
      autosaveDelayMs: 0,
    });
    const recoveredGuestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-recovery'),
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
    });
    const guest = new DesktopCollaborationCoordinator(guestRuntime);
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(recoveredGuestRuntime));
    cleanup.push(() => closeRuntime(guestRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => guest.shutdownAll());
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const guestSource = await guestRuntime.openMainOnly({ targetPath });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const joined = await guest.join({
      sessionId: guestSource.sessionId,
      targetPath,
      endpoint: hosted.status.endpoint!,
      sessionCode: hosted.status.sessionCode!,
      expectedFingerprint: hosted.status.hostFingerprint!,
      displayName: 'Guest',
    });
    const guestBefore = guestRuntime.getSnapshot(joined.snapshot.sessionId);
    await guestRuntime.execute(joined.snapshot.sessionId, {
      expectedRevision: guestBefore.revision,
      commands: [{ type: 'deck.rename', name: 'Injected local divergence' }],
      metadata: {
        transactionId: '97000000-0000-4000-8000-000000000001',
        actorId: 'test-divergence',
        origin: 'user',
        label: 'Inject divergence',
        timestamp: new Date().toISOString(),
      },
    });
    await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Authoritative change',
      commands: [{ type: 'deck.rename', name: 'Authoritative host value' }],
    });
    await waitFor(() => guest.status(joined.snapshot.sessionId).connectedPeers === 0);
    expect(guest.status(joined.snapshot.sessionId).note).toContain('read-only');
    const diverged = guestRuntime.getSnapshot(joined.snapshot.sessionId);
    await expect(
      guest.execute({
        sessionId: joined.snapshot.sessionId,
        expectedRevision: diverged.revision,
        label: 'Forbidden divergent guest edit',
        commands: [{ type: 'deck.rename', name: 'Must not submit' }],
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const ended = await guest.leave(joined.snapshot.sessionId);
    expect(ended).toMatchObject({
      mode: 'guest',
      preserveDetached: true,
      preservationReason: 'guest-copy',
    });
    const recovered = await recoveredGuestRuntime.recoverMainOnly(joined.snapshot.sessionId);
    expect(recovered.document.name).toBe('Injected local divergence');
  }, 30_000);

  it('keeps a recoverable guest copy after bounded reconnect fails on host loss', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-host-loss-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'host-recovery'),
      autosaveDelayMs: 0,
    });
    const guestRecoveryDirectory = path.join(directory, 'guest-recovery');
    const guestRuntime = new DocumentSessionManager({
      recoveryDirectory: guestRecoveryDirectory,
      autosaveDelayMs: 0,
    });
    const recoveredGuestRuntime = new DocumentSessionManager({
      recoveryDirectory: guestRecoveryDirectory,
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
    });
    const guest = new DesktopCollaborationCoordinator(guestRuntime);
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(recoveredGuestRuntime));
    cleanup.push(() => closeRuntime(guestRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => guest.shutdownAll());
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const guestSource = await guestRuntime.openMainOnly({ targetPath });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    const joined = await guest.join({
      sessionId: guestSource.sessionId,
      targetPath,
      endpoint: hosted.status.endpoint!,
      sessionCode: hosted.status.sessionCode!,
      expectedFingerprint: hosted.status.hostFingerprint!,
      displayName: 'Guest',
    });
    await host.execute({
      sessionId: hosted.snapshot.sessionId,
      expectedRevision: hosted.snapshot.revision,
      label: 'Accepted before host loss',
      commands: [{ type: 'deck.rename', name: 'Guest survives host loss' }],
    });
    await waitFor(
      () =>
        guestRuntime.getSnapshot(joined.snapshot.sessionId).document.name ===
        'Guest survives host loss',
    );
    await host.shutdown(hosted.snapshot.sessionId);
    await waitFor(() => guest.status(joined.snapshot.sessionId).note.includes('read-only'), 8_000);
    const ended = await guest.leave(joined.snapshot.sessionId);
    expect(ended).toMatchObject({
      mode: 'guest',
      preserveDetached: true,
      preservationReason: 'guest-copy',
    });
    const recovered = await recoveredGuestRuntime.recoverMainOnly(joined.snapshot.sessionId);
    expect(recovered.document.name).toBe('Guest survives host loss');
  }, 30_000);

  it('binds the desktop session code to the server invitation expiry and a bounded format', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-expiry-'));
    const targetPath = path.join(directory, 'shared.hdeck');
    let now = Date.now();
    const hostRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'host-recovery'),
      autosaveDelayMs: 0,
    });
    const guestRuntime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'guest-recovery'),
      autosaveDelayMs: 0,
    });
    const host = new DesktopCollaborationCoordinator(hostRuntime, {
      bindHost: '127.0.0.1',
      advertisedHost: '127.0.0.1',
      invitationTtlMs: 50,
      clock: () => now,
    });
    const guest = new DesktopCollaborationCoordinator(guestRuntime, { clock: () => now });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(() => closeRuntime(guestRuntime));
    cleanup.push(() => closeRuntime(hostRuntime));
    cleanup.push(() => guest.shutdownAll());
    cleanup.push(() => host.shutdownAll());

    const source = await hostRuntime.createMainOnly();
    await hostRuntime.saveAsMainOnly(source.sessionId, { targetPath, expectedFingerprint: null });
    const guestSource = await guestRuntime.openMainOnly({ targetPath });
    const hosted = await host.host({
      sessionId: source.sessionId,
      targetPath,
      displayName: 'Host',
      enableDiscovery: false,
    });
    expect(hosted.status.sessionCode!.length).toBeLessThanOrEqual(128);
    now += 51;
    await expect(
      guest.join({
        sessionId: guestSource.sessionId,
        targetPath,
        endpoint: hosted.status.endpoint!,
        sessionCode: hosted.status.sessionCode!,
        expectedFingerprint: hosted.status.hostFingerprint!,
        displayName: 'Expired guest',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      guest.join({
        sessionId: guestSource.sessionId,
        targetPath,
        endpoint: hosted.status.endpoint!,
        sessionCode: 'x'.repeat(129),
        expectedFingerprint: hosted.status.hostFingerprint!,
        displayName: 'Oversized code',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  }, 30_000);
});
