import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  canonicalSerialize,
  type DocumentCommand,
  type ImageElement,
} from '@htmllelujah/document-core';
import {
  DocumentSessionManager,
  type DocumentSessionSnapshot,
} from '@htmllelujah/document-runtime';

import {
  DesktopCollaborationCoordinator,
  type CollaborationTransition,
} from '../src/main/collaboration-service.js';

const DEFAULT_DURATION_MINUTES = 30;
const DEFAULT_COMMAND_DELAY_MS = 200;
const DEFAULT_SAVE_INTERVAL_SECONDS = 60;
const DEFAULT_REJOIN_INTERVAL_SECONDS = 300;
const CONVERGENCE_TIMEOUT_MS = 10_000;
const TEXT_LEASE_INTERVAL_MS = 5 * 60_000;
const MAX_LOOP_HIATUS_MS = 30_000;
const EMBEDDED_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

type ActorName = 'host' | 'guest-1' | 'guest-2';

interface MutableParticipant {
  readonly actor: ActorName;
  readonly runtime: DocumentSessionManager;
  readonly coordinator: DesktopCollaborationCoordinator;
  sessionId: string;
}

interface Options {
  readonly durationMs: number;
  readonly commandDelayMs: number;
  readonly saveIntervalMs: number;
  readonly rejoinIntervalMs: number;
  readonly reportPath: string;
}

interface FailureDescriptor {
  readonly name: string;
  readonly code: string;
}

class SoakInvariantError extends Error {
  public readonly code: string;

  public constructor(code: string) {
    super('A soak-test invariant failed.');
    this.name = 'SoakInvariantError';
    this.code = code;
  }
}

const parsePositiveNumber = (value: string | undefined, option: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SoakInvariantError(`INVALID_${option.toUpperCase().replaceAll('-', '_')}`);
  }
  return parsed;
};

const parseOptions = (arguments_: readonly string[]): Options => {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new SoakInvariantError('INVALID_ARGUMENTS');
    }
    values.set(key.slice(2), value);
  }

  const durationMinutes = parsePositiveNumber(
    values.get('minutes') ?? String(DEFAULT_DURATION_MINUTES),
    'minutes',
  );
  const commandDelayMs = parsePositiveNumber(
    values.get('command-delay-ms') ?? String(DEFAULT_COMMAND_DELAY_MS),
    'command-delay-ms',
  );
  const saveIntervalSeconds = parsePositiveNumber(
    values.get('save-every-seconds') ?? String(DEFAULT_SAVE_INTERVAL_SECONDS),
    'save-every-seconds',
  );
  const rejoinIntervalSeconds = parsePositiveNumber(
    values.get('rejoin-every-seconds') ?? String(DEFAULT_REJOIN_INTERVAL_SECONDS),
    'rejoin-every-seconds',
  );
  const reportPath = path.resolve(
    values.get('report') ?? path.join('artifacts', 'evidence', 'lan-soak-v1.json'),
  );

  return {
    durationMs: Math.round(durationMinutes * 60_000),
    commandDelayMs: Math.round(commandDelayMs),
    saveIntervalMs: Math.round(saveIntervalSeconds * 1_000),
    rejoinIntervalMs: Math.round(rejoinIntervalSeconds * 1_000),
    reportPath,
  };
};

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const describeFailure = (error: unknown): FailureDescriptor => {
  if (error instanceof Error) {
    const withCode = error as Error & { readonly code?: unknown };
    return {
      name: error.name || 'Error',
      code: typeof withCode.code === 'string' ? withCode.code : 'UNCLASSIFIED',
    };
  }
  return { name: 'UnknownFailure', code: 'UNCLASSIFIED' };
};

const documentHash = (snapshot: DocumentSessionSnapshot): string =>
  createHash('sha256').update(canonicalSerialize(snapshot.document)).digest('hex');

const closeRuntime = async (runtime: DocumentSessionManager): Promise<void> => {
  await Promise.allSettled(
    runtime
      .listSessions()
      .map((snapshot) => runtime.close(snapshot.sessionId, { discardUnsaved: true })),
  );
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(3));
};

