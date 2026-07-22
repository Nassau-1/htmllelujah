import { describe, expect, it, vi } from 'vitest';

import { BoundedShutdownAdmission, settleShutdownTasks } from '../src/main/bounded-shutdown.js';

describe('bounded process shutdown', () => {
  it('prevents every quit request while admitting final cleanup exactly once', () => {
    const admission = new BoundedShutdownAdmission();
    const firstEvent = { preventDefault: vi.fn() };
    const reentrantEvent = { preventDefault: vi.fn() };
    let cleanupStarts = 0;

    if (admission.intercept(firstEvent)) cleanupStarts += 1;
    if (admission.intercept(reentrantEvent)) cleanupStarts += 1;

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(reentrantEvent.preventDefault).toHaveBeenCalledOnce();
    expect(cleanupStarts).toBe(1);
  });

  it('settles successful tasks in declaration order and clears its deadline timer', async () => {
    vi.useFakeTimers();
    try {
      const report = await settleShutdownTasks(
        [
          { name: 'collaboration', run: async () => undefined },
          { name: 'mcp', run: async () => undefined },
        ],
        15_000,
      );

      expect(report).toEqual({
        ok: true,
        tasks: [
          { name: 'collaboration', status: 'fulfilled' },
          { name: 'mcp', status: 'fulfilled' },
        ],
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(Object.isFrozen(report)).toBe(true);
      expect(Object.isFrozen(report.tasks)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('contains synchronous and asynchronous rejections while preserving their reasons', async () => {
    const synchronous = new Error('sync close failed');
    const asynchronous = new Error('async close failed');
    const report = await settleShutdownTasks(
      [
        {
          name: 'collaboration',
          run: () => {
            throw synchronous;
          },
        },
        { name: 'mcp', run: async () => Promise.reject(asynchronous) },
      ],
      15_000,
    );

    expect(report.ok).toBe(false);
    expect(report.tasks).toEqual([
      { name: 'collaboration', status: 'rejected', reason: synchronous },
      { name: 'mcp', status: 'rejected', reason: asynchronous },
    ]);
  });

  it('marks a task that remains pending at the 15-second deadline as timed out', async () => {
    vi.useFakeTimers();
    try {
      const reportPromise = settleShutdownTasks(
        [{ name: 'collaboration', run: () => new Promise<void>(() => undefined) }],
        15_000,
      );
      await vi.advanceTimersByTimeAsync(14_999);
      let settled = false;
      void reportPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(reportPromise).resolves.toEqual({
        ok: false,
        tasks: [{ name: 'collaboration', status: 'timed-out' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a fast result while marking only the still-pending task timed out', async () => {
    vi.useFakeTimers();
    try {
      const reportPromise = settleShutdownTasks(
        [
          { name: 'collaboration', run: async () => undefined },
          { name: 'mcp', run: () => new Promise<void>(() => undefined) },
        ],
        15_000,
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(reportPromise).resolves.toEqual({
        ok: false,
        tasks: [
          { name: 'collaboration', status: 'fulfilled' },
          { name: 'mcp', status: 'timed-out' },
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes a late rejection after timeout without mutating the sealed report', async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (reason: unknown) => void;
      const reportPromise = settleShutdownTasks(
        [
          {
            name: 'mcp',
            run: () =>
              new Promise<void>((_resolve, reject) => {
                rejectLate = reject;
              }),
          },
        ],
        15_000,
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
      const report = await reportPromise;
      rejectLate(new Error('late close failure'));
      await Promise.resolve();

      expect(report).toEqual({
        ok: false,
        tasks: [{ name: 'mcp', status: 'timed-out' }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
