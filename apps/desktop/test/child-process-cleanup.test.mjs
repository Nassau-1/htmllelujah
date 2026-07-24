import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';

import { describe, it } from 'vitest';

import { drainChildProcess } from '../scripts/child-process-cleanup.mjs';

const fakeStream = () => ({
  destroyed: false,
  destroy() {
    this.destroyed = true;
  },
});

const fakeChild = () => {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: fakeStream(),
    stderr: fakeStream(),
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  });
  return child;
};

describe('child process cleanup', () => {
  it('trusts an exact OS process-tree receipt and drains delayed Node handles', async () => {
    const child = fakeChild();
    let terminationOptions;

    const result = await drainChildProcess({
      child,
      label: 'Packaged editor',
      eventGraceMs: 1,
      terminateTree: async (options) => {
        terminationOptions = options;
        return { processIds: [4242, 4343] };
      },
    });

    assert.deepEqual(result, { processIds: [4242, 4343], alreadyExited: false });
    assert.deepEqual(terminationOptions, {
      pid: 4242,
      drainTimeoutMs: 90_000,
      pollIntervalMs: 100,
      rootKnownExited: false,
    });
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });

  it('fails closed when the OS process-tree authority rejects a survivor', async () => {
    const child = fakeChild();
    await assert.rejects(
      drainChildProcess({
        child,
        label: 'Packaged editor',
        eventGraceMs: 1,
        terminateTree: async () => {
          throw new Error('live PIDs: 4343');
        },
      }),
      (error) =>
        error.message === 'Packaged editor process tree could not be drained.' &&
        error.cause?.message === 'live PIDs: 4343',
    );
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });

  it('accepts a native close event without force-destroying already closed pipes', async () => {
    const child = fakeChild();
    let stdoutDestroyCalls = 0;
    child.stdout.destroy = () => {
      stdoutDestroyCalls += 1;
      child.stdout.destroyed = true;
    };

    const result = await drainChildProcess({
      child,
      label: 'Packaged editor',
      eventGraceMs: 100,
      terminateTree: async () => {
        setTimeout(() => {
          child.exitCode = 1;
          child.stdout.destroyed = true;
          child.stderr.destroyed = true;
          child.emit('close', 1, null);
        }, 1);
        return { processIds: [4242] };
      },
    });

    assert.deepEqual(result, { processIds: [4242], alreadyExited: false });
    assert.equal(stdoutDestroyCalls, 0);
    assert.equal(child.unrefCalled, true);
  });

  it('fails without targeting a PID after an unauthorised root exit', async () => {
    const child = fakeChild();
    child.exitCode = 0;
    let terminationInvoked = false;

    await assert.rejects(
      drainChildProcess({
        child,
        label: 'Packaged editor',
        eventGraceMs: 1,
        terminateTree: async () => {
          terminationInvoked = true;
          throw new Error('must not run');
        },
      }),
      /root exited before process-tree authority was captured; descendant cleanup is unverified/u,
    );

    assert.equal(terminationInvoked, false);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });

  it('fails closed when the root exits during initial authority discovery', async () => {
    const child = fakeChild();
    let terminationInvoked = false;

    await assert.rejects(
      drainChildProcess({
        child,
        label: 'Native dialog automation',
        eventGraceMs: 1,
        terminateTree: async () => {
          terminationInvoked = true;
          child.exitCode = 0;
          throw new Error('Windows process-tree root identity is unavailable.');
        },
      }),
      (error) =>
        error.message === 'Native dialog automation process tree could not be drained.' &&
        error.cause?.message === 'Windows process-tree root identity is unavailable.',
    );

    assert.equal(terminationInvoked, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });

  it('uses pre-captured authority to drain descendants after the root exits', async () => {
    const child = fakeChild();
    child.exitCode = 0;
    const rootAuthority = {
      processId: 4242,
      creationTime: '10000000',
      sessionId: 1,
      name: 'electron.exe',
    };
    const capturedDescendantAuthorities = [
      {
        processId: 4343,
        creationTime: '10000001',
        sessionId: 1,
        name: 'electron.exe',
      },
    ];
    let terminationOptions;

    const result = await drainChildProcess({
      child,
      label: 'Packaged editor',
      eventGraceMs: 1,
      rootAuthority,
      capturedDescendantAuthorities,
      terminateTree: async (options) => {
        terminationOptions = options;
        return { processIds: [4343], killerStatus: null };
      },
    });

    assert.deepEqual(terminationOptions, {
      pid: 4242,
      drainTimeoutMs: 90_000,
      pollIntervalMs: 100,
      rootKnownExited: true,
      rootAuthority,
      capturedDescendantAuthorities,
    });
    assert.deepEqual(result, {
      processIds: [4343],
      killerStatus: null,
      alreadyExited: true,
    });
  });

  it('releases handles even when the process-tree PID is invalid', async () => {
    const child = fakeChild();
    child.pid = undefined;

    await assert.rejects(
      drainChildProcess({ child, label: 'Packaged editor', eventGraceMs: 1 }),
      /Packaged editor has no valid process-tree root PID/u,
    );
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });

  it('aggregates process-tree authority and handle-release failures', async () => {
    const child = fakeChild();
    child.stdout.destroy = () => {
      throw new Error('stdout destroy failed');
    };

    await assert.rejects(
      drainChildProcess({
        child,
        label: 'Packaged editor',
        eventGraceMs: 1,
        terminateTree: async () => {
          throw new Error('live PIDs: 4343');
        },
      }),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0].message === 'Packaged editor process tree could not be drained.' &&
        error.errors[0].cause?.message === 'live PIDs: 4343' &&
        error.errors[1].message ===
          'Packaged editor child-process handles could not be released.' &&
        error.errors[1].cause?.message === 'stdout destroy failed',
    );
    assert.equal(child.stderr.destroyed, true);
    assert.equal(child.unrefCalled, true);
  });
});
