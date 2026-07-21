import { createHash } from 'node:crypto';

export const DEPENDENCY_SBOM_FILE_NAME = 'dependency-sbom.cdx.json';
export const SECURITY_EVIDENCE_FILE_NAME = 'v1-security-evidence.json';
export const SECURITY_EVIDENCE_SCHEMA_VERSION = 1;
export const EXPECTED_CODEQL_WORKFLOW_PATH = '.github/workflows/codeql.yml';
export const EXPECTED_CODEQL_REF = 'refs/heads/main';
export const EXPECTED_CODEQL_ANALYSIS_STEP = 'Run github/codeql-action/analyze@v4';
export const LOCKFILE_HASH_PROPERTY = 'htmllelujah:pnpm-lock-sha256';
export const PACKAGE_MANAGER_PROPERTY = 'htmllelujah:package-manager';
export const SBOM_SCOPE_PROPERTY = 'htmllelujah:dependency-scope';
export const SBOM_GENERATOR_PROPERTY = 'htmllelujah:generator-command';
export const EXPECTED_SBOM_GENERATOR_COMMAND =
  'corepack pnpm sbom --sbom-format cyclonedx --prod --sbom-type application';
export const SECURITY_RAW_RECEIPT_PATHS = Object.freeze({
  productionAudit: 'private-security/pnpm-audit-production.json',
  fullAudit: 'private-security/pnpm-audit-full.json',
  codeqlRuns: 'private-security/codeql-workflow-runs.json',
  codeqlJobs: 'private-security/codeql-jobs.json',
  codeqlAnalyses: 'private-security/codeql-analyses.json',
  codeqlAlerts: 'private-security/codeql-open-alerts.json',
});

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const VERSION = /^[0-9]+(?:\.[0-9]+){1,3}(?:[-+._a-z0-9]*)?$/iu;
const UUID_URN =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRIVATE_ABSOLUTE_PATH =
  /(?:^|[\s"'(=:])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/(?:Users|home)\/)/iu;
const FILE_URI = /file:\/\//iu;
export const SECURITY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const DEFENDER_SIGNATURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

const fail = (message) => {
  throw new Error(message);
};

const requireCondition = (condition, message) => {
  if (!condition) fail(message);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value, expected, label) => {
  requireCondition(isRecord(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  requireCondition(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} fields are incomplete or unexpected.`,
  );
};

const assertPublicSafeJson = (value, trail = 'security evidence') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPublicSafeJson(entry, `${trail}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      requireCondition(!key.includes('\0'), `${trail} contains a NUL key.`);
      assertPublicSafeJson(entry, `${trail}.${key}`);
    }
    return;
  }
  if (typeof value !== 'string') return;
  requireCondition(!value.includes('\0'), `${trail} contains a NUL value.`);
  requireCondition(
    !PRIVATE_ABSOLUTE_PATH.test(value) && !FILE_URI.test(value),
    `${trail} contains a private absolute path.`,
  );
};

const isIsoTimestamp = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const normalizedIsoTimestamp = (value, label) => {
  requireCondition(
    typeof value === 'string' && Number.isFinite(Date.parse(value)),
    `${label} is invalid.`,
  );
  return new Date(value).toISOString();
};

const sortJson = (value) => {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => [key, sortJson(value[key])]),
  );
};

export const canonicalJson = (value) => `${JSON.stringify(sortJson(value), null, 2)}\n`;

export const sha256Bytes = (value) =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) ? value : Buffer.from(value))
    .digest('hex');