const summarizeLatency = (values: readonly number[]) => ({
  samples: values.length,
  average: Number(
    (values.reduce((total, value) => total + value, 0) / Math.max(1, values.length)).toFixed(3),
  ),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: Number(Math.max(0, ...values).toFixed(3)),
});

const waitFor = async (
  predicate: () => boolean,
  failureCode: string,
  timeoutMs = CONVERGENCE_TIMEOUT_MS,
): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new SoakInvariantError(failureCode);
    await delay(10);
  }
};

const assertConverged = (participants: readonly MutableParticipant[]): void => {
  const snapshots = participants.map((participant) =>
    participant.runtime.getSnapshot(participant.sessionId),
  );
  const revisions = new Set(snapshots.map((snapshot) => snapshot.revision));
  const hashes = new Set(snapshots.map(documentHash));
  if (revisions.size !== 1) throw new SoakInvariantError('REVISION_DIVERGENCE');
  if (hashes.size !== 1) throw new SoakInvariantError('HASH_DIVERGENCE');
};

const waitForConvergence = async (participants: readonly MutableParticipant[]): Promise<void> => {
  await waitFor(() => {
    try {
      assertConverged(participants);
      return true;
    } catch {
      return false;
    }
  }, 'CONVERGENCE_TIMEOUT');
  assertConverged(participants);
};

const commandFor = (snapshot: DocumentSessionSnapshot, sequence: number): DocumentCommand => {
  const firstSlide = snapshot.document.slides[0];
  if (firstSlide === undefined) throw new SoakInvariantError('MISSING_SLIDE');
  const commandKind = Math.floor(sequence / 3) % 4;
  if (commandKind === 0) return { type: 'deck.rename', name: `LAN soak deck ${sequence}` };
  if (commandKind === 1) {
    return {
      type: 'slide.update',
      slideId: firstSlide.id,
      name: `LAN soak slide ${sequence}`,
    };
  }
  if (commandKind === 2) {
    return {
      type: 'slide.set-hidden',
      slideId: firstSlide.id,
      hidden: !firstSlide.hidden,
    };
  }
  const image = firstSlide.elements.find((element) => element.type === 'image');
  if (image === undefined) throw new SoakInvariantError('SOAK_IMAGE_MISSING');
  return {
    type: 'element.transform',
    slideId: firstSlide.id,
    transforms: [
      {
        elementId: image.id,
        frame: {
          ...image.frame,
          xPt: sequence % 2 === 0 ? 536 : 548,
          yPt: sequence % 2 === 0 ? 382 : 394,
        },
      },
    ],
  };
};

const assertGuestSaveRejected = async (participant: MutableParticipant): Promise<void> => {
  try {
    await participant.coordinator.saveHost(participant.sessionId);
  } catch (error) {
    const descriptor = describeFailure(error);
    if (descriptor.code === 'WRITER_LEASE_ACTIVE') return;
    throw new SoakInvariantError('GUEST_SAVE_WRONG_REJECTION');
  }
  throw new SoakInvariantError('GUEST_SAVE_ALLOWED');
};

