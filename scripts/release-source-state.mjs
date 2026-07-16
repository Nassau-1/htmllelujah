import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.smoke',
  'artifacts',
  'coverage',
  'node_modules',
  'out',
]);

const gitEnvironmentValues = (environment, requestedKey) => {
  const normalizedKey = requestedKey.toUpperCase();
  return Object.entries(environment)
    .filter(([key]) => key.toUpperCase() === normalizedKey)
    .map(([, value]) => value);
};

const createGitInspectionEnvironment = (source = process.env) => {
  const environment = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey.startsWith('GIT_')) continue;
    environment[key] = value;
  }
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
};

const normalizePath = (value) => value.split(path.sep).join('/');

const exists = async (value) => {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
};

const repositoryRelative = (repositoryRoot, value) => {
  const relative = path.relative(repositoryRoot, value);
  return relative.startsWith('..') ? path.basename(value) : normalizePath(relative);
};

export const latestReleaseInput = async (repositoryRoot) => {
  const roots = [
    path.join(repositoryRoot, 'apps', 'desktop', 'src'),
    path.join(repositoryRoot, 'apps', 'desktop', 'assets'),
    path.join(repositoryRoot, 'apps', 'desktop', 'dist'),
    path.join(repositoryRoot, 'apps', 'desktop', 'dist-electron'),
    path.join(repositoryRoot, 'packages'),
  ];
  const standalone = [
    path.join(repositoryRoot, 'package.json'),
    path.join(repositoryRoot, 'pnpm-lock.yaml'),
    path.join(repositoryRoot, 'pnpm-workspace.yaml'),
    path.join(repositoryRoot, 'LICENSE'),
    path.join(repositoryRoot, 'EULA.txt'),
    path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'),
    path.join(repositoryRoot, 'apps', 'desktop', 'index.html'),
    path.join(repositoryRoot, 'apps', 'desktop', 'package.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'tsconfig.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'tsconfig.node.json'),
    path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'apply-fuses.mjs'),
    path.join(repositoryRoot, 'apps', 'desktop', 'scripts', 'installer-association.nsh'),
    path.join(repositoryRoot, 'apps', 'desktop', 'vite.config.ts'),
  ];
  let newest = { mtimeMs: 0, path: null };

  const consider = async (filePath) => {
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > newest.mtimeMs) {
      newest = {
        mtimeMs: fileStat.mtimeMs,
        path: repositoryRelative(repositoryRoot, filePath),
      };
    }
  };

  const visit = async (directory) => {
    if (!(await exists(directory))) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SOURCE_EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) await consider(fullPath);
    }
  };

  for (const root of roots) await visit(root);
  for (const filePath of standalone) if (await exists(filePath)) await consider(filePath);
  if (newest.path === null) throw new Error('No release source input was found.');
  return newest;
};

export const artifactFreshness = async ({ artifactDir, inventory, installers, repositoryRoot }) => {
  const latestSource = await latestReleaseInput(repositoryRoot);
  const preferredReferences =
    installers.length > 0
      ? installers
      : inventory.filter((entry) =>
          /(?:^|\/)win-unpacked\/resources\/app\.asar$/iu.test(entry.path),
        );
  const artifactReferences =
    preferredReferences.length > 0
      ? preferredReferences
      : inventory.filter((entry) => /(?:^|\/)win-unpacked\/[^/]+\.exe$/iu.test(entry.path));
  if (artifactReferences.length === 0) {
    throw new Error(
      'No installer, packaged app.asar, or unpacked executable freshness reference found.',
    );
  }
  let latestArtifact = { mtimeMs: 0, path: null };
  for (const entry of artifactReferences) {
    const filePath = path.join(artifactDir, ...entry.path.split('/'));
    const fileStat = await stat(filePath);
    if (fileStat.mtimeMs > latestArtifact.mtimeMs) {
      latestArtifact = { mtimeMs: fileStat.mtimeMs, path: entry.path };
    }
  }
  const stale = latestSource.mtimeMs > latestArtifact.mtimeMs + 1_000;
  return {
    stale,
    latestArtifact: {
      path: latestArtifact.path,
      modifiedAt: new Date(latestArtifact.mtimeMs).toISOString(),
    },
    latestSourceInput: {
      path: latestSource.path,
      modifiedAt: new Date(latestSource.mtimeMs).toISOString(),
    },
    reason: stale
      ? 'At least one release input is newer than the newest packaged artifact file.'
      : 'No release input inspected by this tool is newer than the packaged artifact.',
  };
};

