import { McpSafeError } from '@htmllelujah/mcp-server';
import { describe, expect, it } from 'vitest';

import { mcpSafeErrorToDesktopResult } from '../src/main/mcp-desktop-result.js';

describe('mcpSafeErrorToDesktopResult', () => {
  it('preserves the bounded MCP error while classifying authorization as terminal', () => {
    expect(
      mcpSafeErrorToDesktopResult(
        new McpSafeError('MCP_UNAUTHORIZED', 'The trusted client is not authorized.'),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'MCP_UNAUTHORIZED',
        message: 'The trusted client is not authorized.',
        recoverable: false,
      },
    });

    expect(
      mcpSafeErrorToDesktopResult(
        new McpSafeError('REVISION_CONFLICT', 'The presentation changed.'),
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'REVISION_CONFLICT',
        message: 'The presentation changed.',
        recoverable: true,
      },
    });
  });

  it('does not reinterpret unrelated failures', () => {
    expect(mcpSafeErrorToDesktopResult(new Error('unrelated'))).toBeUndefined();
  });
});
