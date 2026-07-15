import { describe, expect, it } from 'vitest';

import {
  CollaborationError,
  decodeManualInvitation,
  encodeManualInvitation,
  LanDiscoveryController,
  type DiscoveryAdvertisement,
  type DiscoveryBackend,
  type DiscoveryHandle,
  type DiscoveredService,
  type ManualInvitation,
} from '../src/index.js';

const SECRET = Buffer.alloc(32, 0x61);

class FakeDiscoveryBackend implements DiscoveryBackend {
  public advertisement: DiscoveryAdvertisement | undefined;
  public listener: ((service: DiscoveredService) => void) | undefined;
  public stopCalls = 0;
  public destroyCalls = 0;

  public publish(advertisement: DiscoveryAdvertisement): DiscoveryHandle {
    this.advertisement = advertisement;
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.stopCalls += 1;
      },
    };
  }

  public browse(onService: (service: DiscoveredService) => void): DiscoveryHandle {
    this.listener = onService;
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.stopCalls += 1;
      },
    };
  }

  public destroy(): void {
    this.destroyCalls += 1;
  }
}

const invitation: ManualInvitation = {
  protocolVersion: 1,
  host: '192.168.1.20',
  port: 45678,
  sessionId: '96000000-0000-4000-8000-000000000001',
  certificateFingerprint: `sha256-${Buffer.alloc(32, 0x31).toString('base64url')}`,
  expiresAtMs: 2_000_000_000_000,
};

describe('opt-in LAN discovery', () => {
  it('publishes only bounded non-content TXT fields and discovers a matching deck secret', () => {
    const backend = new FakeDiscoveryBackend();
    const controller = new LanDiscoveryController({
      documentSecret: SECRET,
      clock: () => 1_000_000_000_000,
      backendFactory: () => backend,
    });
    expect(() => controller.advertise(invitation)).toThrow(CollaborationError);
    controller.setEnabled(true);
    expect(() =>
      controller.advertise({ ...invitation, expiresAtMs: 1_000_000_000_000 }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    controller.advertise(invitation);
    expect(backend.advertisement?.type).toBe('htmllelujah');
    expect(Object.keys(backend.advertisement?.txt ?? {}).sort()).toEqual([
      'exp',
      'fp',
      'hint',
      'sid',
      'v',
    ]);
    expect(JSON.stringify(backend.advertisement?.txt)).not.toContain('deck');
    expect(JSON.stringify(backend.advertisement?.txt)).not.toContain('path');

    const discovered: ManualInvitation[] = [];
    const stop = controller.browse((candidate) => discovered.push(candidate));
    backend.listener?.({
      host: 'htmllelujah.local',
      port: invitation.port,
      addresses: [invitation.host],
      txt: backend.advertisement!.txt,
    });
    expect(discovered).toEqual([invitation]);
    stop();
    stop();
    controller.destroy();
    controller.destroy();
    expect(backend.destroyCalls).toBe(1);
  });

  it('round-trips manual invitations and ignores tampered discovery hints', () => {
    expect(decodeManualInvitation(encodeManualInvitation(invitation))).toEqual(invitation);
    const backend = new FakeDiscoveryBackend();
    const controller = new LanDiscoveryController({
      documentSecret: SECRET,
      enabled: true,
      clock: () => 1_000_000_000_000,
      backendFactory: () => backend,
    });
    controller.advertise(invitation);
    let discovered = 0;
    controller.browse(() => {
      discovered += 1;
    });
    backend.listener?.({
      host: invitation.host,
      port: invitation.port,
      addresses: [invitation.host],
      txt: { ...backend.advertisement!.txt, hint: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(discovered).toBe(0);
    controller.destroy();
  });
});
