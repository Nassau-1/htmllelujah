import { generateTrustedClient } from '@htmllelujah/mcp-server';
import { describe, expect, it } from 'vitest';

import { summarizeTrustedMcpClients } from '../src/main/mcp-trusted-client-summary.js';

describe('renderer-safe MCP trusted client summaries', () => {
  it('exposes only persisted display metadata and derived connection/revocation state', () => {
    const bootstrap = generateTrustedClient({
      displayName: 'Local MCP agent',
      now: new Date('2026-07-23T10:00:00.000Z'),
    }).profile;
    const secondary = generateTrustedClient({
      displayName: 'Research agent',
      now: new Date('2026-07-23T10:05:00.000Z'),
    }).profile;
    const revoked = {
      ...generateTrustedClient({
        displayName: 'Old agent',
        now: new Date('2026-07-23T09:00:00.000Z'),
      }).profile,
      revokedAt: '2026-07-23T11:00:00.000Z',
    };

    const summaries = summarizeTrustedMcpClients(
      [bootstrap, secondary, revoked],
      bootstrap.clientId,
      [secondary.clientId, revoked.clientId],
    );

    expect(summaries).toEqual([
      {
        id: bootstrap.clientId,
        label: 'Local MCP agent',
        createdAt: '2026-07-23T10:00:00.000Z',
        status: 'active',
        connected: false,
        isBootstrap: true,
        revocable: false,
      },
      {
        id: secondary.clientId,
        label: 'Research agent',
        createdAt: '2026-07-23T10:05:00.000Z',
        status: 'active',
        connected: true,
        isBootstrap: false,
        revocable: true,
      },
      {
        id: revoked.clientId,
        label: 'Old agent',
        createdAt: '2026-07-23T09:00:00.000Z',
        revokedAt: '2026-07-23T11:00:00.000Z',
        status: 'revoked',
        connected: false,
        isBootstrap: false,
        revocable: false,
      },
    ]);
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).not.toContain('publicKeySpki');
      expect(Object.keys(summary).sort()).not.toContain('capabilities');
      expect(Object.keys(summary).sort()).not.toContain('lastUsedAt');
    }
  });
});
