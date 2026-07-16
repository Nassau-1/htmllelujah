import { createHash } from 'node:crypto';

export const FUNCTIONAL_VALIDATION_SCHEMA_VERSION = 1;
export const FUNCTIONAL_VALIDATION_FILE_NAME = 'v1-functional-validation.json';
export const FUNCTIONAL_VALIDATION_BUNDLE_NAME = 'v1-functional-validation-evidence.zip';
export const DEFAULT_LAN_DURATION_MS = 30 * 60 * 1_000;

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const PRIVATE_TEXT_PATTERNS = [
  /\b[a-z]:[\\/]/iu,
  /(?:^|[\s"'])\/[Uu]sers\/[^/\s"'<>]+/u,
  /(?:^|[\s"'])\/home\/[^/\s"'<>]+/u,
  /file:\/\//iu,
  /\\\\[^\\\s"']+\\[^\\\s"']+/u,
  /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/u,
  /\b[0-9a-f]{0,4}::[0-9a-f:]{0,39}\b/iu,
  /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/iu,
];
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'absolutepath',
  'computername',
  'hostname',
  'ipaddress',
  'repositoryroot',
  'machinename',
  'temporarydirectory',
  'userprofile',
]);

const requiredGate = (id, evidence) => Object.freeze({ id, required: true, evidence });

export const REQUIRED_FUNCTIONAL_GATES = Object.freeze([
  requiredGate('source-verify', [{ originalName: 'receipt.json', role: 'receipt' }]),
  requiredGate('ui-packaged', [
    { originalName: 'v1-editor-electron.json', role: 'report' },
    { originalName: 'v1-editor-electron.png', role: 'screenshot' },
    { originalName: 'v1-presentation-electron.png', role: 'screenshot' },
  ]),
  requiredGate('exports-widescreen', [
    { originalName: 'system-exports-v1-widescreen.json', role: 'report' },
    { originalName: 'v1-standalone-html-widescreen.png', role: 'screenshot' },
    { originalName: 'v1-pdf-widescreen.png', role: 'screenshot' },
  ]),
  requiredGate('exports-standard', [
    { originalName: 'system-exports-v1-standard.json', role: 'report' },
    { originalName: 'v1-standalone-html-standard.png', role: 'screenshot' },
    { originalName: 'v1-pdf-standard.png', role: 'screenshot' },
  ]),
  requiredGate('exports-a4-landscape', [
    { originalName: 'system-exports-v1-a4-landscape.json', role: 'report' },
    { originalName: 'v1-standalone-html-a4-landscape.png', role: 'screenshot' },
    { originalName: 'v1-pdf-a4-landscape.png', role: 'screenshot' },
  ]),
  requiredGate('exports-stress-50', [
    { originalName: 'system-exports-v1-stress-widescreen.json', role: 'report' },
  ]),
  requiredGate('mcp-packaged', [{ originalName: 'mcp-v1.json', role: 'report' }]),
  requiredGate('accessibility-scaling', [
    { originalName: 'v1-accessibility-scaling.json', role: 'report' },
    { originalName: 'v1-accessibility-scale-100.png', role: 'screenshot' },
    { originalName: 'v1-accessibility-scale-125.png', role: 'screenshot' },
    { originalName: 'v1-accessibility-scale-150.png', role: 'screenshot' },
    { originalName: 'v1-accessibility-scale-200.png', role: 'screenshot' },
  ]),
  requiredGate('text-lock-two-process', [
    { originalName: 'text-lock-ui-system-v1.json', role: 'report' },
    { originalName: 'text-lock-host-owned-v1.png', role: 'screenshot' },
    { originalName: 'text-lock-guest-blocked-v1.png', role: 'screenshot' },
    { originalName: 'text-lock-guest-owned-v1.png', role: 'screenshot' },
  ]),
  requiredGate('single-instance-final-artifact', [
    { originalName: 'single-instance-windows-v1.json', role: 'report' },
  ]),
  requiredGate('installer-lifecycle', [
    { originalName: 'installer-v1.json', role: 'report' },
    { originalName: 'v1-editor-electron.json', role: 'installed-ui-report' },
    { originalName: 'v1-editor-electron.png', role: 'installed-ui-screenshot' },
    { originalName: 'v1-presentation-electron.png', role: 'installed-ui-screenshot' },
    { originalName: 'mcp-v1.json', role: 'installed-mcp-report' },
  ]),
  requiredGate('benchmark-core', [{ originalName: 'benchmark-v1.json', role: 'report' }]),
  requiredGate('benchmark-capacity-presentation', [
    { originalName: 'benchmark-capacity-presentation-v1.json', role: 'report' },
  ]),
  requiredGate('benchmark-expanded-limit', [
    { originalName: 'expanded-limit-benchmark-v1.json', role: 'report' },
  ]),
  requiredGate('lan-loopback-soak', [{ originalName: 'lan-soak-v1.json', role: 'report' }]),
]);

export const expectedPublicGateInvocation = (gateId, { lanMinutes }) => {
  const node = (script, argv = [], environment = []) => ({
    commandId: 'node',
    argv: [`apps/desktop/scripts/${script}`, ...argv],
    environment: [...environment].sort((left, right) => left.localeCompare(right, 'en')),
  });
  const packagedEnvironment = ['HTMLLELUJAH_EXECUTABLE=<candidate-executable>'];
  const invocations = {
    'source-verify': {
      commandId: 'corepack-pnpm',
      argv: ['pnpm', 'verify'],
      environment: [],
    },
    'ui-packaged': node('smoke-ui-electron.mjs', [], packagedEnvironment),
    'exports-widescreen': node(
      'smoke-system-exports-windows.mjs',
      [],
      [...packagedEnvironment, 'HTMLLELUJAH_EXPORT_PAGE_PRESET=widescreen'],
    ),
    'exports-standard': node(
      'smoke-system-exports-windows.mjs',
      [],
      [...packagedEnvironment, 'HTMLLELUJAH_EXPORT_PAGE_PRESET=standard'],
    ),
    'exports-a4-landscape': node(
      'smoke-system-exports-windows.mjs',
      [],
      [...packagedEnvironment, 'HTMLLELUJAH_EXPORT_PAGE_PRESET=a4-landscape'],
    ),
    'exports-stress-50': node(
      'smoke-system-exports-windows.mjs',
      ['--stress-count', '50'],
      [...packagedEnvironment, 'HTMLLELUJAH_EXPORT_PAGE_PRESET=widescreen'],
    ),
    'mcp-packaged': node(
      'smoke-mcp-electron.mjs',
      [],
      [
        ...packagedEnvironment,
        'HTMLLELUJAH_MCP_EVIDENCE=<gate-evidence-report>',
        'HTMLLELUJAH_MCP_LAUNCHER=<candidate-launcher>',
      ],
    ),
    'accessibility-scaling': node(
      'smoke-accessibility-scaling-windows.mjs',
      [],
      [...packagedEnvironment, 'HTMLLELUJAH_SCALE_FACTORS=1,1.25,1.5,2'],
    ),
    'text-lock-two-process': node('smoke-text-lock-ui-system.mjs', [], packagedEnvironment),
    'single-instance-final-artifact': node('smoke-single-instance-windows.mjs', [
      '<candidate-installer>',
      '--final-artifact',
    ]),
    'installer-lifecycle': node('smoke-installer-windows.mjs', [
      '<candidate-installer>',
      '--final-artifact',
    ]),
    'benchmark-core': {
      commandId: 'corepack-pnpm',
      argv: [
        'pnpm',
        'exec',
        'tsx',
        'apps/desktop/scripts/benchmark-v1.ts',
        '--output',
        '<gate-evidence-report>',
      ],
      environment: [],
    },
    'benchmark-capacity-presentation': {
      commandId: 'corepack-pnpm',
      argv: [
        'pnpm',
        'exec',
        'tsx',
        'apps/desktop/scripts/benchmark-capacity-presentation-v1.ts',
        '--output',
        '<gate-evidence-report>',
      ],
      environment: [],
    },
    'benchmark-expanded-limit': {
      commandId: 'corepack-pnpm',
      argv: ['pnpm', 'exec', 'tsx', 'apps/desktop/scripts/benchmark-expanded-limit-v1.ts'],
      environment: [],
    },
    'lan-loopback-soak': {
      commandId: 'corepack-pnpm',
      argv: [
        'pnpm',
        'exec',
        'tsx',
        'apps/desktop/scripts/lan-soak-v1.ts',
        '--minutes',
        String(lanMinutes),
        '--report',
        '<gate-evidence-report>',
      ],
      environment: [],
    },
  };
  const invocation = invocations[gateId];
  if (invocation === undefined) throw new Error(`Unknown functional gate invocation: ${gateId}.`);
  return invocation;
};

export const expectedGateScope = (gateId) => {
  if (
    [
      'ui-packaged',
      'exports-widescreen',
      'exports-standard',
      'exports-a4-landscape',
      'exports-stress-50',
      'mcp-packaged',
      'accessibility-scaling',
      'text-lock-two-process',
    ].includes(gateId)
  ) {
    return 'packaged-unpacked';
  }
  if (['single-instance-final-artifact', 'installer-lifecycle'].includes(gateId)) {
    return 'installed-lifecycle';
  }
  if (gateId === 'lan-loopback-soak') return 'loopback-source-harness';
  if (
    [
      'source-verify',
      'benchmark-core',
      'benchmark-capacity-presentation',
      'benchmark-expanded-limit',
    ].includes(gateId)
  ) {
    return 'source-harness';
  }
  throw new Error(`Unknown functional gate scope: ${gateId}.`);
};

export const AUTOMATED_SCOPE_LIMITATIONS = Object.freeze([
  {
    id: 'source-benchmark-scope',
    gates: ['benchmark-core', 'benchmark-capacity-presentation', 'benchmark-expanded-limit'],
    limitation:
      'These benchmarks execute the candidate-bound TypeScript source harness, not the packaged executable or installed application.',
  },
  {
    id: 'lan-soak-scope',
    gates: ['lan-loopback-soak'],
    limitation:
      'The LAN soak executes three collaboration participants in one source-harness process over WSS loopback, not the packaged executable or separate machines.',
  },
]);

export const EXTERNAL_VALIDATION_LIMITATIONS = Object.freeze([
  {
    id: 'multi-machine-lan',
    required: false,
    status: 'not-run',
    limitation:
      'The automated gate uses three participants in one process over WSS loopback, not separate machines.',
  },
  {
    id: 'clean-windows-account',
    required: false,
    status: 'not-run',
    limitation: 'A dedicated newly-created Windows account is outside this local automated gate.',
  },
  {
    id: 'narrator-nvda',
    required: false,
    status: 'not-run',
    limitation: 'CDP accessibility checks do not simulate Narrator or NVDA.',
  },
  {
    id: 'physical-displays',
    required: false,
    status: 'not-run',
    limitation:
      'Forced scale factors do not cover physical display, GPU, and multi-monitor combinations.',
  },
  {
    id: 'smb-nas-shared-file',
    required: false,
    status: 'not-run',
    limitation: 'SMB and NAS shared-file behavior requires external infrastructure.',
  },
  {
    id: 'offline-machine',
    required: false,
    status: 'not-run',
    limitation: 'A physically disconnected Windows machine is outside this automated gate.',
  },
]);

export const buildPublicValidationEnvironment = ({
  platform,
  architecture,
  osRelease,
  osVersion,
  nodeVersion,
  packageManager,
  installerReport,
}) => {
  if (
    platform !== 'win32' ||
    architecture !== 'x64' ||
    typeof osRelease !== 'string' ||
    osRelease.length === 0 ||
    typeof osVersion !== 'string' ||
    osVersion.length === 0 ||
    typeof nodeVersion !== 'string' ||
    !/^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageManager ?? '') ||
    installerReport?.checks?.nonElevatedCurrentUserToken !== true ||
    installerReport?.checks?.dedicatedNonAdministratorAccount !== 'not-tested'
  ) {
    throw new Error('Public validation environment inputs are incomplete or unverified.');
  }
  const build = osRelease.split('.').at(-1);
  if (!/^\d+$/u.test(build ?? '')) throw new Error('Windows build number is unavailable.');
  return {
    os: { platform: 'Windows', release: osRelease, version: osVersion, build },
    runtime: {
      platform,
      architecture,
      node: nodeVersion,
      packageManager,
      packageManagerLocked: true,
    },
    token: {
      elevated: false,
      system: false,
      dedicatedCleanAccount: false,
    },
    display: {
      forcedScaleFactors: [1, 1.25, 1.5, 2],
      physicalDisplays: { required: false, status: 'not-run' },
    },
    network: { topology: 'single-host-loopback', addressesRecorded: false },
  };
};

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const safeNumber = (value, minimum = 0) => Number.isFinite(value) && value >= minimum;
const validDate = (value) =>
  typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));