const parseJsonBytes = (bytes, label) => {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  requireCondition(data.length > 0, `${label} is empty.`);
  let value;
  try {
    value = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  return { data, value };
};

const uniqueProperty = (properties, name) => {
  const matches = (Array.isArray(properties) ? properties : []).filter(
    (entry) => entry?.name === name,
  );
  requireCondition(matches.length === 1, `Dependency SBOM must contain exactly one ${name}.`);
  requireCondition(
    typeof matches[0].value === 'string' && matches[0].value !== '',
    `Dependency SBOM property ${name} is empty.`,
  );
  return matches[0].value;
};

const flattenComponents = (components, output = []) => {
  for (const component of Array.isArray(components) ? components : []) {
    output.push(component);
    flattenComponents(component?.components, output);
  }
  return output;
};

export const inspectDependencySbom = ({
  bytes,
  expectedLockfileSha256,
  expectedPackageManager,
  requireCanonical = true,
}) => {
  const { data, value: sbom } = parseJsonBytes(bytes, 'Dependency SBOM');
  requireCondition(isRecord(sbom), 'Dependency SBOM root must be an object.');
  assertPublicSafeJson(sbom, 'Dependency SBOM');
  if (requireCanonical) {
    requireCondition(
      data.toString('utf8') === canonicalJson(sbom),
      'Dependency SBOM is not canonical JSON.',
    );
  }
  requireCondition(sbom.bomFormat === 'CycloneDX', 'Dependency SBOM is not CycloneDX.');
  requireCondition(sbom.specVersion === '1.7', 'Dependency SBOM must use CycloneDX 1.7.');
  requireCondition(sbom.version === 1, 'Dependency SBOM document version must be 1.');
  requireCondition(
    typeof sbom.serialNumber === 'string' && UUID_URN.test(sbom.serialNumber),
    'Dependency SBOM serial number is missing or malformed.',
  );
  const lockfileSha256 = uniqueProperty(sbom.metadata?.properties, LOCKFILE_HASH_PROPERTY);
  const packageManager = uniqueProperty(sbom.metadata?.properties, PACKAGE_MANAGER_PROPERTY);
  const dependencyScope = uniqueProperty(sbom.metadata?.properties, SBOM_SCOPE_PROPERTY);
  const generatorCommand = uniqueProperty(sbom.metadata?.properties, SBOM_GENERATOR_PROPERTY);
  requireCondition(
    SHA256.test(lockfileSha256) && lockfileSha256 === expectedLockfileSha256,
    'Dependency SBOM lockfile hash does not match the release candidate.',
  );
  requireCondition(
    packageManager === expectedPackageManager,
    'Dependency SBOM package-manager binding does not match the release source.',
  );
  requireCondition(dependencyScope === 'production', 'Dependency SBOM is not production-only.');
  requireCondition(
    generatorCommand === EXPECTED_SBOM_GENERATOR_COMMAND,
    'Dependency SBOM generator command differs.',
  );

  const components = flattenComponents(sbom.components);
  requireCondition(components.length > 0, 'Dependency SBOM has no production components.');
  const componentRefs = new Set();
  for (const component of components) {
    requireCondition(
      typeof component?.['bom-ref'] === 'string' && component['bom-ref'] !== '',
      'Dependency SBOM component is missing bom-ref.',
    );
    requireCondition(
      !componentRefs.has(component['bom-ref']),
      `Dependency SBOM has duplicate component ref ${component['bom-ref']}.`,
    );
    componentRefs.add(component['bom-ref']);
    requireCondition(
      typeof component.name === 'string' && component.name !== '',
      `Dependency SBOM component ${component['bom-ref']} has no name.`,
    );
    if (typeof component.purl === 'string' && component.purl.startsWith('pkg:npm/')) {
      requireCondition(
        typeof component.version === 'string' && component.version !== '',
        `Locked npm component ${component['bom-ref']} has no version.`,
      );
    }
  }
  const rootRef = sbom.metadata?.component?.['bom-ref'];
  requireCondition(
    typeof rootRef === 'string' && rootRef !== '',
    'Dependency SBOM has no root ref.',
  );
  requireCondition(
    !componentRefs.has(rootRef),
    'Dependency SBOM root ref duplicates a component ref.',
  );
  const knownRefs = new Set([rootRef, ...componentRefs]);
  const dependencyRows = Array.isArray(sbom.dependencies) ? sbom.dependencies : [];
  requireCondition(dependencyRows.length > 0, 'Dependency SBOM graph is missing.');
  const rowRefs = new Set();
  let edgeCount = 0;
  for (const row of dependencyRows) {
    requireCondition(
      typeof row?.ref === 'string' && knownRefs.has(row.ref),
      'Dependency SBOM graph contains an unknown dependency row.',
    );
    requireCondition(!rowRefs.has(row.ref), `Dependency SBOM graph duplicates row ${row.ref}.`);
    rowRefs.add(row.ref);
    requireCondition(Array.isArray(row.dependsOn), `Dependency SBOM row ${row.ref} has no edges.`);
    const edges = new Set();
    for (const dependency of row.dependsOn) {
      requireCondition(
        typeof dependency === 'string' && knownRefs.has(dependency),
        `Dependency SBOM graph edge from ${row.ref} is dangling.`,
      );
      requireCondition(
        dependency !== row.ref && !edges.has(dependency),
        `Dependency SBOM graph edge from ${row.ref} is duplicated or self-referential.`,
      );
      edges.add(dependency);
      edgeCount += 1;
    }
  }
  requireCondition(rowRefs.has(rootRef), 'Dependency SBOM graph does not contain its root row.');
  for (const reference of componentRefs) {
    requireCondition(
      rowRefs.has(reference),
      `Dependency SBOM graph omits component row ${reference}.`,
    );
  }
  const dependencyMap = new Map(dependencyRows.map((row) => [row.ref, row.dependsOn]));
  const reachable = new Set();
  const pending = [rootRef];
  while (pending.length > 0) {
    const reference = pending.pop();
    if (reachable.has(reference)) continue;
    reachable.add(reference);
    pending.push(...dependencyMap.get(reference));
  }
  requireCondition(
    reachable.size === knownRefs.size,
    'Dependency SBOM graph contains a component unreachable from the application root.',
  );
  return {
    fileName: DEPENDENCY_SBOM_FILE_NAME,
    size: data.length,
    sha256: sha256Bytes(data),
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    serialNumber: sbom.serialNumber,
    componentCount: components.length,
    dependencyRowCount: dependencyRows.length,
    dependencyEdgeCount: edgeCount,
    lockfileSha256,
    packageManager,
    dependencyScope,
    generatorCommand,
  };
};

export const expectedAuditCommand = (scope) => [
  'corepack',
  'pnpm',
  'audit',
  ...(scope === 'production' ? ['--prod'] : []),
  '--json',
  '--audit-level',
  'low',
];

export const auditEvidenceFromResult = ({ scope, stdout, exitCode, signal = null }) => {
  requireCondition(scope === 'production' || scope === 'full', 'Audit scope is unsupported.');
  requireCondition(signal === null && exitCode === 0, `${scope} dependency audit did not exit 0.`);
  const { data, value: report } = parseJsonBytes(stdout, `${scope} dependency audit report`);
  exactKeys(report, ['advisories', 'metadata'], `${scope} pnpm dependency audit report`);
  exactKeys(
    report.metadata,
    [
      'vulnerabilities',
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'totalDependencies',
    ],
    `${scope} pnpm dependency audit metadata`,
  );
  const counts = report?.metadata?.vulnerabilities;
  requireCondition(isRecord(counts), `${scope} dependency audit lacks vulnerability totals.`);
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  exactKeys(counts, severities, `${scope} dependency audit vulnerability totals`);
  for (const severity of severities) {
    requireCondition(
      Number.isSafeInteger(counts[severity]) && counts[severity] === 0,
      `${scope} dependency audit reports ${severity} vulnerabilities.`,
    );
  }
  requireCondition(
    isRecord(report.advisories) && Object.keys(report.advisories).length === 0,
    `${scope} dependency audit contains advisory entries.`,
  );
  const dependencyCounts = {};
  for (const property of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'totalDependencies',
  ]) {
    const value = report.metadata[property];
    requireCondition(
      Number.isSafeInteger(value) && value >= 0,
      `${scope} dependency audit ${property} count is invalid.`,
    );
    dependencyCounts[property] = value;
  }
  return {
    scope,
    command: expectedAuditCommand(scope),
    exitCode: 0,
    signal: null,
    format: 'pnpm-json-v11',
    reportSha256: sha256Bytes(data),
    vulnerabilities: {
      ...Object.fromEntries(severities.map((severity) => [severity, 0])),
      total: 0,
    },
    dependencyCounts,
    advisoryCount: 0,
  };
};

