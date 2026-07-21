import {
  createDefaultDeck,
  createNeutralDemoDeck,
  InMemoryDocumentAdapter,
  type DeckDocument,
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
  deckNameKey,
  deckPageKey,
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

  it('evicts the oldest idempotency result and keeps accepting commands past many capacities', () => {
    const idempotencyLimit = 3;
    const { host } = createHost({ idempotencyLimit });
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const retained: Array<{
      request: CommandBatchRequest;
      transaction: ReturnType<AuthoritativeSessionHost['submit']>;
    }> = [];

    for (let sequence = 1; sequence <= idempotencyLimit * 10; sequence += 1) {
      const request = createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(1_000 + sequence),
        commands: [
          transformCommand(element.id, {
            ...element.frame,
            xPt: element.frame.xPt + sequence,
          }),
        ],
      });
      const transaction = host.submit(request);

      expect(host.submit(structuredClone(request))).toEqual(transaction);
      expect(host.sessionSeq).toBe(sequence);
      retained.push({ request, transaction });
      if (retained.length > idempotencyLimit) retained.shift();
    }

    retained.forEach(({ request, transaction }) => {
      expect(host.submit(structuredClone(request))).toEqual(transaction);
    });
    expect(host.sessionSeq).toBe(idempotencyLimit * 10);

    const reusedEvictedKey = createRequest(host, {
      clientId: CLIENT_A,
      clientRequestId: requestId(1_001),
      commands: [transformCommand(element.id, { ...element.frame, xPt: 999 })],
    });
    expect(host.submit(reusedEvictedKey).sessionSeq).toBe(idempotencyLimit * 10 + 1);
  });

  it('does not evict a retained idempotency result when a new submission fails', () => {
    const { host } = createHost({ idempotencyLimit: 1 });
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const retainedRequest = createRequest(host, {
      clientId: CLIENT_A,
      clientRequestId: requestId(2_001),
      commands: [transformCommand(element.id, { ...element.frame, xPt: 123 })],
    });
    const retainedTransaction = host.submit(retainedRequest);

    expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(2_002),
            baseRevision: retainedTransaction.beforeRevision,
            baseSeq: 0,
            commands: [transformCommand(element.id, { ...element.frame, xPt: 456 })],
          }),
        ),
      'REVISION_CONFLICT',
    );

    expect(host.submit(structuredClone(retainedRequest))).toEqual(retainedTransaction);
    expect(host.sessionSeq).toBe(1);
  });

  it('rejects an idempotency entry that cannot fit before committing the document', () => {
    const { host, adapter } = createHost({ maxIdempotencyBytes: 1 });
    const before = adapter.getSnapshot();
    const element = before.document.slides[0]!.elements[0]!;

    expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_A,
            clientRequestId: requestId(2_101),
            commands: [transformCommand(element.id, { ...element.frame, xPt: 321 })],
          }),
        ),
      'IDEMPOTENCY_CAPACITY',
    );
    expect(host.sessionSeq).toBe(0);
    expect(adapter.getSnapshot()).toEqual(before);
  });

  it('evicts idempotency results by aggregate retained bytes before the count limit', () => {
    const probe = createHost({ idempotencyLimit: 10 });
    const probeElement = probe.host.getSnapshot().document.slides[0]!.elements[0]!;
    probe.host.submit(
      createRequest(probe.host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2_111),
        commands: [transformCommand(probeElement.id, { ...probeElement.frame, xPt: 111 })],
      }),
    );
    const probeState = probe.host as unknown as {
      idempotency: Map<string, { accountedBytes: number }>;
    };
    const singleEntryBudget = [...probeState.idempotency.values()][0]!.accountedBytes;

    const { host } = createHost({ idempotencyLimit: 3, maxIdempotencyBytes: singleEntryBudget });
    const element = host.getSnapshot().document.slides[0]!.elements[0]!;
    const initialRevision = host.revision;
    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2_111),
        commands: [transformCommand(element.id, { ...element.frame, xPt: 111 })],
      }),
    );
    const state = host as unknown as {
      idempotency: Map<string, { accountedBytes: number }>;
      idempotencyBytes: number;
    };
    expect([...state.idempotency.keys()]).toEqual([`${CLIENT_A}\0${requestId(2_111)}`]);
    expect(state.idempotencyBytes).toBeLessThanOrEqual(singleEntryBudget);
    const secondRequest = createRequest(host, {
      clientId: CLIENT_A,
      clientRequestId: requestId(2_112),
      commands: [transformCommand(element.id, { ...element.frame, xPt: 112 })],
    });
    const second = host.submit(secondRequest);

    expect(state.idempotency.size).toBe(1);
    expect([...state.idempotency.keys()]).toEqual([`${CLIENT_A}\0${requestId(2_112)}`]);
    expect(state.idempotencyBytes).toBeLessThanOrEqual(singleEntryBudget);
    expect(host.submit(structuredClone(secondRequest))).toEqual(second);
    expect(host.sessionSeq).toBe(2);

    const beforeFailure = {
      keys: [...state.idempotency.keys()],
      bytes: state.idempotencyBytes,
    };
    expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(2_113),
            baseRevision: initialRevision,
            baseSeq: 0,
            commands: [transformCommand(element.id, { ...element.frame, xPt: 113 })],
          }),
        ),
      'REVISION_CONFLICT',
    );
    expect({
      keys: [...state.idempotency.keys()],
      bytes: state.idempotencyBytes,
    }).toEqual(beforeFailure);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    '3',
  ])('rejects an invalid idempotency limit (%s)', (idempotencyLimit) => {
    expectCollaborationError(
      () => createHost({ idempotencyLimit: idempotencyLimit as number }),
      'INVALID_REQUEST',
    );
  });

  it('rejects invalid idempotency byte limits', () => {
    expectCollaborationError(() => createHost({ maxIdempotencyBytes: 0 }), 'INVALID_REQUEST');
  });

  it('bounds stale rebase history to the retained transaction floor', () => {
    const { host } = createHost({ tailLimit: 2 });
    const initialRevision = host.revision;
    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2_201),
        commands: [{ type: 'deck.rename', name: 'History one' }],
      }),
    );
    const revisionAfterOne = host.revision;
    const page = host.getSnapshot().document.page;
    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2_202),
        commands: [{ type: 'deck.set-page', page: { ...page, widthPt: page.widthPt + 1 } }],
      }),
    );
    const slide = host.getSnapshot().document.slides[0]!;
    host.submit(
      createRequest(host, {
        clientId: CLIENT_A,
        clientRequestId: requestId(2_203),
        commands: [{ type: 'slide.set-hidden', slideId: slide.id, hidden: true }],
      }),
    );

    const state = host as unknown as { lastModifiedSeq: Map<string, number> };
    expect(state.lastModifiedSeq.has(deckNameKey)).toBe(false);
    expect(state.lastModifiedSeq.get(deckPageKey)).toBe(2);

    const tooOld = expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(2_204),
            baseRevision: initialRevision,
            baseSeq: 0,
            commands: [{ type: 'deck.set-export-options', includeHiddenSlidesInExport: true }],
          }),
        ),
      'REVISION_CONFLICT',
    );
    expect(tooOld.details?.minimumBaseSeq).toBe(1);

    const retainedConflict = expectCollaborationError(
      () =>
        host.submit(
          createRequest(host, {
            clientId: CLIENT_B,
            clientRequestId: requestId(2_205),
            baseRevision: revisionAfterOne,
            baseSeq: 1,
            commands: [{ type: 'deck.set-page', page }],
          }),
        ),
      'REVISION_CONFLICT',
    );
    expect(retainedConflict.details?.conflictKeys).toContain(deckPageKey);
  });

  it.each(['master.update', 'master.delete', 'layout.update'] as const)(
    'requires the bound text lease for indirect %s remapping',
    (commandType) => {
      const ids = deterministicIdFactory();
      const base = createDefaultDeck({ idFactory: ids });
      const originalMaster = base.masters[0]!;
      const replacementMaster = {
        ...originalMaster,
        id: '93000000-0000-4000-8000-000000000001',
        name: 'Replacement master',
      };
      const deck: DeckDocument =
        commandType === 'master.delete'
          ? { ...base, masters: [...base.masters, replacementMaster] }
          : base;
      const adapter = new InMemoryDocumentAdapter(deck);
      const host = new AuthoritativeSessionHost(adapter, {
        sessionId: SESSION_ID,
        idFactory: deterministicIdFactory(),
      });
      const slide = host.getSnapshot().document.slides[0]!;
      const text = slide.elements[0]!;
      const master = deck.masters[0]!;
      const layout = deck.layouts[0]!;
      const command: DocumentCommand =
        commandType === 'master.update'
          ? {
              type: 'master.update',
              masterId: master.id,
              replacement: { ...master, name: 'Updated master' },
            }
          : commandType === 'master.delete'
            ? {
                type: 'master.delete',
                masterId: master.id,
                replacementMasterId: replacementMaster.id,
              }
            : {
                type: 'layout.update',
                layoutId: layout.id,
                replacement: { ...layout, name: 'Updated layout' },
              };
      const lease = host.acquireTextLease({
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        sessionId: host.sessionId,
        documentId: host.documentId,
        clientId: CLIENT_A,
        slideId: slide.id,
        elementId: text.id,
      });
      const originalBinding = structuredClone(text.placeholderBinding);

      expectCollaborationError(
        () =>
          host.submit(
            createRequest(host, {
              clientId: CLIENT_B,
              clientRequestId: requestId(2_301),
              commands: [command],
            }),
          ),
        'TEXT_LEASE_HELD',
      );
      expect(host.getSnapshot().document.slides[0]!.elements[0]!.placeholderBinding).toEqual(
        originalBinding,
      );
      expect(
        host.submit(
          createRequest(host, {
            clientId: CLIENT_A,
            clientRequestId: requestId(2_302),
            commands: [command],
            lockTokens: { [text.id]: lease.token },
          }),
        ).sessionSeq,
      ).toBe(1);
    },
  );

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

    const { host: boundedTailHost } = createHost({ maxTailResyncBytes: 1 });
    const boundedInitialRevision = boundedTailHost.revision;
    const boundedElement = boundedTailHost.getSnapshot().document.slides[0]!.elements[0]!;
    boundedTailHost.submit(
      createRequest(boundedTailHost, {
        clientId: CLIENT_A,
        clientRequestId: requestId(54),
        commands: [
          transformCommand(boundedElement.id, {
            ...boundedElement.frame,
            xPt: boundedElement.frame.xPt + 1,
          }),
        ],
      }),
    );
    const bounded = boundedTailHost.getResync({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      sessionId: boundedTailHost.sessionId,
      documentId: boundedTailHost.documentId,
      afterSeq: 0,
      knownRevision: boundedInitialRevision,
    });
    expect(bounded.kind).toBe('snapshot');
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
