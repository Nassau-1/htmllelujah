import { describe, expect, it } from 'vitest';

import {
  COLLABORATION_INVITATION_PREFIX,
  COLLABORATION_INVITATION_VERSION,
  encodeCollaborationInvitation,
  MAX_COLLABORATION_INVITATION_CHARACTERS,
  parseCollaborationInvitation,
  type CollaborationInvitationFields,
  CollaborationInvitationError,
} from '../src/renderer/editor/collaboration-invitation.js';

const fixture: CollaborationInvitationFields = {
  endpoint: 'wss://192.168.1.15:43123',
  sessionCode:
    '123e4567-e89b-42d3-a456-426614174000.loyw3v28.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  hostFingerprint: `sha256-${'B'.repeat(42)}Q`,
};

const invitationFromJson = (json: string, version = COLLABORATION_INVITATION_VERSION): string =>
  `${COLLABORATION_INVITATION_PREFIX}:${version}:${Buffer.from(json, 'utf8').toString('base64url')}`;

const expectInvitationError = (
  callback: () => unknown,
  code: CollaborationInvitationError['code'],
): void => {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationInvitationError);
    expect((error as CollaborationInvitationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected CollaborationInvitationError(${code}).`);
};

describe('collaboration invitation text contract', () => {
  it('encodes deterministically and parses the three Join values without using a URL contract', () => {
    const first = encodeCollaborationInvitation(fixture);
    const reorderedInput = {
      hostFingerprint: fixture.hostFingerprint,
      endpoint: fixture.endpoint,
      sessionCode: fixture.sessionCode,
    };
    const second = encodeCollaborationInvitation(reorderedInput);

    expect(first).toBe(second);
    expect(first).toMatch(new RegExp(`^${COLLABORATION_INVITATION_PREFIX}:1:[A-Za-z0-9_-]+$`, 'u'));
    expect(first).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//iu);
    expect(parseCollaborationInvitation(first)).toEqual(fixture);
    expect(Object.isFrozen(parseCollaborationInvitation(first))).toBe(true);
  });

  it('rejects non-HTMLlelujah prefixes, malformed versions, and unsupported versions', () => {
    const valid = encodeCollaborationInvitation(fixture);
    expectInvitationError(() => parseCollaborationInvitation(`OTHER${valid}`), 'INVALID_PREFIX');
    expectInvitationError(
      () => parseCollaborationInvitation(valid.replace(':1:', ':v1:')),
      'UNSUPPORTED_VERSION',
    );
    expectInvitationError(
      () => parseCollaborationInvitation(valid.replace(':1:', ':2:')),
      'UNSUPPORTED_VERSION',
    );
  });

  it('bounds input before decoding and rejects invalid or non-canonical base64url', () => {
    expectInvitationError(
      () =>
        parseCollaborationInvitation(
          `${COLLABORATION_INVITATION_PREFIX}:1:${'A'.repeat(
            MAX_COLLABORATION_INVITATION_CHARACTERS,
          )}`,
        ),
      'TOO_LARGE',
    );
    expectInvitationError(
      () => parseCollaborationInvitation(`${COLLABORATION_INVITATION_PREFIX}:1:abc=`),
      'INVALID_ENCODING',
    );
    expectInvitationError(
      () => parseCollaborationInvitation(`${COLLABORATION_INVITATION_PREFIX}:1:A`),
      'INVALID_ENCODING',
    );
  });

  it('rejects malformed UTF-8, malformed JSON, and non-object payloads', () => {
    const invalidUtf8 =
      `${COLLABORATION_INVITATION_PREFIX}:1:` +
      Buffer.from(Uint8Array.from([0xc3, 0x28])).toString('base64url');
    expectInvitationError(() => parseCollaborationInvitation(invalidUtf8), 'INVALID_ENCODING');
    expectInvitationError(
      () => parseCollaborationInvitation(invitationFromJson('{')),
      'INVALID_PAYLOAD',
    );
    expectInvitationError(
      () => parseCollaborationInvitation(invitationFromJson('[]')),
      'INVALID_PAYLOAD',
    );
  });

  it('rejects missing, extra, file, display-name, and presentation metadata keys', () => {
    const variants = [
      { endpoint: fixture.endpoint, sessionCode: fixture.sessionCode },
      { ...fixture, displayName: 'Alice' },
      { ...fixture, filePath: 'C:\\confidential\\board.hdeck' },
      { ...fixture, presentationName: 'Confidential plan' },
    ];

    for (const variant of variants) {
      expectInvitationError(
        () => parseCollaborationInvitation(invitationFromJson(JSON.stringify(variant))),
        'INVALID_PAYLOAD',
      );
      expectInvitationError(
        () => encodeCollaborationInvitation(variant as CollaborationInvitationFields),
        'INVALID_PAYLOAD',
      );
    }
  });

  it('requires canonical JSON so key reordering, whitespace, and duplicate keys cannot alias an invite', () => {
    const reordered = JSON.stringify({
      hostFingerprint: fixture.hostFingerprint,
      sessionCode: fixture.sessionCode,
      endpoint: fixture.endpoint,
    });
    const whitespace = JSON.stringify(fixture, null, 2);
    const duplicate =
      `{"endpoint":${JSON.stringify(fixture.endpoint)},` +
      `"endpoint":${JSON.stringify(fixture.endpoint)},` +
      `"sessionCode":${JSON.stringify(fixture.sessionCode)},` +
      `"hostFingerprint":${JSON.stringify(fixture.hostFingerprint)}}`;

    for (const json of [reordered, whitespace, duplicate]) {
      expectInvitationError(
        () => parseCollaborationInvitation(invitationFromJson(json)),
        'NON_CANONICAL',
      );
    }
  });

  it.each([
    'ws://192.168.1.15:43123',
    'https://192.168.1.15:43123',
    'file:///C:/deck.hdeck',
    'wss://user:secret@192.168.1.15:43123',
    'wss://192.168.1.15',
    'wss://192.168.1.15:43123/',
    'wss://192.168.1.15:43123/path',
    'wss://192.168.1.15:43123?participant=Alice',
    'wss://192.168.1.15:43123#deck',
    'wss://192.168.1.15:43123\n',
  ])('rejects unsafe or non-canonical endpoint %s', (endpoint) => {
    expectInvitationError(
      () => encodeCollaborationInvitation({ ...fixture, endpoint }),
      'INVALID_FIELD',
    );
  });

  it('accepts canonical IPv4, IPv6, and host-name WSS endpoints with explicit ports', () => {
    for (const endpoint of [
      fixture.endpoint,
      'wss://[fd00::15]:43123',
      'wss://collaboration-host.local:43123',
    ]) {
      const encoded = encodeCollaborationInvitation({ ...fixture, endpoint });
      expect(parseCollaborationInvitation(encoded).endpoint).toBe(endpoint);
    }
  });

  it.each([
    '',
    '123e4567-e89b-42d3-a456-426614174000.loyw3v28',
    `123e4567-e89b-42d3-a456-426614174000.loyw3v28.${'A'.repeat(42)}`,
    `123e4567-e89b-42d3-a456-426614174000.0001.${'A'.repeat(43)}`,
    `123e4567-e89b-42d3-a456-426614174000.loyw3v28.${'A'.repeat(42)}B`,
    `123e4567-e89b-42d3-a456-426614174000.loyw3v28.${'A'.repeat(42)}\n`,
  ])('rejects malformed or non-canonical session code %s', (sessionCode) => {
    expectInvitationError(
      () => encodeCollaborationInvitation({ ...fixture, sessionCode }),
      'INVALID_FIELD',
    );
  });

  it.each([
    '',
    'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    `sha256-${'A'.repeat(42)}`,
    `sha256-${'A'.repeat(42)}B`,
    `sha256-${'A'.repeat(42)}\n`,
  ])('rejects malformed or non-canonical host fingerprint %s', (hostFingerprint) => {
    expectInvitationError(
      () => encodeCollaborationInvitation({ ...fixture, hostFingerprint }),
      'INVALID_FIELD',
    );
  });
});
