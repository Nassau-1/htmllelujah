import { terminateProcessTree } from '../../../scripts/process-tree-support.mjs';

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

export const waitForChildClose = (child, timeoutMs) => {
  const streamsClosed = [child.stdin, child.stdout, child.stderr].every(
    (stream) => stream === null || stream === undefined || stream.destroyed === true,
  );
  if (hasExited(child) && streamsClosed) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
};

const destroyChildStreams = (child) => {
  const errors = [];
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (stream === null || stream === undefined || stream.destroyed === true) continue;
    try {
      stream.destroy();
      if (stream.destroyed !== true) {
        throw new Error('A terminated child-process stream did not enter the destroyed state.');
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Terminated child-process streams could not be destroyed.');
  }
};

const releaseChildHandles = async (child, eventGraceMs) => {
  await waitForChildClose(child, eventGraceMs);
  const errors = [];
  try {
    destroyChildStreams(child);
  } catch (error) {
    errors.push(error);
  }
  try {
    child.unref();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Child-process handles could not be released.');
  }
};

export const drainChildProcess = async ({
  child,
  label = 'Child process',
  terminateTree = terminateProcessTree,
  processDrainTimeoutMs = 90_000,
  eventGraceMs = 3_000,
}) => {
  const alreadyExited = hasExited(child);
  let result;
  let authorityError;
  let handleError;
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
      throw new Error(`${label} has no valid process-tree root PID.`);
    }
    try {
      result = await terminateTree({
        pid: child.pid,
        drainTimeoutMs: processDrainTimeoutMs,
        pollIntervalMs: 100,
        rootKnownExited: alreadyExited,
      });
    } catch (error) {
      throw new Error(`${label} process tree could not be drained.`, { cause: error });
    }
  } catch (error) {
    authorityError = error;
  } finally {
    try {
      await releaseChildHandles(child, eventGraceMs);
    } catch (error) {
      handleError = new Error(`${label} child-process handles could not be released.`, {
        cause: error,
      });
    }
  }

  if (authorityError !== undefined && handleError !== undefined) {
    throw new AggregateError(
      [authorityError, handleError],
      `${label} process-tree authority and handle cleanup both failed.`,
    );
  }
  if (authorityError !== undefined) throw authorityError;
  if (handleError !== undefined) throw handleError;
  return { ...result, alreadyExited };
};
