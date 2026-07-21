import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

import {
  createNeutralDemoDeck,
  InMemoryDocumentAdapter,
  type DocumentCommand,
} from '@htmllelujah/document-core';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  AuthoritativeSessionHost,
  CollaborationTransportClient,
  CollaborationTransportServer as ApprovalRequiredTransportServer,
  ChunkReassembler,
  COLLABORATION_PROTOCOL_VERSION,
  createAuthProof,
  encodeLogicalMessage,
  RemoteTransportError,
  TransportFramingError,
  type CommandBatchRequest,
  type AuthChallenge,
  type ManualInvitation,
  type PresenceUpdate,
  type TransportChunk,
} from '../src/index.js';

const SESSION_ID = '94000000-0000-4000-8000-000000000001';
const SECRET = Buffer.alloc(32, 0x42);

/** Most transport tests exercise the post-approval channel; approval-specific cases use the real class. */
class CollaborationTransportServer extends ApprovalRequiredTransportServer {
  public constructor(options: ConstructorParameters<typeof ApprovalRequiredTransportServer>[0]) {
    super(options);
    this.onPendingJoin((request) => {
      void this.approveJoin(request.joinRequestId).catch(() => undefined);
    });
  }
}

const requestId = (suffix: number): string =>
  `94100000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const createEngine = (): AuthoritativeSessionHost =>
  new AuthoritativeSessionHost(new InMemoryDocumentAdapter(createNeutralDemoDeck()), {
    sessionId: SESSION_ID,
  });

const createLargeEngine = (): AuthoritativeSessionHost => {
  const deck = createNeutralDemoDeck();
  const element = deck.slides[0]?.elements[0];
  if (element?.type !== 'text' || element.content.blocks[0]?.type !== 'paragraph') {
    throw new Error('Demo deck does not expose the expected text element.');
  }
  const original = element.content.blocks[0].runs[0]!;
  const mutableBlock = element.content.blocks[0] as unknown as {
    runs: Array<typeof original>;
  };
  mutableBlock.runs = Array.from({ length: 14 }, (_, index) => ({
    ...original,
    text: `${String(index).padStart(4, '0')}:${'x'.repeat(94_990)}`,
  }));
  expect(Buffer.byteLength(JSON.stringify(deck))).toBeGreaterThan(1024 * 1024);
  return new AuthoritativeSessionHost(new InMemoryDocumentAdapter(deck), {
    sessionId: SESSION_ID,
  });
};

const createSupportedContractEngine = (): {
  readonly engine: AuthoritativeSessionHost;
  readonly documentBytes: number;
} => {
  const deck = createNeutralDemoDeck();
  const element = deck.slides[0]?.elements[0];
  if (element?.type !== 'text' || element.content.blocks[0]?.type !== 'paragraph') {
    throw new Error('Demo deck does not expose the expected text element.');
  }
  const original = element.content.blocks[0].runs[0]!;
  const mutableBlock = element.content.blocks[0] as unknown as {
    runs: Array<typeof original>;
  };
  mutableBlock.runs = Array.from({ length: 180 }, (_, index) => ({
    ...original,
    text: `${String(index).padStart(4, '0')}:${'y'.repeat(99_980)}`,
  }));
  const documentBytes = Buffer.byteLength(JSON.stringify(deck));
  expect(documentBytes).toBeGreaterThan(16 * 1024 * 1024);
  expect(documentBytes).toBeLessThan(32 * 1024 * 1024);
  return {
    engine: new AuthoritativeSessionHost(new InMemoryDocumentAdapter(deck), {
      sessionId: SESSION_ID,
    }),
    documentBytes,
  };
};

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
    readonly requestTimeoutMs?: number;
    readonly maxPayloadBytes?: number;
  } = {},
): CollaborationTransportClient =>
  new CollaborationTransportClient({
    invitation,
    documentId: engine.documentId,
    clientId,
    displayName: clientId,
    documentSecret: options.secret ?? SECRET,
    ...(options.nonceFactory === undefined ? {} : { nonceFactory: options.nonceFactory }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxPayloadBytes === undefined ? {} : { maxPayloadBytes: options.maxPayloadBytes }),
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

const waitForSocketClose = (socket: Socket): Promise<void> => {
  socket.on('error', () => undefined);
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
  });
};

const rawUrl = (invitation: ManualInvitation): string =>
  `wss://${invitation.host}:${invitation.port}/v1/session/${invitation.sessionId}`;

