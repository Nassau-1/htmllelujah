import type { TrustedClientProfile } from '@htmllelujah/mcp-server';

import type { McpTrustedClientSummary } from '../shared/desktop-api.js';

/**
 * Projects the private trust registry into the exact renderer-safe surface.
 * Public keys, capabilities, credentials, paths, and transport secrets are
 * deliberately absent.
 */
export const summarizeTrustedMcpClients = (
  profiles: readonly TrustedClientProfile[],
  bootstrapClientId: string,
  connectedClientIds: readonly string[],
): readonly McpTrustedClientSummary[] => {
  const connected = new Set(connectedClientIds);
  return profiles.map((profile) => {
    const isBootstrap = profile.clientId === bootstrapClientId;
    const active = profile.revokedAt === undefined;
    return {
      id: profile.clientId,
      label: profile.displayName,
      createdAt: profile.createdAt,
      ...(profile.revokedAt === undefined ? {} : { revokedAt: profile.revokedAt }),
      status: active ? 'active' : 'revoked',
      connected: active && connected.has(profile.clientId),
      isBootstrap,
      revocable: active && !isBootstrap,
    };
  });
};
