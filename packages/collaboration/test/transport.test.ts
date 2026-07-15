import { once } from 'node:events';

import {
  createNeutralDemoDeck,
  InMemoryDocumentAdapter,
  type DocumentCommand,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';

import {
  AuthoritativeSessionHost,
  CollaborationTransportClient,
  CollaborationTransportServer,
  COLLABORATION_PROTOCOL_VERSION,
  RemoteTransportError,
  type CommandBatchRequest,
  type ManualInvitation,
  type PresenceUpdate,
} from '../src/index.js';

const SESSION_ID = '94000000-0000-4000-8000-000000000001';
const SECRET = Buffer.alloc(32, 0x42);

const requestId = (suffix: number): string =>
  `94100000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const createEngine = (): AuthoritativeSessionHost =>
  new AuthoritativeSessionHost(new InMemoryDocumentAdapter(createNeutralDemoDeck()), {
    sessionId: SESSION_ID,
  });

const createCommandRequest = (
  engine: AuthoritativeSessionHost,
  clientId: string,
  id: string,
): CommandBatchRequest => {
  const slide = engine.getSnapshot().document.slides[0]!;
  const element = slide.elements[0]!;
  const command: DocumentCommand = {
    type: 'element.transform',
    slideId: slide.id,
    transforms: [
      { elementId: element.id, frame: { ...element.frame, xPt: element.frame.xPt + 7 } },
    ],
  };
  return {
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    sessionId: engine.sessionId,
    documentId: engine.documentId,
    clientId,
    clientRequestId: id,
    baseRevision: engine.revision,
    baseSeq: engine.sessionSeq,
    commands: [command],
    metadata: { origin: 'user', label: 'Move object' },
  };
};

const createClient = (
  invitation: ManualInvitation,
  engine: AuthoritativeSessionHost,
  clientId: string,
  options: {
    readonly secret?: Uint8Array;
    readonly nonceFactory?: () => string;
    readonly clock?: () => number;
  } = {},
): CollaborationTransportClient =>
  new CollaborationTransportClient({
    invitation,
    documentId: engine.documentId,
    clientId,
    documentSecret: options.secret ?? SECRET,
    ...(options.nonceFactory === undefined ? {} : { nonceFactory: options.nonceFactory }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

const expectRemoteCode = async (operation: Promise<unknown>, code: string): Promise<void> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteTransportError);
    expect((error as RemoteTransportError).code).toBe(code);
    return;
  }
  throw new Error(`Expected remote transport error ${code}.`);
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('WSS collaboration transport', () => {
  it('authenticates over real TLS loopback and forwards a typed command', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const starting = server.start();
    expect(server.start()).toBe(starting);
    const invitation = await starting;
    expect(await server.start()).toEqual(invitation);
    const client = createClient(invitation, engine, 'client-a');
    try {
      await client.connect();
      expect(client.isConnected).toBe(true);
      expect(server.authenticatedPeerCount).toBe(1);
      const transaction = await client.submit(
        createCommandRequest(engine, 'client-a', requestId(1)),
      );
      expect(transaction.sessionSeq).toBe(1);
      expect(engine.sessionSeq).toBe(1);
      const rename = await client.submit({
        ...createCommandRequest(engine, 'client-a', requestId(2)),
        commands: [{ type: 'deck.rename', name: 'Renamed over WSS' }],
        metadata: { origin: 'user', label: 'Rename deck' },
      });
      expect(rename.commands[0]?.type).toBe('deck.rename');
      expect(rename.sessionSeq).toBe(2);
      expect(engine.getSnapshot().document.name).toBe('Renamed over WSS');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects invalid limits and cannot restart after secret-destroying shutdown', async () => {
    const engine = createEngine();
    expect(
      () =>
        new CollaborationTransportServer({
          engine,
          documentSecret: SECRET,
          maxPeers: Number.NaN,
        }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));

    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    await server.start();
    await server.close();
    await expect(server.start()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects a wrong document secret and a wrong pinned fingerprint', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const wrongSecret = createClient(invitation, engine, 'client-secret', {
      secret: Buffer.alloc(32, 0x24),
    });
    const fingerprintTail = invitation.certificateFingerprint.endsWith('A') ? 'B' : 'A';
    const wrongFingerprint = createClient(
      {
        ...invitation,
        certificateFingerprint: `${invitation.certificateFingerprint.slice(0, -1)}${fingerprintTail}`,
      },
      engine,
      'client-fingerprint',
    );
    try {
      await expectRemoteCode(wrongSecret.connect(), 'AUTH_FAILED');
      await expectRemoteCode(wrongFingerprint.connect(), 'FINGERPRINT_MISMATCH');
    } finally {
      await wrongSecret.close();
      await wrongFingerprint.close();
      await server.close();
    }
  });

  it('rejects replayed client nonces and allows a clean reconnect with a fresh nonce', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const fixedNonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const first = createClient(invitation, engine, 'client-replay', {
      nonceFactory: () => fixedNonce,
    });
    const replay = createClient(invitation, engine, 'client-replay', {
      nonceFactory: () => fixedNonce,
    });
    const reconnect = createClient(invitation, engine, 'client-replay');
    try {
      await first.connect();
      await first.close();
      await waitFor(() => server.connectionCount === 0);
      await expectRemoteCode(replay.connect(), 'AUTH_REPLAY');
      await reconnect.connect();
      expect(server.authenticatedPeerCount).toBe(1);
    } finally {
      await first.close();
      await replay.close();
      await reconnect.close();
      await server.close();
      await server.close();
    }
  });

  it('signals an authenticated drop and reconnects with a fresh authenticated channel', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-auto-reconnect');
    try {
      await client.connect();
      const disconnected = new Promise<string>((resolve) => {
        const stop = client.onDisconnect((error) => {
          stop();
          resolve(error.code);
        });
      });
      const socket = (client as unknown as { socket: WebSocket }).socket;
      socket.terminate();
      expect(await disconnected).toBe('CONNECTION_CLOSED');
      await waitFor(() => server.connectionCount === 0);
      await client.connect();
      expect(client.isConnected).toBe(true);
      const transaction = await client.submit(
        createCommandRequest(engine, 'client-auto-reconnect', requestId(77)),
      );
      expect(transaction.sessionSeq).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns bounded lease-owner details and releases all leases on peer disconnect', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const first = createClient(invitation, engine, 'lease-client-a');
    const second = createClient(invitation, engine, 'lease-client-b');
    try {
      await Promise.all([first.connect(), second.connect()]);
      const slide = engine.getSnapshot().document.slides[0]!;
      const text = slide.elements[0]!;
      const request = {
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: engine.sessionId,
        documentId: engine.documentId,
        clientId: 'lease-client-a',
        slideId: slide.id,
        elementId: text.id,
      } as const;
      const owned = await first.acquireTextLease(request);
      expect(owned.clientId).toBe('lease-client-a');
      try {
        await second.acquireTextLease({ ...request, clientId: 'lease-client-b' });
        throw new Error('Expected the second client to observe a held lease.');
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteTransportError);
        expect(error).toMatchObject({
          code: 'TEXT_LEASE_HELD',
          details: {
            ownerClientId: 'lease-client-a',
            expiresAtMs: owned.expiresAtMs,
          },
        });
      }
      await first.close();
      await waitFor(() => engine.listTextLeases().length === 0);
      const transferred = await second.acquireTextLease({
        ...request,
        clientId: 'lease-client-b',
      });
      expect(transferred.clientId).toBe('lease-client-b');
    } finally {
      await first.close();
      await second.close();
      await server.close();
    }
  });

  it('rejects a replayed invitation at the server after its original expiry', async () => {
    let now = 10_000;
    const engine = createEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      invitationTtlMs: 100,
      clock: () => now,
    });
    const invitation = await server.start();
    const first = createClient(invitation, engine, 'client-before-expiry', { clock: () => now });
    try {
      await first.connect();
      await first.close();
      await waitFor(() => server.connectionCount === 0);
      now = invitation.expiresAtMs;
      // Simulate the former desktop bug that reconstructed a fresh client-side expiry from an
      // old session code. The authoritative server must still fence the replay.
      const replay = createClient(
        { ...invitation, expiresAtMs: now + 60_000 },
        engine,
        'client-after-expiry',
        { clock: () => now },
      );
      try {
        await expectRemoteCode(replay.connect(), 'INVITATION_EXPIRED');
      } finally {
        await replay.close();
      }
      expect(server.authenticatedPeerCount).toBe(0);
    } finally {
      await first.close();
      await server.close();
    }
  });

  it('enforces the authenticated peer limit and frees capacity on disconnect', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxPeers: 1,
    });
    const invitation = await server.start();
    const first = createClient(invitation, engine, 'client-one');
    const blocked = createClient(invitation, engine, 'client-two');
    const replacement = createClient(invitation, engine, 'client-three');
    try {
      await first.connect();
      await expectRemoteCode(blocked.connect(), 'PEER_LIMIT');
      await first.close();
      await waitFor(() => server.connectionCount === 0);
      await replacement.connect();
      expect(server.authenticatedPeerCount).toBe(1);
    } finally {
      await first.close();
      await blocked.close();
      await replacement.close();
      await server.close();
    }
  });

  it('closes oversized frames and rate-limited peers', async () => {
    const oversizeEngine = createEngine();
    const oversizeServer = new CollaborationTransportServer({
      engine: oversizeEngine,
      documentSecret: SECRET,
      maxPayloadBytes: 512,
    });
    const oversizeInvitation = await oversizeServer.start();
    const oversizeClient = createClient(oversizeInvitation, oversizeEngine, 'client-oversize');
    try {
      await oversizeClient.connect();
      const socket = (oversizeClient as unknown as { socket: WebSocket }).socket;
      const closed = once(socket, 'close');
      socket.send('x'.repeat(2_000));
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1009);
    } finally {
      await oversizeClient.close();
      await oversizeServer.close();
    }

    const rateEngine = createEngine();
    const rateServer = new CollaborationTransportServer({
      engine: rateEngine,
      documentSecret: SECRET,
      maxMessagesPerWindow: 1,
      rateWindowMs: 60_000,
    });
    const rateInvitation = await rateServer.start();
    const rateClient = createClient(rateInvitation, rateEngine, 'client-rate');
    const presence: PresenceUpdate = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: rateEngine.sessionId,
      documentId: rateEngine.documentId,
      clientId: 'client-rate',
      sequence: 1,
      displayName: 'Rate test',
      selectedElementIds: [],
    };
    try {
      await rateClient.connect();
      await rateClient.updatePresence(presence);
      await expect(rateClient.updatePresence({ ...presence, sequence: 2 })).rejects.toBeInstanceOf(
        Error,
      );
      await waitFor(() => rateServer.connectionCount === 0);
    } finally {
      await rateClient.close();
      await rateServer.close();
    }
  });
});