const runGitProcess = (
  repositoryRoot,
  arguments_,
  allowedStatuses = [0],
  { input = undefined } = {},
) => {
  const result = spawnSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: null,
    env: createGitInspectionEnvironment(process.env),
    input,
    timeout: 15_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal || !allowedStatuses.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim();
    throw new Error(
      `Git command failed closed (git ${arguments_.join(' ')}): ${stderr || result.error?.message || `exit ${result.status ?? 'unknown'}`}`,
    );
  }
  return result;
};

export const runGitText = (repositoryRoot, arguments_, allowedStatuses = [0]) =>
  runGitProcess(repositoryRoot, arguments_, allowedStatuses).stdout.toString('utf8').trim();

const decodeStrictUtf8 = (value, label) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
};

const replacementNamespace = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('The custom Git replacement namespace is invalid.');
  }
  if (!value.startsWith('refs/') || !value.endsWith('/') || value.length <= 'refs/'.length) {
    throw new Error('The custom Git replacement namespace is invalid.');
  }
  return value;
};

const exactGitPath = (repositoryRoot, arguments_) => {
  const output = runGitProcess(repositoryRoot, arguments_).stdout;
  const decoded = decodeStrictUtf8(output, 'Git path output');
  const value = decoded.endsWith('\n') ? decoded.slice(0, -1) : decoded;
  if (value.length === 0 || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error('Git returned an ambiguous repository metadata path.');
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(repositoryRoot, value);
};

export const assertNoGitObjectSubstitution = (
  repositoryRoot,
  { environment = process.env } = {},
) => {
  const customNamespaces = new Set();
  const customBases = gitEnvironmentValues(environment, 'GIT_REPLACE_REF_BASE');
  for (const customBase of customBases) {
    const namespace = replacementNamespace(customBase);
    const formatCheck = runGitProcess(
      repositoryRoot,
      ['check-ref-format', `${namespace}${'0'.repeat(40)}`],
      [0, 1],
    );
    if (formatCheck.status !== 0) {
      throw new Error('The custom Git replacement namespace is invalid.');
    }
    customNamespaces.add(namespace);
  }

  const refsOutput = runGitProcess(repositoryRoot, ['for-each-ref', '--format=%(refname)']).stdout;
  const refsText = decodeStrictUtf8(refsOutput, 'Git ref inventory');
  if (refsText.includes('\0') || refsText.includes('\r')) {
    throw new Error('Git returned a malformed ref inventory.');
  }
  const refs = refsText.length === 0 ? [] : refsText.split('\n');
  if (refs.at(-1) === '') refs.pop();
  if (refs.some((ref) => ref.length === 0 || ref.includes('\n'))) {
    throw new Error('Git returned a malformed ref inventory.');
  }
  const isReplacementRef = (ref) => {
    if (ref.startsWith('refs/replace/')) return true;
    return [...customNamespaces].some((namespace) => {
      if (!ref.startsWith(namespace)) return false;
      return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ref.slice(namespace.length));
    });
  };
  if (refs.some(isReplacementRef)) {
    throw new Error('Git replacement refs are forbidden for release source provenance.');
  }

  const graftsPath = exactGitPath(repositoryRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'info/grafts',
  ]);
  let graftsMetadata = null;
  try {
    graftsMetadata = lstatSync(graftsPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  if (graftsMetadata !== null) {
    throw new Error('Git info/grafts is forbidden for release source provenance.');
  }
};

export const gitSourceState = (repositoryRoot, runner = runGitProcess) => {
  if (runner === runGitProcess) assertNoGitObjectSubstitution(repositoryRoot);
  const runText = (arguments_, allowedStatuses = [0]) =>
    runner(repositoryRoot, arguments_, allowedStatuses).stdout.toString('utf8').trim();
  const hasChanges = (arguments_) => runner(repositoryRoot, arguments_, [0, 1]).status === 1;
  if (runText(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error('The release source is not a Git worktree.');
  }
  const commit = runText(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40,64}$/u.test(commit)) {
    throw new Error('Git HEAD did not resolve to an exact commit.');
  }
  const staged = hasChanges(['diff', '--cached', '--quiet', '--no-ext-diff', 'HEAD', '--']);
  const unstaged = hasChanges(['diff-files', '--quiet', '--no-ext-diff', '--']);
  const untrackedOutput = runner(repositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]).stdout;
  const untracked = untrackedOutput.length > 0;
  const statusOutput = runner(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]).stdout;
  const dirty = staged || unstaged || untracked;
  const statusDirty = statusOutput.length > 0;
  if (statusDirty !== dirty) {
    throw new Error('Git cleanliness checks disagreed; refusing an ambiguous source state.');
  }
  let branch = null;
  const branchResult = runner(repositoryRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], [0, 1]);
  if (branchResult.status === 0) branch = branchResult.stdout.toString('utf8').trim() || null;
  const exactTagResult = runner(
    repositoryRoot,
    ['describe', '--tags', '--exact-match', 'HEAD'],
    [0, 128],
  );
  const exactTag =
    exactTagResult.status === 0 ? exactTagResult.stdout.toString('utf8').trim() || null : null;
  return {
    commit,
    branch,
    exactTag,
    dirty,
    staged,
    unstaged,
    untracked,
  };
};

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(digest.digest('hex')));
  });

