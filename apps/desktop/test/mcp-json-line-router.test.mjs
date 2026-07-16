import { describe, expect, it } from 'vitest';

import { createMcpResponseRouter } from '../scripts/mcp-json-line-router.mjs';

describe('MCP JSON-line response router', () => {
  it('assembles split lines and returns responses that arrive before their waiter', async () => {
    const router = createMcpResponseRouter();

    router.push(Buffer.from('{"jsonrpc":"2.0","id":7,'));
    router.push(Buffer.from('"result":{"ok":true}}\n'));

    await expect(router.waitForResponse(7)).resolves.toMatchObject({
      id: 7,
      result: { ok: true },
    });
  });

  it('preserves a multibyte UTF-8 character split across stdout chunks', async () => {
    const router = createMcpResponseRouter();
    const encoded = Buffer.from(
      `${JSON.stringify({ jsonrpc: '2.0', id: 70, result: { label: 'HTMLlelujah 🎉' } })}\n`,
      'utf8',
    );
    const emoji = Buffer.from('🎉', 'utf8');
    const emojiOffset = encoded.indexOf(emoji);

    router.push(encoded.subarray(0, emojiOffset + 2));
    router.push(encoded.subarray(emojiOffset + 2));

    await expect(router.waitForResponse(70)).resolves.toMatchObject({
      result: { label: 'HTMLlelujah 🎉' },
    });
  });

  it('captures malformed stdout without throwing from the data callback path', async () => {
    const router = createMcpResponseRouter();
    const pending = router.waitForResponse(8, 1_000);

    expect(() => router.push(Buffer.from('{not-json}\n'))).not.toThrow();
    await expect(pending).rejects.toThrow(/invalid JSON-line protocol data/u);
    await expect(router.waitForResponse(9)).rejects.toMatchObject({
      code: 'MCP_STDIO_FAILURE',
      message: expect.stringMatching(/invalid JSON-line protocol data/u),
    });
  });

  it('rejects every pending request when the child process reports a fatal error', async () => {
    const router = createMcpResponseRouter();
    const first = router.waitForResponse(10, 1_000);
    const second = router.waitForResponse(11, 1_000);

    router.fail(new Error('MCP child exited unexpectedly.'));

    await expect(first).rejects.toThrow('MCP child exited unexpectedly.');
    await expect(second).rejects.toThrow('MCP child exited unexpectedly.');
  });

  it('fails closed when stdout ends with an unterminated response', async () => {
    const router = createMcpResponseRouter();
    router.push(Buffer.from('{"jsonrpc":"2.0","id":12'));

    expect(() => router.finish()).not.toThrow();
    await expect(router.waitForResponse(12)).rejects.toThrow(/incomplete JSON-line message/u);
  });
});
