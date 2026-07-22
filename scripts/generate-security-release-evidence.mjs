#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDirectoryInventory } from '../apps/desktop/scripts/build-provenance-support.mjs';
import { drainChildProcess } from '../apps/desktop/scripts/child-process-cleanup.mjs';
import { assertCandidateManifest } from './release-candidate-manifest.mjs';
import { captureSourceSnapshot } from './release-source-state.mjs';
import { terminateProcessTree } from './process-tree-support.mjs';
import {
  auditEvidenceFromResult,
  buildCodeqlEvidence,
  canonicalJson,
  DEPENDENCY_SBOM_FILE_NAME,
  inspectDependencySbom,
  SECURITY_RAW_RECEIPT_PATHS,
  SECURITY_EVIDENCE_FILE_NAME,
  sha256Bytes,
  verifySecurityEvidence,
} from './security-release-evidence-support.mjs';
import {
  acquireReleaseLock,
  assertNoPendingReleasePromotions,
  createReleaseEnvironment,
  releaseReleaseLock,
  resolveCorepackInvocation,
} from './windows-release-pipeline-support.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const EXPECTED_REPOSITORY = 'Nassau-1/htmllelujah';

export { terminateProcessTree };

const parseArgs = (argv) => {
  const options = {
    repositoryRoot,
    artifactDir: path.join(repositoryRoot, 'apps', 'desktop', 'out'),
    evidenceDir: path.join(repositoryRoot, 'artifacts', 'release-evidence'),
    repository: EXPECTED_REPOSITORY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node scripts/generate-security-release-evidence.mjs [--artifact-dir <path>] [--evidence-dir <path>]\n',
      );
      process.exit(0);
    }
    if (argument === '--artifact-dir' || argument === '--evidence-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      index += 1;
      options[argument === '--artifact-dir' ? 'artifactDir' : 'evidenceDir'] = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}.`);
  }
  return options;
};

export const defaultRunCommand = ({
  command,
  args,
  cwd,
  env,
  timeoutMs = 15 * 60_000,
  drainChild = drainChildProcess,
  spawnChild = spawn,
}) =>
  new Promise((resolve, reject) => {
    const child = spawnChild(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    let terminating = false;
    let timer;
    const maximumOutput = 32 * 1024 * 1024;
    const settle = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation(value);
    };
    const terminateTree = async (error) => {
      if (settled || terminating) return;
      terminating = true;
      try {
        await drainChild({ child, label: 'Security evidence command' });
      } catch (terminationError) {
        settle(
          reject,
          new AggregateError(
            [error, terminationError],
            'Security evidence command failed and its process tree or handles could not be drained.',
          ),
        );
        return;
      }
      settle(reject, error);
    };
    const collect = (target, chunk, currentSize) => {
      const next = currentSize + chunk.length;
      if (next > maximumOutput) {
        void terminateTree(new Error('Security evidence command exceeded its output limit.'));
        return currentSize;
      }
      target.push(chunk);
      return next;
    };
    child.stdout.on('data', (chunk) => {
      stdoutSize = collect(stdout, chunk, stdoutSize);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize = collect(stderr, chunk, stderrSize);
    });
    timer = setTimeout(() => {
      void terminateTree(new Error(`Security evidence command exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (terminating) return;
      settle(reject, error);
    });
    child.once('close', (code, signal) => {
      if (terminating) return;
      settle(resolve, {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });

const requireSuccessful = (result, label) => {
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `${label} failed with ${result.signal ?? result.code ?? 'unknown status'}: ${String(
        result.stderr ?? '',
      )
        .trim()
        .slice(-2_000)}`,
    );
  }
  return result;
};