const unwrapArrayPayload = (payload, property) => {
  if (Array.isArray(payload)) {
    if (payload.every((entry) => Array.isArray(entry))) return payload.flat();
    if (payload.every((entry) => Array.isArray(entry?.[property]))) {
      return payload.flatMap((entry) => entry[property]);
    }
    return payload;
  }
  if (Array.isArray(payload?.[property])) return payload[property];
  return [];
};

export const buildCodeqlEvidence = ({
  repository,
  commit,
  workflowSha256,
  runs,
  jobs,
  analyses,
  alerts,
}) => {
  requireCondition(repository === 'Nassau-1/htmllelujah', 'CodeQL repository is not canonical.');
  requireCondition(COMMIT.test(commit), 'CodeQL source commit is malformed.');
  requireCondition(SHA256.test(workflowSha256 ?? ''), 'CodeQL workflow hash is malformed.');
  const matchingRuns = unwrapArrayPayload(runs, 'workflow_runs').filter(
    (run) =>
      run?.head_sha === commit &&
      run?.head_branch === 'main' &&
      run?.event === 'push' &&
      run?.status === 'completed' &&
      run?.conclusion === 'success' &&
      run?.path === EXPECTED_CODEQL_WORKFLOW_PATH,
  );
  requireCondition(
    matchingRuns.length === 1,
    'Expected exactly one successful CodeQL push run for the candidate commit.',
  );
  const run = matchingRuns[0];
  requireCondition(Number.isSafeInteger(run.id) && run.id > 0, 'CodeQL run id is invalid.');
  requireCondition(
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0,
    'CodeQL run attempt is invalid.',
  );
  const runStartedAt = normalizedIsoTimestamp(run.run_started_at, 'CodeQL run start');
  const runCompletedAt = normalizedIsoTimestamp(run.updated_at, 'CodeQL run completion');

  const matchingJobs = unwrapArrayPayload(jobs, 'jobs').filter(
    (job) =>
      job?.run_id === run.id &&
      job?.status === 'completed' &&
      job?.conclusion === 'success' &&
      /^analyze(?:\s|$)/iu.test(job?.name ?? ''),
  );
  requireCondition(matchingJobs.length === 1, 'CodeQL run lacks one successful analyze job.');
  const job = matchingJobs[0];
  const analysisSteps = (Array.isArray(job.steps) ? job.steps : []).filter(
    (step) => step?.name === EXPECTED_CODEQL_ANALYSIS_STEP,
  );
  requireCondition(
    analysisSteps.length === 1 &&
      analysisSteps[0].status === 'completed' &&
      analysisSteps[0].conclusion === 'success',
    `CodeQL analyze job lacks a successful ${EXPECTED_CODEQL_ANALYSIS_STEP} step.`,
  );

  const matchingAnalyses = unwrapArrayPayload(analyses, 'analyses').filter((analysis) => {
    const createdAt = Date.parse(analysis?.created_at ?? '');
    return (
      analysis?.commit_sha === commit &&
      analysis?.ref === EXPECTED_CODEQL_REF &&
      analysis?.tool?.name === 'CodeQL' &&
      (analysis?.error === '' || analysis?.error === null || analysis?.error === undefined) &&
      Number.isFinite(createdAt) &&
      createdAt >= Date.parse(run.run_started_at) - 60_000 &&
      createdAt <= Date.parse(run.updated_at) + 5 * 60_000
    );
  });
  requireCondition(
    matchingAnalyses.length === 1,
    'Expected exactly one successful CodeQL analysis for the candidate commit.',
  );
  const analysis = matchingAnalyses[0];
  requireCondition(
    Number.isSafeInteger(analysis.id) && analysis.id > 0,
    'CodeQL analysis id is invalid.',
  );
  const analysisCreatedAt = normalizedIsoTimestamp(
    analysis.created_at,
    'CodeQL analysis timestamp',
  );
  const openAlerts = unwrapArrayPayload(alerts, 'alerts');
  requireCondition(openAlerts.length === 0, 'CodeQL has open code-scanning alerts.');

  return {
    repository,
    workflowPath: EXPECTED_CODEQL_WORKFLOW_PATH,
    workflowSha256,
    workflowName: 'CodeQL',
    run: {
      id: run.id,
      attempt: run.run_attempt,
      headSha: commit,
      headBranch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      startedAt: runStartedAt,
      completedAt: runCompletedAt,
    },
    job: {
      id: job.id,
      runId: run.id,
      name: job.name,
      status: 'completed',
      conclusion: 'success',
      analysisStepName: EXPECTED_CODEQL_ANALYSIS_STEP,
      analysisStepConclusion: 'success',
    },
    analysis: {
      id: analysis.id,
      commitSha: commit,
      ref: EXPECTED_CODEQL_REF,
      toolName: 'CodeQL',
      category: analysis.category ?? null,
      createdAt: analysisCreatedAt,
      resultsCount: analysis.results_count ?? null,
      rulesCount: analysis.rules_count ?? null,
      error: null,
    },
    openAlerts: { state: 'open', count: 0, checkedAllPages: true },
  };
};

