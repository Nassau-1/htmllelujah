import {
  createNeutralDemoDeck,
  InMemoryDocumentAdapter,
  type DocumentCommand,
  type Element,
  type Frame,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  analyzeCommandAccess,
  applyCommittedTransaction,
  AuthoritativeSessionHost,
  CollaborationError,
  COLLABORATION_PROTOCOL_VERSION,
  deckSlideOrderKey,
  elementCollectionKey,
  elementEntityKey,
  slideEntityKey,
  type CommandBatchRequest,
} from '../src/index.js';

const SESSION_ID = '90000000-0000-4000-8000-000000000001';
const CLIENT_A = 'client-a';
const CLIENT_B = 'client-b';

const deterministicIdFactory = (): (() => string) => {
  let sequence = 10;
  return () => `90000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
};

const createHost = (
  options: ConstructorParameters<typeof AuthoritativeSessionHost>[1] = {},
): {
  host: AuthoritativeSessionHost;
  adapter: InMemoryDocumentAdapter;
} => {
  const adapter = new InMemoryDocumentAdapter(createNeutralDemoDeck());
  return {
    adapter,
    host: new AuthoritativeSessionHost(adapter, {
      sessionId: SESSION_ID,
      idFactory: deterministicIdFactory(),
      ...options,
    }),
  };
};

const requestId = (suffix: number): string =>
  `91000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

const transformCommand = (elementId: string, frame: Frame): DocumentCommand => ({
  type: 'element.transform',
  slideId: '20000000-0000-4000-8000-000000000001',
  transforms: [{ elementId, frame }],
});

const createRequest = (
  host: AuthoritativeSessionHost,
  input: {
    readonly clientId: string;
    readonly clientRequestId: string;
    readonly commands: readonly DocumentCommand[];
    readonly baseRevision?: string;
    readonly baseSeq?: number;
    readonly lockTokens?: Readonly<Record<string, string>>;
  },
): CommandBatchRequest => ({
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  sessionId: host.sessionId,
  documentId: host.documentId,
  clientId: input.clientId,
  clientRequestId: input.clientRequestId,
  baseRevision: input.baseRevision ?? host.revision,
  baseSeq: input.baseSeq ?? host.sessionSeq,
  commands: [...input.commands],
  metadata: { origin: 'user', label: 'Test mutation' },
  ...(input.lockTokens === undefined ? {} : { lockTokens: input.lockTokens }),
});

const expectCollaborationError = (
  operation: () => unknown,
  code: CollaborationError['code'],
): CollaborationError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return error as CollaborationError;
  }
  throw new Error(`Expected ${code}.`);
};