const parseCommandJson = (result, label) => {
  requireSuccessful(result, label);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON.`, { cause: error });
  }
};

const sameInventory = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const samePlainFile = (left, right) =>
  left.isFile() &&
  right.isFile() &&
  !left.isSymbolicLink() &&
  !right.isSymbolicLink() &&
  left.nlink === 1 &&
  right.nlink === 1 &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.birthtimeMs === right.birthtimeMs &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const readPlainFile = async (filePath, label) => {
  const metadata = await lstat(filePath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size < 1
  ) {
    throw new Error(`${label} must be a non-empty regular one-link file.`);
  }
  const handle = await open(filePath, 'r');
  let opened;
  let afterRead;
  let bytes;
  try {
    opened = await handle.stat();
    if (!samePlainFile(metadata, opened)) {
      throw new Error(`${label} changed before it was opened.`);
    }
    bytes = await handle.readFile();
    afterRead = await handle.stat();
    if (!samePlainFile(opened, afterRead) || bytes.length !== afterRead.size) {
      throw new Error(`${label} changed while it was read.`);
    }
  } finally {
    await handle.close();
  }
  const confirmation = await lstat(filePath);
  if (!samePlainFile(afterRead, confirmation)) {
    throw new Error(`${label} changed while it was read.`);
  }
  return bytes;
};

const runGhJson = async ({ endpoint, runCommand, cwd, env, label }) => {
  const result = await runCommand({
    command: 'gh',
    args: ['api', '--paginate', '--slurp', endpoint],
    cwd,
    env,
    timeoutMs: 5 * 60_000,
  });
  return {
    payload: parseCommandJson(result, label),
    bytes: Buffer.from(result.stdout, 'utf8'),
  };
};

const matchingCodeqlRunId = (payload, commit) => {
  const pages = Array.isArray(payload) ? payload : [payload];
  const runs = pages.flatMap((page) => page?.workflow_runs ?? []);
  const matches = runs.filter(
    (run) =>
      run?.head_sha === commit &&
      run?.head_branch === 'main' &&
      run?.event === 'push' &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.path === '.github/workflows/codeql.yml',
  );
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) {
    throw new Error('Could not resolve exactly one successful CodeQL run for the candidate.');
  }
  return matches[0].id;
};

export const generateSecurityReleaseEvidence = async (
  options,
  {
    runCommand = defaultRunCommand,
    platform = process.platform,
    now = () => new Date(),
    environment = createReleaseEnvironment(process.env),
    corepackInvocation = resolveCorepackInvocation(),
  } = {},
) => {
  if (platform !== 'win32') throw new Error('The V1 security evidence gate requires Windows.');
  if (options.repository !== EXPECTED_REPOSITORY) {
    throw new Error('The security evidence repository is not canonical.');
  }
  const outputPath = path.join(options.evidenceDir, SECURITY_EVIDENCE_FILE_NAME);
  await rm(outputPath, { force: true });
  await mkdir(options.evidenceDir, { recursive: true });

  const candidatePath = path.join(options.evidenceDir, 'release-candidate-v1.json');
  const releaseManifestPath = path.join(options.evidenceDir, 'release-manifest.json');
  const dependencySbomPath = path.join(options.evidenceDir, DEPENDENCY_SBOM_FILE_NAME);
  const workflowPath = path.join(options.repositoryRoot, '.github', 'workflows', 'codeql.yml');
  const packagePath = path.join(options.repositoryRoot, 'package.json');
  const [candidateBytes, releaseManifestBytes, dependencySbomBytes, workflowBytes, packageBytes] =
    await Promise.all([
      readPlainFile(candidatePath, 'Release candidate manifest'),
      readPlainFile(releaseManifestPath, 'Release evidence manifest'),
      readPlainFile(dependencySbomPath, 'Dependency SBOM'),
      readPlainFile(workflowPath, 'CodeQL workflow'),
      readPlainFile(packagePath, 'Root package manifest'),
    ]);
  const candidateManifest = JSON.parse(candidateBytes.toString('utf8'));
  const releaseManifest = JSON.parse(releaseManifestBytes.toString('utf8'));
  const rootPackage = JSON.parse(packageBytes.toString('utf8'));
  const source = await captureSourceSnapshot(options.repositoryRoot, { requireClean: true });
  const inventoryBefore = await buildDirectoryInventory(options.artifactDir);
  assertCandidateManifest({
    manifest: candidateManifest,
    inventory: inventoryBefore.files,
    version: candidateManifest.version,
    source,
  });
  const dependencySbom = inspectDependencySbom({
    bytes: dependencySbomBytes,
    expectedLockfileSha256: candidateManifest.lockfile.sha256,
    expectedPackageManager: rootPackage.packageManager,
  });
  const privateSecurityDirectory = path.join(options.evidenceDir, 'private-security');
  await rm(privateSecurityDirectory, { recursive: true, force: true });
  await mkdir(privateSecurityDirectory, { recursive: true });
  const rawReceiptBytes = new Map();

  const runAudit = async (scope) => {
    const auditArgs = [
      ...corepackInvocation.argsPrefix,
      'pnpm',
      'audit',
      ...(scope === 'production' ? ['--prod'] : []),
      '--json',
      '--audit-level',
      'low',
    ];
    const result = await runCommand({
      command: corepackInvocation.command,
      args: auditArgs,
      cwd: options.repositoryRoot,
      env: environment,
      timeoutMs: 10 * 60_000,
    });
    rawReceiptBytes.set(
      scope === 'production'
        ? SECURITY_RAW_RECEIPT_PATHS.productionAudit
        : SECURITY_RAW_RECEIPT_PATHS.fullAudit,
      Buffer.from(result.stdout, 'utf8'),
    );
    return auditEvidenceFromResult({
      scope,
      stdout: result.stdout,
      exitCode: result.code,
      signal: result.signal,
    });
  };
  const productionAudit = await runAudit('production');
  const fullAudit = await runAudit('full');

  const encodedCommit = encodeURIComponent(candidateManifest.source.commit);
  const runsReceipt = await runGhJson({
    endpoint: `repos/${options.repository}/actions/workflows/codeql.yml/runs?head_sha=${encodedCommit}&event=push&status=completed&per_page=100`,
    runCommand,
    cwd: options.repositoryRoot,
    env: environment,
    label: 'CodeQL workflow runs query',
  });
  const runs = runsReceipt.payload;
  rawReceiptBytes.set(SECURITY_RAW_RECEIPT_PATHS.codeqlRuns, runsReceipt.bytes);
  const runId = matchingCodeqlRunId(runs, candidateManifest.source.commit);
  const jobsReceipt = await runGhJson({
    endpoint: `repos/${options.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    runCommand,
    cwd: options.repositoryRoot,
    env: environment,
    label: 'CodeQL jobs query',
  });
  const jobs = jobsReceipt.payload;
  rawReceiptBytes.set(SECURITY_RAW_RECEIPT_PATHS.codeqlJobs, jobsReceipt.bytes);
  const analysesReceipt = await runGhJson({
    endpoint: `repos/${options.repository}/code-scanning/analyses?ref=refs%2Fheads%2Fmain&tool_name=CodeQL&per_page=100`,
    runCommand,
    cwd: options.repositoryRoot,
    env: environment,
    label: 'CodeQL analyses query',
  });
  const analyses = analysesReceipt.payload;
  rawReceiptBytes.set(SECURITY_RAW_RECEIPT_PATHS.codeqlAnalyses, analysesReceipt.bytes);
  const alertsReceipt = await runGhJson({
    endpoint: `repos/${options.repository}/code-scanning/alerts?state=open&per_page=100`,
    runCommand,
    cwd: options.repositoryRoot,
    env: environment,
    label: 'CodeQL open alerts query',
  });
  const alerts = alertsReceipt.payload;
  rawReceiptBytes.set(SECURITY_RAW_RECEIPT_PATHS.codeqlAlerts, alertsReceipt.bytes);
  const codeql = buildCodeqlEvidence({
    repository: options.repository,
    commit: candidateManifest.source.commit,
    workflowSha256: sha256Bytes(workflowBytes),
    runs,
    jobs,
    analyses,
    alerts,
  });
  if (
    rawReceiptBytes.size !== Object.keys(SECURITY_RAW_RECEIPT_PATHS).length ||
    [...rawReceiptBytes.values()].some((bytes) => !Buffer.isBuffer(bytes) || bytes.length === 0)
  ) {
    throw new Error('Raw security receipt set is incomplete.');
  }
  await Promise.all(
    [...rawReceiptBytes].map(([relativePath, bytes]) =>
      writeFile(path.join(options.evidenceDir, ...relativePath.split('/')), bytes, { flag: 'wx' }),
    ),
  );
  const readRawReceiptFiles = async () =>
    new Map(
      await Promise.all(
        Object.values(SECURITY_RAW_RECEIPT_PATHS).map(async (relativePath) => [
          relativePath,
          await readPlainFile(
            path.join(options.evidenceDir, ...relativePath.split('/')),
            `Raw security receipt ${relativePath}`,
          ),
        ]),
      ),
    );
  const rawReceiptFiles = await readRawReceiptFiles();
  const rawReceipts = Object.fromEntries(
    Object.entries(SECURITY_RAW_RECEIPT_PATHS).map(([name, relativePath]) => {
      const bytes = rawReceiptFiles.get(relativePath);
      return [name, { path: relativePath, size: bytes.length, sha256: sha256Bytes(bytes) }];
    }),
  );

  const installerPath = path.join(
    options.artifactDir,
    ...candidateManifest.artifact.installer.path.split('/'),
  );
  const executableEntry = candidateManifest.artifact.files.find(
    (entry) => entry.path === 'win-unpacked/HTMLlelujah.exe',
  );
  if (executableEntry === undefined)
    throw new Error('Candidate application executable is missing.');
  const executablePath = path.join(options.artifactDir, ...executableEntry.path.split('/'));
  const unpackedPath = path.join(options.artifactDir, 'win-unpacked');
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error('Windows system root is unavailable.');
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const defenderResult = await runCommand({
    command: powershell,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(options.repositoryRoot, 'scripts', 'collect-windows-security-evidence.ps1'),
      '-InstallerPath',
      installerPath,
      '-ExecutablePath',
      executablePath,
      '-UnpackedPath',
      unpackedPath,
      '-PrivateEvidenceDirectory',
      privateSecurityDirectory,
    ],
    cwd: options.repositoryRoot,
    env: environment,
    timeoutMs: 45 * 60_000,
  });
  const defenderFixture = parseCommandJson(
    defenderResult,
    'Microsoft Defender evidence collection',
  );
  const inventoryAfter = await buildDirectoryInventory(options.artifactDir);
  if (!sameInventory(inventoryAfter, inventoryBefore)) {
    throw new Error('Candidate artifacts changed during Microsoft Defender scans.');
  }
  const defenderScanRoles = new Set(
    Array.isArray(defenderFixture.scans)
      ? defenderFixture.scans.map((scan) => scan?.targetRole)
      : [],
  );
  if (
    !Array.isArray(defenderFixture.scans) ||
    defenderFixture.scans.length !== 2 ||
    defenderScanRoles.size !== 2 ||
    !defenderScanRoles.has('installer') ||
    !defenderScanRoles.has('win-unpacked')
  ) {
    throw new Error('Microsoft Defender did not return both exact scan roles.');
  }
  const signatureRoles = new Set(
    Array.isArray(defenderFixture.signatures)
      ? defenderFixture.signatures.map((signature) => signature?.role)
      : [],
  );
  if (
    !Array.isArray(defenderFixture.signatures) ||
    defenderFixture.signatures.length !== 2 ||
    signatureRoles.size !== 2 ||
    !signatureRoles.has('installer') ||
    !signatureRoles.has('application-executable')
  ) {
    throw new Error('Authenticode inspection did not return both exact executable roles.');
  }
  const scans = defenderFixture.scans.map((scan) => ({
    ...scan,
    outputLog: `private-security/${scan.targetRole}-defender-scan.log`,
    target:
      scan.targetRole === 'installer'
        ? candidateManifest.artifact.installer
        : {
            path: 'win-unpacked',
            size: candidateManifest.artifact.winUnpacked.totalSize,
            sha256: candidateManifest.artifact.winUnpacked.aggregateSha256,
          },
  }));
  const signatureIdentities = new Map([
    ['installer', candidateManifest.artifact.installer],
    ['application-executable', executableEntry],
  ]);
  const codeSigning = {
    policy: 'unsigned-v1',
    targets: defenderFixture.signatures.map((signature) => ({
      ...signature,
      identity: signatureIdentities.get(signature.role),
    })),
  };
  const defender = {
    policy: 'signed-microsoft-on-demand',
    status: defenderFixture.status,
    scanner: defenderFixture.scanner,
    preScanArtifactAggregateSha256: inventoryBefore.aggregateSha256,
    postScanArtifactAggregateSha256: inventoryAfter.aggregateSha256,
    scans,
  };
  const defenderLogFiles = new Map(
    await Promise.all(
      scans.map(async (scan) => [
        scan.outputLog,
        await readPlainFile(
          path.join(options.evidenceDir, ...scan.outputLog.split('/')),
          `Defender ${scan.targetRole} raw output`,
        ),
      ]),
    ),
  );

  const postVerification = await runCommand({
    command: process.execPath,
    args: [
      'scripts/verify-release-evidence.mjs',
      '--artifact-dir',
      options.artifactDir,
      '--evidence-dir',
      options.evidenceDir,
      '--require-ready',
    ],
    cwd: options.repositoryRoot,
    env: environment,
    timeoutMs: 10 * 60_000,
  });
  requireSuccessful(postVerification, 'Post-scan release-evidence verification');
  const verifiedAt = now().toISOString();
  const generatedAt = now().toISOString();
  const manifest = {
    schemaVersion: 1,
    productName: 'HTMLlelujah',
    version: candidateManifest.version,
    generatedAt,
    releaseReady: true,
    source: {
      commit: candidateManifest.source.commit,
      dirty: false,
      treeSha256: candidateManifest.source.treeSha256,
      fileCount: candidateManifest.source.fileCount,
      bytes: candidateManifest.source.bytes,
      lockfileSha256: candidateManifest.lockfile.sha256,
    },
    candidate: {
      manifestFile: 'release-candidate-v1.json',
      manifestSha256: sha256Bytes(candidateBytes),
      manifestSize: candidateBytes.length,
      buildId: candidateManifest.buildId,
      artifactAggregateSha256: candidateManifest.artifact.aggregateSha256,
    },
    releaseEvidence: {
      manifestFile: 'release-manifest.json',
      manifestSha256: sha256Bytes(releaseManifestBytes),
      manifestSize: releaseManifestBytes.length,
      generatedAt: releaseManifest.release.generatedAt,
      releaseReady: true,
    },
    dependencySbom,
    audits: {
      packageManager: rootPackage.packageManager,
      production: productionAudit,
      full: fullAudit,
    },
    rawReceipts,
    codeql,
    defender,
    codeSigning,
    postScanVerification: {
      commandId: 'verify-release-evidence',
      exitCode: 0,
      signal: null,
      verifiedAt,
      candidateManifestSha256: sha256Bytes(candidateBytes),
      artifactAggregateSha256: candidateManifest.artifact.aggregateSha256,
      releaseManifestSha256: sha256Bytes(releaseManifestBytes),
    },
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  verifySecurityEvidence({
    manifestBytes,
    candidateManifest,
    candidateManifestBytes: candidateBytes,
    releaseManifest,
    releaseManifestBytes,
    dependencySbomBytes,
    packageManager: rootPackage.packageManager,
    codeqlWorkflowBytes: workflowBytes,
    rawReceiptFiles,
    defenderLogFiles,
    source,
    now: Date.parse(generatedAt),
  });

  const [candidateConfirmation, releaseConfirmation, sbomConfirmation, workflowConfirmation] =
    await Promise.all([
      readPlainFile(candidatePath, 'Release candidate manifest'),
      readPlainFile(releaseManifestPath, 'Release evidence manifest'),
      readPlainFile(dependencySbomPath, 'Dependency SBOM'),
      readPlainFile(workflowPath, 'CodeQL workflow'),
    ]);
  const defenderLogConfirmation = new Map(
    await Promise.all(
      [...defenderLogFiles.keys()].map(async (relativePath) => [
        relativePath,
        await readPlainFile(
          path.join(options.evidenceDir, ...relativePath.split('/')),
          `Defender raw output ${relativePath}`,
        ),
      ]),
    ),
  );
  const rawReceiptConfirmation = await readRawReceiptFiles();
  const finalInventory = await buildDirectoryInventory(options.artifactDir);
  const finalSource = await captureSourceSnapshot(options.repositoryRoot, { requireClean: true });
  if (
    !candidateConfirmation.equals(candidateBytes) ||
    !releaseConfirmation.equals(releaseManifestBytes) ||
    !sbomConfirmation.equals(dependencySbomBytes) ||
    !workflowConfirmation.equals(workflowBytes) ||
    [...defenderLogFiles].some(
      ([relativePath, bytes]) => !defenderLogConfirmation.get(relativePath)?.equals(bytes),
    ) ||
    [...rawReceiptFiles].some(
      ([relativePath, bytes]) => !rawReceiptConfirmation.get(relativePath)?.equals(bytes),
    ) ||
    !sameInventory(finalInventory, inventoryBefore) ||
    JSON.stringify(finalSource) !== JSON.stringify(source)
  ) {
    throw new Error('Security evidence inputs changed during collection.');
  }

  const temporaryPath = `${outputPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, manifestBytes, { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  try {
    const persistedBytes = await readPlainFile(outputPath, 'Security evidence');
    if (!persistedBytes.equals(manifestBytes)) {
      throw new Error('Persisted security evidence differs from the verified canonical bytes.');
    }
    const persistedRawReceiptFiles = await readRawReceiptFiles();
    verifySecurityEvidence({
      manifestBytes: persistedBytes,
      candidateManifest,
      candidateManifestBytes: candidateBytes,
      releaseManifest,
      releaseManifestBytes,
      dependencySbomBytes,
      packageManager: rootPackage.packageManager,
      codeqlWorkflowBytes: workflowBytes,
      rawReceiptFiles: persistedRawReceiptFiles,
      defenderLogFiles,
      source,
      now: Date.parse(generatedAt),
    });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
  process.stdout.write(`Security release evidence generated: ${outputPath}\n`);
  return { outputPath, manifest };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const cliOptions = parseArgs(process.argv.slice(2));
  const releaseLock = await acquireReleaseLock({
    transactionParent: path.dirname(repositoryRoot),
    purpose: 'generate-security-release-evidence',
  });
  try {
    await assertNoPendingReleasePromotions({
      transactionParent: path.dirname(repositoryRoot),
      releaseLock,
    });
    await generateSecurityReleaseEvidence(cliOptions);
    await assertNoPendingReleasePromotions({
      transactionParent: path.dirname(repositoryRoot),
      releaseLock,
    });
  } finally {
    await releaseReleaseLock({ releaseLock });
  }
}