const decodeGitPath = (value) => {
  const decoded = decodeStrictUtf8(value, 'Tracked Git index path');
  const segments = decoded.split('/');
  if (
    decoded.length === 0 ||
    decoded.includes('\\') ||
    /^[A-Za-z]:/u.test(decoded) ||
    path.posix.isAbsolute(decoded) ||
    path.win32.isAbsolute(decoded) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error(`Tracked source path is unsafe: ${JSON.stringify(decoded)}.`);
  }
  return decoded;
};

const trackedIndexEntries = (repositoryRoot) => {
  const output = runGitProcess(repositoryRoot, ['ls-files', '--stage', '-v', '-f', '-z']).stdout;
  if (output.length === 0 || output.at(-1) !== 0) {
    throw new Error('The tracked Git index output is empty or malformed.');
  }
  const entries = [];
  const paths = new Set();
  let offset = 0;
  while (offset < output.length) {
    const terminator = output.indexOf(0, offset);
    if (terminator < 0 || terminator === offset) {
      throw new Error('The tracked Git index output contains an empty or unterminated entry.');
    }
    const record = output.subarray(offset, terminator);
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new Error('The tracked Git index output is missing an entry separator.');
    }
    const headerBytes = record.subarray(0, separator);
    if (headerBytes.some((value) => value > 0x7f)) {
      throw new Error('The tracked Git index contains a non-ASCII stage header.');
    }
    const header = headerBytes.toString('ascii');
    const match = /^([^ ]) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(header);
    if (!match) throw new Error('The tracked Git index contains a malformed stage entry.');
    const [, tag, mode, objectId, stage] = match;
    const relativePath = decodeGitPath(record.subarray(separator + 1));
    if (tag !== 'H') {
      throw new Error(
        `Tracked provenance entry has an unsafe index flag (tag ${tag}): ${relativePath}.`,
      );
    }
    if (stage !== '0') {
      throw new Error(`Tracked provenance entry is not at index stage 0: ${relativePath}.`);
    }
    if (mode !== '100644' && mode !== '100755') {
      throw new Error(
        `Tracked provenance entry is not a regular Git blob: ${relativePath} (${mode}).`,
      );
    }
    if (paths.has(relativePath)) {
      throw new Error(`Tracked Git index contains a duplicate path: ${relativePath}.`);
    }
    paths.add(relativePath);
    entries.push({ mode, objectId, relativePath, pathBytes: record.subarray(separator + 1) });
    offset = terminator + 1;
  }
  entries.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  if (entries.length === 0 || entries.length > 100_000) {
    throw new Error('The tracked source set is outside the supported provenance bounds.');
  }
  return entries;
};