const sameIdentity = (left, right) =>
  left?.path === right?.path && left?.size === right?.size && left?.sha256 === right?.sha256;

const assertIdentity = (value, expected, label) => {
  requireCondition(
    sameIdentity(value, expected),
    `${label} identity does not match the candidate.`,
  );
};

const assertAuditEvidence = (value, scope) => {
  exactKeys(
    value,
    [
      'scope',
      'command',
      'exitCode',
      'signal',
      'format',
      'reportSha256',
      'vulnerabilities',
      'dependencyCounts',
      'advisoryCount',
    ],
    `${scope} audit`,
  );
  requireCondition(value.scope === scope, `${scope} audit scope differs.`);
  requireCondition(
    JSON.stringify(value.command) === JSON.stringify(expectedAuditCommand(scope)),
    `${scope} audit did not use exact corepack pnpm arguments.`,
  );
  requireCondition(value.exitCode === 0 && value.signal === null, `${scope} audit did not pass.`);
  requireCondition(value.format === 'pnpm-json-v11', `${scope} audit format differs.`);
  requireCondition(SHA256.test(value.reportSha256 ?? ''), `${scope} audit hash is malformed.`);
  requireCondition(value.advisoryCount === 0, `${scope} audit advisory count is nonzero.`);
  exactKeys(
    value.vulnerabilities,
    ['info', 'low', 'moderate', 'high', 'critical', 'total'],
    `${scope} audit vulnerabilities`,
  );
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    requireCondition(
      value.vulnerabilities?.[severity] === 0,
      `${scope} audit ${severity} count is nonzero.`,
    );
  }
  exactKeys(
    value.dependencyCounts,
    ['dependencies', 'devDependencies', 'optionalDependencies', 'totalDependencies'],
    `${scope} audit dependency counts`,
  );
  for (const count of Object.values(value.dependencyCounts)) {
    requireCondition(
      Number.isSafeInteger(count) && count >= 0,
      `${scope} audit dependency count is invalid.`,
    );
  }
};

const assertCodeqlEvidence = (value, commit, workflowSha256, generatedAt) => {
  exactKeys(
    value,
    [
      'repository',
      'workflowPath',
      'workflowSha256',
      'workflowName',
      'run',
      'job',
      'analysis',
      'openAlerts',
    ],
    'CodeQL evidence',
  );
  exactKeys(
    value.run,
    [
      'id',
      'attempt',
      'headSha',
      'headBranch',
      'event',
      'status',
      'conclusion',
      'startedAt',
      'completedAt',
    ],
    'CodeQL run evidence',
  );
  exactKeys(
    value.job,
    ['id', 'runId', 'name', 'status', 'conclusion', 'analysisStepName', 'analysisStepConclusion'],
    'CodeQL job evidence',
  );
  exactKeys(
    value.analysis,
    [
      'id',
      'commitSha',
      'ref',
      'toolName',
      'category',
      'createdAt',
      'resultsCount',
      'rulesCount',
      'error',
    ],
    'CodeQL analysis evidence',
  );
  exactKeys(value.openAlerts, ['state', 'count', 'checkedAllPages'], 'CodeQL alert evidence');
  requireCondition(value?.repository === 'Nassau-1/htmllelujah', 'CodeQL repository differs.');
  requireCondition(
    value?.workflowPath === EXPECTED_CODEQL_WORKFLOW_PATH,
    'CodeQL workflow differs.',
  );
  requireCondition(value?.workflowSha256 === workflowSha256, 'CodeQL workflow hash differs.');
  requireCondition(value?.workflowName === 'CodeQL', 'CodeQL workflow name differs.');
  requireCondition(value?.run?.headSha === commit, 'CodeQL run is not bound to source commit.');
  const runStartedAt = Date.parse(value?.run?.startedAt ?? '');
  const runCompletedAt = Date.parse(value?.run?.completedAt ?? '');
  const analysisCreatedAt = Date.parse(value?.analysis?.createdAt ?? '');
  const evidenceGeneratedAt = Date.parse(generatedAt ?? '');
  requireCondition(
    value.run.headBranch === 'main' &&
      value.run.event === 'push' &&
      value.run.status === 'completed' &&
      value.run.conclusion === 'success' &&
      Number.isSafeInteger(value.run.id) &&
      value.run.id > 0 &&
      Number.isSafeInteger(value.run.attempt) &&
      value.run.attempt > 0 &&
      isIsoTimestamp(value.run.startedAt) &&
      isIsoTimestamp(value.run.completedAt) &&
      runStartedAt <= runCompletedAt &&
      runCompletedAt <= evidenceGeneratedAt,
    'CodeQL run did not complete successfully.',
  );
  requireCondition(
    Number.isSafeInteger(value?.job?.id) &&
      value.job.id > 0 &&
      value.job.runId === value.run.id &&
      /^analyze(?:\s|$)/iu.test(value.job.name ?? '') &&
      value.job.status === 'completed' &&
      value.job.conclusion === 'success' &&
      value.job.analysisStepName === EXPECTED_CODEQL_ANALYSIS_STEP &&
      value.job.analysisStepConclusion === 'success',
    'CodeQL analyze job evidence is incomplete.',
  );
  requireCondition(
    Number.isSafeInteger(value?.analysis?.id) &&
      value.analysis.id > 0 &&
      value.analysis.commitSha === commit &&
      value.analysis.ref === EXPECTED_CODEQL_REF &&
      value.analysis.toolName === 'CodeQL' &&
      value.analysis.error === null &&
      isIsoTimestamp(value.analysis.createdAt) &&
      analysisCreatedAt >= runStartedAt - 60_000 &&
      analysisCreatedAt <= runCompletedAt + 5 * 60_000 &&
      analysisCreatedAt <= evidenceGeneratedAt,
    'CodeQL analysis evidence is incomplete.',
  );
  requireCondition(
    value?.openAlerts?.state === 'open' &&
      value.openAlerts.count === 0 &&
      value.openAlerts.checkedAllPages === true,
    'CodeQL open-alert evidence is not zero and exhaustive.',
  );
};

