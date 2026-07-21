import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultRunCommand, terminateProcessTree } from './generate-security-release-evidence.mjs';
import {
  auditEvidenceFromResult,
  buildCodeqlEvidence,
  canonicalJson,
  inspectDependencySbom,
  LOCKFILE_HASH_PROPERTY,
  PACKAGE_MANAGER_PROPERTY,
  SECURITY_RAW_RECEIPT_PATHS,
  SBOM_GENERATOR_PROPERTY,
  SBOM_SCOPE_PROPERTY,
  EXPECTED_SBOM_GENERATOR_COMMAND,
  sha256Bytes,
  verifySecurityEvidence,
} from './security-release-evidence-support.mjs';

const generatedAt = '2026-07-17T12:00:00.000Z';
const commit = 'a'.repeat(40);
const treeSha256 = 'b'.repeat(64);
const lockfileSha256 = 'c'.repeat(64);
const artifactAggregateSha256 = 'd'.repeat(64);
const packageManager = 'pnpm@11.13.0';
const workflowBytes = Buffer.from('name: CodeQL\n');
const installer = {
  path: 'HTMLlelujah-1.0.0-x64-unsigned-Setup.exe',
  size: 101,
  sha256: '1'.repeat(64),
};
const applicationExecutable = {
  path: 'win-unpacked/HTMLlelujah.exe',
  size: 202,
  sha256: '2'.repeat(64),
};
const defenderLogs = new Map([
  ['private-security/installer-defender-scan.log', Buffer.from('clean installer scan\n')],
  ['private-security/win-unpacked-defender-scan.log', Buffer.from('clean directory scan\n')],
]);

const dependencySbomFixture = () => ({
  bomFormat: 'CycloneDX',
  specVersion: '1.7',
  serialNumber: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'htmllelujah',
      version: '1.0.0',
      'bom-ref': 'htmllelujah@1.0.0',
    },
    properties: [
      { name: LOCKFILE_HASH_PROPERTY, value: lockfileSha256 },
      { name: PACKAGE_MANAGER_PROPERTY, value: packageManager },
      { name: SBOM_GENERATOR_PROPERTY, value: EXPECTED_SBOM_GENERATOR_COMMAND },
      { name: SBOM_SCOPE_PROPERTY, value: 'production' },
    ],
  },
  components: [
    {
      type: 'library',
      name: 'yjs',
      version: '13.6.27',
      purl: 'pkg:npm/yjs@13.6.27',
      'bom-ref': 'pkg:npm/yjs@13.6.27',
    },
  ],
  dependencies: [
    { ref: 'htmllelujah@1.0.0', dependsOn: ['pkg:npm/yjs@13.6.27'] },
    { ref: 'pkg:npm/yjs@13.6.27', dependsOn: [] },
  ],
});

const zeroAuditResult = () => ({
  code: 0,
  signal: null,
  stdout: JSON.stringify({
    advisories: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: 125,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 125,
    },
  }),
});

