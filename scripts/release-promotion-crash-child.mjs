#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { open } from 'node:fs/promises';

import {
  acquireReleaseLock,
  promoteDirectoriesAtomically,
} from './windows-release-pipeline-support.mjs';

const [transactionRoot, source, destination, crashCheckpoint, reachedMarker] =
  process.argv.slice(2);
if (!transactionRoot || !source || !destination || !crashCheckpoint || !reachedMarker) {
  process.stderr.write(
    'Usage: release-promotion-crash-child.mjs <transaction> <source> <destination> <checkpoint> <marker>\n',
  );
  process.exit(64);
}

const releaseLock = await acquireReleaseLock({
  transactionParent: path.dirname(path.resolve(transactionRoot)),
  purpose: `crash-test:${crashCheckpoint}`,
});
await promoteDirectoriesAtomically({
  promotions: [{ source, destination }],
  transactionRoot,
  releaseLock,
  rollbackOnError: false,
  checkpoint: async (checkpoint) => {
    if (checkpoint === crashCheckpoint) {
      const marker = await open(reachedMarker, 'wx');
      await marker.writeFile(`${checkpoint}\n`, 'utf8');
      await marker.sync();
      await marker.close();
      process.kill(process.pid, 'SIGKILL');
    }
  },
});
process.stderr.write(`Crash checkpoint was not reached: ${crashCheckpoint}.\n`);
process.exit(65);
