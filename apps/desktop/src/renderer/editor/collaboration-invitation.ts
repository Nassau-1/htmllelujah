export const COLLABORATION_INVITATION_PREFIX = 'HTMLLELUJAH-COLLABORATION-INVITATION';
export const COLLABORATION_INVITATION_VERSION = 1;

export const COLLABORATION_INVITATION_LIMITS = Object.freeze({
  endpointCharacters: 512,
  sessionCodeCharacters: 128,
  hostFingerprintCharacters: 256,
  decodedPayloadBytes: 768,
});

const INVITATION_HEADER =
  `${COLLABORATION_INVITATION_PREFIX}:${COLLABORATION_INVITATION_VERSION}:` as const;
const MAX_ENCODED_PAYLOAD_CHARACTERS =
  Math.ceil(COLLABORATION_INVITATION_LIMITS.decodedPayloadBytes / 3) * 4;

export const MAX_COLLABORATION_INVITATION_CHARACTERS =
  INVITATION_HEADER.length + MAX_ENCODED_PAYLOAD_CHARACTERS;

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const INVITATION_KEYS = ['endpoint', 'sessionCode', 'hostFingerprint'] as const;

export interface CollaborationInvitationFields {
  readonly endpoint: string;
  readonly sessionCode: string;
  readonly hostFingerprint: string;
}

export type CollaborationInvitationErrorCode =
  | 'INVALID_PREFIX'
  | 'UNSUPPORTED_VERSION'
  | 'TOO_LARGE'
  | 'INVALID_ENCODING'
  | 'INVALID_PAYLOAD'
  | 'INVALID_FIELD'
  | 'NON_CANONICAL';

export class CollaborationInvitationError extends Error {
  public readonly code: CollaborationInvitationErrorCode;

  public constructor(code: CollaborationInvitationErrorCode, message: string) {
    super(message);
    this.name = 'CollaborationInvitationError';
    this.code = code;
  }
}

const invalid = (
  code: CollaborationInvitationErrorCode,
  message: string,
): CollaborationInvitationError => new CollaborationInvitationError(code, message);

const encodeBase64Url = (bytes: Uint8Array): string => {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triplet = (first << 16) | (second << 8) | third;
    encoded += BASE64URL_ALPHABET[(triplet >>> 18) & 63];
    encoded += BASE64URL_ALPHABET[(triplet >>> 12) & 63];
    if (index + 1 < bytes.length) encoded += BASE64URL_ALPHABET[(triplet >>> 6) & 63];
    if (index + 2 < bytes.length) encoded += BASE64URL_ALPHABET[triplet & 63];
  }
  return encoded;
};

const decodeBase64Url = (encoded: string): Uint8Array => {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_ENCODED_PAYLOAD_CHARACTERS ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw invalid('INVALID_ENCODING', 'Invitation payload encoding is invalid.');
  }

  const decodedLength = Math.floor((encoded.length * 6) / 8);
  if (decodedLength > COLLABORATION_INVITATION_LIMITS.decodedPayloadBytes) {
    throw invalid('TOO_LARGE', 'Invitation payload exceeds the supported size.');
  }

  const decoded = new Uint8Array(decodedLength);
  let accumulator = 0;
  let availableBits = 0;
  let outputIndex = 0;

  for (const character of encoded) {
    const value = BASE64URL_ALPHABET.indexOf(character);
    accumulator = (accumulator << 6) | value;
    availableBits += 6;
    if (availableBits >= 8) {
      availableBits -= 8;
      decoded[outputIndex] = (accumulator >>> availableBits) & 255;
      outputIndex += 1;
      accumulator &= (1 << availableBits) - 1;
    }
  }

  if (outputIndex !== decodedLength || accumulator !== 0 || encodeBase64Url(decoded) !== encoded) {
    throw invalid('INVALID_ENCODING', 'Invitation payload encoding is not canonical.');
  }
  return decoded;
};

const isRecordWithExactInvitationKeys = (
  value: unknown,
): value is Record<(typeof INVITATION_KEYS)[number], unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return (
    keys.length === INVITATION_KEYS.length &&
    INVITATION_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
};

const isCanonicalSha256Base64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength === 32;
  } catch {
    return false;
  }
};

const validateEndpoint = (endpoint: unknown): string => {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > COLLABORATION_INVITATION_LIMITS.endpointCharacters ||
    !/^[\x21-\x7e]+$/u.test(endpoint)
  ) {
    throw invalid('INVALID_FIELD', 'Invitation endpoint is invalid.');
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw invalid('INVALID_FIELD', 'Invitation endpoint is invalid.');
  }

  const port = Number(parsed.port);
  if (
    !endpoint.startsWith('wss://') ||
    parsed.protocol !== 'wss:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === '' ||
    parsed.port === '' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== endpoint
  ) {
    throw invalid(
      'INVALID_FIELD',
      'Invitation endpoint must be a canonical secure WSS host with an explicit port.',
    );
  }
  return endpoint;
};