export const sha256Bytes = (value) => createHash('sha256').update(value).digest('hex');

export const aggregateEvidenceInventory = (entries) => {
  const digest = createHash('sha256');
  for (const entry of entries) {
    digest.update(entry.path);
    digest.update('\0');
    digest.update(String(entry.size));
    digest.update('\0');
    digest.update(entry.sha256);
    digest.update('\n');
  }
  return digest.digest('hex');
};

export const safeEvidencePath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 240 &&
  !value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.endsWith('/') &&
  !/^[a-z]:\//iu.test(value) &&
  !value.includes('\\') &&
  !value.includes('//') &&
  !value.split('/').includes('..') &&
  !value.split('/').includes('.') &&
  !value.includes('\0');

const collectForbiddenKeys = (value, findings = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectForbiddenKeys(item, findings);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key.toLowerCase())) findings.push(key);
      collectForbiddenKeys(item, findings);
    }
  }
  return findings;
};

const collectStringValues = (value, strings = []) => {
  if (typeof value === 'string') strings.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, strings);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectStringValues(item, strings);
  }
  return strings;
};

export const publicEvidenceJsonErrors = (bytes) => {
  const errors = [];
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    return ['JSON evidence bytes are unavailable'];
  }
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) {
    errors.push('JSON evidence size is outside public bundle bounds');
    return errors;
  }
  let value;
  try {
    value = jsonObjectFromBytes(bytes, {
      label: 'JSON evidence',
      canonical: true,
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'JSON evidence is invalid');
    return errors;
  }
  const text = Buffer.from(bytes).toString('utf8');
  const inspectedStrings = [text, ...collectStringValues(value)];
  for (const pattern of PRIVATE_TEXT_PATTERNS) {
    if (inspectedStrings.some((item) => pattern.test(item))) {
      errors.push('JSON evidence contains a private path or address');
    }
  }
  if (collectForbiddenKeys(value).length > 0) {
    errors.push('JSON evidence contains forbidden environment identity keys');
  }
  return [...new Set(errors)];
};

