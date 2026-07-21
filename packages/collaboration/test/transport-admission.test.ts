import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

import { createNeutralDemoDeck, InMemoryDocumentAdapter } from '@htmllelujah/document-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  AuthoritativeSessionHost,
  CollaborationError,
  CollaborationTransportServer,
  COLLABORATION_PROTOCOL_VERSION,
  type ManualInvitation,
} from '../src/index.js';

const SESSION_ID = '97000000-0000-4000-8000-000000000001';
const SECRET = Buffer.alloc(32, 0x71);
const FINGERPRINT = `sha256-${Buffer.alloc(32, 0x72).toString('base64url')}`;

const createEngine = (): AuthoritativeSessionHost =>
  new AuthoritativeSessionHost(new InMemoryDocumentAdapter(createNeutralDemoDeck()), {
    sessionId: SESSION_ID,
  });

interface FakeRawSocket {
  readonly socket: Socket;
  readonly events: EventEmitter;
  readonly destroy: ReturnType<typeof vi.fn>;
}

const createRawSocket = (remotePort: number): FakeRawSocket => {
  const events = new EventEmitter();
  const destroy = vi.fn();
  const socket = {
    remoteAddress: '192.168.1.20',
    remotePort,
    localAddress: '192.168.1.10',
    localPort: 443,
    once: events.once.bind(events),
    destroy,
  } as unknown as Socket;
  return { socket, events, destroy };
};

interface FakeWebSocket {
  readonly socket: WebSocket;
  readonly close: ReturnType<typeof vi.fn>;
  readonly terminate: ReturnType<typeof vi.fn>;
}

const createWebSocket = (): FakeWebSocket => {
  const events = new EventEmitter();
  const close = vi.fn();
  const terminate = vi.fn();
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close,
    terminate,
    on: events.on.bind(events),
    send: (_frame: string, callback: (error?: Error) => void) => callback(),
  } as unknown as WebSocket;
  return { socket, close, terminate };
};

type AdmissionHarness = {
  acceptPreUpgradeConnection(socket: Socket): void;
  markConnectionUpgraded(socket: Socket): unknown | undefined;
  acceptConnection(
    socket: WebSocket,
    requestUrl: string,
    fingerprint: string,
    remoteAddress: string,
    admissionState: unknown,
  ): void;
  invitation: ManualInvitation | undefined;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('transport admission boundary', () => {
  it('rejects wildcard, public, and hostname listener bindings before startup', async () => {
    for (const bindHost of ['0.0.0.0', '::', '8.8.8.8', 'localhost']) {
      try {
        new CollaborationTransportServer({
          engine: createEngine(),
          documentSecret: SECRET,
          bindHost,
          advertisedHost: '127.0.0.1',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(CollaborationError);
        expect((error as CollaborationError).code).toBe('INVALID_REQUEST');
        continue;
      }
      throw new Error(`Expected listener address ${bindHost} to be rejected.`);
    }

    const privateServer = new CollaborationTransportServer({
      engine: createEngine(),
      documentSecret: SECRET,
      bindHost: '192.168.1.10',
      advertisedHost: '192.168.1.10',
    });
    await privateServer.close();
  });

  it('keeps an upgraded early rejection charged until bounded forced termination', async () => {
    vi.useFakeTimers();
    const server = new CollaborationTransportServer({
      engine: createEngine(),
      documentSecret: SECRET,
      maxPendingConnections: 1,
      maxPendingPerAddress: 1,
      authTimeoutMs: 1_000,
    });
    const harness = server as unknown as AdmissionHarness;
    const firstRaw = createRawSocket(10_001);
    harness.acceptPreUpgradeConnection(firstRaw.socket);
    const admission = harness.markConnectionUpgraded(firstRaw.socket);
    expect(admission).toBeDefined();

    const rejectedWebSocket = createWebSocket();
    harness.acceptConnection(
      rejectedWebSocket.socket,
      '/invalid-session-path',
      FINGERPRINT,
      '192.168.1.20',
      admission,
    );
    expect(rejectedWebSocket.close).toHaveBeenCalledWith(1008, 'Invalid session path');
    expect(server.pendingHandshakeCount).toBe(1);

    const secondRaw = createRawSocket(10_002);
    harness.acceptPreUpgradeConnection(secondRaw.socket);
    expect(secondRaw.destroy).toHaveBeenCalledTimes(1);
    expect(server.pendingHandshakeCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(rejectedWebSocket.terminate).toHaveBeenCalledTimes(1);
    firstRaw.events.emit('close');
    expect(server.pendingHandshakeCount).toBe(0);
    await server.close();
  });

  it('transfers one raw admission charge directly into protocol state', async () => {
    const server = new CollaborationTransportServer({
      engine: createEngine(),
      documentSecret: SECRET,
      maxPendingConnections: 1,
      maxPendingPerAddress: 1,
      clock: () => 100,
      idFactory: () => '97000000-0000-4000-8000-000000000002',
      nonceFactory: () => Buffer.alloc(24, 0x73).toString('base64url'),
    });
    const harness = server as unknown as AdmissionHarness;
    harness.invitation = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      host: '127.0.0.1',
      port: 443,
      sessionId: SESSION_ID,
      certificateFingerprint: FINGERPRINT,
      expiresAtMs: 1_000,
    };
    const raw = createRawSocket(10_003);
    const upgraded = createWebSocket();
    harness.acceptPreUpgradeConnection(raw.socket);
    const admission = harness.markConnectionUpgraded(raw.socket);
    expect(admission).toBeDefined();

    harness.acceptConnection(
      upgraded.socket,
      `/v1/session/${SESSION_ID}`,
      FINGERPRINT,
      '192.168.1.20',
      admission,
    );
    expect(server.pendingHandshakeCount).toBe(0);
    expect(server.connectionCount).toBe(1);
    await Promise.resolve();
    await server.close();
  });
});