const connectRaw = async (
  invitation: ManualInvitation,
): Promise<{
  socket: WebSocket;
  firstMessage: Promise<unknown>;
  closed: Promise<[number, Buffer]>;
}> => {
  const socket = new WebSocket(rawUrl(invitation), {
    // Test-only raw peer for the server's ephemeral self-signed certificate; production pin
    // verification is exercised by createClient().
    // CodeQL triage: used in tests.
    rejectUnauthorized: false,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  const firstMessage = new Promise<unknown>((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
  });
  const closed = new Promise<[number, Buffer]>((resolve) => {
    socket.once('close', (code, reason) => resolve([code, reason]));
  });
  await once(socket, 'open');
  return { socket, firstMessage, closed };
};

const testChunkMac = (chunk: Omit<TransportChunk, 'mac'>): string =>
  createHmac('sha256', SECRET)
    .update('htmllelujah-collaboration-chunk-v1\0')
    .update(chunk.stream)
    .update('\0')
    .update(chunk.transferId)
    .update('\0')
    .update(String(chunk.index))
    .update('\0')
    .update(String(chunk.totalChunks))
    .update('\0')
    .update(String(chunk.totalBytes))
    .update('\0')
    .update(chunk.sha256)
    .update('\0')
    .update(chunk.data)
    .digest('base64url');

const framesFor = (transferId: string, value: unknown): TransportChunk[] =>
  encodeLogicalMessage(value, {
    stream: 'client',
    secret: SECRET,
    transferId,
    maxFrameBytes: 512,
    maxLogicalPayloadBytes: 8_192,
  }).map((frame) => JSON.parse(frame) as TransportChunk);

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

    expect(
      () =>
        new CollaborationTransportServer({
          engine,
          documentSecret: SECRET,
          maxPeers: 33,
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
      await waitFor(() => server.connectionCount === 0);
      expect(server.authenticatedPeerCount).toBe(0);
    } finally {
      await wrongSecret.close();
      await wrongFingerprint.close();
      await server.close();
    }
  });

  it('withholds authentication and snapshots until the host explicitly accepts', async () => {
    const engine = createEngine();
    engine.updatePresence({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: engine.sessionId,
      documentId: engine.documentId,
      clientId: 'authoritative-host',
      sequence: 0,
      displayName: 'Authoritative host',
      selectedElementIds: [],
    });
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      hostClientId: 'authoritative-host',
      joinApprovalTimeoutMs: 2_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'approval-gated');
    const spoofedHost = createClient(invitation, engine, 'authoritative-host');
    try {
      await expectRemoteCode(spoofedHost.connect(), 'CLIENT_ID_IN_USE');
      await waitFor(() => server.connectionCount === 0);
      const connecting = client.connect();
      await waitFor(() => server.listPendingJoins().length === 1);
      expect(client.isConnected).toBe(false);
      expect(server.authenticatedPeerCount).toBe(0);
      expect(engine.listPresence()).toMatchObject([
        { clientId: 'authoritative-host', displayName: 'Authoritative host' },
      ]);
      const pending = server.listPendingJoins()[0]!;
      expect(pending).toMatchObject({
        clientId: 'approval-gated',
        displayName: 'approval-gated',
      });

      let resyncSettled = false;
      const resync = client
        .getResync({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: engine.sessionId,
          documentId: engine.documentId,
          afterSeq: 0,
          knownRevision: engine.revision,
        })
        .finally(() => {
          resyncSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(resyncSettled).toBe(false);
      expect(await server.approveJoin(pending.joinRequestId)).toBe(true);
      await connecting;
      const snapshot = await resync;
      expect(snapshot.sessionId).toBe(engine.sessionId);
      expect(server.authenticatedPeerCount).toBe(1);
      expect(engine.listPresence()).toMatchObject([
        { clientId: 'approval-gated', displayName: 'approval-gated' },
        { clientId: 'authoritative-host', displayName: 'Authoritative host' },
      ]);
      expect(client.authoritativeHostClientId).toBe('authoritative-host');
    } finally {
      await client.close();
      await spoofedHost.close();
      await server.close();
    }
  });

  it('queues the initial snapshot before broadcasts and accepts the first request immediately', async () => {
    const engine = createEngine();
    engine.updatePresence({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: engine.sessionId,
      documentId: engine.documentId,
      clientId: 'bootstrap-host',
      sequence: 0,
      displayName: 'Bootstrap host',
      selectedElementIds: [],
    });
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      hostClientId: 'bootstrap-host',
      joinApprovalTimeoutMs: 2_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'bootstrap-guest');
    let releaseAccepted!: () => void;
    let releaseSnapshotCompletion!: () => void;
    const acceptedGate = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    const snapshotCompletionGate = new Promise<void>((resolve) => {
      releaseSnapshotCompletion = resolve;
    });
    const connecting = client.connect();
    void connecting.catch(() => undefined);
    try {
      await waitFor(() => server.listPendingJoins().length === 1);
      type BootstrapState = {
        authenticated: boolean;
        operationalReady: boolean;
        sender: {
          sendRaw: (frame: string) => Promise<void>;
          sendLogical: (value: unknown) => Promise<void>;
        };
      };
      const state = [
        ...(
          server as unknown as {
            connections: Map<WebSocket, BootstrapState>;
          }
        ).connections.values(),
      ][0]!;
      const originalSendRaw = state.sender.sendRaw.bind(state.sender);
      const originalSendLogical = state.sender.sendLogical.bind(state.sender);
      const logicalTypes: string[] = [];
      let acceptedBlocked = false;
      let snapshotEnqueued = false;

      state.sender.sendRaw = async (frame: string): Promise<void> => {
        const message = JSON.parse(frame) as { readonly type?: unknown };
        if (message.type === 'auth.accepted') {
          acceptedBlocked = true;
          await acceptedGate;
        }
        await originalSendRaw(frame);
      };
      state.sender.sendLogical = (value: unknown): Promise<void> => {
        const type =
          typeof value === 'object' && value !== null && 'type' in value
            ? (value as { readonly type?: unknown }).type
            : undefined;
        if (typeof type === 'string') logicalTypes.push(type);
        const operation = originalSendLogical(value);
        if (type !== 'presence.snapshot') return operation;
        snapshotEnqueued = true;
        return operation.then(() => snapshotCompletionGate);
      };

      const pending = server.listPendingJoins()[0]!;
      const approval = server.approveJoin(pending.joinRequestId);
      void approval.catch(() => undefined);
      await waitFor(() => acceptedBlocked && state.authenticated && !state.operationalReady);

      await server.publishPresence({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: engine.sessionId,
        documentId: engine.documentId,
        clientId: 'bootstrap-host',
        sequence: 1,
        displayName: 'Bootstrap host',
        selectedElementIds: [],
      });
      expect(logicalTypes).toEqual([]);

      releaseAccepted();
      await waitFor(() => snapshotEnqueued);
      await connecting;
      expect(state.operationalReady).toBe(true);
      await expect(
        client.updatePresence({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: engine.sessionId,
          documentId: engine.documentId,
          clientId: 'bootstrap-guest',
          sequence: 1,
          displayName: 'bootstrap-guest',
          selectedElementIds: [],
        }),
      ).resolves.toMatchObject({ sequence: 1 });

      releaseSnapshotCompletion();
      await expect(approval).resolves.toBe(true);
      expect(logicalTypes[0]).toBe('presence.snapshot');
      expect(client.listPresence()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ clientId: 'bootstrap-host', sequence: 1 }),
          expect.objectContaining({ clientId: 'bootstrap-guest', sequence: 1 }),
        ]),
      );
    } finally {
      releaseAccepted();
      releaseSnapshotCompletion();
      await client.close();
      await server.close();
    }
  }, 10_000);

  it('fails closed if operational data arrives while host approval is pending', async () => {
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      joinApprovalTimeoutMs: 2_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'pending-protocol-guard');
    const connecting = client.connect();
    void connecting.catch(() => undefined);
    try {
      await waitFor(() => server.listPendingJoins().length === 1);
      const state = [
        ...(
          server as unknown as {
            connections: Map<WebSocket, { sender: { sendRaw: (value: string) => Promise<void> } }>;
          }
        ).connections.values(),
      ][0]!;
      await state.sender.sendRaw(
        JSON.stringify({
          type: 'presence.snapshot',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          participants: [],
        }),
      );
      await expectRemoteCode(connecting, 'PROTOCOL_ERROR');
      await waitFor(() => server.connectionCount === 0);
      expect(engine.listPresence()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects and expires unconfirmed joins without granting authenticated access', async () => {
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      joinApprovalTimeoutMs: 120,
    });
    const invitation = await server.start();
    const rejected = createClient(invitation, engine, 'join-rejected');
    const timedOut = createClient(invitation, engine, 'join-timeout');
    try {
      const rejectedConnection = rejected.connect();
      await waitFor(() => server.listPendingJoins().length === 1);
      expect(server.rejectJoin(server.listPendingJoins()[0]!.joinRequestId)).toBe(true);
      await expectRemoteCode(rejectedConnection, 'JOIN_REJECTED');
      await waitFor(() => server.connectionCount === 0);

      const timedConnection = timedOut.connect();
      await waitFor(() => server.listPendingJoins().length === 1);
      await expectRemoteCode(timedConnection, 'JOIN_TIMEOUT');
      await waitFor(() => server.connectionCount === 0);
      expect(server.authenticatedPeerCount).toBe(0);
      expect(engine.listPresence()).toEqual([]);
    } finally {
      await rejected.close();
      await timedOut.close();
      await server.close();
    }
  });

  it('bounds secret-correct pending floods and rejects hostile display names server-side', async () => {
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      maxPendingConnections: 2,
      maxPendingPerAddress: 2,
      joinApprovalTimeoutMs: 2_000,
    });
    const invitation = await server.start();
    const first = createClient(invitation, engine, 'pending-one');
    const second = createClient(invitation, engine, 'pending-two');
    const overflow = createClient(invitation, engine, 'pending-three');
    try {
      const connections = Promise.allSettled([first.connect(), second.connect()]);
      await waitFor(() => server.listPendingJoins().length === 2);
      await expect(overflow.connect()).rejects.toBeInstanceOf(Error);
      expect(server.listPendingJoins()).toHaveLength(2);
      expect(server.authenticatedPeerCount).toBe(0);
      await first.close();
      await second.close();
      await connections;
    } finally {
      await first.close();
      await second.close();
      await overflow.close();
      await server.close();
    }

    const namesEngine = createEngine();
    const namesServer = new ApprovalRequiredTransportServer({
      engine: namesEngine,
      documentSecret: SECRET,
    });
    const namesInvitation = await namesServer.start();
    const raw = await connectRaw(namesInvitation);
    try {
      const challenge = (await raw.firstMessage) as AuthChallenge;
      const clientNonce = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      const displayName = `hidden\n${'x'.repeat(60)}`;
      const proof = createAuthProof(SECRET, {
        sessionId: challenge.sessionId,
        documentId: namesEngine.documentId,
        certificateFingerprint: challenge.certificateFingerprint,
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        clientId: 'hostile-name',
        displayName,
        clientNonce,
        expiresAtMs: challenge.expiresAtMs,
      });
      const rejection = new Promise<unknown>((resolve) => {
        raw.socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      raw.socket.send(
        JSON.stringify({
          type: 'auth.response',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: challenge.sessionId,
          documentId: namesEngine.documentId,
          challengeId: challenge.challengeId,
          clientId: 'hostile-name',
          displayName,
          clientNonce,
          proof,
        }),
      );
      await expect(rejection).resolves.toMatchObject({
        type: 'auth.rejected',
        code: 'PROTOCOL_ERROR',
      });
      expect(namesServer.listPendingJoins()).toEqual([]);
    } finally {
      raw.socket.terminate();
      await namesServer.close();
    }
  });
  it('binds the bounded display name into the authentication proof', async () => {
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const raw = await connectRaw(invitation);
    try {
      const challenge = (await raw.firstMessage) as AuthChallenge;
      const clientNonce = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
      const proof = createAuthProof(SECRET, {
        sessionId: challenge.sessionId,
        documentId: engine.documentId,
        certificateFingerprint: challenge.certificateFingerprint,
        challengeId: challenge.challengeId,
        serverNonce: challenge.serverNonce,
        clientId: 'display-name-binding',
        displayName: 'Approved name',
        clientNonce,
        expiresAtMs: challenge.expiresAtMs,
      });
      const rejection = new Promise<unknown>((resolve) => {
        raw.socket.once('message', (data) => resolve(JSON.parse(data.toString())));
      });
      raw.socket.send(
        JSON.stringify({
          type: 'auth.response',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: challenge.sessionId,
          documentId: engine.documentId,
          challengeId: challenge.challengeId,
          clientId: 'display-name-binding',
          displayName: 'Tampered name',
          clientNonce,
          proof,
        }),
      );
      await expect(rejection).resolves.toMatchObject({
        type: 'auth.rejected',
        code: 'AUTH_FAILED',
      });
      expect(server.listPendingJoins()).toEqual([]);
    } finally {
      raw.socket.terminate();
      await server.close();
    }
  });

  it('reconnects only with the rotated post-approval token and cleans presence on loss', async () => {
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      reconnectGrantTtlMs: 2_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'approved-rejoin');
    try {
      const firstConnection = client.connect();
      await waitFor(() => server.listPendingJoins().length === 1);
      await server.approveJoin(server.listPendingJoins()[0]!.joinRequestId);
      await firstConnection;
      const presence = {
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: engine.sessionId,
        documentId: engine.documentId,
        clientId: 'approved-rejoin',
        sequence: 1,
        displayName: 'approved-rejoin',
        selectedElementIds: [],
      };
      await expectRemoteCode(
        client.updatePresence({ ...presence, displayName: 'Unapproved rename' }),
        'CLIENT_MISMATCH',
      );
      await client.updatePresence(presence);
      expect(client.listPresence()).toMatchObject([
        { clientId: 'approved-rejoin', displayName: 'approved-rejoin' },
      ]);
      const socket = (client as unknown as { socket: WebSocket }).socket;
      socket.terminate();
      await waitFor(() => server.connectionCount === 0);
      expect(engine.listPresence()).toEqual([]);

      await client.connect();
      expect(server.listPendingJoins()).toEqual([]);
      expect(server.authenticatedPeerCount).toBe(1);
      expect(client.listPresence()).toMatchObject([
        { clientId: 'approved-rejoin', displayName: 'approved-rejoin' },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('requires fresh host approval after the reconnect grant expires', async () => {
    let now = 1_000;
    const engine = createEngine();
    const server = new ApprovalRequiredTransportServer({
      engine,
      documentSecret: SECRET,
      reconnectGrantTtlMs: 100,
      clock: () => now,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'expired-rejoin', { clock: () => now });
    try {
      const firstConnection = client.connect();
      await waitFor(() => server.listPendingJoins().length === 1);
      await server.approveJoin(server.listPendingJoins()[0]!.joinRequestId);
      await firstConnection;
      await client.close();
      await waitFor(() => server.connectionCount === 0);

      now += 101;
      const reconnecting = client.connect();
      void reconnecting.catch(() => undefined);
      await waitFor(() => server.listPendingJoins().length === 1);
      expect(server.authenticatedPeerCount).toBe(0);
      await server.approveJoin(server.listPendingJoins()[0]!.joinRequestId);
      await reconnecting;
      expect(server.authenticatedPeerCount).toBe(1);
    } finally {
      await client.close();
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
      displayName: 'client-rate',
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

  it('charges every authenticated chunk against the wire-frame rate limit', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxPayloadBytes: 512,
      maxMessagesPerWindow: 1,
      rateWindowMs: 60_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-chunk-rate', {
      maxPayloadBytes: 512,
    });
    try {
      await client.connect();
      await expect(
        client.updatePresence({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: engine.sessionId,
          documentId: engine.documentId,
          clientId: 'client-chunk-rate',
          sequence: 1,
          displayName: 'client-chunk-rate',
          selectedElementIds: Array.from(
            { length: 100 },
            (_, index) => `95000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
          ),
        }),
      ).rejects.toBeInstanceOf(Error);
      await waitFor(() => server.connectionCount === 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('chunks snapshots larger than one MiB and preserves concurrent resync ordering', async () => {
    const engine = createLargeEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-large-resync');
    const frameSizes: number[] = [];
    const transferIds: string[] = [];
    try {
      await client.connect();
      const socket = (client as unknown as { socket: WebSocket }).socket;
      socket.on('message', (data) => {
        frameSizes.push(Buffer.byteLength(data.toString()));
        try {
          const raw = JSON.parse(data.toString()) as { type?: string; transferId?: string };
          if (raw.type === 'transport.chunk' && raw.transferId !== undefined) {
            transferIds.push(raw.transferId);
          }
        } catch {
          // The client itself will fail closed if this ever happens.
        }
      });
      const request = {
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: engine.sessionId,
        documentId: engine.documentId,
        afterSeq: 0,
        knownRevision: 'force-a-snapshot',
      } as const;
      const completionOrder: number[] = [];
      const first = client.getResync(request).then((result) => {
        completionOrder.push(1);
        return result;
      });
      const second = client.getResync(request).then((result) => {
        completionOrder.push(2);
        return result;
      });
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.kind).toBe('snapshot');
      expect(secondResult.kind).toBe('snapshot');
      expect(completionOrder).toEqual([1, 2]);
      expect(frameSizes.length).toBeGreaterThan(2);
      expect(Math.max(...frameSizes)).toBeLessThanOrEqual(1024 * 1024);
      const transferTransitions = transferIds.filter(
        (transferId, index) => index === 0 || transferIds[index - 1] !== transferId,
      );
      expect(transferTransitions).toHaveLength(2);
      expect(new Set(transferTransitions).size).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it('resynchronizes a supported document above the former sixteen MiB boundary', async () => {
    const { engine, documentBytes } = createSupportedContractEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-supported-limit', {
      requestTimeoutMs: 30_000,
    });
    try {
      await client.connect();
      const result = await client.getResync({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: engine.sessionId,
        documentId: engine.documentId,
        afterSeq: 0,
        knownRevision: 'force-a-snapshot',
      });
      expect(result.kind).toBe('snapshot');
      if (result.kind === 'snapshot') {
        expect(Buffer.byteLength(JSON.stringify(result.snapshot.document))).toBe(documentBytes);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);

  it('refuses an oversized logical result with a typed error and keeps the channel usable', async () => {
    const engine = createLargeEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxLogicalPayloadBytes: 256 * 1024,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-logical-limit');
    try {
      await client.connect();
      await expectRemoteCode(
        client.getResync({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: engine.sessionId,
          documentId: engine.documentId,
          afterSeq: 0,
          knownRevision: 'force-a-snapshot',
        }),
        'LOGICAL_PAYLOAD_TOO_LARGE',
      );
      expect(
        await client.updatePresence({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          sessionId: engine.sessionId,
          documentId: engine.documentId,
          clientId: 'client-logical-limit',
          sequence: 1,
          displayName: 'client-logical-limit',
          selectedElementIds: [],
        }),
      ).toMatchObject({ sequence: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it('closes a paused slow peer at the queue high-water mark without unbounded growth', async () => {
    const engine = createEngine();
    const maxQueuedBytes = 8_000;
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxQueuedBytes,
      maxBufferedBytes: 4_000,
    });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-slow');
    try {
      await client.connect();
      const clientSocket = (client as unknown as { socket: WebSocket }).socket;
      (clientSocket as unknown as { _socket: { pause: () => void } })._socket.pause();
      const state = [
        ...(
          server as unknown as {
            connections: Map<
              WebSocket,
              { sender: { readonly pendingByteCount: number }; socket: WebSocket }
            >;
          }
        ).connections.values(),
      ][0]!;
      const transaction = await engine.submitAsync(
        createCommandRequest(engine, 'client-slow', requestId(901)),
      );
      let peakPendingBytes = 0;
      for (let index = 0; index < 50; index += 1) {
        (server as unknown as { broadcast: (message: unknown) => void }).broadcast({
          type: 'transaction.committed',
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          payload: transaction,
        });
        peakPendingBytes = Math.max(peakPendingBytes, state.sender.pendingByteCount);
      }
      expect(peakPendingBytes).toBeLessThanOrEqual(maxQueuedBytes);
      await waitFor(() => server.connectionCount === 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects duplicate authenticated client identities but permits reconnect after close', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const first = createClient(invitation, engine, 'same-client');
    const duplicate = createClient(invitation, engine, 'same-client');
    const reconnect = createClient(invitation, engine, 'same-client');
    try {
      await first.connect();
      await expectRemoteCode(duplicate.connect(), 'CLIENT_ID_IN_USE');
      await first.close();
      await waitFor(() => server.authenticatedPeerCount === 0);
      await reconnect.connect();
      expect(server.authenticatedPeerCount).toBe(1);
    } finally {
      await first.close();
      await duplicate.close();
      await reconnect.close();
      await server.close();
    }
  });

  it('separates pending and authenticated quotas and bounds pending handshakes by address', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxPeers: 1,
      maxPendingConnections: 3,
      maxPendingPerAddress: 3,
    });
    const invitation = await server.start();
    const pending = await connectRaw(invitation);
    await pending.firstMessage;
    const authenticated = createClient(invitation, engine, 'authenticated-slot');
    const blocked = createClient(invitation, engine, 'blocked-slot');
    try {
      await authenticated.connect();
      expect(server.authenticatedPeerCount).toBe(1);
      expect(server.connectionCount).toBe(2);
      await expectRemoteCode(blocked.connect(), 'PEER_LIMIT');
    } finally {
      pending.socket.terminate();
      await authenticated.close();
      await blocked.close();
      await server.close();
    }

    const addressEngine = createEngine();
    const addressServer = new CollaborationTransportServer({
      engine: addressEngine,
      documentSecret: SECRET,
      maxPendingConnections: 4,
      maxPendingPerAddress: 1,
    });
    const addressInvitation = await addressServer.start();
    const firstPending = await connectRaw(addressInvitation);
    await firstPending.firstMessage;
    try {
      await expect(connectRaw(addressInvitation)).rejects.toMatchObject({ code: 'ECONNRESET' });
      expect(addressServer.connectionCount).toBe(1);
    } finally {
      firstPending.socket.terminate();
      await addressServer.close();
    }
  });

  it('bounds raw TCP and partial TLS handshakes before WebSocket upgrade', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({
      engine,
      documentSecret: SECRET,
      maxPendingConnections: 2,
      maxPendingPerAddress: 1,
      authTimeoutMs: 1_500,
    });
    const invitation = await server.start();
    const sockets: Array<ReturnType<typeof connectTcp>> = [];
    const client = createClient(invitation, engine, 'post-handshake-quota');
    try {
      const first = connectTcp({ host: invitation.host, port: invitation.port });
      sockets.push(first);
      const firstClosed = waitForSocketClose(first);
      await once(first, 'connect');
      await waitFor(() => server.pendingHandshakeCount === 1);

      const rejected = connectTcp({ host: invitation.host, port: invitation.port });
      sockets.push(rejected);
      const rejectedClosed = waitForSocketClose(rejected);
      await once(rejected, 'connect');
      await rejectedClosed;
      expect(server.pendingHandshakeCount).toBe(1);

      await firstClosed;
      await waitFor(() => server.pendingHandshakeCount === 0);

      const partialTls = connectTls({
        host: invitation.host,
        port: invitation.port,
        // Test-only incomplete TLS handshake against the local ephemeral self-signed server; no
        // application data is accepted or sent.
        // CodeQL triage: used in tests.
        rejectUnauthorized: false,
      });
      sockets.push(partialTls);
      const partialClosed = waitForSocketClose(partialTls);
      await once(partialTls, 'secureConnect');
      await waitFor(() => server.pendingHandshakeCount === 1);
      await partialClosed;
      await waitFor(() => server.pendingHandshakeCount === 0);

      await client.connect();
      expect(server.authenticatedPeerCount).toBe(1);
      expect(server.pendingHandshakeCount).toBe(0);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await client.close();
      await server.close();
    }
  }, 15_000);

  it('fails closed on malformed authenticated transport frames', async () => {
    const engine = createEngine();
    const server = new CollaborationTransportServer({ engine, documentSecret: SECRET });
    const invitation = await server.start();
    const client = createClient(invitation, engine, 'client-malformed-frame');
    try {
      await client.connect();
      const socket = (client as unknown as { socket: WebSocket }).socket;
      const closed = once(socket, 'close');
      socket.send(JSON.stringify({ type: 'transport.chunk' }));
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1008);
      await waitFor(() => server.connectionCount === 0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('closes real authenticated peers on duplicate chunks and end-to-end hash mismatch', async () => {
    const duplicateEngine = createEngine();
    const duplicateServer = new CollaborationTransportServer({
      engine: duplicateEngine,
      documentSecret: SECRET,
      maxPayloadBytes: 512,
    });
    const duplicateInvitation = await duplicateServer.start();
    const duplicateClient = createClient(
      duplicateInvitation,
      duplicateEngine,
      'client-duplicate-chunk',
    );
    try {
      await duplicateClient.connect();
      const socket = (duplicateClient as unknown as { socket: WebSocket }).socket;
      const chunks = framesFor('94200000-0000-4000-8000-000000000006', {
        value: 'duplicate'.repeat(200),
      });
      expect(chunks.length).toBeGreaterThan(1);
      const closed = once(socket, 'close');
      socket.send(JSON.stringify(chunks[0]));
      socket.send(JSON.stringify(chunks[0]));
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1008);
    } finally {
      await duplicateClient.close();
      await duplicateServer.close();
    }

    const hashEngine = createEngine();
    const hashServer = new CollaborationTransportServer({
      engine: hashEngine,
      documentSecret: SECRET,
      maxPayloadBytes: 512,
    });
    const hashInvitation = await hashServer.start();
    const hashClient = createClient(hashInvitation, hashEngine, 'client-hash-mismatch');
    try {
      await hashClient.connect();
      const socket = (hashClient as unknown as { socket: WebSocket }).socket;
      const chunks = framesFor('94200000-0000-4000-8000-000000000007', {
        value: 'hash-mismatch'.repeat(200),
      }).map((chunk) => {
        const { mac: _oldMac, ...unsigned } = { ...chunk, sha256: 'C'.repeat(43) };
        return { ...unsigned, mac: testChunkMac(unsigned) };
      });
      const closed = once(socket, 'close');
      chunks.forEach((chunk) => socket.send(JSON.stringify(chunk)));
      const [code] = (await closed) as [number, Buffer];
      expect(code).toBe(1008);
    } finally {
      await hashClient.close();
      await hashServer.close();
    }
  });
});

describe('authenticated chunk reassembly', () => {
  const limits = {
    maxFrameBytes: 512,
    maxLogicalPayloadBytes: 8_192,
    maxReassemblyBytes: 12_000,
    maxConcurrentTransfers: 1,
    chunkTimeoutMs: 100,
  } as const;

  it('rejects duplicate, out-of-order, malformed, and hash-mismatched chunks', () => {
    const failures: TransportFramingError[] = [];
    const create = (): ChunkReassembler =>
      new ChunkReassembler({
        ...limits,
        stream: 'client',
        secret: SECRET,
        onTimeout: (error) => failures.push(error),
      });

    const duplicate = create();
    const duplicateFrames = framesFor('94200000-0000-4000-8000-000000000001', {
      value: 'x'.repeat(1_000),
    });
    expect(duplicate.accept(duplicateFrames[0])).toBeUndefined();
    expect(() => duplicate.accept(duplicateFrames[0])).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_CHUNK' }),
    );
    duplicate.dispose();

    const outOfOrder = create();
    const orderedFrames = framesFor('94200000-0000-4000-8000-000000000002', {
      value: 'y'.repeat(1_000),
    });
    expect(() => outOfOrder.accept(orderedFrames[1])).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CHUNK' }),
    );
    outOfOrder.dispose();

    const malformed = create();
    expect(() => malformed.accept({ type: 'transport.chunk' })).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CHUNK' }),
    );
    malformed.dispose();

    const hashMismatch = create();
    const mismatchedFrames = framesFor('94200000-0000-4000-8000-000000000003', {
      value: 'z'.repeat(1_000),
    }).map((chunk) => {
      const { mac: _oldMac, ...unsigned } = { ...chunk, sha256: 'B'.repeat(43) };
      return { ...unsigned, mac: testChunkMac(unsigned) };
    });
    for (const chunk of mismatchedFrames.slice(0, -1)) {
      expect(hashMismatch.accept(chunk)).toBeUndefined();
    }
    expect(() => hashMismatch.accept(mismatchedFrames.at(-1))).toThrowError(
      expect.objectContaining({ code: 'HASH_MISMATCH' }),
    );
    hashMismatch.dispose();
    expect(failures).toEqual([]);
  });

  it('bounds concurrent reservations and expires incomplete transfers', async () => {
    vi.useFakeTimers();
    const timeouts: TransportFramingError[] = [];
    const reassembler = new ChunkReassembler({
      ...limits,
      stream: 'client',
      secret: SECRET,
      onTimeout: (error) => timeouts.push(error),
    });
    const first = framesFor('94200000-0000-4000-8000-000000000004', {
      value: 'a'.repeat(1_000),
    });
    const second = framesFor('94200000-0000-4000-8000-000000000005', {
      value: 'b'.repeat(1_000),
    });
    try {
      expect(reassembler.accept(first[0])).toBeUndefined();
      expect(() => reassembler.accept(second[0])).toThrowError(
        expect.objectContaining({ code: 'REASSEMBLY_LIMIT' }),
      );
      await vi.advanceTimersByTimeAsync(limits.chunkTimeoutMs);
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]?.code).toBe('CHUNK_TIMEOUT');
    } finally {
      reassembler.dispose();
      vi.useRealTimers();
    }
  });
});