describe('authoritative collaboration host', () => {
  it('does not acknowledge or advance a durable submission before its async journal boundary', async () => {
    const memory = new InMemoryDocumentAdapter(createNeutralDemoDeck());
    let releaseJournal: (() => void) | undefined;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    const host = new AuthoritativeSessionHost(
      {
        durability: 'async',
        getSnapshot: () => memory.getSnapshot(),
        transact: async (commands, options) => {
          await journalGate;
          return memory.transact(commands, options);
        },
      },
      { sessionId: SESSION_ID, idFactory: deterministicIdFactory() },
    );
    const first = host.getSnapshot().document.slides[0]?.elements[0];
    if (first === undefined) throw new Error('Missing fixture element.');
    let acknowledged = false;
    const pending = host
      .submitAsync(
        createRequest(host, {
          clientId: CLIENT_A,
          clientRequestId: requestId(999),
          commands: [transformCommand(first.id, { ...first.frame, xPt: first.frame.xPt + 10 })],
        }),
      )
      .then((transaction) => {
        acknowledged = true;
        return transaction;
      });

    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(host.sessionSeq).toBe(0);
    releaseJournal?.();
    const transaction = await pending;
    expect(transaction.sessionSeq).toBe(1);
    expect(host.sessionSeq).toBe(1);
  });

  it('replicates committed transactions and converges deterministically', () => {
    const { host } = createHost();
    const replica = new InMemoryDocumentAdapter(createNeutralDemoDeck());
    const firstElement = host.getSnapshot().document.slides[0]?.elements[0];
    expect(firstElement).toBeDefined();

    const transaction = host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(1),
        commands: [
          transformCommand(firstElement!.id, {
            ...firstElement!.frame,
            xPt: firstElement!.frame.xPt + 24,
          }),
        ],
      }),
    );
    const replicaSnapshot = applyCommittedTransaction(replica, transaction);

    expect(replicaSnapshot).toEqual(host.getSnapshot());
    expect(transaction.sessionSeq).toBe(1);
    expect(transaction.beforeRevision).not.toBe(transaction.afterRevision);
  });

  it('rebases stale edits to independent elements', () => {
    const { host } = createHost();
    const replica = new InMemoryDocumentAdapter(createNeutralDemoDeck());
    const elements = host.getSnapshot().document.slides[0]!.elements;
    const first = elements[0]!;
    const second = elements[1]!;
    const baseRevision = host.revision;
    const baseSeq = host.sessionSeq;

    const firstTransaction = host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2),
        baseRevision,
        baseSeq,
        commands: [transformCommand(first.id, { ...first.frame, xPt: first.frame.xPt + 10 })],
      }),
    );
    const rebased = host.submit(
      createRequest(host, {
        clientId: CLIENT_B,
        clientRequestId: requestId(3),
        baseRevision,
        baseSeq,
        commands: [transformCommand(second.id, { ...second.frame, yPt: second.frame.yPt + 12 })],
      }),
    );

    expect(rebased.sessionSeq).toBe(2);
    expect(rebased.rebasedFromRevision).toBe(baseRevision);
    applyCommittedTransaction(replica, firstTransaction);
    applyCommittedTransaction(replica, rebased);
    expect(replica.getSnapshot()).toEqual(host.getSnapshot());
    const finalElements = host.getSnapshot().document.slides[0]!.elements;
    expect(finalElements[0]!.frame.xPt).toBe(first.frame.xPt + 10);
    expect(finalElements[1]!.frame.yPt).toBe(second.frame.yPt + 12);
  });

  it('rejects stale edits to the same entity', () => {
    const { host } = createHost();
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const baseRevision = host.revision;
    const baseSeq = host.sessionSeq;

    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(4),
        baseRevision,
        baseSeq,
        commands: [transformCommand(element.id, { ...element.frame, xPt: 100 })],
      }),
    );
    const error = expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(5),
            baseRevision,
            baseSeq,
            commands: [transformCommand(element.id, { ...element.frame, xPt: 200 })],
          }),
        ),
      'REVISION_CONFLICT',
    );

    expect(error.details?.conflictKeys).toContain(elementEntityKey(element.id));
    expect(host.sessionSeq).toBe(1);
  });

  it('rejects stale mutations of the same ordered collection', () => {
    const { host } = createHost();
    const slides = host.getSnapshot().document.slides;
    const baseRevision = host.revision;
    const baseSeq = host.sessionSeq;
    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(51),
        baseRevision,
        baseSeq,
        commands: [{ type: 'slide.reorder', slideId: slides[0]!.id, toIndex: 1 }],
      }),
    );

    const error = expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(52),
            baseRevision,
            baseSeq,
            commands: [{ type: 'slide.reorder', slideId: slides[2]!.id, toIndex: 0 }],
          }),
        ),
      'REVISION_CONFLICT',
    );
    expect(error.details?.conflictKeys).toContain(deckSlideOrderKey);
  });

  it('returns the original result for an idempotent retry and rejects key reuse', () => {
    const { host } = createHost();
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const request = createRequest(host, {
      clientId: CLIENT_A,
      clientRequestId: requestId(6),
      commands: [transformCommand(element.id, { ...element.frame, xPt: 123 })],
    });

    const first = host.submit(request);
    const retry = host.submit(structuredClone(request));
    expect(retry).toEqual(first);
    expect(host.sessionSeq).toBe(1);

    expectCollaborationError(
      () =>
        host.submit({
          ...request,
          commands: [transformCommand(element.id, { ...element.frame, xPt: 456 })],
        }),
      'IDEMPOTENCY_KEY_REUSE',
    );
  });

  it('scopes idempotency keys to the authenticated client', () => {
    const { host } = createHost();
    const [first, second] = host.getSnapshot().document.slides[0]!.elements;
    const baseRevision = host.revision;
    const baseSeq = host.sessionSeq;
    const sharedRequestId = requestId(61);

    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: sharedRequestId,
        baseRevision,
        baseSeq,
        commands: [transformCommand(first!.id, { ...first!.frame, xPt: first!.frame.xPt + 1 })],
      }),
    );
    const secondTransaction = host.submit(
      createRequest(host, {
        clientId: CLIENT_B,
        clientRequestId: sharedRequestId,
        baseRevision,
        baseSeq,
        commands: [transformCommand(second!.id, { ...second!.frame, xPt: second!.frame.xPt + 1 })],
      }),
    );

    expect(secondTransaction.clientId).toBe(CLIENT_B);
    expect(secondTransaction.sessionSeq).toBe(2);
  });

  it('enforces, renews, releases, and expires 15-second text leases', () => {
    let now = 1_000;
    const { host } = createHost({ clock: () => now });
    const slide = host.getSnapshot().document.slides[0]!;
    const text = slide.elements[0]!;
    const leaseRequest = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      clientId: CLIENT_A,
      slideId: slide.id,
      elementId: text.id,
    } as const;
    const lease = host.acquireTextLease(leaseRequest);
    expect(lease.expiresAtMs).toBe(now + 15_000);

    expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(7),
            commands: [transformCommand(text.id, { ...text.frame, xPt: 90 })],
          }),
        ),
      'TEXT_LEASE_HELD',
    );
    expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_A,
            clientRequestId: requestId(8),
            commands: [transformCommand(text.id, { ...text.frame, xPt: 91 })],
          }),
        ),
      'LOCK_TOKEN_REQUIRED',
    );

    now += 5_000;
    const renewed = host.renewTextLease({ ...leaseRequest, token: lease.token });
    expect(renewed.expiresAtMs).toBe(now + 15_000);
    expect(
      host.submit(
        createRequest(host, {
          clientId: CLIENT_A,
          clientRequestId: requestId(9),
          commands: [transformCommand(text.id, { ...text.frame, xPt: 92 })],
          lockTokens: { [text.id]: lease.token },
        }),
      ).sessionSeq,
    ).toBe(1);
    expect(host.releaseTextLease({ ...leaseRequest, token: lease.token })).toBe(true);

    const next = host.acquireTextLease({ ...leaseRequest, clientId: CLIENT_B });
    expect(host.releaseTextLeasesForClient(CLIENT_A)).toBe(0);
    expect(host.releaseTextLeasesForClient(CLIENT_B)).toBe(1);
    expect(host.listTextLeases()).toEqual([]);
    const reacquired = host.acquireTextLease({ ...leaseRequest, clientId: CLIENT_B });
    expect(reacquired.clientId).toBe(CLIENT_B);
    now = next.expiresAtMs;
    const afterExpiry = host.acquireTextLease(leaseRequest);
    expect(afterExpiry.clientId).toBe(CLIENT_A);
  });

  it('rejects malformed and oversized command requests', () => {
    const { host } = createHost({ maxCommandPayloadBytes: 900 });
    expectCollaborationError(
      () => host.submit({ protocolVersion: 1, unexpected: true }),
      'INVALID_REQUEST',
    );

    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const valid = createRequest(host, {
      clientId: CLIENT_A,
      clientRequestId: requestId(10),
      commands: [transformCommand(element.id, { ...element.frame, xPt: 99 })],
    });
    expectCollaborationError(
      () => host.submit({ ...valid, padding: 'x'.repeat(1_000) }),
      'PAYLOAD_TOO_LARGE',
    );

    const limited = createHost({ maxCommandsPerBatch: 1 }).host;
    const limitedElement = limited.getSnapshot().document.slides[0]!.elements[0]!;
    expectCollaborationError(
      () =>
        limited.submit(
          createRequest(limited, {
            clientId: CLIENT_A,
            clientRequestId: requestId(53),
            commands: [
              transformCommand(limitedElement.id, { ...limitedElement.frame, xPt: 101 }),
              transformCommand(limitedElement.id, { ...limitedElement.frame, xPt: 102 }),
            ],
          }),
        ),
      'INVALID_REQUEST',
    );
  });

  it('returns retained transaction tails or a complete snapshot', () => {
    const { host } = createHost({ tailLimit: 2 });
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const revisions = [host.revision];
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      host.submit(
        createRequest(host, {
          clientId: CLIENT_A,
          clientRequestId: requestId(10 + sequence),
          commands: [
            transformCommand(element.id, { ...element.frame, xPt: element.frame.xPt + sequence }),
          ],
        }),
      );
      revisions.push(host.revision);
    }

    const tail = host.getResync({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      afterSeq: 2,
      knownRevision: revisions[2],
    });
    expect(tail.kind).toBe('tail');
    if (tail.kind === 'tail') expect(tail.transactions.map((tx) => tx.sessionSeq)).toEqual([3]);

    const snapshot = host.getResync({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      afterSeq: 0,
      knownRevision: revisions[0],
    });
    expect(snapshot.kind).toBe('snapshot');
    if (snapshot.kind === 'snapshot') expect(snapshot.snapshot).toEqual(host.getSnapshot());

    const divergent = host.getResync({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      afterSeq: host.sessionSeq,
      knownRevision: 'rev1-not-the-current-revision',
    });
    expect(divergent.kind).toBe('snapshot');
  });

  it('bounds and expires ephemeral presence', () => {
    let now = 2_000;
    const { host } = createHost({ clock: () => now, maxParticipants: 1 });
    const basePresence = {
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: host.sessionId,
      documentId: host.documentId,
      clientId: CLIENT_A,
      sequence: 1,
      displayName: 'A',
      selectedElementIds: [],
    } as const;
    const first = host.updatePresence(basePresence);
    const stale = host.updatePresence({ ...basePresence, sequence: 0, displayName: 'Ignored' });
    expect(stale).toEqual(first);
    expectCollaborationError(
      () => host.updatePresence({ ...basePresence, clientId: CLIENT_B, displayName: 'B' }),
      'PRESENCE_CAPACITY',
    );

    now = first.expiresAtMs;
    const second = host.updatePresence({
      ...basePresence,
      clientId: CLIENT_B,
      displayName: 'B',
    });
    expect(second.clientId).toBe(CLIENT_B);
    expect(host.listPresence()).toHaveLength(1);

    expectCollaborationError(
      () =>
        host.updatePresence({
          ...basePresence,
          clientId: 'client-c',
          sequence: 2,
          selectedElementIds: Array.from(
            { length: 101 },
            (_, index) => `93000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          ),
        }),
      'INVALID_REQUEST',
    );
  });
});

describe('command access analysis', () => {
  it('is sorted, deterministic, and covers every current command kind', () => {
    const deck = createNeutralDemoDeck();
    const firstSlide = deck.slides[0]!;
    const secondSlide = deck.slides[1]!;
    const first = firstSlide.elements[0]!;
    const second = firstSlide.elements[1]!;
    const secondSlideIds = secondSlide.elements.map((element) => element.id);
    const inserted = structuredClone(secondSlide.elements[1]!) as Element;
    const commands: readonly DocumentCommand[] = [
      { type: 'slide.create', slide: structuredClone(firstSlide), index: 0 },
      { type: 'slide.delete', slideId: firstSlide.id },
      { type: 'slide.reorder', slideId: firstSlide.id, toIndex: 1 },
      { type: 'element.insert', slideId: firstSlide.id, element: inserted, index: 0 },
      {
        type: 'element.update',
        slideId: firstSlide.id,
        elementId: first.id,
        replacement: structuredClone(first),
      },
      { type: 'element.delete', slideId: firstSlide.id, elementIds: [first.id] },
      {
        type: 'element.transform',
        slideId: firstSlide.id,
        transforms: [{ elementId: first.id, frame: first.frame }],
      },
      {
        type: 'element.align',
        slideId: firstSlide.id,
        elementIds: [first.id, second.id],
        mode: 'left',
        relativeTo: 'container',
      },
      {
        type: 'element.distribute',
        slideId: secondSlide.id,
        elementIds: secondSlideIds.slice(0, 3),
        axis: 'horizontal',
        relativeTo: 'selection',
      },
      {
        type: 'element.group',
        slideId: firstSlide.id,
        elementIds: [first.id, second.id],
        groupId: '92000000-0000-4000-8000-000000000001',
        name: 'Group',
      },
      {
        type: 'element.ungroup',
        slideId: firstSlide.id,
        groupId: '92000000-0000-4000-8000-000000000001',
      },
    ];

    commands.forEach((command) => {
      const firstAnalysis = analyzeCommandAccess([command]);
      const secondAnalysis = analyzeCommandAccess([structuredClone(command)]);
      expect(secondAnalysis).toEqual(firstAnalysis);
      expect(firstAnalysis.readSet.length + firstAnalysis.writeSet.length).toBeGreaterThan(0);
      expect(firstAnalysis.readSet).toEqual([...firstAnalysis.readSet].sort());
      expect(firstAnalysis.writeSet).toEqual([...firstAnalysis.writeSet].sort());
    });

    expect(analyzeCommandAccess([commands[0]!]).writeSet).toContain(deckSlideOrderKey);
    expect(analyzeCommandAccess([commands[1]!]).writeSet).toContain(slideEntityKey(firstSlide.id));
    expect(analyzeCommandAccess([commands[3]!]).writeSet).toContain(
      elementCollectionKey(firstSlide.id),
    );
    expect(analyzeCommandAccess([commands[6]!]).writeSet).toContain(elementEntityKey(first.id));
  });
});