const verifyRawSecurityReceipts = ({
  value,
  rawReceiptFiles,
  audits,
  codeql,
  commit,
  workflowSha256,
}) => {
  const receiptNames = Object.keys(SECURITY_RAW_RECEIPT_PATHS);
  exactKeys(value, receiptNames, 'Raw security receipts');
  requireCondition(rawReceiptFiles instanceof Map, 'Raw security receipt files are unavailable.');
  requireCondition(
    rawReceiptFiles.size === receiptNames.length &&
      [...rawReceiptFiles.keys()].every((entry) =>
        Object.values(SECURITY_RAW_RECEIPT_PATHS).includes(entry),
      ),
    'Raw security receipt file set is incomplete or unexpected.',
  );

  const receiptBytes = {};
  for (const name of receiptNames) {
    const expectedPath = SECURITY_RAW_RECEIPT_PATHS[name];
    const identity = value?.[name];
    exactKeys(identity, ['path', 'size', 'sha256'], `Raw security receipt ${name}`);
    const bytes = rawReceiptFiles.get(expectedPath);
    requireCondition(Buffer.isBuffer(bytes) && bytes.length > 0, `${name} receipt is missing.`);
    requireCondition(
      identity.path === expectedPath &&
        identity.size === bytes.length &&
        identity.sha256 === sha256Bytes(bytes),
      `${name} receipt identity differs from its exact raw bytes.`,
    );
    receiptBytes[name] = bytes;
  }

  const recomputedProduction = auditEvidenceFromResult({
    scope: 'production',
    stdout: receiptBytes.productionAudit,
    exitCode: audits?.production?.exitCode,
    signal: audits?.production?.signal,
  });
  const recomputedFull = auditEvidenceFromResult({
    scope: 'full',
    stdout: receiptBytes.fullAudit,
    exitCode: audits?.full?.exitCode,
    signal: audits?.full?.signal,
  });
  requireCondition(
    canonicalJson(recomputedProduction) === canonicalJson(audits?.production) &&
      canonicalJson(recomputedFull) === canonicalJson(audits?.full),
    'Audit semantic claims differ from their raw receipts.',
  );

  const rawJson = (name) => parseJsonBytes(receiptBytes[name], `${name} receipt`).value;
  const recomputedCodeql = buildCodeqlEvidence({
    repository: codeql?.repository,
    commit,
    workflowSha256,
    runs: rawJson('codeqlRuns'),
    jobs: rawJson('codeqlJobs'),
    analyses: rawJson('codeqlAnalyses'),
    alerts: rawJson('codeqlAlerts'),
  });
  requireCondition(
    canonicalJson(recomputedCodeql) === canonicalJson(codeql),
    'CodeQL semantic claims differ from their raw receipts.',
  );
};