const codeqlApiFixtures = () => ({
  runs: [
    {
      total_count: 1,
      workflow_runs: [
        {
          id: 9001,
          run_attempt: 1,
          head_sha: commit,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          path: '.github/workflows/codeql.yml',
          run_started_at: '2026-07-17T10:00:00Z',
          updated_at: '2026-07-17T10:03:00Z',
        },
      ],
    },
  ],
  jobs: [
    {
      total_count: 1,
      jobs: [
        {
          id: 9010,
          run_id: 9001,
          name: 'analyze',
          status: 'completed',
          conclusion: 'success',
          steps: [
            {
              name: 'Run github/codeql-action/analyze@v4',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      ],
    },
  ],
  analyses: [
    [
      {
        id: 9020,
        commit_sha: commit,
        ref: 'refs/heads/main',
        tool: { name: 'CodeQL' },
        category: '/language:javascript-typescript',
        created_at: '2026-07-17T10:02:30Z',
        results_count: 0,
        rules_count: 211,
        error: '',
      },
    ],
  ],
  alerts: [[]],
});

const baseFixture = () => {
  const candidateManifest = {
    schemaVersion: 2,
    productName: 'HTMLlelujah',
    version: '1.0.0',
    buildId: 'fixture-build',
    source: {
      commit,
      dirty: false,
      treeSha256,
      fileCount: 10,
      bytes: 1000,
    },
    lockfile: { sha256: lockfileSha256 },
    artifact: {
      aggregateSha256: artifactAggregateSha256,
      installer,
      files: [installer, applicationExecutable],
      winUnpacked: {
        fileCount: 1,
        totalSize: applicationExecutable.size,
        aggregateSha256: applicationExecutable.sha256,
        files: [{ ...applicationExecutable, path: 'HTMLlelujah.exe' }],
      },
    },
  };
  const candidateBytes = Buffer.from(`${JSON.stringify(candidateManifest, null, 2)}\n`);
  const releaseManifest = {
    release: { generatedAt: '2026-07-17T09:00:00.000Z', source: { commit } },
    artifact: { aggregateSha256: artifactAggregateSha256 },
    quality: { releaseReady: true },
  };
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`);
  const dependencySbomBytes = Buffer.from(canonicalJson(dependencySbomFixture()));
  const dependencySbom = inspectDependencySbom({
    bytes: dependencySbomBytes,
    expectedLockfileSha256: lockfileSha256,
    expectedPackageManager: packageManager,
  });
  const api = codeqlApiFixtures();
  const codeql = buildCodeqlEvidence({
    repository: 'Nassau-1/htmllelujah',
    commit,
    workflowSha256: sha256Bytes(workflowBytes),
    ...api,
  });
  const rawReceiptFiles = new Map([
    [SECURITY_RAW_RECEIPT_PATHS.productionAudit, Buffer.from(zeroAuditResult().stdout)],
    [SECURITY_RAW_RECEIPT_PATHS.fullAudit, Buffer.from(zeroAuditResult().stdout)],
    [SECURITY_RAW_RECEIPT_PATHS.codeqlRuns, Buffer.from(JSON.stringify(api.runs))],
    [SECURITY_RAW_RECEIPT_PATHS.codeqlJobs, Buffer.from(JSON.stringify(api.jobs))],
    [SECURITY_RAW_RECEIPT_PATHS.codeqlAnalyses, Buffer.from(JSON.stringify(api.analyses))],
    [SECURITY_RAW_RECEIPT_PATHS.codeqlAlerts, Buffer.from(JSON.stringify(api.alerts))],
  ]);
  const rawReceipts = Object.fromEntries(
    Object.entries(SECURITY_RAW_RECEIPT_PATHS).map(([name, relativePath]) => {
      const bytes = rawReceiptFiles.get(relativePath);
      return [name, { path: relativePath, size: bytes.length, sha256: sha256Bytes(bytes) }];
    }),
  );
  const scans = ['installer', 'win-unpacked'].map((targetRole, index) => {
    const outputLog = `private-security/${targetRole}-defender-scan.log`;
    return {
      targetRole,
      target:
        targetRole === 'installer'
          ? installer
          : {
              path: 'win-unpacked',
              size: applicationExecutable.size,
              sha256: applicationExecutable.sha256,
            },
      scanType: 'custom',
      disableRemediation: true,
      arguments: [
        '-Scan',
        '-ScanType',
        '3',
        '-File',
        targetRole === 'installer' ? '<candidate-installer>' : '<candidate-win-unpacked>',
        '-DisableRemediation',
      ],
      exitCode: 0,
      signal: null,
      detectionCount: 0,
      outputLog,
      outputBytes: defenderLogs.get(outputLog).length,
      outputSha256: sha256Bytes(defenderLogs.get(outputLog)),
      startedAt: `2026-07-17T11:0${index}:00.000Z`,
      completedAt: `2026-07-17T11:0${index}:10.000Z`,
    };
  });
  const manifest = {
    schemaVersion: 1,
    productName: 'HTMLlelujah',
    version: '1.0.0',
    generatedAt,
    releaseReady: true,
    source: {
      commit,
      dirty: false,
      treeSha256,
      fileCount: 10,
      bytes: 1000,
      lockfileSha256,
    },
    candidate: {
      manifestFile: 'release-candidate-v1.json',
      manifestSha256: sha256Bytes(candidateBytes),
      manifestSize: candidateBytes.length,
      buildId: 'fixture-build',
      artifactAggregateSha256,
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
      packageManager,
      production: auditEvidenceFromResult({
        scope: 'production',
        stdout: zeroAuditResult().stdout,
        exitCode: 0,
      }),
      full: auditEvidenceFromResult({
        scope: 'full',
        stdout: zeroAuditResult().stdout,
        exitCode: 0,
      }),
    },
    rawReceipts,
    codeql,
    defender: {
      policy: 'signed-microsoft-on-demand',
      status: {
        antivirusEnabled: true,
        antispywareEnabled: true,
        amServiceEnabled: true,
        realTimeProtectionEnabled: false,
        engineVersion: '1.1.26060.1',
        platformVersion: '4.18.26060.2004',
        antivirusSignatureVersion: '1.431.1.0',
        antivirusSignatureUpdatedAt: '2026-07-17T08:00:00.000Z',
        antispywareSignatureVersion: '1.431.1.0',
        antispywareSignatureUpdatedAt: '2026-07-17T08:00:00.000Z',
        nisEngineVersion: '1.1.26060.1',
        nisSignatureVersion: null,
        nisSignatureUpdatedAt: null,
      },
      scanner: {
        sha256: 'e'.repeat(64),
        size: 300,
        version: '4.18.26060.2004',
        authenticodeStatus: 'Valid',
        signerCertificatePresent: true,
        signerSubject:
          'CN=Microsoft Windows Publisher, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
        signerThumbprint: '3'.repeat(40),
      },
      preScanArtifactAggregateSha256: artifactAggregateSha256,
      postScanArtifactAggregateSha256: artifactAggregateSha256,
      scans,
    },
    codeSigning: {
      policy: 'unsigned-v1',
      targets: [
        {
          role: 'installer',
          identity: installer,
          status: 'NotSigned',
          signerCertificatePresent: false,
          timeStamperCertificatePresent: false,
          signerSubject: null,
          timeStamperSubject: null,
        },
        {
          role: 'application-executable',
          identity: applicationExecutable,
          status: 'NotSigned',
          signerCertificatePresent: false,
          timeStamperCertificatePresent: false,
          signerSubject: null,
          timeStamperSubject: null,
        },
      ],
    },
    postScanVerification: {
      commandId: 'verify-release-evidence',
      exitCode: 0,
      signal: null,
      verifiedAt: '2026-07-17T11:59:59.000Z',
      candidateManifestSha256: sha256Bytes(candidateBytes),
      artifactAggregateSha256,
      releaseManifestSha256: sha256Bytes(releaseManifestBytes),
    },
  };
  return {
    manifest,
    candidateManifest,
    candidateBytes,
    releaseManifest,
    releaseManifestBytes,
    dependencySbomBytes,
    rawReceiptFiles,
  };
};

const verify = (
  fixture,
  { now = Date.parse(generatedAt), logs = defenderLogs, receipts = fixture.rawReceiptFiles } = {},
) =>
  verifySecurityEvidence({
    manifestBytes: Buffer.from(canonicalJson(fixture.manifest)),
    candidateManifest: fixture.candidateManifest,
    candidateManifestBytes: fixture.candidateBytes,
    releaseManifest: fixture.releaseManifest,
    releaseManifestBytes: fixture.releaseManifestBytes,
    dependencySbomBytes: fixture.dependencySbomBytes,
    packageManager,
    codeqlWorkflowBytes: workflowBytes,
    rawReceiptFiles: receipts,
    defenderLogFiles: logs,
    now,
  });

test('canonical security evidence accepts exact zero-risk injected fixtures', () => {
  const result = verify(baseFixture());
  assert.equal(result.manifest.releaseReady, true);
  assert.equal(result.dependencySbom.componentCount, 1);
});

test('audit fixture rejects nonzero vulnerabilities and non-exact corepack command', () => {
  const report = JSON.parse(zeroAuditResult().stdout);
  report.metadata.vulnerabilities.high = 1;
  report.advisories.package = { severity: 'high' };
  assert.throws(
    () =>
      auditEvidenceFromResult({
        scope: 'production',
        stdout: JSON.stringify(report),
        exitCode: 1,
      }),
    /did not exit 0/u,
  );
  const fixture = baseFixture();
  fixture.manifest.audits.production.command.splice(3, 1);
  assert.throws(() => verify(fixture), /exact corepack pnpm arguments/u);
  const unexpectedSeverity = JSON.parse(zeroAuditResult().stdout);
  unexpectedSeverity.metadata.vulnerabilities.unknown = 0;
  assert.throws(
    () =>
      auditEvidenceFromResult({
        scope: 'full',
        stdout: JSON.stringify(unexpectedSeverity),
        exitCode: 0,
      }),
    /fields are incomplete or unexpected/u,
  );
});

test('GitHub API fixtures require the exact analyze action and zero open alerts', () => {
  const wrongStep = codeqlApiFixtures();
  wrongStep.jobs[0].jobs[0].steps[0].name = 'Perform CodeQL Analysis';
  assert.throws(
    () =>
      buildCodeqlEvidence({
        repository: 'Nassau-1/htmllelujah',
        commit,
        workflowSha256: sha256Bytes(workflowBytes),
        ...wrongStep,
      }),
    /Run github\/codeql-action\/analyze@v4/u,
  );
  const openAlert = codeqlApiFixtures();
  openAlert.alerts = [[{ number: 1, state: 'open' }]];
  assert.throws(
    () =>
      buildCodeqlEvidence({
        repository: 'Nassau-1/htmllelujah',
        commit,
        workflowSha256: sha256Bytes(workflowBytes),
        ...openAlert,
      }),
    /open code-scanning alerts/u,
  );
});

test('security verifier rejects stale, future, wrong-CodeQL, and stale post-scan records', () => {
  const stale = baseFixture();
  assert.throws(
    () => verify(stale, { now: Date.parse(generatedAt) + 24 * 60 * 60 * 1000 + 1 }),
    /stale or dated in the future/u,
  );
  const future = baseFixture();
  assert.throws(
    () => verify(future, { now: Date.parse(generatedAt) - 1 }),
    /stale or dated in the future/u,
  );
  const codeql = baseFixture();
  codeql.manifest.codeql.analysis.commitSha = 'f'.repeat(40);
  assert.throws(() => verify(codeql), /CodeQL analysis evidence/u);
  const wrongRun = baseFixture();
  wrongRun.manifest.codeql.job.runId += 1;
  assert.throws(() => verify(wrongRun), /CodeQL analyze job evidence/u);
  const reversedRun = baseFixture();
  reversedRun.manifest.codeql.run.startedAt = '2026-07-17T10:04:00.000Z';
  assert.throws(() => verify(reversedRun), /CodeQL run did not complete/u);
  const lateAnalysis = baseFixture();
  lateAnalysis.manifest.codeql.analysis.createdAt = '2026-07-17T10:08:00.001Z';
  assert.throws(() => verify(lateAnalysis), /CodeQL analysis evidence/u);
  const postScan = baseFixture();
  postScan.manifest.postScanVerification.releaseManifestSha256 = '0'.repeat(64);
  assert.throws(() => verify(postScan), /Post-scan release-evidence/u);
});

test('Defender timestamps are fresh, nonfuture, and ordered before post-scan verification', () => {
  const staleScan = baseFixture();
  staleScan.manifest.defender.scans[0].startedAt = '2026-07-16T11:59:59.999Z';
  staleScan.manifest.defender.scans[0].completedAt = '2026-07-16T12:00:10.000Z';
  assert.throws(() => verify(staleScan), /Defender scan timing is stale/u);

  const staleScanInsideFreshEnvelope = baseFixture();
  for (const [index, scan] of staleScanInsideFreshEnvelope.manifest.defender.scans.entries()) {
    scan.startedAt = `2026-07-15T12:0${index}:00.002Z`;
    scan.completedAt = `2026-07-15T12:0${index}:10.002Z`;
  }
  for (const property of ['antivirusSignatureUpdatedAt', 'antispywareSignatureUpdatedAt']) {
    staleScanInsideFreshEnvelope.manifest.defender.status[property] = '2026-07-15T08:00:00.000Z';
  }
  assert.throws(() => verify(staleScanInsideFreshEnvelope), /Defender scan timing is stale/u);

  const scanAfterVerification = baseFixture();
  scanAfterVerification.manifest.defender.scans[1].completedAt = '2026-07-17T11:59:59.001Z';
  assert.throws(() => verify(scanAfterVerification), /after post-scan verification/u);

  const futureSignature = baseFixture();
  futureSignature.manifest.defender.status.antivirusSignatureUpdatedAt = '2026-07-17T11:00:00.001Z';
  assert.throws(() => verify(futureSignature), /newer than the scans/u);

  const staleSignature = baseFixture();
  staleSignature.manifest.defender.status.antispywareSignatureUpdatedAt =
    '2026-07-10T10:59:59.999Z';
  assert.throws(() => verify(staleSignature), /antispywareSignatureUpdatedAt is stale/u);

  const verificationAfterEvidence = baseFixture();
  verificationAfterEvidence.manifest.postScanVerification.verifiedAt = '2026-07-17T12:00:00.001Z';
  assert.throws(() => verify(verificationAfterEvidence), /current time are out of order/u);

  const releaseAfterScan = baseFixture();
  releaseAfterScan.releaseManifest.release.generatedAt = '2026-07-17T11:00:00.001Z';
  releaseAfterScan.manifest.releaseEvidence.generatedAt =
    releaseAfterScan.releaseManifest.release.generatedAt;
  releaseAfterScan.releaseManifestBytes = Buffer.from(
    `${JSON.stringify(releaseAfterScan.releaseManifest, null, 2)}\n`,
  );
  releaseAfterScan.manifest.releaseEvidence.manifestSha256 = sha256Bytes(
    releaseAfterScan.releaseManifestBytes,
  );
  releaseAfterScan.manifest.releaseEvidence.manifestSize =
    releaseAfterScan.releaseManifestBytes.length;
  releaseAfterScan.manifest.postScanVerification.releaseManifestSha256 =
    releaseAfterScan.manifest.releaseEvidence.manifestSha256;
  assert.throws(() => verify(releaseAfterScan), /must predate the exact Defender scans/u);

  const overlappingScans = baseFixture();
  overlappingScans.manifest.defender.scans[1].startedAt = '2026-07-17T11:00:05.000Z';
  assert.throws(() => verify(overlappingScans), /overlap or are out of their required order/u);
});

test('security verifier rejects remediation, tampered logs, and either signed binary', () => {
  const remediation = baseFixture();
  remediation.manifest.defender.scans[0].disableRemediation = false;
  assert.throws(() => verify(remediation), /without remediation/u);
  const tamperedLogs = new Map(defenderLogs);
  tamperedLogs.set('private-security/win-unpacked-defender-scan.log', Buffer.from('tampered\n'));
  assert.throws(() => verify(baseFixture(), { logs: tamperedLogs }), /without remediation/u);
  const untrustedScanner = baseFixture();
  untrustedScanner.manifest.defender.scanner.signerSubject = 'CN=Untrusted Scanner';
  assert.throws(() => verify(untrustedScanner), /scanner identity is incomplete/u);
  const mismatchedScanner = baseFixture();
  mismatchedScanner.manifest.defender.scanner.version = '4.18.99999.1 (different-platform)';
  assert.throws(() => verify(mismatchedScanner), /does not match the active platform/u);
  for (const role of ['installer', 'application-executable']) {
    const signed = baseFixture();
    const target = signed.manifest.codeSigning.targets.find((entry) => entry.role === role);
    target.status = 'Valid';
    target.signerCertificatePresent = true;
    target.signerSubject = 'CN=Unexpected signer';
    assert.throws(() => verify(signed), /exactly NotSigned/u);
  }
});

test('canonical public security evidence rejects private paths and unknown fields', () => {
  const privatePath = baseFixture();
  privatePath.manifest.defender.scanner.version =
    'scanner failure at D:\\release-user\\private\\MpCmdRun.exe';
  assert.throws(() => verify(privatePath), /private absolute path/u);
  const unknownField = baseFixture();
  unknownField.manifest.codeql.run.unverifiedUrl = 'https://example.invalid/';
  assert.throws(() => verify(unknownField), /fields are incomplete or unexpected/u);
});

test('raw audit and CodeQL receipts are exact and semantic claims are recomputed', () => {
  const byteTampering = baseFixture();
  const changedBytes = new Map(byteTampering.rawReceiptFiles);
  changedBytes.set(
    SECURITY_RAW_RECEIPT_PATHS.codeqlAlerts,
    Buffer.from(`${byteTampering.rawReceiptFiles.get(SECURITY_RAW_RECEIPT_PATHS.codeqlAlerts)} `),
  );
  assert.throws(
    () => verify(byteTampering, { receipts: changedBytes }),
    /receipt identity differs from its exact raw bytes/iu,
  );

  const semanticTampering = baseFixture();
  const changedRuns = codeqlApiFixtures().runs;
  changedRuns[0].workflow_runs[0].run_attempt = 2;
  const changedRunBytes = Buffer.from(JSON.stringify(changedRuns));
  const semanticReceipts = new Map(semanticTampering.rawReceiptFiles);
  semanticReceipts.set(SECURITY_RAW_RECEIPT_PATHS.codeqlRuns, changedRunBytes);
  semanticTampering.manifest.rawReceipts.codeqlRuns = {
    path: SECURITY_RAW_RECEIPT_PATHS.codeqlRuns,
    size: changedRunBytes.length,
    sha256: sha256Bytes(changedRunBytes),
  };
  assert.throws(
    () => verify(semanticTampering, { receipts: semanticReceipts }),
    /semantic claims differ from their raw receipts/iu,
  );

  const missingReceipt = baseFixture();
  const incomplete = new Map(missingReceipt.rawReceiptFiles);
  incomplete.delete(SECURITY_RAW_RECEIPT_PATHS.fullAudit);
  assert.throws(
    () => verify(missingReceipt, { receipts: incomplete }),
    /file set is incomplete or unexpected/iu,
  );
});

test('dependency SBOM graph and exact candidate binding fail closed', () => {
  const dangling = dependencySbomFixture();
  dangling.dependencies[0].dependsOn = ['pkg:npm/missing@1.0.0'];
  assert.throws(
    () =>
      inspectDependencySbom({
        bytes: Buffer.from(canonicalJson(dangling)),
        expectedLockfileSha256: lockfileSha256,
        expectedPackageManager: packageManager,
      }),
    /dangling/u,
  );
  const development = dependencySbomFixture();
  development.metadata.properties.find((entry) => entry.name === SBOM_SCOPE_PROPERTY).value =
    'development';
  assert.throws(
    () =>
      inspectDependencySbom({
        bytes: Buffer.from(canonicalJson(development)),
        expectedLockfileSha256: lockfileSha256,
        expectedPackageManager: packageManager,
      }),
    /not production-only/u,
  );
  const disconnected = dependencySbomFixture();
  disconnected.components.push({
    type: 'library',
    name: 'disconnected',
    version: '1.0.0',
    purl: 'pkg:npm/disconnected@1.0.0',
    'bom-ref': 'pkg:npm/disconnected@1.0.0',
  });
  disconnected.dependencies.push({ ref: 'pkg:npm/disconnected@1.0.0', dependsOn: [] });
  assert.throws(
    () =>
      inspectDependencySbom({
        bytes: Buffer.from(canonicalJson(disconnected)),
        expectedLockfileSha256: lockfileSha256,
        expectedPackageManager: packageManager,
      }),
    /unreachable from the application root/u,
  );
  const candidate = baseFixture();
  candidate.manifest.candidate.manifestSha256 = '0'.repeat(64);
  assert.throws(() => verify(candidate), /candidate binding/u);

  const unexpectedExecutable = baseFixture();
  unexpectedExecutable.candidateManifest.artifact.files.push({
    path: 'win-unpacked/elevate.exe',
    size: 12,
    sha256: '9'.repeat(64),
  });
  unexpectedExecutable.candidateBytes = Buffer.from(
    `${JSON.stringify(unexpectedExecutable.candidateManifest, null, 2)}\n`,
  );
  unexpectedExecutable.manifest.candidate.manifestSha256 = sha256Bytes(
    unexpectedExecutable.candidateBytes,
  );
  unexpectedExecutable.manifest.candidate.manifestSize = unexpectedExecutable.candidateBytes.length;
  unexpectedExecutable.manifest.postScanVerification.candidateManifestSha256 =
    unexpectedExecutable.manifest.candidate.manifestSha256;
  assert.throws(
    () => verify(unexpectedExecutable),
    /exactly HTMLlelujah\.exe and no other executable/iu,
  );
});

test(
  'default command timeout drains the spawned process tree',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'htmllelujah-security-timeout-'));
    const pidPath = path.join(root, 'pids.json');
    const childSource = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
      `fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify({root:process.pid,child:child.pid}));`,
      'setInterval(()=>{},1000);',
    ].join('');
    try {
      await assert.rejects(
        defaultRunCommand({
          command: process.execPath,
          args: ['-e', childSource],
          cwd: root,
          env: process.env,
          timeoutMs: 2_000,
        }),
        /exceeded 2000 ms/u,
      );
      const pids = JSON.parse(await readFile(pidPath, 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const pid of [pids.root, pids.child]) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('process-tree termination fails closed on a nonzero Windows killer status', async () => {
  await assert.rejects(
    terminateProcessTree({
      pid: 4242,
      platform: 'win32',
      discoverTree: () => [4242, 4343],
      killWindowsTree: () => ({ status: 1, signal: null, error: undefined }),
      isAlive: () => false,
      drainTimeoutMs: 1,
      pollIntervalMs: 1,
    }),
    /killer status 1; live PIDs: none/u,
  );
});

test('process-tree termination still invokes the killer when discovery fails', async () => {
  let killerInvoked = false;
  await assert.rejects(
    terminateProcessTree({
      pid: 4242,
      platform: 'win32',
      discoverTree: () => {
        throw new Error('CIM unavailable');
      },
      killWindowsTree: () => {
        killerInvoked = true;
        return { status: 0, signal: null, error: undefined };
      },
      isAlive: () => false,
      drainTimeoutMs: 1,
      pollIntervalMs: 1,
    }),
    /discovery CIM unavailable; killer status 0/u,
  );
  assert.equal(killerInvoked, true);
});

test('process-tree termination fails closed when any captured descendant survives', async () => {
  await assert.rejects(
    terminateProcessTree({
      pid: 4242,
      platform: 'win32',
      discoverTree: () => [4242, 4343],
      killWindowsTree: () => ({ status: 0, signal: null, error: undefined }),
      isAlive: (pid) => pid === 4343,
      drainTimeoutMs: 1,
      pollIntervalMs: 1,
    }),
    /live PIDs: 4343/u,
  );
});