const assertNoDuplicateJsonKeys = (text, label) => {
  let offset = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(text[offset] ?? '')) offset += 1;
  };
  const scanString = () => {
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      if (text[offset] === '\\') {
        offset += text[offset + 1] === 'u' ? 6 : 2;
      } else {
        offset += 1;
      }
    }
    throw new Error(`${label} contains an unterminated JSON string.`);
  };
  const scanValue = () => {
    skipWhitespace();
    if (text[offset] === '{') {
      offset += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        if (text[offset] !== '"') throw new Error(`${label} contains invalid JSON object syntax.`);
        const key = scanString();
        if (keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${key}.`);
        keys.add(key);
        skipWhitespace();
        if (text[offset] !== ':') throw new Error(`${label} contains invalid JSON object syntax.`);
        offset += 1;
        scanValue();
        skipWhitespace();
        if (text[offset] === '}') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') throw new Error(`${label} contains invalid JSON object syntax.`);
        offset += 1;
        skipWhitespace();
      }
      throw new Error(`${label} contains an unterminated JSON object.`);
    }
    if (text[offset] === '[') {
      offset += 1;
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        scanValue();
        skipWhitespace();
        if (text[offset] === ']') {
          offset += 1;
          return;
        }
        if (text[offset] !== ',') throw new Error(`${label} contains invalid JSON array syntax.`);
        offset += 1;
      }
      throw new Error(`${label} contains an unterminated JSON array.`);
    }
    if (text[offset] === '"') {
      scanString();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset])) offset += 1;
    if (offset === start) throw new Error(`${label} contains an invalid JSON value.`);
  };

  try {
    scanValue();
    skipWhitespace();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} contains invalid JSON syntax.`, { cause: error });
  }
  if (offset !== text.length) throw new Error(`${label} contains trailing JSON data.`);
};

const exactBytes = (bytes, label) => {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error(`${label} bytes are unavailable.`);
  }
  return Buffer.from(bytes);
};

const jsonObjectFromBytes = (bytes, { label, canonical }) => {
  const data = exactBytes(bytes, label);
  if (data.length === 0) throw new Error(`${label} bytes are empty.`);
  const text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) throw new Error(`${label} is not valid UTF-8.`);
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON or contains trailing JSON data.`, { cause: error });
  }
  assertNoDuplicateJsonKeys(text, label);
  if (!isRecord(value)) throw new Error(`${label} JSON root must be an object.`);
  if (canonical) {
    const expected = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (!data.equals(expected)) {
      throw new Error(`${label} bytes are not canonical two-space JSON with one final newline.`);
    }
  }
  return value;
};

const stableJsonText = (value, seen = new Set()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Candidate manifest object is cyclic.');
    seen.add(value);
    const result = `[${value.map((item) => stableJsonText(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (seen.has(value)) throw new Error('Candidate manifest object is cyclic.');
    seen.add(value);
    const result = `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key], seen)}`)
      .join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw new Error('Candidate manifest object contains a non-JSON value.');
};

export const publicPngErrors = (bytes) => {
  const data = Buffer.from(bytes ?? []);
  const errors = [];
  if (data.length < 33 || data.length > 40 * 1024 * 1024) {
    return ['PNG evidence size is outside public bundle bounds'];
  }
  if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return ['Screenshot evidence is not PNG'];
  }
  let offset = 8;
  let sawEnd = false;
  let chunkIndex = 0;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    if (length > 32 * 1024 * 1024 || offset + 12 + length > data.length) {
      errors.push('PNG evidence contains an invalid chunk');
      break;
    }
    const storedCrc = data.readUInt32BE(offset + 8 + length);
    const computedCrc = crc32(data.subarray(offset + 4, offset + 8 + length));
    if (storedCrc !== computedCrc) errors.push('PNG evidence contains an invalid chunk CRC');
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) {
      errors.push('PNG evidence does not begin with a valid IHDR chunk');
    }
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf'].includes(type)) {
      errors.push('PNG evidence contains public-unsafe textual metadata');
    }
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0) errors.push('PNG IEND chunk is invalid');
      sawEnd = true;
      break;
    }
    chunkIndex += 1;
  }
  if (!sawEnd || offset !== data.length)
    errors.push('PNG evidence is truncated or has trailing data');
  return errors;
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const zipDateTime = (isoTimestamp) => {
  const date = new Date(isoTimestamp);
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
  };
};

