#!/usr/bin/env node

import process from 'node:process';

import { acquireReleaseLock, releaseReleaseLock } from './windows-release-pipeline-support.mjs';

const [mode, transactionParent] = process.argv.slice(2);
if (!['hold', 'try'].includes(mode) || !transactionParent) {
  process.stderr.write('Usage: release-lock-child.mjs <hold|try> <transaction-parent>\n');
  process.exit(64);
}

try {
  const releaseLock = await acquireReleaseLock({
    transactionParent,
    purpose: `multiprocess-test:${mode}`,
  });
  if (mode === 'try') {
    await releaseReleaseLock({ releaseLock });
    process.stdout.write('ACQUIRED\n');
  } else {
    process.stdout.write('LOCKED\n');
    process.stdout.write('');
    setInterval(() => {}, 10_000);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
