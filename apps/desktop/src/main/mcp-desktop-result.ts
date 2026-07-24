import { McpSafeError } from '@htmllelujah/mcp-server';

import type { DesktopResult } from '../shared/desktop-api.js';

export const mcpSafeErrorToDesktopResult = (error: unknown): DesktopResult<never> | undefined => {
  if (!(error instanceof McpSafeError)) return undefined;
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      recoverable: error.code !== 'MCP_UNAUTHORIZED',
    },
  };
};
