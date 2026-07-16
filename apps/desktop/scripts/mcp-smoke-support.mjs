export const MCP_V1_CASE_IDS = Object.freeze([
  'MCP-001',
  'MCP-002',
  'MCP-003',
  'MCP-004',
  'MCP-005',
  'MCP-006',
  'MCP-007',
  'MCP-008',
  'MCP-009',
]);

export const EXPECTED_MCP_TOOL_NAMES = Object.freeze([
  'app_status',
  'assets_request_import',
  'collaboration_status',
  'documents_commit_proposal',
  'documents_get_outline',
  'documents_get_styles',
  'documents_list',
  'documents_propose_commands',
  'documents_request_export',
  'documents_undo_agent_transaction',
  'documents_validate',
  'slides_get',
]);

export const SAFE_MCP_ERROR_CODES = Object.freeze([
  'APPROVAL_EXPIRED',
  'APPROVAL_REQUIRED',
  'INVALID_REQUEST',
  'MCP_UNAUTHORIZED',
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'SERVICE_UNAVAILABLE',
]);

const SAFE_ERROR_CODE_SET = new Set(SAFE_MCP_ERROR_CODES);
const FORBIDDEN_EVIDENCE_KEYS =
  /(?:approval|capability|descriptor|documentId|nonce|path|pipe|proposalId|revision|secret|sessionId|transactionId|userData)/iu;
const FORBIDDEN_EVIDENCE_TEXT = [
  /(?:^|\s)[a-z]:[\\/]/iu,
  /\\\\\.\\pipe\\/iu,
  /\/(?:home|users)\//iu,
  /approval-[a-z0-9_-]{16,}/iu,
];
const FORBIDDEN_SAFE_RESULT_KEYS = /^(?:bytes|filePath|html|nonce|path|pipeName|secret|url)$/iu;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message) => {
  throw new Error(message);
};

export const assertExactToolCatalog = (tools) => {
  if (!Array.isArray(tools)) fail('MCP tools/list did not return an array.');
  const names = tools.map((tool) => (isRecord(tool) ? tool.name : undefined));
  if (names.some((name) => typeof name !== 'string')) {
    fail('MCP tools/list contained an invalid tool descriptor.');
  }
  const unique = new Set(names);
  if (unique.size !== names.length) fail('MCP tools/list contained duplicate tool names.');
  const actual = [...unique].sort((left, right) => left.localeCompare(right, 'en'));
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_MCP_TOOL_NAMES)) {
    fail('MCP tool catalog did not match the V1 allowlist exactly.');
  }
  for (const tool of tools) {
    if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
      fail(`MCP tool ${tool.name} did not expose an object input schema.`);
    }
  }
  return actual;
};

const parseTextContent = (result) => {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    fail('MCP tool response did not contain a content array.');
  }
  const textItems = result.content.filter(
    (item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string',
  );
  if (textItems.length !== 1) fail('MCP tool response did not contain exactly one text result.');
  try {
    return JSON.parse(textItems[0].text);
  } catch {
    return fail('MCP tool response text was not valid JSON.');
  }
};

export const decodeToolResponse = (response) => {
  if (!isRecord(response) || response.jsonrpc !== '2.0' || response.id === undefined) {
    fail('MCP response envelope was invalid.');
  }
  if (response.error !== undefined) {
    if (!isRecord(response.error) || typeof response.error.code !== 'number') {
      fail('MCP JSON-RPC error envelope was invalid.');
    }
    return {
      ok: false,
      error: {
        code: 'JSON_RPC_ERROR',
        category: response.error.code,
      },
    };
  }
  const payload = parseTextContent(response.result);
  if (response.result.isError === true) {
    if (
      !isRecord(payload) ||
      !isRecord(payload.error) ||
      typeof payload.error.code !== 'string' ||
      typeof payload.error.message !== 'string' ||
      !SAFE_ERROR_CODE_SET.has(payload.error.code)
    ) {
      fail('MCP tool returned an unsafe or malformed error.');
    }
    assertSafeDiagnostic(payload.error.message);
    return { ok: false, error: { code: payload.error.code } };
  }
  return { ok: true, value: payload };
};

export const assertToolError = (outcome, expectedCodes) => {
  if (outcome?.ok !== false || typeof outcome.error?.code !== 'string') {
    fail('MCP operation unexpectedly succeeded.');
  }
  const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  if (!allowed.includes(outcome.error.code)) {
    fail(`MCP operation returned ${outcome.error.code} instead of the expected safe error.`);
  }
  return outcome.error.code;
};

export const assertSafeDiagnostic = (text, forbiddenValues = []) => {
  if (typeof text !== 'string') fail('MCP diagnostic was not text.');
  if (Buffer.byteLength(text, 'utf8') > 8_192) fail('MCP diagnostic exceeded its smoke bound.');
  for (const pattern of FORBIDDEN_EVIDENCE_TEXT) {
    if (pattern.test(text)) fail('MCP diagnostic exposed a local path or capability.');
  }
  for (const value of forbiddenValues) {
    if (typeof value === 'string' && value.length > 0 && text.includes(value)) {
      fail('MCP diagnostic exposed authenticated endpoint material.');
    }
  }
  return true;
};