const main = async (): Promise<void> => {
  const options = parseOptions(process.argv.slice(2));
  const requestedStart = new Date();
  let stopRequested = false;
  const requestStop = (): void => {
    stopRequested = true;
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  console.log(
    JSON.stringify({
      event: 'started',
      pid: process.pid,
      configuredDurationMinutes: options.durationMs / 60_000,
    }),
  );

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-lan-soak-'));
  const targetPath = path.join(temporaryDirectory, 'shared.hdeck');
  const hostRuntime = new DocumentSessionManager({
    recoveryDirectory: path.join(temporaryDirectory, 'host-recovery'),
    autosaveDelayMs: 0,
  });
  const guestOneRuntime = new DocumentSessionManager({
    recoveryDirectory: path.join(temporaryDirectory, 'guest-one-recovery'),
    autosaveDelayMs: 0,
  });
  const guestTwoRuntime = new DocumentSessionManager({
    recoveryDirectory: path.join(temporaryDirectory, 'guest-two-recovery'),
    autosaveDelayMs: 0,
  });
  const verifierRuntime = new DocumentSessionManager({
    recoveryDirectory: path.join(temporaryDirectory, 'verifier-recovery'),
    autosaveDelayMs: 0,
  });
  const hostCoordinator = new DesktopCollaborationCoordinator(hostRuntime, {
    bindHost: '127.0.0.1',
    advertisedHost: '127.0.0.1',
  });
  const guestOneCoordinator = new DesktopCollaborationCoordinator(guestOneRuntime);
  const guestTwoCoordinator = new DesktopCollaborationCoordinator(guestTwoRuntime);
  const coordinators = [hostCoordinator, guestOneCoordinator, guestTwoCoordinator] as const;
  const runtimes = [hostRuntime, guestOneRuntime, guestTwoRuntime, verifierRuntime] as const;

  let participants: MutableParticipant[] = [];
  let invitation:
    | { readonly endpoint: string; readonly sessionCode: string; readonly fingerprint: string }
    | undefined;
  let authoritativeHostSessionId: string | undefined;
  let steadyStateStartedAt = 0;
  let steadyStateEndedAt = 0;
  let lastLoopCheckpoint = 0;
  let maximumLoopHiatusMs = 0;
  let status: 'passed' | 'failed' | 'interrupted' = 'failed';
  let failure: FailureDescriptor | undefined;
  let cleanupFailures = 0;
  let commandCount = 0;
  let convergenceChecks = 0;
  let hostSaves = 0;
  let persistedSnapshotVerifications = 0;
  let guestSaveAttempts = 0;
  let guestSaveRejections = 0;
  let rejoinCycles = 0;
  let assetInsertions = 0;
  let objectEdits = 0;
  let textLeaseContentions = 0;
  let textLeaseEdits = 0;
  let textLeaseTransfers = 0;
  let hostTerminationChecks = 0;
  let postHostLossEditRejections = 0;
  let minHostPeerCount = 2;
  let maxHostPeerCount = 0;
  const commandsByActor: Record<ActorName, number> = {
    host: 0,
    'guest-1': 0,
    'guest-2': 0,
  };
  const commandsByType: Record<string, number> = {};
  const commandRoundTripMs: number[] = [];

  const hostParticipant = (): MutableParticipant => {
    const host = participants.find((participant) => participant.actor === 'host');
    if (host === undefined) throw new SoakInvariantError('HOST_MISSING');
    return host;
  };

  const updatePeerRange = (): number => {
    const host = hostParticipant();
    const count = host.coordinator.status(host.sessionId).connectedPeers;
    minHostPeerCount = Math.min(minHostPeerCount, count);
    maxHostPeerCount = Math.max(maxHostPeerCount, count);
    return count;
  };

  const joinWithApproval = async (
    coordinator: DesktopCollaborationCoordinator,
    input: Parameters<DesktopCollaborationCoordinator['join']>[0],
    expectedDisplayName: string,
  ): Promise<CollaborationTransition> => {
    const hostSessionId = authoritativeHostSessionId;
    if (hostSessionId === undefined) {
      throw new SoakInvariantError('HOST_SESSION_MISSING');
    }
    const joining = coordinator.join(input);
    void joining.catch(() => undefined);
    await waitFor(
      () => hostCoordinator.status(hostSessionId).pendingJoins.length > 0,
      'JOIN_APPROVAL_PENDING_TIMEOUT',
    );
    const pending = hostCoordinator.status(hostSessionId).pendingJoins;
    if (pending.length !== 1 || pending[0]?.displayName !== expectedDisplayName) {
      throw new SoakInvariantError('UNEXPECTED_PENDING_JOIN');
    }
    await hostCoordinator.decideJoin({
      sessionId: hostSessionId,
      joinRequestId: pending[0].joinRequestId,
      decision: 'accept',
    });
    return joining;
  };

  const verifyPersistence = async (): Promise<void> => {
    const host = hostParticipant();
    const hostSnapshot = host.runtime.getSnapshot(host.sessionId);
    const saved = await host.coordinator.saveHost(host.sessionId);
    hostSaves += 1;
    if (saved === undefined || saved.revision !== hostSnapshot.revision) {
      throw new SoakInvariantError('HOST_SAVE_REVISION_MISMATCH');
    }
    for (const guest of participants.filter((participant) => participant.actor !== 'host')) {
      guestSaveAttempts += 1;
      await assertGuestSaveRejected(guest);
      guestSaveRejections += 1;
    }
    const persisted = await verifierRuntime.openMainOnly({ targetPath });
    try {
      if (
        persisted.revision !== hostSnapshot.revision ||
        documentHash(persisted) !== documentHash(hostSnapshot)
      ) {
        throw new SoakInvariantError('PERSISTED_SNAPSHOT_DIVERGENCE');
      }
      persistedSnapshotVerifications += 1;
    } finally {
      await verifierRuntime.close(persisted.sessionId, { discardUnsaved: true });
    }
  };

  const rejoinGuest = async (participant: MutableParticipant): Promise<void> => {
    if (invitation === undefined) throw new SoakInvariantError('INVITATION_MISSING');
    const oldSessionId = participant.sessionId;
    const left = await participant.coordinator.leave(oldSessionId);
    if (left?.mode !== 'guest') throw new SoakInvariantError('GUEST_LEAVE_FAILED');
    await waitFor(() => updatePeerRange() === 1, 'GUEST_LEAVE_PEER_TIMEOUT');
    const joined = await joinWithApproval(
      participant.coordinator,
      {
        sessionId: oldSessionId,
        targetPath,
        endpoint: invitation.endpoint,
        sessionCode: invitation.sessionCode,
        expectedFingerprint: invitation.fingerprint,
        displayName: participant.actor,
      },
      participant.actor,
    );
    participant.sessionId = joined.snapshot.sessionId;
    await participant.runtime.close(oldSessionId, { discardUnsaved: true });
    await waitFor(() => updatePeerRange() === 2, 'GUEST_REJOIN_PEER_TIMEOUT');
    await waitForConvergence(participants);
    convergenceChecks += 1;
    rejoinCycles += 1;
  };

  const exerciseTextLease = async (sequence: number): Promise<void> => {
    const ownerIndex = sequence % participants.length;
    const owner = participants[ownerIndex];
    if (owner === undefined) throw new SoakInvariantError('TEXT_LEASE_OWNER_MISSING');
    const contenders = participants.filter((participant) => participant !== owner);
    const snapshot = owner.runtime.getSnapshot(owner.sessionId);
    const slide = snapshot.document.slides[0];
    const text = slide?.elements.find((element) => element.type === 'text');
    if (slide === undefined || text === undefined) {
      throw new SoakInvariantError('TEXT_LEASE_TARGET_MISSING');
    }
    const target = { slideId: slide.id, elementId: text.id } as const;
    const owned = await owner.coordinator.beginTextLease({
      sessionId: owner.sessionId,
      ...target,
    });
    if (owned.status !== 'owned') throw new SoakInvariantError('TEXT_LEASE_NOT_OWNED');
    const held = await Promise.all(
      contenders.map((contender) =>
        contender.coordinator.beginTextLease({
          sessionId: contender.sessionId,
          ...target,
        }),
      ),
    );
    if (held.some((lease) => lease.status !== 'held')) {
      throw new SoakInvariantError('TEXT_LEASE_CONTENTION_FAILED');
    }
    textLeaseContentions += held.length;

    const before = owner.runtime.getSnapshot(owner.sessionId);
    const result = await owner.coordinator.execute({
      sessionId: owner.sessionId,
      expectedRevision: before.revision,
      label: 'LAN soak leased text edit',
      commands: [
        {
          type: 'text.replace-content',
          slideId: slide.id,
          textId: text.id,
          content: {
            blocks: [
              {
                id: randomUUID(),
                type: 'paragraph',
                alignment: 'left',
                runs: [
                  {
                    text: `Three-participant text lease ${sequence}`,
                    marks: {
                      bold: sequence % 2 === 0,
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
    if (result === undefined) throw new SoakInvariantError('TEXT_LEASE_EDIT_SKIPPED');
    await waitForConvergence(participants);
    convergenceChecks += 1;
    textLeaseEdits += 1;
    commandsByActor[owner.actor] += 1;
    commandsByType['text.replace-content'] = (commandsByType['text.replace-content'] ?? 0) + 1;

    const released = await owner.coordinator.endTextLease({
      sessionId: owner.sessionId,
      ...target,
    });
    if (released.status !== 'available') {
      throw new SoakInvariantError('TEXT_LEASE_RELEASE_FAILED');
    }
    const nextOwner = contenders[0];
    if (nextOwner === undefined) throw new SoakInvariantError('TEXT_LEASE_SUCCESSOR_MISSING');
    const transferred = await nextOwner.coordinator.beginTextLease({
      sessionId: nextOwner.sessionId,
      ...target,
    });
    if (transferred.status !== 'owned') {
      throw new SoakInvariantError('TEXT_LEASE_TRANSFER_FAILED');
    }
    textLeaseTransfers += 1;
    await nextOwner.coordinator.endTextLease({ sessionId: nextOwner.sessionId, ...target });
  };

  const insertExistingAsset = async (participant: MutableParticipant): Promise<void> => {
    const snapshot = participant.runtime.getSnapshot(participant.sessionId);
    const slide = snapshot.document.slides[0];
    const asset = snapshot.document.assets[0];
    if (slide === undefined || asset === undefined || asset.kind !== 'image') {
      throw new SoakInvariantError('SOAK_ASSET_MISSING');
    }
    const image: ImageElement = {
      id: randomUUID(),
      type: 'image',
      name: 'Collaborative embedded image',
      frame: { xPt: 700, yPt: 390, widthPt: 72, heightPt: 72, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId: asset.id,
      altText: 'Embedded one-pixel collaboration fixture',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    const result = await participant.coordinator.execute({
      sessionId: participant.sessionId,
      expectedRevision: snapshot.revision,
      label: 'LAN soak embedded asset insertion',
      commands: [{ type: 'element.insert', slideId: slide.id, element: image }],
    });
    if (result === undefined) throw new SoakInvariantError('ASSET_INSERTION_SKIPPED');
    await waitForConvergence(participants);
    convergenceChecks += 1;
    assetInsertions += 1;
    commandsByActor[participant.actor] += 1;
    commandsByType['element.insert'] = (commandsByType['element.insert'] ?? 0) + 1;
  };

  const verifyHostLoss = async (): Promise<void> => {
    const host = hostParticipant();
    const finalSnapshot = host.runtime.getSnapshot(host.sessionId);
    if (updatePeerRange() !== 2) throw new SoakInvariantError('PRE_TERMINATION_PEER_MISMATCH');
    await host.coordinator.shutdownAll();
    hostTerminationChecks += 1;
    await delay(1_500);
    for (const guest of participants.filter((participant) => participant.actor !== 'host')) {
      const before = guest.runtime.getSnapshot(guest.sessionId);
      try {
        await guest.coordinator.execute({
          sessionId: guest.sessionId,
          expectedRevision: before.revision,
          label: 'Must fail after host loss',
          commands: [{ type: 'deck.rename', name: 'Forbidden detached edit' }],
        });
      } catch {
        const after = guest.runtime.getSnapshot(guest.sessionId);
        if (after.revision !== before.revision || documentHash(after) !== documentHash(before)) {
          throw new SoakInvariantError('POST_HOST_LOSS_GUEST_MUTATED');
        }
        postHostLossEditRejections += 1;
        continue;
      }
      throw new SoakInvariantError('POST_HOST_LOSS_EDIT_ALLOWED');
    }
    const persisted = await verifierRuntime.openMainOnly({ targetPath });
    try {
      if (
        persisted.revision !== finalSnapshot.revision ||
        documentHash(persisted) !== documentHash(finalSnapshot)
      ) {
        throw new SoakInvariantError('POST_HOST_LOSS_FILE_DIVERGENCE');
      }
    } finally {
      await verifierRuntime.close(persisted.sessionId, { discardUnsaved: true });
    }
  };

  try {
    let hostSource = await hostRuntime.createMainOnly();
    const sourceSlide = hostSource.document.slides[0];
    if (sourceSlide === undefined) throw new SoakInvariantError('MISSING_SLIDE');
    const sourceAssetId = randomUUID();
    const sourceImage: ImageElement = {
      id: randomUUID(),
      type: 'image',
      name: 'Embedded collaboration fixture',
      frame: { xPt: 536, yPt: 382, widthPt: 96, heightPt: 96, rotationDeg: 0 },
      opacity: 1,
      visible: true,
      locked: false,
      assetId: sourceAssetId,
      altText: 'Embedded one-pixel collaboration fixture',
      fit: 'contain',
      crop: { top: 0, right: 0, bottom: 0, left: 0 },
    };
    hostSource = await hostRuntime.storeAssetAndExecute(hostSource.sessionId, {
      expectedRevision: hostSource.revision,
      id: sourceAssetId,
      bytes: EMBEDDED_PNG,
      mediaType: 'image/png',
      fileName: 'embedded-fixture.png',
      widthPx: 1,
      heightPx: 1,
      commands: [{ type: 'element.insert', slideId: sourceSlide.id, element: sourceImage }],
      metadata: {
        transactionId: randomUUID(),
        actorId: 'release-soak-setup',
        origin: 'system',
        label: 'Create embedded collaboration fixture',
        timestamp: new Date().toISOString(),
      },
    });
    await hostRuntime.saveAsMainOnly(hostSource.sessionId, {
      targetPath,
      expectedFingerprint: null,
      allowOverwrite: true,
    });
    const guestOneSource = await guestOneRuntime.openMainOnly({ targetPath });
    const guestTwoSource = await guestTwoRuntime.openMainOnly({ targetPath });

    const hosted = await hostCoordinator.host({
      sessionId: hostSource.sessionId,
      targetPath,
      displayName: 'host',
      enableDiscovery: false,
    });
    authoritativeHostSessionId = hosted.snapshot.sessionId;
    await hostRuntime.close(hostSource.sessionId, { discardUnsaved: true });
    const hostedStatus = hosted.status;
    if (
      hostedStatus.endpoint === undefined ||
      hostedStatus.sessionCode === undefined ||
      hostedStatus.hostFingerprint === undefined
    ) {
      throw new SoakInvariantError('HOST_INVITATION_INCOMPLETE');
    }
    invitation = {
      endpoint: hostedStatus.endpoint,
      sessionCode: hostedStatus.sessionCode,
      fingerprint: hostedStatus.hostFingerprint,
    };

    const guestOneJoined = await joinWithApproval(
      guestOneCoordinator,
      {
        sessionId: guestOneSource.sessionId,
        targetPath,
        endpoint: invitation.endpoint,
        sessionCode: invitation.sessionCode,
        expectedFingerprint: invitation.fingerprint,
        displayName: 'guest-1',
      },
      'guest-1',
    );
    await guestOneRuntime.close(guestOneSource.sessionId, { discardUnsaved: true });
    const guestTwoJoined = await joinWithApproval(
      guestTwoCoordinator,
      {
        sessionId: guestTwoSource.sessionId,
        targetPath,
        endpoint: invitation.endpoint,
        sessionCode: invitation.sessionCode,
        expectedFingerprint: invitation.fingerprint,
        displayName: 'guest-2',
      },
      'guest-2',
    );
    await guestTwoRuntime.close(guestTwoSource.sessionId, { discardUnsaved: true });

    participants = [
      {
        actor: 'host',
        runtime: hostRuntime,
        coordinator: hostCoordinator,
        sessionId: hosted.snapshot.sessionId,
      },
      {
        actor: 'guest-1',
        runtime: guestOneRuntime,
        coordinator: guestOneCoordinator,
        sessionId: guestOneJoined.snapshot.sessionId,
      },
      {
        actor: 'guest-2',
        runtime: guestTwoRuntime,
        coordinator: guestTwoCoordinator,
        sessionId: guestTwoJoined.snapshot.sessionId,
      },
    ];

    await waitFor(() => updatePeerRange() === 2, 'INITIAL_PEER_TIMEOUT');
    await waitForConvergence(participants);
    convergenceChecks += 1;
    await verifyPersistence();
    await insertExistingAsset(participants[1]!);
    await exerciseTextLease(0);

    steadyStateStartedAt = performance.now();
    lastLoopCheckpoint = steadyStateStartedAt;
    const deadline = steadyStateStartedAt + options.durationMs;
    let nextSaveAt = steadyStateStartedAt + options.saveIntervalMs;
    let nextRejoinAt = steadyStateStartedAt + options.rejoinIntervalMs;
    let nextTextLeaseAt = steadyStateStartedAt + TEXT_LEASE_INTERVAL_MS;
    let nextProgressAt = steadyStateStartedAt + 60_000;
    let rejoinGuestIndex = 1;

    console.log(JSON.stringify({ event: 'steady-state-started', connectedGuests: 2 }));

    while (performance.now() < deadline && !stopRequested) {
      const loopCheckpoint = performance.now();
      maximumLoopHiatusMs = Math.max(maximumLoopHiatusMs, loopCheckpoint - lastLoopCheckpoint);
      lastLoopCheckpoint = loopCheckpoint;
      const actor = participants[commandCount % participants.length];
      if (actor === undefined) throw new SoakInvariantError('ACTOR_MISSING');
      const before = actor.runtime.getSnapshot(actor.sessionId);
      const command = commandFor(before, commandCount);
      const operationStartedAt = performance.now();
      const result = await actor.coordinator.execute({
        sessionId: actor.sessionId,
        expectedRevision: before.revision,
        label: 'LAN soak command',
        commands: [command],
      });
      if (result === undefined) throw new SoakInvariantError('COLLABORATION_EXECUTE_SKIPPED');
      await waitForConvergence(participants);
      commandRoundTripMs.push(performance.now() - operationStartedAt);
      commandCount += 1;
      convergenceChecks += 1;
      commandsByActor[actor.actor] += 1;
      commandsByType[command.type] = (commandsByType[command.type] ?? 0) + 1;
      if (command.type === 'element.transform') objectEdits += 1;
      updatePeerRange();

      const now = performance.now();
      if (now >= nextSaveAt) {
        await verifyPersistence();
        nextSaveAt = now + options.saveIntervalMs;
      }
      if (now >= nextRejoinAt) {
        const guest = participants[rejoinGuestIndex];
        if (guest === undefined || guest.actor === 'host') {
          throw new SoakInvariantError('REJOIN_GUEST_MISSING');
        }
        await rejoinGuest(guest);
        rejoinGuestIndex = rejoinGuestIndex === 1 ? 2 : 1;
        nextRejoinAt = performance.now() + options.rejoinIntervalMs;
      }
      if (now >= nextTextLeaseAt) {
        await exerciseTextLease(textLeaseEdits);
        nextTextLeaseAt = performance.now() + TEXT_LEASE_INTERVAL_MS;
      }
      if (now >= nextProgressAt) {
        console.log(
          JSON.stringify({
            event: 'progress',
            elapsedMinutes: Number(((now - steadyStateStartedAt) / 60_000).toFixed(1)),
            commands: commandCount,
            p95RoundTripMs: summarizeLatency(commandRoundTripMs).p95,
            hostSaves,
            rejoinCycles,
          }),
        );
        nextProgressAt = now + 60_000;
      }
      await delay(options.commandDelayMs);
    }
    steadyStateEndedAt = performance.now();
    maximumLoopHiatusMs = Math.max(maximumLoopHiatusMs, steadyStateEndedAt - lastLoopCheckpoint);

    if (stopRequested) {
      status = 'interrupted';
      failure = { name: 'Signal', code: 'INTERRUPTED' };
    } else {
      if (maximumLoopHiatusMs >= MAX_LOOP_HIATUS_MS) {
        throw new SoakInvariantError('LOOP_HIATUS_EXCEEDED');
      }
      await waitForConvergence(participants);
      convergenceChecks += 1;
      await verifyPersistence();
      if (commandCount === 0) throw new SoakInvariantError('NO_COMMANDS_EXECUTED');
      if (guestSaveAttempts !== guestSaveRejections) {
        throw new SoakInvariantError('GUEST_SAVE_REJECTION_COUNT_MISMATCH');
      }
      if (updatePeerRange() !== 2) throw new SoakInvariantError('FINAL_PEER_COUNT_MISMATCH');
      if (
        objectEdits === 0 ||
        assetInsertions === 0 ||
        textLeaseContentions === 0 ||
        textLeaseEdits === 0 ||
        textLeaseTransfers === 0
      ) {
        throw new SoakInvariantError('REQUIRED_SCENARIO_MISSING');
      }
      await verifyHostLoss();
      if (postHostLossEditRejections !== 2) {
        throw new SoakInvariantError('HOST_LOSS_REJECTION_COUNT_MISMATCH');
      }
      status = 'passed';
    }
  } catch (error) {
    failure = describeFailure(error);
    status = stopRequested ? 'interrupted' : 'failed';
    steadyStateEndedAt ||= performance.now();
  } finally {
    process.removeListener('SIGINT', requestStop);
    process.removeListener('SIGTERM', requestStop);
    invitation = undefined;
    for (const coordinator of coordinators) {
      try {
        await coordinator.shutdownAll();
      } catch {
        cleanupFailures += 1;
      }
    }
    for (const runtime of runtimes) {
      try {
        await closeRuntime(runtime);
      } catch {
        cleanupFailures += 1;
      }
    }
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch {
      cleanupFailures += 1;
    }
  }

  if (cleanupFailures > 0 && status === 'passed') {
    status = 'failed';
    failure = { name: 'CleanupFailure', code: 'CLEANUP_INCOMPLETE' };
  }

  const endedAt = new Date();
  const effectiveStart = steadyStateStartedAt;
  const effectiveEnd = steadyStateEndedAt || performance.now();
  const report = {
    schemaVersion: 1,
    test: 'desktop-collaboration-lan-wss-soak',
    status,
    startedAt: requestedStart.toISOString(),
    endedAt: endedAt.toISOString(),
    configuredDurationMs: options.durationMs,
    steadyStateDurationMs: effectiveStart > 0 ? Math.max(0, effectiveEnd - effectiveStart) : 0,
    topology: {
      hosts: 1,
      guests: 2,
      transport: 'WSS loopback',
      sharedFileWriters: 1,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
    },
    operations: {
      commands: commandCount + textLeaseEdits + assetInsertions,
      steadyStateCommands: commandCount,
      commandsByActor,
      commandsByType,
      convergenceChecks,
      objectEdits,
      assetInsertions,
      textLeaseContentions,
      textLeaseEdits,
      textLeaseTransfers,
    },
    commandRoundTripMs: summarizeLatency(commandRoundTripMs),
    continuity: {
      maximumLoopHiatusMs: Number(maximumLoopHiatusMs.toFixed(3)),
      thresholdExclusiveMs: MAX_LOOP_HIATUS_MS,
      passed:
        steadyStateStartedAt > 0 && maximumLoopHiatusMs < MAX_LOOP_HIATUS_MS && status === 'passed',
    },
    persistence: {
      hostSaves,
      persistedSnapshotVerifications,
      guestSaveAttempts,
      guestSaveRejections,
    },
    reconnect: {
      cycles: rejoinCycles,
      hostTerminationChecks,
      postHostLossEditRejections,
    },
    peers: {
      expectedGuestCount: 2,
      minimumObservedDuringExercise: minHostPeerCount,
      maximumObserved: maxHostPeerCount,
    },
    invariants: {
      revisionAndHashCheckedAfterEveryCommand:
        convergenceChecks >= commandCount + textLeaseEdits + assetInsertions,
      onlyHostSavedSharedFile: guestSaveAttempts === guestSaveRejections,
      persistedSnapshotsMatchedHost: persistedSnapshotVerifications === hostSaves,
      objectEditingExercised: objectEdits > 0,
      embeddedAssetInsertionExercised: assetInsertions > 0,
      textLeaseContentionAndTransferExercised:
        textLeaseContentions > 0 && textLeaseEdits > 0 && textLeaseTransfers > 0,
      hostLossRejectedAllGuestEdits:
        hostTerminationChecks === 1 && postHostLossEditRejections === 2,
      cleanupComplete: cleanupFailures === 0,
    },
    ...(failure === undefined ? {} : { failure }),
  };

  await mkdir(path.dirname(options.reportPath), { recursive: true });
  await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify({
      event: status,
      commands: commandCount,
      p95RoundTripMs: report.commandRoundTripMs.p95,
      hostSaves,
      rejoinCycles,
      cleanupComplete: cleanupFailures === 0,
      ...(failure === undefined ? {} : { failure }),
    }),
  );
  if (status !== 'passed') process.exitCode = 1;
};

void main().catch((error: unknown) => {
  const failure = describeFailure(error);
  console.error(JSON.stringify({ event: 'fatal', failure }));
  process.exitCode = 1;
});
