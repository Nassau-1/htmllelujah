import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { runWithCleanup } from '../scripts/operation-cleanup.mjs';

describe('operation cleanup outcome preservation', () => {
  it('returns both the operation result and cleanup receipt', async () => {
    await assert.doesNotReject(async () => {
      const result = await runWithCleanup({
        operation: async () => 'captured',
        cleanup: async () => ({ processIds: [123] }),
        label: 'PDF visual capture',
      });
      assert.deepEqual(result, {
        value: 'captured',
        cleanupReceipt: { processIds: [123] },
      });
    });
  });

  it('preserves the primary error when cleanup succeeds', async () => {
    const primary = new Error('capture failed');
    await assert.rejects(
      runWithCleanup({
        operation: async () => {
          throw primary;
        },
        cleanup: async () => ({ processIds: [] }),
      }),
      (error) => error === primary,
    );
  });

  it('aggregates primary and cleanup errors in causal order', async () => {
    const primary = new Error('capture failed');
    const cleanup = new Error('browser survived');
    await assert.rejects(
      runWithCleanup({
        operation: async () => {
          throw primary;
        },
        cleanup: async () => {
          throw cleanup;
        },
        label: 'PDF visual capture',
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, 'PDF visual capture and its cleanup both failed.');
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      },
    );
  });
});