const TRACKED_TRANSFORMATION_ATTRIBUTES = ['filter', 'ident', 'working-tree-encoding'];
const SAFE_TRANSFORMATION_ATTRIBUTE_VALUES = new Set(['unspecified', 'unset']);

const readNulField = (output, offset) => {
  const terminator = output.indexOf(0, offset);
  if (terminator < 0) throw new Error('Git check-attr returned unterminated output.');
  return { value: output.subarray(offset, terminator), offset: terminator + 1 };
};

const assertSafeTrackedAttributes = (repositoryRoot, entries) => {
  const inputParts = [];
  for (const entry of entries) inputParts.push(entry.pathBytes, Buffer.from([0]));
  const output = runGitProcess(
    repositoryRoot,
    ['check-attr', '-z', '--stdin', ...TRACKED_TRANSFORMATION_ATTRIBUTES],
    [0],
    { input: Buffer.concat(inputParts) },
  ).stdout;
  let offset = 0;
  for (const entry of entries) {
    for (const expectedAttribute of TRACKED_TRANSFORMATION_ATTRIBUTES) {
      const pathField = readNulField(output, offset);
      const attributeField = readNulField(output, pathField.offset);
      const valueField = readNulField(output, attributeField.offset);
      offset = valueField.offset;
      if (!pathField.value.equals(entry.pathBytes)) {
        throw new Error('Git check-attr returned paths in an unexpected order.');
      }
      if (
        attributeField.value.some((value) => value > 0x7f) ||
        attributeField.value.toString('ascii') !== expectedAttribute
      ) {
        throw new Error('Git check-attr returned an unexpected attribute name.');
      }
      const attributeValue = decodeStrictUtf8(valueField.value, 'Git attribute value');
      if (!SAFE_TRANSFORMATION_ATTRIBUTE_VALUES.has(attributeValue)) {
        throw new Error(
          `Tracked provenance entry uses a forbidden Git ${expectedAttribute} transformation: ${entry.relativePath}.`,
        );
      }
    }
  }
  if (offset !== output.length) {
    throw new Error('Git check-attr returned trailing or duplicate output.');
  }
};