export const createPublicEvidenceZip = (entries, generatedAt) => {
  if (!validDate(generatedAt)) throw new Error('ZIP generation requires an ISO UTC timestamp.');
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  if (sorted.length === 0 || sorted.length > 0xffff) {
    throw new Error('ZIP evidence entry count is outside V1 bounds.');
  }
  if (new Set(sorted.map((entry) => entry.path)).size !== sorted.length) {
    throw new Error('ZIP evidence paths must be unique.');
  }
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = zipDateTime(generatedAt);
  for (const entry of sorted) {
    if (!safeEvidencePath(entry.path)) throw new Error(`Unsafe ZIP evidence path: ${entry.path}.`);
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.from(entry.bytes);
    if (name.length > 0xffff || data.length > 0xffffffff) {
      throw new Error('ZIP evidence entry exceeds V1 bounds.');
    }
    const checksum = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

export const readPublicEvidenceZipEntries = (bytes) => {
  const data = Buffer.from(bytes);
  if (data.length < 22 || data.readUInt32LE(data.length - 22) !== 0x06054b50) {
    throw new Error('ZIP end-of-central-directory record is missing or not final.');
  }
  const endOffset = data.length - 22;
  const diskNumber = data.readUInt16LE(endOffset + 4);
  const centralDisk = data.readUInt16LE(endOffset + 6);
  const diskEntryCount = data.readUInt16LE(endOffset + 8);
  const entryCount = data.readUInt16LE(endOffset + 10);
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  const commentLength = data.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0 ||
    commentLength !== 0 ||
    centralOffset + centralSize !== endOffset
  ) {
    throw new Error('ZIP central-directory bounds or counts are invalid.');
  }
  const entries = [];
  let offset = 0;
  while (offset < centralOffset) {
    if (offset + 30 > centralOffset || data.readUInt32LE(offset) !== 0x04034b50) {
      throw new Error('ZIP local header is truncated or invalid.');
    }
    const flags = data.readUInt16LE(offset + 6);
    const method = data.readUInt16LE(offset + 8);
    const checksum = data.readUInt32LE(offset + 14);
    const compressedSize = data.readUInt32LE(offset + 18);
    const size = data.readUInt32LE(offset + 22);
    const nameLength = data.readUInt16LE(offset + 26);
    const extraLength = data.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const contentEnd = contentStart + compressedSize;
    if (
      flags !== 0x0800 ||
      method !== 0 ||
      compressedSize !== size ||
      nameLength === 0 ||
      extraLength !== 0 ||
      contentEnd > centralOffset
    ) {
      throw new Error('ZIP local entry flags, method, sizes, or bounds are invalid.');
    }
    const nameBytes = data.subarray(nameStart, nameStart + nameLength);
    const entryPath = nameBytes.toString('utf8');
    if (!Buffer.from(entryPath, 'utf8').equals(nameBytes)) {
      throw new Error('ZIP local entry name is not valid UTF-8.');
    }
    if (!safeEvidencePath(entryPath)) throw new Error('ZIP contains an unsafe path.');
    const content = data.subarray(contentStart, contentEnd);
    if (crc32(content) !== checksum) throw new Error('ZIP entry CRC does not match its bytes.');
    entries.push({
      path: entryPath,
      nameBytes: Buffer.from(nameBytes),
      bytes: content,
      checksum,
      localOffset: offset,
    });
    offset = contentEnd;
  }
  if (offset !== centralOffset || entries.length !== entryCount) {
    throw new Error('ZIP local entry count or central-directory offset is inconsistent.');
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error('ZIP contains duplicate entry names.');
  }

  let centralCursor = centralOffset;
  for (const local of entries) {
    if (centralCursor + 46 > endOffset || data.readUInt32LE(centralCursor) !== 0x02014b50) {
      throw new Error('ZIP central entry is truncated or invalid.');
    }
    const flags = data.readUInt16LE(centralCursor + 8);
    const method = data.readUInt16LE(centralCursor + 10);
    const checksum = data.readUInt32LE(centralCursor + 16);
    const compressedSize = data.readUInt32LE(centralCursor + 20);
    const size = data.readUInt32LE(centralCursor + 24);
    const nameLength = data.readUInt16LE(centralCursor + 28);
    const extraLength = data.readUInt16LE(centralCursor + 30);
    const entryCommentLength = data.readUInt16LE(centralCursor + 32);
    const entryDisk = data.readUInt16LE(centralCursor + 34);
    const localOffset = data.readUInt32LE(centralCursor + 42);
    const nameStart = centralCursor + 46;
    const next = nameStart + nameLength + extraLength + entryCommentLength;
    const nameBytes = data.subarray(nameStart, nameStart + nameLength);
    const entryPath = nameBytes.toString('utf8');
    if (!Buffer.from(entryPath, 'utf8').equals(nameBytes)) {
      throw new Error('ZIP central entry name is not valid UTF-8.');
    }
    if (
      next > endOffset ||
      flags !== 0x0800 ||
      method !== 0 ||
      compressedSize !== local.bytes.length ||
      size !== local.bytes.length ||
      checksum !== local.checksum ||
      extraLength !== 0 ||
      entryCommentLength !== 0 ||
      entryDisk !== 0 ||
      localOffset !== local.localOffset ||
      !nameBytes.equals(local.nameBytes)
    ) {
      throw new Error('ZIP central entry differs from its local entry.');
    }
    centralCursor = next;
  }
  if (centralCursor !== endOffset) throw new Error('ZIP central directory has trailing data.');
  return entries.map(({ path: entryPath, bytes: content }) => ({
    path: entryPath,
    bytes: content,
  }));
};

const criticalEntry = (candidate, entryPath) =>
  candidate?.artifact?.files?.find((entry) => entry.path === entryPath) ?? null;

export const candidateTargetIdentity = (candidate) => {
  const installer = candidate?.artifact?.installer;
  const blockmap = candidate?.artifact?.blockmap;
  const executable = criticalEntry(candidate, 'win-unpacked/HTMLlelujah.exe');
  const launcher = criticalEntry(candidate, 'win-unpacked/HTMLlelujah-MCP.cmd');
  const appAsar = criticalEntry(candidate, 'win-unpacked/resources/app.asar');
  const entries = [installer, blockmap, executable, launcher, appAsar];
  if (entries.some((entry) => entry === null || !SHA256.test(entry?.sha256 ?? ''))) {
    throw new Error('Candidate critical target identity is incomplete.');
  }
  const sorted = entries
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return {
    installer,
    blockmap,
    executable,
    launcher,
    appAsar,
    winUnpacked: {
      fileCount: candidate.artifact.winUnpacked.fileCount,
      totalSize: candidate.artifact.winUnpacked.totalSize,
      aggregateSha256: candidate.artifact.winUnpacked.aggregateSha256,
    },
    criticalAggregateSha256: aggregateEvidenceInventory(sorted),
  };
};

const allBooleanValuesTrue = (record, allowedFalse = []) =>
  isRecord(record) &&
  Object.entries(record).every(
    ([key, value]) => typeof value !== 'boolean' || value === true || allowedFalse.includes(key),
  );

const hasTrueKeys = (record, keys) => isRecord(record) && keys.every((key) => record[key] === true);

const exactArray = (left, right) => Array.isArray(left) && jsonEqual(left, right);

const reportForGate = (gate, evidenceFiles) => {
  const report = evidenceFiles.find(
    (entry) =>
      entry.gateId === gate.id && (entry.role.includes('report') || entry.role === 'receipt'),
  );
  if (!report) return null;
  try {
    return jsonObjectFromBytes(report.bytes, {
      label: `${gate.id} report`,
      canonical: true,
    });
  } catch {
    return null;
  }
};

const reportTimeWithinGate = (report, gate) => {
  const primary = report?.testedAt ?? report?.generatedAt ?? report?.startedAt;
  if (!validDate(primary)) return false;
  const values = [primary, report?.completedAt, report?.endedAt].filter(
    (value) => value !== undefined,
  );
  if (values.some((value) => !validDate(value))) return false;
  const start = Date.parse(gate.startedAt) - 5_000;
  const end = Date.parse(gate.completedAt) + 5_000;
  if (values.some((value) => Date.parse(value) < start || Date.parse(value) > end)) return false;
  const final = report?.completedAt ?? report?.endedAt;
  return final === undefined || Date.parse(final) >= Date.parse(primary);
};

export const expectedGateThresholdRecords = (gateId, report) => {
  if (gateId === 'ui-packaged') {
    return [
      {
        id: 'interactive-ready',
        measuredMs: report?.performance?.interactiveReadyMs,
        thresholdInclusiveMs: 3_000,
        passed:
          Number.isFinite(report?.performance?.interactiveReadyMs) &&
          report.performance?.warmStartBudgetMs === 3_000 &&
          report.performance.interactiveReadyMs <= 3_000,
      },
    ];
  }
  if (gateId === 'benchmark-core') {
    return [
      {
        id: 'gesture-p95',
        measuredMs: report?.gesture?.p95Ms,
        thresholdExclusiveMs: 16.7,
        passed:
          Number.isFinite(report?.gesture?.p95Ms) &&
          report.gesture?.thresholdMs === 16.7 &&
          report.gesture.p95Ms < 16.7,
      },
      {
        id: 'command-p95',
        measuredMs: report?.runtime?.commandP95Ms,
        thresholdExclusiveMs: 100,
        passed:
          Number.isFinite(report?.runtime?.commandP95Ms) &&
          report.runtime?.commandThresholdMs === 100 &&
          report.runtime.commandP95Ms < 100,
      },
    ];
  }
  if (gateId === 'benchmark-capacity-presentation') {
    return [
      {
        id: 'presentation-navigation-p95',
        measuredMs: report?.presentationNavigation?.p95Ms,
        thresholdExclusiveMs: 100,
        passed:
          Number.isFinite(report?.presentationNavigation?.p95Ms) &&
          report.presentationNavigation?.thresholdMs === 100 &&
          report.presentationNavigation.p95Ms < 100,
      },
    ];
  }
  if (gateId === 'benchmark-expanded-limit') {
    return [
      {
        id: 'save-duration',
        measuredMs: report?.measurements?.saveMs,
        thresholdExclusiveMs: 120_000,
        passed:
          Number.isFinite(report?.measurements?.saveMs) && report.measurements.saveMs < 120_000,
      },
      {
        id: 'reopen-duration',
        measuredMs: report?.measurements?.reopenMs,
        thresholdExclusiveMs: 120_000,
        passed:
          Number.isFinite(report?.measurements?.reopenMs) && report.measurements.reopenMs < 120_000,
      },
      {
        id: 'peak-rss',
        measuredMiB: report?.measurements?.peakRssMiB,
        thresholdExclusiveMiB: 6_144,
        passed:
          Number.isFinite(report?.measurements?.peakRssMiB) &&
          report.measurements.peakRssMiB < 6_144,
      },
    ];
  }
  if (gateId === 'lan-loopback-soak') {
    return [
      {
        id: 'command-round-trip-p95',
        measuredMs: report?.commandRoundTripMs?.p95,
        thresholdExclusiveMs: 250,
        passed:
          Number.isFinite(report?.commandRoundTripMs?.p95) && report.commandRoundTripMs.p95 < 250,
      },
    ];
  }
  return [];
};

export const gateReportErrors = ({
  gate,
  evidenceFiles,
  target,
  minimumLanDurationMs,
  candidateManifest,
  candidateManifestSha256,
  source,
  lockfileSha256,
  lanMinutes,
}) => {
  const errors = [];
  const report = reportForGate(gate, evidenceFiles);
  const fail = (message) => errors.push(`${gate.id}: ${message}`);
  if (gate.id === 'source-verify') {
    if (
      report?.schemaVersion !== 1 ||
      report?.passed !== true ||
      report?.gateId !== 'source-verify' ||
      report?.command !== 'pnpm verify' ||
      !reportTimeWithinGate(report, gate)
    ) {
      fail('verify receipt is invalid');
    }
    return errors;
  }
  if (!report) return [`${gate.id}: required JSON report is missing or invalid`];
  if (!reportTimeWithinGate(report, gate)) fail('report timestamp is stale or outside the gate');

  if (gate.id === 'ui-packaged') {
    if (
      report.passed !== true ||
      report.launchMode !== 'packaged-executable' ||
      report.performance?.withinWarmStartBudget !== true ||
      !safeNumber(report.performance?.interactiveReadyMs) ||
      !Array.isArray(report.checks) ||
      report.checks.length < 10
    ) {
      fail('packaged UI report or warm-start threshold failed');
    }
  } else if (gate.id.startsWith('exports-')) {
    const expectedPreset =
      gate.id === 'exports-a4-landscape' ? 'a4-landscape' : gate.id.split('-')[1];
    const stress = gate.id === 'exports-stress-50';
    if (
      report.schemaVersion !== 2 ||
      report.passed !== true ||
      report.launchMode !== 'packaged-executable' ||
      report.fixture?.pagePreset !== (stress ? 'widescreen' : expectedPreset) ||
      report.run?.mode !== (stress ? 'stress' : 'short') ||
      report.run?.exportCount !== (stress ? 50 : 2) ||
      report.run?.alternatingFormats !== true ||
      report.run?.uniqueDestinations !== true ||
      !allBooleanValuesTrue(report.checks) ||
      report.security?.publicReportContainsLocalPaths !== false
    ) {
      fail('export matrix, cleanup, or safety checks failed');
    }
  } else if (gate.id === 'mcp-packaged' || gate.id === 'installer-lifecycle') {
    if (gate.id === 'mcp-packaged') {
      if (
        report.schemaVersion !== 1 ||
        report.result !== 'passed' ||
        report.target?.mode !== 'packaged-launcher' ||
        report.target?.artifact?.executable?.sha256 !== target.executable.sha256 ||
        report.target?.artifact?.launcher?.sha256 !== target.launcher.sha256 ||
        report.protocol?.stdoutPurity !== true ||
        report.protocol?.frameCount < 100 ||
        report.protocol?.processCount < 7 ||
        !Array.isArray(report.cases) ||
        report.cases.length !== 9 ||
        report.cases.some((entry) => entry?.status !== 'passed')
      ) {
        fail('MCP result or exact companion binding failed');
      }
    } else if (
      report.schemaVersion !== 4 ||
      report.passed !== true ||
      report.sourceCleanAndStable !== true ||
      report.installer?.sha256 !== target.installer.sha256 ||
      report.releaseCandidateManifest?.blockmapSha256 !== target.blockmap.sha256 ||
      report.releaseCandidateManifest?.companionExecutableSha256 !== target.executable.sha256 ||
      report.releaseCandidateManifest?.companionAppAsarSha256 !== target.appAsar.sha256 ||
      report.releaseCandidateManifest?.installedPayloadMatchedCompanion !== true ||
      report.releaseCandidateManifest?.sha256 !== candidateManifestSha256 ||
      report.sourceCommit !== candidateManifest.source.commit ||
      report.sourceTree?.sha256 !== source.tree.sha256 ||
      report.sourceTree?.fileCount !== source.tree.fileCount ||
      report.sourceTree?.bytes !== source.tree.bytes ||
      report.lockfileSha256 !== lockfileSha256 ||
      !hasTrueKeys(report.checks, [
        'existingHdeckOpenedInRealEditor',
        'installedMcpLauncherRoundTrip',
        'repairRerunRestoredMissingPayload',
        'upgradeLikeReinstallRemovedObsoletePayload',
        'completeInstalledTreeMatchedCandidateAfterInstall',
        'completeInstalledTreeMatchedCandidateAfterRepair',
        'completeInstalledTreeMatchedCandidateAfterUpgradeLikeReinstall',
        'installedFileSizesAndSha256Verified',
        'noInstalledSymlinksOrReparsePoints',
        'maintenancePreservedUserDeck',
        'uninstallPreservedUserDeck',
        'noResidualProductProcesses',
        'noResidualProductRegistry',
        'noResidualProductShortcuts',
      ]) ||
      !allBooleanValuesTrue(report.checks)
    ) {
      fail('installer lifecycle or exact payload binding failed');
    }
  } else if (gate.id === 'accessibility-scaling') {
    const factors = [1, 1.25, 1.5, 2];
    if (
      report.schemaVersion !== 1 ||
      report.passed !== true ||
      report.launchMode !== 'packaged-executable' ||
      !exactArray(report.requestedScaleFactors, factors) ||
      !exactArray(report.completedScaleFactors, factors) ||
      !Array.isArray(report.results) ||
      report.results.length !== factors.length
    ) {
      fail('accessibility scale matrix is incomplete');
    }
  } else if (gate.id === 'text-lock-two-process') {
    if (
      report.passed !== true ||
      report.launchMode !== 'packaged-executable' ||
      report.checks?.screenshotsCapturedAfterSecretDialogClosed !== 3 ||
      report.checks?.rendererProductBridgeCalledDirectlyByTest !== false ||
      !allBooleanValuesTrue(report.checks, ['rendererProductBridgeCalledDirectlyByTest'])
    ) {
      fail('two-process text-lock checks failed');
    }
  } else if (gate.id === 'single-instance-final-artifact') {
    if (
      report.schemaVersion !== 1 ||
      report.passed !== true ||
      report.artifactFinality !== 'final-release-candidate' ||
      report.freshForRelease !== true ||
      report.installer?.sha256 !== target.installer.sha256 ||
      !hasTrueKeys(report.checks, [
        'hdeckOpenedThroughWindowsShellAssociation',
        'quotedUnicodeCommandLinePathOpened',
        'exactlyOneDurablePrimaryProcess',
        'malformedArchivePreservedCurrentSession',
        'missingArchivePreservedCurrentSession',
        'allInstalledProcessesExitedBeforeUninstall',
        'silentUninstallRemovedApplication',
      ]) ||
      !allBooleanValuesTrue(report.checks)
    ) {
      fail('single-instance final-artifact checks failed');
    }
  } else if (gate.id === 'benchmark-core') {
    if (
      report.schemaVersion !== 1 ||
      report.validation?.slides !== 500 ||
      report.exports?.mixedExports !== 50 ||
      report.gesture?.passed !== true ||
      report.runtime?.commandPassed !== true
    ) {
      fail('core benchmark thresholds failed');
    }
  } else if (gate.id === 'benchmark-capacity-presentation') {
    if (
      report.schemaVersion !== 1 ||
      report.fixture?.slides !== 500 ||
      report.fixture?.elements !== 10_000 ||
      report.capacity?.passed !== true ||
      report.presentationNavigation?.passed !== true
    ) {
      fail('capacity or presentation threshold failed');
    }
  } else if (gate.id === 'benchmark-expanded-limit') {
    if (
      report.schemaVersion !== 1 ||
      report.passed !== true ||
      report.fixture?.expandedAssetMiB !== 500 ||
      !Number.isFinite(report.measurements?.saveMs) ||
      report.measurements.saveMs >= 120_000 ||
      !Number.isFinite(report.measurements?.reopenMs) ||
      report.measurements.reopenMs >= 120_000 ||
      !Number.isFinite(report.measurements?.peakRssMiB) ||
      report.measurements.peakRssMiB >= 6_144 ||
      !allBooleanValuesTrue(report.checks)
    ) {
      fail('expanded-limit functional or performance threshold checks failed');
    }
  } else if (gate.id === 'lan-loopback-soak') {
    const expectedReconnectCycles = Math.floor(
      Math.max(0, report.configuredDurationMs - 1) / (5 * 60_000),
    );
    if (
      report.schemaVersion !== 1 ||
      report.status !== 'passed' ||
      report.configuredDurationMs !== Math.round(lanMinutes * 60_000) ||
      report.configuredDurationMs < minimumLanDurationMs ||
      report.steadyStateDurationMs < minimumLanDurationMs ||
      !safeNumber(gate.durationMs) ||
      report.steadyStateDurationMs > gate.durationMs + 1_000 ||
      gate.durationMs < minimumLanDurationMs ||
      report.topology?.hosts !== 1 ||
      report.topology?.guests !== 2 ||
      report.peers?.expectedGuestCount !== 2 ||
      report.peers?.maximumObserved !== 2 ||
      report.peers?.minimumObservedDuringExercise !== (expectedReconnectCycles > 0 ? 1 : 2) ||
      !Number.isInteger(report.reconnect?.cycles) ||
      report.reconnect.cycles < expectedReconnectCycles ||
      report.operations?.commands < 1 ||
      report.continuity?.thresholdExclusiveMs !== 30_000 ||
      report.continuity?.passed !== true ||
      !Number.isFinite(report.continuity?.maximumLoopHiatusMs) ||
      report.continuity.maximumLoopHiatusMs >= 30_000 ||
      !Number.isFinite(report.commandRoundTripMs?.p95) ||
      report.commandRoundTripMs.p95 >= 250 ||
      !hasTrueKeys(report.invariants, [
        'revisionAndHashCheckedAfterEveryCommand',
        'onlyHostSavedSharedFile',
        'persistedSnapshotsMatchedHost',
        'objectEditingExercised',
        'embeddedAssetInsertionExercised',
        'textLeaseContentionAndTransferExercised',
        'hostLossRejectedAllGuestEdits',
        'cleanupComplete',
      ]) ||
      !allBooleanValuesTrue(report.invariants)
    ) {
      fail('LAN duration, topology, convergence, or cleanup threshold failed');
    }
  }

  if (gate.id === 'installer-lifecycle') {
    const installedUi = evidenceFiles.find(
      (entry) => entry.gateId === gate.id && entry.role === 'installed-ui-report',
    );
    const installedMcp = evidenceFiles.find(
      (entry) => entry.gateId === gate.id && entry.role === 'installed-mcp-report',
    );
    let ui;
    let mcp;
    try {
      ui = jsonObjectFromBytes(installedUi?.bytes, {
        label: 'Installed UI report',
        canonical: true,
      });
      mcp = jsonObjectFromBytes(installedMcp?.bytes, {
        label: 'Installed MCP report',
        canonical: true,
      });
    } catch {
      fail('installed child evidence is invalid JSON');
    }
    if (
      ui?.passed !== true ||
      ui?.launchMode !== 'packaged-executable' ||
      ui?.performance?.withinWarmStartBudget !== true ||
      !reportTimeWithinGate(ui, gate)
    ) {
      fail('installed UI child smoke did not pass');
    }
    if (
      mcp?.result !== 'passed' ||
      mcp?.target?.mode !== 'packaged-launcher' ||
      !reportTimeWithinGate(mcp, gate)
    ) {
      fail('installed MCP child smoke did not pass');
    }
    if (
      mcp?.target?.artifact?.executable?.sha256 !== target.executable.sha256 ||
      mcp?.target?.artifact?.launcher?.sha256 !== target.launcher.sha256
    ) {
      fail('installed MCP child smoke differs from the candidate payload');
    }
  }
  return errors;
};

const inventoryFromEvidenceFiles = (evidenceFiles) =>
  evidenceFiles
    .map((entry) => ({
      path: entry.path,
      size: Buffer.from(entry.bytes).length,
      sha256: sha256Bytes(entry.bytes),
      gateId: entry.gateId,
      role: entry.role,
      originalName: entry.originalName,
    }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));

export const reconstructEvidenceFilesFromBundle = ({ manifest, bundleBytes }) => {
  const metadata = manifest?.evidence?.files;
  if (!Array.isArray(metadata) || metadata.length === 0) {
    throw new Error('Functional validation evidence metadata is missing.');
  }
  const expectedKeys = ['gateId', 'originalName', 'path', 'role', 'sha256', 'size'];
  const paths = metadata.map((entry) => entry?.path);
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right, 'en'));
  if (
    metadata.some(
      (entry) =>
        !isRecord(entry) ||
        !jsonEqual(Object.keys(entry).sort(), expectedKeys) ||
        !safeEvidencePath(entry.path) ||
        entry.path === FUNCTIONAL_VALIDATION_FILE_NAME ||
        entry.path === FUNCTIONAL_VALIDATION_BUNDLE_NAME ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 1 ||
        !SHA256.test(entry.sha256 ?? '') ||
        typeof entry.gateId !== 'string' ||
        typeof entry.role !== 'string' ||
        typeof entry.originalName !== 'string',
    ) ||
    new Set(paths).size !== paths.length ||
    !jsonEqual(paths, sortedPaths)
  ) {
    throw new Error('Functional validation evidence metadata is unsafe, duplicate, or unsorted.');
  }
  const bundle = Buffer.from(bundleBytes ?? []);
  if (
    manifest?.bundle?.fileName !== FUNCTIONAL_VALIDATION_BUNDLE_NAME ||
    manifest?.bundle?.format !== 'zip-store' ||
    manifest?.bundle?.size !== bundle.length ||
    manifest?.bundle?.sha256 !== sha256Bytes(bundle)
  ) {
    throw new Error('Functional validation evidence bundle identity differs from the manifest.');
  }
  const archive = readPublicEvidenceZipEntries(bundle);
  if (
    archive.length !== metadata.length ||
    archive.some((entry, index) => entry.path !== metadata[index].path)
  ) {
    throw new Error(
      'Functional validation ZIP has missing, extra, reordered, or duplicate entries.',
    );
  }
  return archive.map((entry, index) => {
    const expected = metadata[index];
    if (entry.bytes.length !== expected.size || sha256Bytes(entry.bytes) !== expected.sha256) {
      throw new Error(`Functional validation ZIP entry differs from metadata: ${entry.path}.`);
    }
    return { ...expected, bytes: entry.bytes };
  });
};