const validateSessionCode = (sessionCode: unknown): string => {
  if (
    typeof sessionCode !== 'string' ||
    sessionCode.length > COLLABORATION_INVITATION_LIMITS.sessionCodeCharacters
  ) {
    throw invalid('INVALID_FIELD', 'Invitation session code is invalid.');
  }

  const match =
    /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/iu.exec(
      sessionCode,
    );
  if (match === null) {
    throw invalid('INVALID_FIELD', 'Invitation session code is invalid.');
  }

  const encodedExpiry = match[2] ?? '';
  const encodedSecret = match[3] ?? '';
  const expiresAtMs = Number.parseInt(encodedExpiry, 36);
  if (
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= 0 ||
    expiresAtMs.toString(36) !== encodedExpiry ||
    !isCanonicalSha256Base64Url(encodedSecret)
  ) {
    throw invalid('INVALID_FIELD', 'Invitation session code is invalid.');
  }
  return sessionCode;
};

const validateHostFingerprint = (hostFingerprint: unknown): string => {
  if (
    typeof hostFingerprint !== 'string' ||
    hostFingerprint.length > COLLABORATION_INVITATION_LIMITS.hostFingerprintCharacters ||
    !hostFingerprint.startsWith('sha256-') ||
    !isCanonicalSha256Base64Url(hostFingerprint.slice('sha256-'.length))
  ) {
    throw invalid('INVALID_FIELD', 'Invitation host fingerprint is invalid.');
  }
  return hostFingerprint;
};

const validateFields = (value: unknown): CollaborationInvitationFields => {
  if (!isRecordWithExactInvitationKeys(value)) {
    throw invalid(
      'INVALID_PAYLOAD',
      'Invitation payload must contain only endpoint, sessionCode, and hostFingerprint.',
    );
  }
  return Object.freeze({
    endpoint: validateEndpoint(value.endpoint),
    sessionCode: validateSessionCode(value.sessionCode),
    hostFingerprint: validateHostFingerprint(value.hostFingerprint),
  });
};

const canonicalPayload = (fields: CollaborationInvitationFields): string =>
  JSON.stringify({
    endpoint: fields.endpoint,
    sessionCode: fields.sessionCode,
    hostFingerprint: fields.hostFingerprint,
  });

export const encodeCollaborationInvitation = (input: CollaborationInvitationFields): string => {
  const fields = validateFields(input);
  const bytes = new TextEncoder().encode(canonicalPayload(fields));
  if (bytes.byteLength > COLLABORATION_INVITATION_LIMITS.decodedPayloadBytes) {
    throw invalid('TOO_LARGE', 'Invitation payload exceeds the supported size.');
  }
  return `${INVITATION_HEADER}${encodeBase64Url(bytes)}`;
};

export const parseCollaborationInvitation = (
  invitationText: string,
): CollaborationInvitationFields => {
  if (
    typeof invitationText !== 'string' ||
    !invitationText.startsWith(`${COLLABORATION_INVITATION_PREFIX}:`)
  ) {
    throw invalid('INVALID_PREFIX', 'This is not an HTMLlelujah collaboration invitation.');
  }
  if (invitationText.length > MAX_COLLABORATION_INVITATION_CHARACTERS) {
    throw invalid('TOO_LARGE', 'Invitation text exceeds the supported size.');
  }

  const versionAndPayload = invitationText.slice(COLLABORATION_INVITATION_PREFIX.length + 1);
  const separatorIndex = versionAndPayload.indexOf(':');
  if (separatorIndex < 1) {
    throw invalid('UNSUPPORTED_VERSION', 'Invitation version is missing or invalid.');
  }
  const versionToken = versionAndPayload.slice(0, separatorIndex);
  if (!/^(0|[1-9][0-9]*)$/u.test(versionToken)) {
    throw invalid('UNSUPPORTED_VERSION', 'Invitation version is missing or invalid.');
  }
  if (Number(versionToken) !== COLLABORATION_INVITATION_VERSION) {
    throw invalid('UNSUPPORTED_VERSION', `Invitation version ${versionToken} is not supported.`);
  }

  const encodedPayload = versionAndPayload.slice(separatorIndex + 1);
  const decoded = decodeBase64Url(encodedPayload);
  let payloadText: string;
  try {
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw invalid('INVALID_ENCODING', 'Invitation payload is not valid UTF-8.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    throw invalid('INVALID_PAYLOAD', 'Invitation payload is not valid JSON.');
  }

  const fields = validateFields(parsed);
  if (encodeCollaborationInvitation(fields) !== invitationText) {
    throw invalid('NON_CANONICAL', 'Invitation text is not in canonical form.');
  }
  return fields;
};
