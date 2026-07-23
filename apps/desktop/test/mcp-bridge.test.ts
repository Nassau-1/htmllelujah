import { randomUUID } from 'node:crypto';
import { mkdtemp, rm as remove } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createDuplicateSlide } from '@htmllelujah/document-core';
import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { generateTrustedClient, MCP_LIMITS, trustedClientContext } from '@htmllelujah/mcp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopMcpBridge } from '../src/main/mcp-bridge.js';

const rm = (target: string, options: { readonly recursive: true; readonly force: true }) =>
  remove(target, { ...options, maxRetries: 5, retryDelay: 100 });

const trustedClient = trustedClientContext(
  generateTrustedClient({
    clientId: '10000000-0000-4000-8000-000000000010',
    displayName: 'Desktop bridge test client',
    now: new Date('2026-07-15T12:00:00.000Z'),
  }).profile,
);
const otherTrustedClient = trustedClientContext(
  generateTrustedClient({
    clientId: '10000000-0000-4000-8000-000000000011',
    displayName: 'Other desktop bridge client',
    now: new Date('2026-07-15T12:00:00.000Z'),
  }).profile,
);

describe('DesktopMcpBridge', () => {
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
    if (errors.length > 0) throw new AggregateError(errors, 'MCP bridge test cleanup failed.');
  });

  it('exposes visible decks, commits attributable proposals, and enforces one-time approvals', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-mcp-'));
    let now = new Date('2026-07-15T12:00:00.000Z');
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
      now: () => now.toISOString(),
    });
    const source = await runtime.createMainOnly();
    let collaborationMode: 'offline' | 'host' | 'guest' = 'offline';
    const importAsset = vi.fn(async () => ({ assetId: 'approved-asset' }));
    const exportDocument = vi.fn(async (_sessionId, input: { readonly format: string }) => ({
      format: input.format,
      pageCount: 1,
    }));
    const bridge = new DesktopMcpBridge({
      runtime,
      appVersion: () => '1.0.0',
      visibleSessionIds: () => [source.sessionId],
      collaborationStatus: () => ({
        mode: collaborationMode,
        connectedPeers: collaborationMode === 'offline' ? 0 : 1,
        discoveryEnabled: false,
      }),
      importAsset,
      exportDocument,
      now: () => now,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(async () => {
      await Promise.all(
        runtime
          .listSessions()
          .map((session) => runtime.close(session.sessionId, { discardUnsaved: true })),
      );
    });

    await expect(bridge.appStatus()).resolves.toMatchObject({
      running: true,
      version: '1.0.0',
      visibleDocuments: 1,
    });
    await expect(bridge.listOpenDocuments()).resolves.toEqual([
      expect.objectContaining({
        documentId: source.documentId,
        revision: source.revision,
        name: source.document.name,
      }),
    ]);
    await expect(bridge.getDocumentOutline(source.documentId)).resolves.toMatchObject({
      documentId: source.documentId,
      slides: expect.any(Array),
    });
    await expect(
      bridge.getDesignContext({
        documentId: source.documentId,
        elementScope: 'selected-projection',
        elementOffset: 0,
        elementLimit: 250,
        assetOffset: 0,
        assetLimit: 100,
      }),
    ).resolves.toMatchObject({
      documentId: source.documentId,
      revision: source.revision,
      inheritance: {
        themeId: source.document.themes[0]?.id,
        masterId: source.document.masters[0]?.id,
        layoutId: source.document.layouts[0]?.id,
        slideId: source.document.slides[0]?.id,
      },
      constraints: {
        proposal: {
          expectedRevisionRequired: true,
          arbitraryMarkupAccepted: false,
          arbitraryUrlsAccepted: false,
          arbitraryFilesystemPathsAccepted: false,
        },
      },
      validation: { valid: true, issueCount: 0 },
    });

    const renameProposal = await bridge.proposeCommands(
      {
        documentId: source.documentId,
        expectedRevision: source.revision,
        label: 'Rename deck',
        commands: [{ type: 'deck.rename', name: 'Agent-renamed deck' }],
      },
      trustedClient,
    );
    expect(renameProposal.requiresApproval).toBe(false);
    await expect(
      bridge.commitProposal({ proposalId: renameProposal.proposalId }, otherTrustedClient),
    ).rejects.toMatchObject({ code: 'MCP_UNAUTHORIZED' });
    const renamed = await bridge.commitProposal(
      { proposalId: renameProposal.proposalId },
      trustedClient,
    );
    expect(renamed).toMatchObject({
      documentId: source.documentId,
      previousRevision: source.revision,
      acceptedCommandCount: 1,
    });
    expect(runtime.getSnapshot(source.sessionId).document.name).toBe('Agent-renamed deck');
    expect(runtime.getAgentAudit(source.sessionId)).toEqual([
      expect.objectContaining({
        actorId: trustedClient.actorId,
        transactionId: renamed.transactionId,
      }),
    ]);

    const beforeDesignEdit = runtime.getSnapshot(source.sessionId);
    const designTheme = beforeDesignEdit.document.themes[0];
    if (designTheme === undefined) throw new Error('Missing default design theme.');
    const designProposal = await bridge.proposeDesignOperations(
      {
        documentId: source.documentId,
        expectedRevision: beforeDesignEdit.revision,
        label: 'Update semantic accent',
        operations: [
          {
            type: 'theme.update',
            themeId: designTheme.id,
            patch: { colors: { accent: '#123456' } },
          },
        ],
      },
      trustedClient,
    );
    expect(designProposal.requiresApproval).toBe(false);
    await expect(
      bridge.commitProposal({ proposalId: designProposal.proposalId }, trustedClient),
    ).resolves.toMatchObject({ acceptedCommandCount: 1 });
    expect(runtime.getSnapshot(source.sessionId).document.themes[0]?.colors.accent).toBe('#123456');

    const beforeReplacement = runtime.getSnapshot(source.sessionId);
    const layout = beforeReplacement.document.layouts[0];
    if (layout === undefined) throw new Error('Missing default layout.');
    const replacementProposal = await bridge.proposeCommands(
      {
        documentId: source.documentId,
        expectedRevision: beforeReplacement.revision,
        label: 'Submit complete layout replacement',
        commands: [
          {
            type: 'layout.update',
            layoutId: layout.id,
            replacement: layout,
          },
        ],
      },
      trustedClient,
    );
    expect(replacementProposal.requiresApproval).toBe(false);
    expect(runtime.getSnapshot(source.sessionId).document.layouts[0]?.elements).toHaveLength(
      layout.elements.length,
    );

    const beforeThemeReplacement = runtime.getSnapshot(source.sessionId);
    const theme = beforeThemeReplacement.document.themes[0];
    if (theme === undefined) throw new Error('Missing default theme.');
    const themeProposal = await bridge.proposeCommands(
      {
        documentId: source.documentId,
        expectedRevision: beforeThemeReplacement.revision,
        label: 'Submit complete theme replacement',
        commands: [
          {
            type: 'theme.update',
            themeId: theme.id,
            replacement: { ...theme, name: 'Agent replacement theme' },
          },
        ],
      },
      trustedClient,
    );
    expect(themeProposal.requiresApproval).toBe(false);
    await expect(
      bridge.commitProposal({ proposalId: themeProposal.proposalId }, trustedClient),
    ).resolves.toMatchObject({ acceptedCommandCount: 1 });
    expect(runtime.getSnapshot(source.sessionId).document.themes[0]?.name).toBe(
      'Agent replacement theme',
    );

    const beforePage = runtime.getSnapshot(source.sessionId);
    const destructive = await bridge.proposeDesignOperations(
      {
        documentId: source.documentId,
        expectedRevision: beforePage.revision,
        label: 'Change page format',
        operations: [{ type: 'page.set', page: { widthPt: 900, heightPt: 600 } }],
      },
      trustedClient,
    );
    expect(destructive.requiresApproval).toBe(true);
    await expect(
      bridge.commitProposal({ proposalId: destructive.proposalId }, trustedClient),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const approval = bridge.issueApproval(
      source.documentId,
      'commit-destructive',
      trustedClient.clientId,
    );
    await expect(
      bridge.consumeApproval(
        {
          approvalId: approval.approvalId,
          documentId: source.documentId,
          action: 'commit-destructive',
        },
        otherTrustedClient,
      ),
    ).resolves.toBe(false);
    await expect(
      bridge.consumeApproval(
        {
          approvalId: approval.approvalId,
          documentId: source.documentId,
          action: 'commit-destructive',
        },
        trustedClient,
      ),
    ).resolves.toBe(true);
    await expect(
      bridge.commitProposal(
        {
          proposalId: destructive.proposalId,
          approvalId: approval.approvalId,
        },
        trustedClient,
      ),
    ).resolves.toMatchObject({ acceptedCommandCount: 1 });
    await expect(
      bridge.consumeApproval(
        {
          approvalId: approval.approvalId,
          documentId: source.documentId,
          action: 'commit-destructive',
        },
        trustedClient,
      ),
    ).resolves.toBe(false);

    const current = runtime.getSnapshot(source.sessionId);
    const exportApproval = bridge.issueApproval(
      source.documentId,
      'export-pdf',
      trustedClient.clientId,
    );
    await expect(
      bridge.consumeApproval(
        {
          approvalId: exportApproval.approvalId,
          documentId: source.documentId,
          action: 'export-pdf',
        },
        trustedClient,
      ),
    ).resolves.toBe(true);
    await expect(
      bridge.exportDocument(
        {
          documentId: source.documentId,
          expectedRevision: current.revision,
          format: 'pdf',
          includeHidden: false,
          approvalId: exportApproval.approvalId,
        },
        trustedClient,
      ),
    ).resolves.toMatchObject({ format: 'pdf', pageCount: 1 });
    expect(exportDocument).toHaveBeenCalledOnce();

    const staleApproval = bridge.issueApproval(source.documentId, 'import', trustedClient.clientId);
    await runtime.execute(source.sessionId, {
      expectedRevision: runtime.getSnapshot(source.sessionId).revision,
      commands: [{ type: 'deck.rename', name: 'Human changed it' }],
      metadata: {
        transactionId: 'a0000000-0000-4000-8000-000000000001',
        actorId: 'desktop-test',
        origin: 'user',
        label: 'Human rename',
        timestamp: now.toISOString(),
      },
    });
    await expect(
      bridge.consumeApproval(
        {
          approvalId: staleApproval.approvalId,
          documentId: source.documentId,
          action: 'import',
        },
        trustedClient,
      ),
    ).resolves.toBe(false);
    expect(importAsset).not.toHaveBeenCalled();

    now = new Date(now.getTime() + 3 * 60_000);
    expect(bridge.pendingApprovalCount()).toBe(0);
    collaborationMode = 'host';
    await expect(bridge.canRead(source.documentId, trustedClient)).resolves.toBe(true);
    await expect(bridge.canEdit(source.documentId, trustedClient)).resolves.toBe(false);
  });

  it('maps atomic command rejections safely without mutating or disabling the bridge', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-mcp-atomic-'));
    const now = new Date('2026-07-15T12:00:00.000Z');
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
      now: () => now.toISOString(),
    });
    const source = await runtime.createMainOnly();
    const bridge = new DesktopMcpBridge({
      runtime,
      appVersion: () => '1.0.0',
      visibleSessionIds: () => [source.sessionId],
      collaborationStatus: () => ({
        mode: 'offline',
        connectedPeers: 0,
        discoveryEnabled: false,
      }),
      importAsset: vi.fn(async () => ({ assetId: 'approved-asset' })),
      exportDocument: vi.fn(async () => ({ format: 'pdf', pageCount: 1 })),
      now: () => now,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(async () => {
      await Promise.all(
        runtime
          .listSessions()
          .map((session) => runtime.close(session.sessionId, { discardUnsaved: true })),
      );
    });

    const rejectMissingSlide = (expectedRevision: string) =>
      bridge.proposeCommands(
        {
          documentId: source.documentId,
          expectedRevision,
          label: 'Reject an atomic mixed batch',
          commands: [
            { type: 'deck.rename', name: 'This rename must not apply' },
            {
              type: 'slide.delete',
              slideId: '00000000-0000-4000-8000-000000000099',
            },
          ],
        },
        trustedClient,
      );

    const oneSlideBefore = runtime.getSnapshot(source.sessionId);
    await expect(rejectMissingSlide(oneSlideBefore.revision)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'The document operation could not be completed.',
    });
    expect(runtime.getSnapshot(source.sessionId)).toEqual(oneSlideBefore);
    expect(runtime.getAgentAudit(source.sessionId)).toEqual([]);

    const originalSlide = oneSlideBefore.document.slides[0];
    if (originalSlide === undefined) throw new Error('Missing default slide.');
    const duplicate = createDuplicateSlide(oneSlideBefore.document, originalSlide.id, randomUUID);
    const twoSlides = await runtime.execute(source.sessionId, {
      expectedRevision: oneSlideBefore.revision,
      commands: [{ type: 'slide.duplicate', slideId: originalSlide.id, duplicate }],
      metadata: {
        transactionId: randomUUID(),
        actorId: 'desktop-test',
        origin: 'user',
        label: 'Create a second slide',
        timestamp: now.toISOString(),
      },
    });
    const twoSlidesBefore = runtime.getSnapshot(source.sessionId);
    expect(twoSlidesBefore.revision).toBe(twoSlides.revision);
    await expect(rejectMissingSlide(twoSlidesBefore.revision)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'The document operation could not be completed.',
    });
    expect(runtime.getSnapshot(source.sessionId)).toEqual(twoSlidesBefore);
    expect(runtime.getAgentAudit(source.sessionId)).toEqual([]);

    const recoveryProposal = await bridge.proposeCommands(
      {
        documentId: source.documentId,
        expectedRevision: twoSlidesBefore.revision,
        label: 'Prove the bridge remains available',
        commands: [{ type: 'deck.rename', name: 'Bridge recovered safely' }],
      },
      trustedClient,
    );
    await expect(
      bridge.commitProposal({ proposalId: recoveryProposal.proposalId }, trustedClient),
    ).resolves.toMatchObject({
      previousRevision: twoSlidesBefore.revision,
      acceptedCommandCount: 1,
    });
    expect(runtime.getSnapshot(source.sessionId).document.name).toBe('Bridge recovered safely');
  });

  it('purges expired proposals and fails closed at proposal, approval, and receipt caps', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'htmllelujah-desktop-mcp-limits-'));
    let now = new Date('2026-07-16T12:00:00.000Z');
    const runtime = new DocumentSessionManager({
      recoveryDirectory: path.join(directory, 'recovery'),
      autosaveDelayMs: 0,
      defaultProposalTtlMs: 1_000,
      now: () => now.toISOString(),
    });
    const source = await runtime.createMainOnly();
    const bridge = new DesktopMcpBridge({
      runtime,
      appVersion: () => '1.0.0',
      visibleSessionIds: () => [source.sessionId],
      collaborationStatus: () => ({
        mode: 'offline',
        connectedPeers: 0,
        discoveryEnabled: false,
      }),
      importAsset: vi.fn(async () => ({ assetId: 'approved-asset' })),
      exportDocument: vi.fn(async () => ({ format: 'pdf', pageCount: 1 })),
      now: () => now,
    });
    cleanup.push(async () => rm(directory, { recursive: true, force: true }));
    cleanup.push(async () => {
      await Promise.all(
        runtime
          .listSessions()
          .map((session) => runtime.close(session.sessionId, { discardUnsaved: true })),
      );
    });

    const propose = (index: number) =>
      bridge.proposeCommands(
        {
          documentId: source.documentId,
          expectedRevision: source.revision,
          label: `Bounded proposal ${index}`,
          commands: [{ type: 'deck.rename', name: `Proposed ${index}` }],
        },
        trustedClient,
      );
    await Promise.all(
      Array.from({ length: MCP_LIMITS.maxPendingProposals }, (_, index) => propose(index)),
    );
    await expect(propose(MCP_LIMITS.maxPendingProposals)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });

    now = new Date(now.getTime() + 1_001);
    const afterExpiry = await propose(MCP_LIMITS.maxPendingProposals + 1);
    expect(afterExpiry.proposalId).toEqual(expect.any(String));
    now = new Date(now.getTime() + 1_001);
    await expect(
      bridge.commitProposal({ proposalId: afterExpiry.proposalId }, trustedClient),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const grants = Array.from({ length: MCP_LIMITS.maxPendingApprovals }, () =>
      bridge.issueApproval(source.documentId, 'import', trustedClient.clientId),
    );
    expect(bridge.pendingApprovalCount()).toBe(MCP_LIMITS.maxPendingApprovals);
    expect(() =>
      bridge.issueApproval(source.documentId, 'import', trustedClient.clientId),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    await Promise.all(
      grants.map((grant) =>
        bridge.consumeApproval(
          {
            approvalId: grant.approvalId,
            documentId: source.documentId,
            action: 'import',
          },
          trustedClient,
        ),
      ),
    );
    const secondBatch = Array.from({ length: MCP_LIMITS.maxPendingApprovals }, () =>
      bridge.issueApproval(source.documentId, 'import', trustedClient.clientId),
    );
    await Promise.all(
      secondBatch.map((grant) =>
        bridge.consumeApproval(
          {
            approvalId: grant.approvalId,
            documentId: source.documentId,
            action: 'import',
          },
          trustedClient,
        ),
      ),
    );
    const blockedByReceiptCap = bridge.issueApproval(
      source.documentId,
      'import',
      trustedClient.clientId,
    );
    await expect(
      bridge.consumeApproval(
        {
          approvalId: blockedByReceiptCap.approvalId,
          documentId: source.documentId,
          action: 'import',
        },
        trustedClient,
      ),
    ).resolves.toBe(false);

    now = new Date(now.getTime() + 30_001);
    await expect(
      bridge.consumeApproval(
        {
          approvalId: blockedByReceiptCap.approvalId,
          documentId: source.documentId,
          action: 'import',
        },
        trustedClient,
      ),
    ).resolves.toBe(true);
  });
});