export const assertProtocolStdout = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.byteLength > 8 * 1024 * 1024) fail('MCP stdout exceeded the smoke capture bound.');
  const text = buffer.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(buffer) !== 0) {
    fail('MCP stdout was not canonical UTF-8 text.');
  }
  const lines = text.split('\n');
  if (lines.at(-1) !== '') fail('MCP stdout ended with an incomplete protocol frame.');
  const frames = [];
  for (const line of lines.slice(0, -1)) {
    if (line.length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      fail('MCP stdout contained non-JSON protocol data.');
    }
    if (!isRecord(frame) || frame.jsonrpc !== '2.0' || frame.id === undefined) {
      fail('MCP stdout contained a non-response protocol frame.');
    }
    const keys = Object.keys(frame);
    if (
      keys.some((key) => !['jsonrpc', 'id', 'result', 'error'].includes(key)) ||
      (frame.result === undefined) === (frame.error === undefined)
    ) {
      fail('MCP stdout contained an invalid JSON-RPC response envelope.');
    }
    frames.push(frame);
  }
  return frames.length;
};

export const assertSafeProjection = (value, label = 'MCP projection') => {
  const seen = new Set();
  let nodes = 0;
  const visit = (candidate, depth) => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) fail(`${label} exceeded the bounded smoke projection.`);
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) fail(`${label} contained a cyclic value.`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else {
      for (const [key, item] of Object.entries(candidate)) {
        if (FORBIDDEN_SAFE_RESULT_KEYS.test(key)) {
          fail(`${label} exposed forbidden field ${key}.`);
        }
        visit(item, depth + 1);
      }
    }
    seen.delete(candidate);
  };
  visit(value, 0);
  return true;
};

export const comparableDocumentState = (outline) => {
  if (!isRecord(outline)) fail('MCP outline was not an object.');
  return JSON.stringify({
    documentId: outline.documentId,
    revision: outline.revision,
    name: outline.name,
    page: outline.page,
    slides: outline.slides,
  });
};

export const assertDocumentUnchanged = (before, after) => {
  if (comparableDocumentState(before) !== comparableDocumentState(after)) {
    fail('An MCP preview or rejected operation mutated the document.');
  }
  return true;
};

export const assertRevisionAdvanced = (before, after) => {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) {
    fail('MCP mutation did not advance the opaque document revision.');
  }
  return true;
};

export const createCaseRecorder = () => {
  const entries = new Map();
  let activeCase;
  const begin = (caseId) => {
    if (!MCP_V1_CASE_IDS.includes(caseId)) fail(`Unknown MCP smoke case ${caseId}.`);
    activeCase = caseId;
  };
  const pass = (caseId, assertions, coverage = 'packaged') => {
    if (!MCP_V1_CASE_IDS.includes(caseId)) fail(`Unknown MCP smoke case ${caseId}.`);
    if (!Array.isArray(assertions) || assertions.length === 0) {
      fail(`MCP smoke case ${caseId} has no assertions.`);
    }
    entries.set(caseId, { status: 'passed', coverage, assertions: [...assertions] });
    activeCase = undefined;
  };
  return {
    begin,
    pass,
    get activeCase() {
      return activeCase;
    },
    evidence() {
      return MCP_V1_CASE_IDS.map((caseId) => {
        const entry = entries.get(caseId);
        if (entry === undefined) fail(`MCP smoke case ${caseId} was not completed.`);
        return { id: caseId, ...entry };
      });
    },
  };
};

export const assertEvidenceSafe = (evidence) => {
  let nodes = 0;
  const visit = (value, key = '', depth = 0) => {
    nodes += 1;
    if (nodes > 20_000 || depth > 32) fail('MCP evidence exceeded its structural bound.');
    if (key !== '' && FORBIDDEN_EVIDENCE_KEYS.test(key)) {
      fail(`MCP evidence contained forbidden key ${key}.`);
    }
    if (typeof value === 'string') {
      for (const pattern of FORBIDDEN_EVIDENCE_TEXT) {
        if (pattern.test(value)) fail('MCP evidence contained a local path or capability.');
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, '', depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
    }
  };
  visit(evidence);
  const encoded = JSON.stringify(evidence);
  if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) {
    fail('MCP evidence exceeded 64 KiB.');
  }
  return true;
};

export const createMcpEvidence = ({
  generatedAt,
  mode,
  platform,
  architecture,
  version,
  artifact,
  cases,
  protocolFrameCount,
  processCount,
  limitations = [],
}) => {
  if (!Array.isArray(cases) || cases.length !== MCP_V1_CASE_IDS.length) {
    fail('MCP evidence did not contain every V1 case.');
  }
  if (
    cases.some(
      (entry, index) =>
        entry?.id !== MCP_V1_CASE_IDS[index] ||
        entry.status !== 'passed' ||
        !Array.isArray(entry.assertions) ||
        entry.assertions.length === 0,
    )
  ) {
    fail('MCP evidence contained an incomplete or failed V1 case.');
  }
  const evidence = {
    schemaVersion: 1,
    generatedAt,
    product: 'HTMLlelujah',
    version,
    target: { mode, platform, architecture, artifact },
    result: 'passed',
    protocol: {
      transport: 'stdio-json-rpc',
      frameCount: protocolFrameCount,
      processCount,
      stdoutPurity: true,
    },
    cases,
    limitations,
  };
  assertEvidenceSafe(evidence);
  return evidence;
};

export const createMcpFailureEvidence = ({ generatedAt, mode, platform, architecture, stage }) => {
  if (stage !== 'startup' && !MCP_V1_CASE_IDS.includes(stage)) {
    fail('MCP failure evidence stage was invalid.');
  }
  const evidence = {
    schemaVersion: 1,
    generatedAt,
    product: 'HTMLlelujah',
    target: { mode, platform, architecture },
    result: 'failed',
    failure: { stage, code: 'MCP_SMOKE_FAILED' },
  };
  assertEvidenceSafe(evidence);
  return evidence;
};