const expectedEvidenceDescriptors = (gateId) =>
  REQUIRED_FUNCTIONAL_GATES.find((gate) => gate.id === gateId)?.evidence ?? [];

export const functionalValidationErrors = ({
  manifest,
  candidateManifest,
  candidateManifestSha256,
  artifactInventory,
  source,
  lockfileSha256,
  evidenceFiles,
  bundleBytes,
  expectedEnvironment,
  minimumLanDurationMs = DEFAULT_LAN_DURATION_MS,
}) => {
  const errors = [];
  const suppliedEvidenceFiles = evidenceFiles ?? [];
  const evidenceInventory = inventoryFromEvidenceFiles(suppliedEvidenceFiles);
  const target = candidateTargetIdentity(candidateManifest);
  const expectedGateIds = REQUIRED_FUNCTIONAL_GATES.map((gate) => gate.id);
  const actualGateIds = manifest?.gates?.map((gate) => gate.id) ?? [];
  if (manifest?.schemaVersion !== FUNCTIONAL_VALIDATION_SCHEMA_VERSION)
    errors.push('unsupported schema');
  if (manifest?.productName !== 'HTMLlelujah' || manifest?.version !== candidateManifest?.version) {
    errors.push('product or version mismatch');
  }
  if (!validDate(manifest?.generatedAt)) errors.push('generatedAt is invalid');
  if (
    manifest?.candidate?.buildId !== candidateManifest?.buildId ||
    manifest?.candidate?.manifestSha256 !== candidateManifestSha256 ||
    manifest?.candidate?.artifactAggregateSha256 !== candidateManifest?.artifact?.aggregateSha256
  ) {
    errors.push('candidate binding mismatch');
  }
  if (
    source?.commit !== candidateManifest?.source?.commit ||
    source?.dirty !== false ||
    source?.tree?.sha256 !== candidateManifest?.source?.treeSha256 ||
    source?.tree?.fileCount !== candidateManifest?.source?.fileCount ||
    source?.tree?.bytes !== candidateManifest?.source?.bytes ||
    lockfileSha256 !== candidateManifest?.lockfile?.sha256 ||
    !jsonEqual(manifest?.source, {
      commit: source?.commit,
      dirty: false,
      treeSha256: source?.tree?.sha256,
      fileCount: source?.tree?.fileCount,
      bytes: source?.tree?.bytes,
      lockfileSha256,
    })
  ) {
    errors.push('source, tree, or lockfile binding mismatch');
  }
  if (
    artifactInventory?.aggregateSha256 !== candidateManifest?.artifact?.aggregateSha256 ||
    artifactInventory?.fileCount !== candidateManifest?.artifact?.fileCount ||
    artifactInventory?.totalSize !== candidateManifest?.artifact?.totalSize ||
    !jsonEqual(artifactInventory?.files, candidateManifest?.artifact?.files)
  ) {
    errors.push('artifact inventory differs from candidate');
  }
  if (
    manifest?.target?.platform !== 'Windows' ||
    manifest?.target?.architecture !== 'x64' ||
    manifest?.target?.criticalAggregateSha256 !== target.criticalAggregateSha256 ||
    !jsonEqual(manifest?.target?.installer, target.installer) ||
    !jsonEqual(manifest?.target?.blockmap, target.blockmap) ||
    !jsonEqual(manifest?.target?.executable, target.executable) ||
    !jsonEqual(manifest?.target?.launcher, target.launcher) ||
    !jsonEqual(manifest?.target?.appAsar, target.appAsar) ||
    !jsonEqual(manifest?.target?.winUnpacked, target.winUnpacked) ||
    manifest?.target?.artifactSnapshotBeforeSha256 !==
      candidateManifest?.artifact?.aggregateSha256 ||
    manifest?.target?.artifactSnapshotAfterSha256 !== candidateManifest?.artifact?.aggregateSha256
  ) {
    errors.push('Windows target or before/after snapshot mismatch');
  }
  if (!exactArray(actualGateIds, expectedGateIds))
    errors.push('required gate set or order mismatch');
  if (new Set(actualGateIds).size !== actualGateIds.length) errors.push('duplicate gate');
  const configuredLanMinutes = manifest?.configuration?.lanDurationMinutes;
  if (
    !Number.isFinite(configuredLanMinutes) ||
    configuredLanMinutes <= 0 ||
    configuredLanMinutes * 60_000 < minimumLanDurationMs
  ) {
    errors.push('configured LAN duration is below the readiness threshold');
  }

  const candidateCreatedAt = candidateManifest?.createdAt;
  if (!validDate(candidateCreatedAt)) errors.push('candidate creation timestamp is invalid');
  let previousCompletedAt = candidateCreatedAt;
  for (const gate of manifest?.gates ?? []) {
    const expectedDescriptors = expectedEvidenceDescriptors(gate.id);
    const inventoryByPath = new Map(evidenceInventory.map((entry) => [entry.path, entry]));
    const actualDescriptors = (gate.evidence ?? []).map((entryPath) => {
      const entry = inventoryByPath.get(entryPath);
      return entry === undefined ? null : { originalName: entry.originalName, role: entry.role };
    });
    const report = reportForGate(gate, suppliedEvidenceFiles);
    const expectedInvocation = expectedPublicGateInvocation(gate.id, {
      lanMinutes: configuredLanMinutes,
    });
    const expectedThresholds = expectedGateThresholdRecords(gate.id, report);
    if (
      gate.required !== true ||
      gate.status !== 'passed' ||
      gate.scope !== expectedGateScope(gate.id) ||
      !validDate(gate.startedAt) ||
      !validDate(gate.completedAt) ||
      Date.parse(gate.completedAt) < Date.parse(gate.startedAt) ||
      !safeNumber(gate.durationMs) ||
      Math.abs(Date.parse(gate.completedAt) - Date.parse(gate.startedAt) - gate.durationMs) >
        1_000 ||
      Date.parse(gate.startedAt) < Date.parse(candidateCreatedAt ?? '') ||
      Date.parse(gate.startedAt) < Date.parse(previousCompletedAt ?? '') ||
      Date.parse(gate.completedAt) > Date.parse(manifest?.generatedAt ?? '') ||
      gate.criticalBeforeSha256 !== target.criticalAggregateSha256 ||
      gate.criticalAfterSha256 !== target.criticalAggregateSha256 ||
      gate.commandId !== expectedInvocation.commandId ||
      !jsonEqual(gate.argv, expectedInvocation.argv) ||
      !jsonEqual(gate.environment, expectedInvocation.environment) ||
      !jsonEqual(gate.thresholds, expectedThresholds) ||
      expectedThresholds.some((threshold) => threshold.passed !== true) ||
      !exactArray(actualDescriptors, expectedDescriptors)
    ) {
      errors.push(`${gate.id}: gate status, timing, target, or evidence shape is invalid`);
    }
    const actualPaths = evidenceInventory
      .filter((entry) => entry.gateId === gate.id)
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right, 'en'));
    const referencedPaths = [...(gate.evidence ?? [])].sort((left, right) =>
      left.localeCompare(right, 'en'),
    );
    if (!exactArray(referencedPaths, actualPaths)) {
      errors.push(`${gate.id}: evidence references differ`);
    }
    errors.push(
      ...gateReportErrors({
        gate,
        evidenceFiles: suppliedEvidenceFiles,
        target,
        minimumLanDurationMs,
        candidateManifest,
        candidateManifestSha256,
        source,
        lockfileSha256,
        lanMinutes: configuredLanMinutes,
      }),
    );
    previousCompletedAt = gate.completedAt;
  }

  if (!jsonEqual(manifest?.coverage?.external, EXTERNAL_VALIDATION_LIMITATIONS)) {
    errors.push('external limitations are missing or overstated');
  }
  if (!exactArray(manifest?.coverage?.automated, expectedGateIds)) {
    errors.push('automated coverage differs from required gates');
  }
  if (!jsonEqual(manifest?.coverage?.scopeLimitations, AUTOMATED_SCOPE_LIMITATIONS)) {
    errors.push('automated source-harness scope limitations are missing or overstated');
  }
  if (
    evidenceInventory.some(
      (entry) =>
        !safeEvidencePath(entry.path) ||
        entry.path === FUNCTIONAL_VALIDATION_FILE_NAME ||
        entry.path === FUNCTIONAL_VALIDATION_BUNDLE_NAME ||
        !SHA256.test(entry.sha256) ||
        !expectedGateIds.includes(entry.gateId),
    ) ||
    new Set(evidenceInventory.map((entry) => entry.path)).size !== evidenceInventory.length
  ) {
    errors.push('evidence contains unsafe, duplicate, or self-referential paths');
  }
  const manifestInventory = manifest?.evidence?.files ?? [];
  if (!jsonEqual(manifestInventory, evidenceInventory)) errors.push('evidence inventory mismatch');
  const evidenceTotal = evidenceInventory.reduce((sum, entry) => sum + entry.size, 0);
  if (
    manifest?.evidence?.fileCount !== evidenceInventory.length ||
    manifest?.evidence?.totalSize !== evidenceTotal ||
    manifest?.evidence?.aggregateSha256 !== aggregateEvidenceInventory(evidenceInventory)
  ) {
    errors.push('evidence aggregate mismatch');
  }
  for (const entry of suppliedEvidenceFiles) {
    const safetyErrors = entry.role.includes('screenshot')
      ? publicPngErrors(entry.bytes)
      : publicEvidenceJsonErrors(entry.bytes);
    if (safetyErrors.length > 0) errors.push(`${entry.path}: ${safetyErrors.join('; ')}`);
  }
  if (bundleBytes === undefined) {
    errors.push('public evidence bundle is missing');
  } else {
    try {
      const zipEntries = readPublicEvidenceZipEntries(bundleBytes);
      const zipIdentity = { size: bundleBytes.length, sha256: sha256Bytes(bundleBytes) };
      if (
        manifest?.bundle?.fileName !== FUNCTIONAL_VALIDATION_BUNDLE_NAME ||
        manifest?.bundle?.format !== 'zip-store' ||
        manifest?.bundle?.size !== zipIdentity.size ||
        manifest?.bundle?.sha256 !== zipIdentity.sha256 ||
        !exactArray(
          zipEntries.map((entry) => entry.path),
          evidenceInventory.map((entry) => entry.path),
        ) ||
        zipEntries.some(
          (entry, index) => sha256Bytes(entry.bytes) !== evidenceInventory[index]?.sha256,
        )
      ) {
        errors.push('public evidence ZIP identity or entries mismatch');
      }
    } catch {
      errors.push('public evidence ZIP is malformed');
    }
  }
  if (!jsonEqual(manifest?.environment, expectedEnvironment)) {
    errors.push('sanitized public environment differs from the verified runtime');
  }
  if (collectForbiddenKeys(manifest?.environment).length > 0) {
    errors.push('environment contains private identity fields');
  }
  const computedReady =
    errors.length === 0 &&
    actualGateIds.length === REQUIRED_FUNCTIONAL_GATES.length &&
    (manifest?.gates ?? []).every((gate) => gate.required === true && gate.status === 'passed');
  if (manifest?.releaseReady !== computedReady || manifest?.releaseReady !== true) {
    errors.push('releaseReady is not supported by all required gates');
  }
  return [...new Set(errors)];
};