const assertDefender = (
  value,
  candidate,
  defenderLogFiles,
  { generatedAt, releaseEvidenceGeneratedAt, postScanVerifiedAt, now, maxAgeMs },
) => {
  exactKeys(
    value,
    [
      'policy',
      'status',
      'scanner',
      'preScanArtifactAggregateSha256',
      'postScanArtifactAggregateSha256',
      'scans',
    ],
    'Defender evidence',
  );
  const status = value?.status;
  requireCondition(
    value?.policy === 'signed-microsoft-on-demand',
    'Defender evidence does not use the approved on-demand scan policy.',
  );
  exactKeys(
    status,
    [
      'antivirusEnabled',
      'antispywareEnabled',
      'amServiceEnabled',
      'realTimeProtectionEnabled',
      'engineVersion',
      'platformVersion',
      'antivirusSignatureVersion',
      'antivirusSignatureUpdatedAt',
      'antispywareSignatureVersion',
      'antispywareSignatureUpdatedAt',
      'nisEngineVersion',
      'nisSignatureVersion',
      'nisSignatureUpdatedAt',
    ],
    'Defender status',
  );
  exactKeys(
    value.scanner,
    [
      'sha256',
      'size',
      'version',
      'authenticodeStatus',
      'signerCertificatePresent',
      'signerSubject',
      'signerThumbprint',
    ],
    'Defender scanner',
  );
  for (const property of [
    'engineVersion',
    'platformVersion',
    'antivirusSignatureVersion',
    'antispywareSignatureVersion',
  ]) {
    requireCondition(
      typeof status?.[property] === 'string' && VERSION.test(status[property]),
      `Defender ${property} is missing or malformed.`,
    );
  }
  for (const property of ['antivirusSignatureUpdatedAt', 'antispywareSignatureUpdatedAt']) {
    requireCondition(isIsoTimestamp(status?.[property]), `Defender ${property} is invalid.`);
  }
  for (const property of ['antivirusEnabled', 'antispywareEnabled', 'amServiceEnabled']) {
    requireCondition(status?.[property] === true, `Defender ${property} is not enabled.`);
  }
  requireCondition(
    typeof status?.realTimeProtectionEnabled === 'boolean',
    'Defender real-time protection status is unavailable.',
  );
  requireCondition(
    status?.nisEngineVersion === null ||
      (typeof status?.nisEngineVersion === 'string' && VERSION.test(status.nisEngineVersion)),
    'Defender NIS engine version is malformed.',
  );
  const hasNisSignature = status?.nisSignatureVersion !== null;
  requireCondition(
    hasNisSignature === (status?.nisSignatureUpdatedAt !== null) &&
      (!hasNisSignature ||
        (typeof status.nisSignatureVersion === 'string' &&
          VERSION.test(status.nisSignatureVersion) &&
          isIsoTimestamp(status.nisSignatureUpdatedAt))),
    'Defender optional NIS signature evidence is malformed.',
  );
  requireCondition(
    SHA256.test(value?.scanner?.sha256 ?? '') &&
      Number.isSafeInteger(value.scanner.size) &&
      value.scanner.size > 0 &&
      typeof value.scanner.version === 'string' &&
      value.scanner.version !== '' &&
      value.scanner.authenticodeStatus === 'Valid' &&
      value.scanner.signerCertificatePresent === true &&
      typeof value.scanner.signerSubject === 'string' &&
      /(?:^|, )O=Microsoft Corporation(?:,|$)/iu.test(value.scanner.signerSubject) &&
      /^[0-9a-f]{40}$/iu.test(value.scanner.signerThumbprint ?? ''),
    'Defender scanner identity is incomplete.',
  );
  const scannerPlatformVersion = value.scanner.version.split(/\s+/u, 1)[0];
  requireCondition(
    scannerPlatformVersion === status.platformVersion,
    'Defender scanner version does not match the active platform version.',
  );
  requireCondition(
    value.preScanArtifactAggregateSha256 === candidate.artifact.aggregateSha256 &&
      value.postScanArtifactAggregateSha256 === candidate.artifact.aggregateSha256,
    'Defender scan changed or was not bound to the candidate artifacts.',
  );
  const scans = Array.isArray(value.scans) ? value.scans : [];
  requireCondition(scans.length === 2, 'Defender must contain exactly two target scans.');
  const expectedTargets = new Map([
    ['installer', candidate.artifact.installer],
    [
      'win-unpacked',
      {
        path: 'win-unpacked',
        size: candidate.artifact.winUnpacked.totalSize,
        sha256: candidate.artifact.winUnpacked.aggregateSha256,
      },
    ],
  ]);
  requireCondition(
    new Set(scans.map((scan) => scan.targetRole)).size === 2,
    'Defender target scans are duplicated.',
  );
  const scanTimes = new Map();
  for (const scan of scans) {
    exactKeys(
      scan,
      [
        'targetRole',
        'target',
        'scanType',
        'disableRemediation',
        'arguments',
        'exitCode',
        'signal',
        'detectionCount',
        'outputLog',
        'outputBytes',
        'outputSha256',
        'startedAt',
        'completedAt',
      ],
      'Defender scan',
    );
    const expected = expectedTargets.get(scan.targetRole);
    requireCondition(expected !== undefined, 'Defender scan has an unexpected target.');
    exactKeys(scan.target, ['path', 'size', 'sha256'], `Defender ${scan.targetRole} identity`);
    assertIdentity(scan.target, expected, `Defender ${scan.targetRole}`);
    const expectedLog = `private-security/${scan.targetRole}-defender-scan.log`;
    const logBytes = defenderLogFiles?.get(expectedLog);
    requireCondition(
      scan.scanType === 'custom' &&
        scan.disableRemediation === true &&
        JSON.stringify(scan.arguments) ===
          JSON.stringify([
            '-Scan',
            '-ScanType',
            '3',
            '-File',
            scan.targetRole === 'installer' ? '<candidate-installer>' : '<candidate-win-unpacked>',
            '-DisableRemediation',
          ]) &&
        scan.exitCode === 0 &&
        scan.signal === null &&
        scan.detectionCount === 0 &&
        SHA256.test(scan.outputSha256 ?? '') &&
        Number.isSafeInteger(scan.outputBytes) &&
        scan.outputBytes > 0 &&
        scan.outputLog === expectedLog &&
        Buffer.isBuffer(logBytes) &&
        scan.outputBytes === logBytes.length &&
        scan.outputSha256 === sha256Bytes(logBytes) &&
        isIsoTimestamp(scan.startedAt) &&
        isIsoTimestamp(scan.completedAt) &&
        Date.parse(scan.completedAt) >= Date.parse(scan.startedAt),
      `Defender ${scan.targetRole} scan did not pass cleanly without remediation.`,
    );
    scanTimes.set(scan.targetRole, {
      startedAt: Date.parse(scan.startedAt),
      completedAt: Date.parse(scan.completedAt),
    });
  }
  const generatedTime = Date.parse(generatedAt);
  const postScanVerifiedTime = Date.parse(postScanVerifiedAt);
  requireCondition(
    Number.isFinite(generatedTime) &&
      Number.isFinite(postScanVerifiedTime) &&
      Number.isFinite(now) &&
      Number.isFinite(maxAgeMs) &&
      postScanVerifiedTime <= generatedTime &&
      generatedTime <= now,
    'Security evidence, post-scan verification, and current time are out of order.',
  );
  for (const timing of scanTimes.values()) {
    requireCondition(
      timing.startedAt >= now - maxAgeMs && timing.completedAt <= postScanVerifiedTime,
      'Defender scan timing is stale, future-dated, or after post-scan verification.',
    );
  }
  const installerTiming = scanTimes.get('installer');
  const unpackedTiming = scanTimes.get('win-unpacked');
  requireCondition(
    installerTiming.completedAt <= unpackedTiming.startedAt,
    'Defender target scans overlap or are out of their required order.',
  );
  const earliestScanStart = Math.min(...[...scanTimes.values()].map((timing) => timing.startedAt));
  requireCondition(
    isIsoTimestamp(releaseEvidenceGeneratedAt) &&
      Date.parse(releaseEvidenceGeneratedAt) <= earliestScanStart,
    'Release evidence must predate the exact Defender scans.',
  );
  for (const property of ['antivirusSignatureUpdatedAt', 'antispywareSignatureUpdatedAt']) {
    const signatureTime = Date.parse(status[property]);
    requireCondition(
      signatureTime <= earliestScanStart &&
        earliestScanStart - signatureTime <= DEFENDER_SIGNATURE_MAX_AGE_MS,
      `Defender ${property} is stale or newer than the scans it is meant to protect.`,
    );
  }
};