const assertRegularCheckoutEntry = async (repositoryRoot, relativePath) => {
  const absolutePath = path.resolve(repositoryRoot, ...relativePath.split('/'));
  const relation = path.relative(repositoryRoot, absolutePath);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`Tracked source path escaped the repository: ${relativePath}.`);
  }
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Tracked provenance entry is not a regular file: ${relativePath}.`);
  }
  return { absolutePath, metadata };
};

const gitBlobIdentities = (repositoryRoot, entries) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: repositoryRoot,
      env: createGitInspectionEnvironment(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const identities = [];
    let entryIndex = 0;
    let state = 'header';
    let pending = Buffer.alloc(0);
    let remaining = 0;
    let currentDigest = null;
    let currentSize = 0;
    let stderr = Buffer.alloc(0);
    let settled = false;
    let closed = false;
    let failure = null;
    let terminationTimer = null;

    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(operationTimer);
      if (terminationTimer !== null) clearTimeout(terminationTimer);
      if (error) reject(error);
      else resolve(value);
    };

    const addFailureDetail = (message) => {
      failure = new Error(failure ? `${failure.message} ${message}` : message);
    };

    const requestTermination = (message) => {
      if (failure === null) failure = new Error(message);
      pending = Buffer.alloc(0);
      if (closed || child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.destroy();
      let terminationRequested = false;
      try {
        terminationRequested = child.kill();
      } catch (error) {
        addFailureDetail(`Git cat-file termination failed: ${error.message}`);
      }
      if (!terminationRequested && child.exitCode === null && child.signalCode === null) {
        addFailureDetail('Git cat-file did not accept the termination signal.');
      }
      if (terminationTimer === null) {
        terminationTimer = setTimeout(() => {
          if (closed || child.exitCode !== null || child.signalCode !== null) return;
          try {
            const killed = child.kill('SIGKILL');
            if (!killed && child.exitCode === null && child.signalCode === null) {
              addFailureDetail('Git cat-file did not accept the forced termination signal.');
            }
          } catch (error) {
            addFailureDetail(`Git cat-file forced termination failed: ${error.message}`);
          }
        }, 2_000);
      }
    };

    const fail = (message) => requestTermination(message);

    const processOutput = () => {
      while (pending.length > 0 && failure === null) {
        if (state === 'header') {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) {
            if (pending.length > 256) fail('Git cat-file emitted an oversized batch header.');
            return;
          }
          const headerBytes = pending.subarray(0, newline);
          if (headerBytes.some((value) => value > 0x7f)) {
            fail('Git cat-file emitted a non-ASCII batch header.');
            return;
          }
          const header = headerBytes.toString('ascii');
          pending = pending.subarray(newline + 1);
          const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (0|[1-9][0-9]*)$/u.exec(header);
          if (!match || entryIndex >= entries.length) {
            fail('Git cat-file emitted a malformed or unexpected batch header.');
            return;
          }
          const [, objectId, sizeText] = match;
          if (objectId !== entries[entryIndex].objectId) {
            fail('Git cat-file returned blobs in an unexpected order.');
            return;
          }
          currentSize = Number(sizeText);
          if (!Number.isSafeInteger(currentSize) || currentSize < 0) {
            fail('Git cat-file reported an unsupported blob size.');
            return;
          }
          remaining = currentSize;
          currentDigest = createHash('sha256');
          state = remaining === 0 ? 'delimiter' : 'body';
        } else if (state === 'body') {
          const consumed = Math.min(remaining, pending.length);
          currentDigest.update(pending.subarray(0, consumed));
          pending = pending.subarray(consumed);
          remaining -= consumed;
          if (remaining > 0) return;
          state = 'delimiter';
        } else if (state === 'delimiter') {
          if (pending.at(0) !== 0x0a) {
            fail('Git cat-file omitted the required blob delimiter.');
            return;
          }
          pending = pending.subarray(1);
          identities.push({ size: currentSize, sha256: currentDigest.digest('hex') });
          entryIndex += 1;
          currentDigest = null;
          state = entryIndex === entries.length ? 'complete' : 'header';
        } else {
          fail('Git cat-file emitted trailing batch output.');
          return;
        }
      }
    };

    const operationTimer = setTimeout(
      () => fail('Git cat-file timed out while reading tracked source blobs.'),
      60_000,
    );
    child.once('error', (error) => {
      if (failure === null) fail(`Git cat-file failed to start: ${error.message}`);
      else addFailureDetail(`Git cat-file emitted an error during teardown: ${error.message}`);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1024 * 1024) {
        stderr = Buffer.concat([stderr, chunk.subarray(0, 1024 * 1024 - stderr.length)]);
      }
    });
    child.stdout.on('data', (chunk) => {
      if (failure !== null) return;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      processOutput();
    });
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(operationTimer);
      if (terminationTimer !== null) clearTimeout(terminationTimer);
      if (failure === null) processOutput();
      if (failure !== null) {
        settle(failure);
      } else if (code !== 0 || signal) {
        settle(
          new Error(
            `Git cat-file failed closed: ${stderr.toString('utf8').trim() || signal || `exit ${code}`}`,
          ),
        );
      } else if (state !== 'complete' || pending.length !== 0 || entryIndex !== entries.length) {
        settle(new Error('Git cat-file ended before the complete tracked blob set was read.'));
      } else {
        settle(null, identities);
      }
    });
    child.stdin.once('error', (error) => {
      if (failure === null) fail(`Git cat-file input failed: ${error.message}`);
    });
    child.stdin.end(Buffer.from(`${entries.map((entry) => entry.objectId).join('\n')}\n`, 'ascii'));
  });

const aggregateTrackedIdentity = (entries, identities) => {
  const digest = createHash('sha256');
  let bytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const { relativePath } = entries[index];
    const identity = identities[index];
    bytes += identity.size;
    if (!Number.isSafeInteger(bytes)) {
      throw new Error('The tracked source byte total exceeds the supported provenance bounds.');
    }
    digest.update(relativePath, 'utf8');
    digest.update('\0');
    digest.update(String(identity.size));
    digest.update('\0');
    digest.update(identity.sha256);
    digest.update('\n');
  }
  return { sha256: digest.digest('hex'), fileCount: entries.length, bytes };
};

export const trackedSourceIdentity = async (repositoryRoot, { sourceState = null } = {}) => {
  const state = sourceState ?? gitSourceState(repositoryRoot);
  if (typeof state?.dirty !== 'boolean') {
    throw new Error('Tracked source identity requires an exact Git cleanliness state.');
  }
  const entries = trackedIndexEntries(repositoryRoot);
  assertSafeTrackedAttributes(repositoryRoot, entries);
  if (!state.dirty) {
    for (const { relativePath } of entries) {
      await assertRegularCheckoutEntry(repositoryRoot, relativePath);
    }
    return aggregateTrackedIdentity(entries, await gitBlobIdentities(repositoryRoot, entries));
  }
  const identities = [];
  for (const { relativePath } of entries) {
    const { absolutePath, metadata } = await assertRegularCheckoutEntry(
      repositoryRoot,
      relativePath,
    );
    identities.push({ size: metadata.size, sha256: await sha256File(absolutePath) });
  }
  return aggregateTrackedIdentity(entries, identities);
};

const sameIdentity = (left, right) =>
  left.sha256 === right.sha256 && left.fileCount === right.fileCount && left.bytes === right.bytes;

export const captureSourceSnapshot = async (repositoryRoot, { requireClean = false } = {}) => {
  const before = gitSourceState(repositoryRoot);
  if (requireClean && before.dirty) {
    throw new Error('A release source snapshot requires a clean index and worktree.');
  }
  const tree = await trackedSourceIdentity(repositoryRoot, { sourceState: before });
  const after = gitSourceState(repositoryRoot);
  if (before.commit !== after.commit || before.dirty !== after.dirty) {
    throw new Error('Source state changed while the provenance snapshot was captured.');
  }
  const confirmation = await trackedSourceIdentity(repositoryRoot, { sourceState: after });
  if (!sameIdentity(tree, confirmation)) {
    throw new Error('Tracked source changed while the provenance snapshot was captured.');
  }
  const finalState = gitSourceState(repositoryRoot);
  if (after.commit !== finalState.commit || after.dirty !== finalState.dirty) {
    throw new Error('Source state changed while the provenance snapshot was confirmed.');
  }
  return { ...finalState, tree };
};

export const assertSourceSnapshot = async (
  repositoryRoot,
  expected,
  { requireClean = false } = {},
) => {
  const current = await captureSourceSnapshot(repositoryRoot, { requireClean });
  assertSourceSnapshotIdentity(current, expected);
  return current;
};

export const assertSourceSnapshotIdentity = (current, expected) => {
  if (
    current.commit !== expected.commit ||
    current.dirty !== expected.dirty ||
    !sameIdentity(current.tree, expected.tree)
  ) {
    throw new Error('The source commit or tracked source snapshot changed during the build.');
  }
};

export const sourceProvenance = (repositoryRoot) => {
  const source = gitSourceState(repositoryRoot);
  return {
    commit: source.commit,
    branch: source.branch,
    exactTag: source.exactTag,
    dirty: source.dirty,
    dirtyEntryCount: Number(source.staged) + Number(source.unstaged) + Number(source.untracked),
  };
};