export const assertFunctionalValidationManifest = (options) => {
  const errors = functionalValidationErrors(options);
  if (errors.length > 0) {
    throw new Error(`Functional candidate validation failed: ${errors.join('; ')}`);
  }
};

export const assertFunctionalValidationBundle = (options) => {
  const evidenceFiles = reconstructEvidenceFilesFromBundle(options);
  assertFunctionalValidationManifest({ ...options, evidenceFiles });
  return evidenceFiles;
};

export const verifyFunctionalValidationPair = ({
  manifestBytes,
  bundleBytes,
  candidateManifest,
  candidateManifestBytes,
  artifactInventory,
  source,
  lockfileSha256,
  packageManager,
  platform,
  architecture,
  osRelease,
  osVersion,
  nodeVersion,
}) => {
  const manifestData = exactBytes(manifestBytes, 'Functional validation manifest');
  const safetyErrors = publicEvidenceJsonErrors(manifestData);
  if (safetyErrors.length > 0) {
    throw new Error(
      `Functional validation manifest is not public-safe: ${safetyErrors.join('; ')}`,
    );
  }
  const manifest = jsonObjectFromBytes(manifestData, {
    label: 'Functional validation manifest',
    canonical: true,
  });
  const candidateData = exactBytes(candidateManifestBytes, 'Release candidate manifest');
  const candidateFromBytes = jsonObjectFromBytes(candidateData, {
    label: 'Release candidate manifest',
    canonical: false,
  });
  if (stableJsonText(candidateFromBytes) !== stableJsonText(candidateManifest)) {
    throw new Error('Parsed release candidate manifest differs from its exact bytes.');
  }

  const bundleData = exactBytes(bundleBytes, 'Functional validation evidence bundle');
  const reconstructedEvidence = reconstructEvidenceFilesFromBundle({
    manifest,
    bundleBytes: bundleData,
  });
  const canonicalBundle = createPublicEvidenceZip(
    reconstructedEvidence.map(({ path, bytes }) => ({ path, bytes })),
    manifest.generatedAt,
  );
  if (!bundleData.equals(canonicalBundle)) {
    throw new Error(
      'Functional validation evidence bundle is not the exact canonical ZIP for its entries and generatedAt timestamp.',
    );
  }
  const installerReports = reconstructedEvidence.filter(
    (entry) => entry.gateId === 'installer-lifecycle' && entry.role === 'report',
  );
  if (installerReports.length !== 1) {
    throw new Error(
      'Functional validation bundle must contain exactly one installer-lifecycle report.',
    );
  }
  const installerReport = jsonObjectFromBytes(installerReports[0].bytes, {
    label: 'Installer lifecycle report',
    canonical: true,
  });
  const expectedEnvironment = buildPublicValidationEnvironment({
    platform,
    architecture,
    osRelease,
    osVersion,
    nodeVersion,
    packageManager,
    installerReport,
  });
  const verifiedEvidence = assertFunctionalValidationBundle({
    manifest,
    candidateManifest,
    candidateManifestSha256: sha256Bytes(candidateData),
    artifactInventory,
    source,
    lockfileSha256,
    bundleBytes: bundleData,
    expectedEnvironment,
    minimumLanDurationMs: DEFAULT_LAN_DURATION_MS,
  });
  const manifestIdentity = {
    path: FUNCTIONAL_VALIDATION_FILE_NAME,
    size: manifestData.length,
    sha256: sha256Bytes(manifestData),
  };
  const bundleIdentity = {
    path: FUNCTIONAL_VALIDATION_BUNDLE_NAME,
    size: bundleData.length,
    sha256: sha256Bytes(bundleData),
  };
  return {
    manifest,
    evidenceFiles: verifiedEvidence,
    manifestSha256: manifestIdentity.sha256,
    manifestSize: manifestIdentity.size,
    bundleSha256: bundleIdentity.sha256,
    bundleSize: bundleIdentity.size,
    evidenceAggregateSha256: manifest.evidence.aggregateSha256,
    aggregateSha256: aggregateEvidenceInventory(
      [manifestIdentity, bundleIdentity].sort((left, right) =>
        left.path.localeCompare(right.path, 'en'),
      ),
    ),
  };
};

