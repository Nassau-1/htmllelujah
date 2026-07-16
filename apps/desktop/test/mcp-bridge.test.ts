import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DocumentSessionManager } from '@htmllelujah/document-runtime';
import { MCP_LIMITS } from '@htmllelujah/mcp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopMcpBridge } from '../src/main/mcp-bridge.js';

describe('DesktopMcpBridge', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(
      cleanup
        .splice(0)
        .reverse()
        .map((operation) => operation()),
    );
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

    const renameProposal = await bridge.proposeCommands({
      documentId: source.documentId,
      expectedRevision: source.revision,
      label: 'Rename deck',
      commands: [{ type: 'deck.rename', name: 'Agent-renamed deck' }],
    });
    expect(renameProposal.requiresApproval).toBe(false);
    const renamed = await bridge.commitProposal({ proposalId: renameProposal.proposalId });
    expect(renamed).toMatchObject({
      documentId: source.documentId,
      previousRevision: source.revision,
      acceptedCommandCount: 1,
    });
    expect(runtime.getSnapshot(source.sessionId).document.name).toBe('Agent-renamed deck');
    expect(runtime.getAgentAudit(source.sessionId)).toEqual([
      expect.objectContaining({ actorId: 'mcp-local-agent', transactionId: renamed.transactionId }),
    ]);

    const beforeReplacement = runtime.getSnapshot(source.sessionId);
    const layout = beforeReplacement.document.layouts[0];
    if (layout === undefined) throw new Error('Missing default layout.');
    const replacementProposal = await bridge.proposeCommands({
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
    });
    expect(replacementProposal.requiresApproval).toBe(true);
    await expect(
      bridge.commitProposal({ proposalId: replacementProposal.proposalId }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(runtime.getSnapshot(source.sessionId).document.layouts[0]?.elements).toHaveLength(
      layout.elements.length,
    );

    const beforeThemeReplacement = runtime.getSnapshot(source.sessionId);
    const theme = beforeThemeReplacement.document.themes[0];
    if (theme === undefined) throw new Error('Missing default theme.');
    const themeProposal = await bridge.proposeCommands({
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
    });
    expect(themeProposal.requiresApproval).toBe(true);
    await expect(
      bridge.commitProposal({ proposalId: themeProposal.proposalId }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(runtime.getSnapshot(source.sessionId).document.themes[0]?.name).toBe(theme.name);

    const beforePage = runtime.getSnapshot(source.sessionId);
    const destructive = await bridge.proposeCommands({
      documentId: source.documentId,
      expectedRevision: beforePage.revision,
      label: 'Change page format',
      commands: [
        {
          type: 'deck.set-page',
          page: { widthPt: 900, heightPt: 600 },
        },
      ],
    });
    expect(destructive.requiresApproval).toBe(true);
    await expect(
      bridge.commitProposal({ proposalId: destructive.proposalId }),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const approval = bridge.issueApproval(source.documentId, 'commit-destructive');
    await expect(
      bridge.consumeApproval({
        approvalId: approval.approvalId,
        documentId: source.documentId,
        action: 'commit-destructive',
      }),
    ).resolves.toBe(true);
    await expect(
      bridge.commitProposal({
        proposalId: destructive.proposalId,
        approvalId: approval.approvalId,
      }),
    ).resolves.toMatchObject({ acceptedCommandCount: 1 });
    await expect(
      bridge.consumeApproval({
        approvalId: approval.approvalId,
        documentId: source.documentId,
        action: 'commit-destructive',
      }),
    ).resolves.toBe(false);

    const current = runtime.getSnapshot(source.sessionId);
    const exportApproval = bridge.issueApproval(source.documentId, 'export-pdf');
    await expect(
      bridge.consumeApproval({
        approvalId: exportApproval.approvalId,
        documentId: source.documentId,
        action: 'export-pdf',
      }),
    ).resolves.toBe(true);
    await expect(
      bridge.exportDocument({
        documentId: source.documentId,
        expectedRevision: current.revision,
        format: 'pdf',
        includeHidden: false,
        approvalId: exportApproval.approvalId,
      }),
    ).resolves.toMatchObject({ format: 'pdf', pageCount: 1 });
    expect(exportDocument).toHaveBeenCalledOnce();

    const staleApproval = bridge.issueApproval(source.documentId, 'import');
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
      bridge.consumeApproval({
        approvalId: staleApproval.approvalId,
        documentId: source.documentId,
        action: 'import',
      }),
    ).resolves.toBe(false);
    expect(importAsset).not.toHaveBeenCalled();

    now = new Date(now.getTime() + 3 * 60_000);
    expect(bridge.pendingApprovalCount()).toBe(0);
    collaborationMode = 'host';
    await expect(bridge.canRead(source.documentId)).resolves.toBe(true);
    await expect(bridge.canEdit(source.documentId)).resolves.toBe(false);
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
      bridge.proposeCommands({
        documentId: source.documentId,
        expectedRevision: source.revision,
        label: `Bounded proposal ${index}`,
        commands: [{ type: 'deck.rename', name: `Proposed ${index}` }],
      });
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
      bridge.commitProposal({ proposalId: afterExpiry.proposalId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const grants = Array.from({ length: MCP_LIMITS.maxPendingApprovals }, () =>
      bridge.issueApproval(source.documentId, 'import'),
    );
    expect(bridge.pendingApprovalCount()).toBe(MCP_LIMITS.maxPendingApprovals);
    expect(() => bridge.issueApproval(source.documentId, 'import')).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    await Promise.all(
      grants.map((grant) =>
        bridge.consumeApproval({
          approvalId: grant.approvalId,
          documentId: source.documentId,
          action: 'import',
        }),
      ),
    );
    const secondBatch = Array.from({ length: MCP_LIMITS.maxPendingApprovals }, () =>
      bridge.issueApproval(source.documentId, 'import'),
    );
    await Promise.all(
      secondBatch.map((grant) =>
        bridge.consumeApproval({
          approvalId: grant.approvalId,
          documentId: source.documentId,
          action: 'import',
        }),
      ),
    );
    const blockedByReceiptCap = bridge.issueApproval(source.documentId, 'import');
    await expect(
      bridge.consumeApproval({
        approvalId: blockedByReceiptCap.approvalId,
        documentId: source.documentId,
        action: 'import',
      }),
    ).resolves.toBe(false);

    now = new Date(now.getTime() + 30_001);
    await expect(
      bridge.consumeApproval({
        approvalId: blockedByReceiptCap.approvalId,
        documentId: source.documentId,
        action: 'import',
      }),
    ).resolves.toBe(true);
  });
});