export const verifySecurityEvidence = ({
  manifestBytes,
  candidateManifest,
  candidateManifestBytes,
  releaseManifest,
  releaseManifestBytes,
  dependencySbomBytes,
  packageManager,
  codeqlWorkflowBytes,
  rawReceiptFiles,
  defenderLogFiles,
  source = null,
  now = Date.now(),
  maxAgeMs = SECURITY_EVIDENCE_MAX_AGE_MS,
}) => {
  const { data, value: manifest } = parseJsonBytes(manifestBytes, 'Security evidence');
  requireCondition(
    data.toString('utf8') === canonicalJson(manifest),
    'Security evidence is not canonical JSON.',
  );
  exactKeys(
    manifest,
    [
      'schemaVersion',
      'productName',
      'version',
      'generatedAt',
      'releaseReady',
      'source',
      'candidate',
      'releaseEvidence',
      'dependencySbom',
      'audits',
      'rawReceipts',
      'codeql',
      'defender',
      'codeSigning',
      'postScanVerification',
    ],
    'Security evidence',
  );
  assertPublicSafeJson(manifest);
  exactKeys(
    manifest.source,
    ['commit', 'dirty', 'treeSha256', 'fileCount', 'bytes', 'lockfileSha256'],
    'Security source',
  );
  exactKeys(
    manifest.candidate,
    ['manifestFile', 'manifestSha256', 'manifestSize', 'buildId', 'artifactAggregateSha256'],
    'Security candidate',
  );
  exactKeys(
    manifest.releaseEvidence,
    ['manifestFile', 'manifestSha256', 'manifestSize', 'generatedAt', 'releaseReady'],
    'Security release evidence',
  );
  exactKeys(
    manifest.dependencySbom,
    [
      'fileName',
      'size',
      'sha256',
      'bomFormat',
      'specVersion',
      'serialNumber',
      'componentCount',
      'dependencyRowCount',
      'dependencyEdgeCount',
      'lockfileSha256',
      'packageManager',
      'dependencyScope',
      'generatorCommand',
    ],
    'Security dependency SBOM',
  );
  exactKeys(manifest.audits, ['packageManager', 'production', 'full'], 'Security audits');
  requireCondition(
    manifest.schemaVersion === SECURITY_EVIDENCE_SCHEMA_VERSION &&
      manifest.productName === 'HTMLlelujah' &&
      manifest.version === candidateManifest?.version &&
      isIsoTimestamp(manifest.generatedAt),
    'Security evidence release identity is invalid.',
  );
  requireCondition(
    Number.isFinite(now) &&
      Number.isFinite(maxAgeMs) &&
      maxAgeMs > 0 &&
      Date.parse(manifest.generatedAt) <= now &&
      now - Date.parse(manifest.generatedAt) <= maxAgeMs,
    'Security evidence is stale or dated in the future.',
  );
  requireCondition(candidateManifest?.source?.dirty === false, 'Candidate source is not clean.');
  requireCondition(
    COMMIT.test(candidateManifest.source.commit ?? ''),
    'Candidate commit is malformed.',
  );
  const candidateData = Buffer.isBuffer(candidateManifestBytes)
    ? candidateManifestBytes
    : Buffer.from(candidateManifestBytes);
  const releaseData = Buffer.isBuffer(releaseManifestBytes)
    ? releaseManifestBytes
    : Buffer.from(releaseManifestBytes);
  requireCondition(
    JSON.stringify(JSON.parse(candidateData.toString('utf8'))) ===
      JSON.stringify(candidateManifest),
    'Candidate object differs from its exact manifest bytes.',
  );
  requireCondition(
    JSON.stringify(JSON.parse(releaseData.toString('utf8'))) === JSON.stringify(releaseManifest),
    'Release evidence object differs from its exact manifest bytes.',
  );
  const candidateSha256 = sha256Bytes(candidateData);
  const releaseSha256 = sha256Bytes(releaseData);
  requireCondition(
    manifest.source?.commit === candidateManifest.source.commit &&
      manifest.source?.dirty === false &&
      manifest.source?.treeSha256 === candidateManifest.source.treeSha256 &&
      manifest.source?.fileCount === candidateManifest.source.fileCount &&
      manifest.source?.bytes === candidateManifest.source.bytes &&
      manifest.source?.lockfileSha256 === candidateManifest.lockfile.sha256,
    'Security evidence source does not match the candidate.',
  );
  if (source !== null) {
    requireCondition(
      source.commit === candidateManifest.source.commit &&
        source.dirty === false &&
        source.tree?.sha256 === candidateManifest.source.treeSha256 &&
        source.tree?.fileCount === candidateManifest.source.fileCount &&
        source.tree?.bytes === candidateManifest.source.bytes,
      'Current source snapshot does not match security evidence.',
    );
  }
  requireCondition(
    manifest.candidate?.manifestFile === 'release-candidate-v1.json' &&
      manifest.candidate?.manifestSha256 === candidateSha256 &&
      manifest.candidate?.manifestSize === candidateData.length &&
      manifest.candidate?.buildId === candidateManifest.buildId &&
      manifest.candidate?.artifactAggregateSha256 === candidateManifest.artifact.aggregateSha256,
    'Security evidence candidate binding is invalid.',
  );
  requireCondition(
    releaseManifest?.quality?.releaseReady === true &&
      releaseManifest?.release?.source?.commit === candidateManifest.source.commit &&
      releaseManifest?.artifact?.aggregateSha256 === candidateManifest.artifact.aggregateSha256 &&
      isIsoTimestamp(releaseManifest?.release?.generatedAt) &&
      Date.parse(releaseManifest.release.generatedAt) <= Date.parse(manifest.generatedAt) &&
      manifest.releaseEvidence?.manifestFile === 'release-manifest.json' &&
      manifest.releaseEvidence?.manifestSha256 === releaseSha256 &&
      manifest.releaseEvidence?.manifestSize === releaseData.length &&
      manifest.releaseEvidence?.generatedAt === releaseManifest.release.generatedAt &&
      manifest.releaseEvidence?.releaseReady === true,
    'Security evidence release-manifest binding is invalid.',
  );

  const sbom = inspectDependencySbom({
    bytes: dependencySbomBytes,
    expectedLockfileSha256: candidateManifest.lockfile.sha256,
    expectedPackageManager: packageManager,
  });
  requireCondition(
    canonicalJson(manifest.dependencySbom) === canonicalJson(sbom),
    'Security evidence dependency SBOM identity or graph statistics differ.',
  );
  requireCondition(
    manifest.audits?.packageManager === packageManager,
    'Audit package manager differs.',
  );
  assertAuditEvidence(manifest.audits?.production, 'production');
  assertAuditEvidence(manifest.audits?.full, 'full');
  assertCodeqlEvidence(
    manifest.codeql,
    candidateManifest.source.commit,
    sha256Bytes(codeqlWorkflowBytes),
    manifest.generatedAt,
  );
  verifyRawSecurityReceipts({
    value: manifest.rawReceipts,
    rawReceiptFiles,
    audits: manifest.audits,
    codeql: manifest.codeql,
    commit: candidateManifest.source.commit,
    workflowSha256: sha256Bytes(codeqlWorkflowBytes),
  });
  requireCondition(
    manifest.postScanVerification?.commandId === 'verify-release-evidence' &&
      manifest.postScanVerification?.exitCode === 0 &&
      manifest.postScanVerification?.signal === null &&
      isIsoTimestamp(manifest.postScanVerification?.verifiedAt) &&
      Date.parse(manifest.postScanVerification.verifiedAt) >=
        Date.parse(releaseManifest.release.generatedAt) &&
      manifest.postScanVerification?.candidateManifestSha256 === candidateSha256 &&
      manifest.postScanVerification?.artifactAggregateSha256 ===
        candidateManifest.artifact.aggregateSha256 &&
      manifest.postScanVerification?.releaseManifestSha256 === releaseSha256,
    'Post-scan release-evidence verification is incomplete or stale.',
  );
  exactKeys(
    manifest.postScanVerification,
    [
      'commandId',
      'exitCode',
      'signal',
      'verifiedAt',
      'candidateManifestSha256',
      'artifactAggregateSha256',
      'releaseManifestSha256',
    ],
    'Post-scan verification',
  );
  assertDefender(manifest.defender, candidateManifest, defenderLogFiles, {
    generatedAt: manifest.generatedAt,
    releaseEvidenceGeneratedAt: releaseManifest.release.generatedAt,
    postScanVerifiedAt: manifest.postScanVerification.verifiedAt,
    now,
    maxAgeMs,
  });
  requireCondition(
    manifest.codeSigning?.policy === 'unsigned-v1' &&
      Array.isArray(manifest.codeSigning?.targets) &&
      manifest.codeSigning.targets.length === 2,
    'Unsigned V1 Authenticode evidence must contain exactly two targets.',
  );
  const applicationExecutable = candidateManifest.artifact.files.find(
    (entry) => entry.path === 'win-unpacked/HTMLlelujah.exe',
  );
  requireCondition(
    applicationExecutable !== undefined,
    'Candidate application executable is missing.',
  );
  const unpackedExecutables = candidateManifest.artifact.files.filter(
    (entry) => entry.path.startsWith('win-unpacked/') && /\.exe$/iu.test(entry.path),
  );
  requireCondition(
    unpackedExecutables.length === 1 &&
      unpackedExecutables[0].path === 'win-unpacked/HTMLlelujah.exe',
    'Candidate win-unpacked payload must contain exactly HTMLlelujah.exe and no other executable.',
  );
  const signingTargets = new Map(
    manifest.codeSigning.targets.map((target) => [target.role, target]),
  );
  exactKeys(manifest.codeSigning, ['policy', 'targets'], 'Authenticode evidence');
  requireCondition(signingTargets.size === 2, 'Authenticode targets are duplicated.');
  for (const [role, expected] of [
    ['installer', candidateManifest.artifact.installer],
    ['application-executable', applicationExecutable],
  ]) {
    const target = signingTargets.get(role);
    requireCondition(target !== undefined, `Authenticode target ${role} is missing.`);
    exactKeys(
      target,
      [
        'role',
        'identity',
        'status',
        'signerCertificatePresent',
        'timeStamperCertificatePresent',
        'signerSubject',
        'timeStamperSubject',
      ],
      `Authenticode ${role}`,
    );
    exactKeys(target.identity, ['path', 'size', 'sha256'], `Authenticode ${role} identity`);
    assertIdentity(target.identity, expected, `Authenticode ${role}`);
    requireCondition(
      target.status === 'NotSigned' &&
        target.signerCertificatePresent === false &&
        target.timeStamperCertificatePresent === false &&
        target.signerSubject === null &&
        target.timeStamperSubject === null,
      `Authenticode target ${role} must be exactly NotSigned with no signer or timestamper.`,
    );
  }
  requireCondition(manifest.releaseReady === true, 'Security evidence is not release-ready.');
  return {
    manifest,
    manifestSize: data.length,
    manifestSha256: sha256Bytes(data),
    dependencySbom: sbom,
  };
};