export const buildFunctionalValidationManifest = ({
  candidateManifest,
  candidateManifestSha256,
  source,
  lockfileSha256,
  gates,
  evidenceFiles,
  bundleBytes,
  generatedAt,
  lanMinutes,
  environment,
}) => {
  const target = candidateTargetIdentity(candidateManifest);
  const inventory = inventoryFromEvidenceFiles(evidenceFiles);
  return {
    schemaVersion: FUNCTIONAL_VALIDATION_SCHEMA_VERSION,
    productName: 'HTMLlelujah',
    version: candidateManifest.version,
    generatedAt,
    releaseReady: true,
    configuration: { lanDurationMinutes: lanMinutes },
    candidate: {
      buildId: candidateManifest.buildId,
      manifestFile: 'release-candidate-v1.json',
      manifestSha256: candidateManifestSha256,
      artifactAggregateSha256: candidateManifest.artifact.aggregateSha256,
    },
    source: {
      commit: source.commit,
      dirty: false,
      treeSha256: source.tree.sha256,
      fileCount: source.tree.fileCount,
      bytes: source.tree.bytes,
      lockfileSha256,
    },
    target: {
      platform: 'Windows',
      architecture: 'x64',
      installer: target.installer,
      blockmap: target.blockmap,
      executable: target.executable,
      launcher: target.launcher,
      appAsar: target.appAsar,
      winUnpacked: target.winUnpacked,
      criticalAggregateSha256: target.criticalAggregateSha256,
      artifactSnapshotBeforeSha256: candidateManifest.artifact.aggregateSha256,
      artifactSnapshotAfterSha256: candidateManifest.artifact.aggregateSha256,
    },
    gates,
    coverage: {
      automated: REQUIRED_FUNCTIONAL_GATES.map((gate) => gate.id),
      scopeLimitations: AUTOMATED_SCOPE_LIMITATIONS,
      external: EXTERNAL_VALIDATION_LIMITATIONS,
    },
    evidence: {
      fileCount: inventory.length,
      totalSize: inventory.reduce((sum, entry) => sum + entry.size, 0),
      aggregateSha256: aggregateEvidenceInventory(inventory),
      files: inventory,
    },
    bundle: {
      fileName: FUNCTIONAL_VALIDATION_BUNDLE_NAME,
      format: 'zip-store',
      size: bundleBytes.length,
      sha256: sha256Bytes(bundleBytes),
    },
    environment,
  };
};
