import { isIP } from 'node:net';

import Bonjour from 'bonjour-service';
import { z } from 'zod';

import { COLLABORATION_PROTOCOL_VERSION } from '../contracts.js';
import { CollaborationError } from '../errors.js';
import { constantTimeEqual, createDiscoveryHint, normalizeDocumentSecret } from './crypto.js';
import {
  certificateFingerprintSchema,
  manualInvitationSchema,
  type ManualInvitation,
} from './protocol.js';

export const HTMLLELUJAH_DISCOVERY_TYPE = 'htmllelujah';

const discoveryTxtSchema = z
  .object({
    v: z.literal(String(COLLABORATION_PROTOCOL_VERSION)),
    sid: z.string().uuid(),
    fp: certificateFingerprintSchema,
    exp: z.string().regex(/^\d{10,16}$/),
    hint: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

export interface DiscoveryAdvertisement {
  readonly name: string;
  readonly type: typeof HTMLLELUJAH_DISCOVERY_TYPE;
  readonly protocol: 'tcp';
  readonly port: number;
  readonly txt: Readonly<Record<string, string>>;
}

export interface DiscoveredService {
  readonly host: string;
  readonly port: number;
  readonly addresses: readonly string[];
  readonly txt: Readonly<Record<string, unknown>>;
}

export interface DiscoveryHandle {
  stop(): void;
}

export interface DiscoveryBackend {
  publish(advertisement: DiscoveryAdvertisement): DiscoveryHandle;
  browse(onService: (service: DiscoveredService) => void): DiscoveryHandle;
  destroy(): void;
}

export class BonjourDiscoveryBackend implements DiscoveryBackend {
  private readonly bonjour = new Bonjour();
  private destroyed = false;

  public publish(advertisement: DiscoveryAdvertisement): DiscoveryHandle {
    const service = this.bonjour.publish(advertisement);
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        service.stop();
      },
    };
  }

  public browse(onService: (service: DiscoveredService) => void): DiscoveryHandle {
    const browser = this.bonjour.find(
      { type: HTMLLELUJAH_DISCOVERY_TYPE, protocol: 'tcp' },
      (service) => {
        onService({
          host: service.host,
          port: service.port,
          addresses: service.addresses ?? [],
          txt: (service.txt ?? {}) as Readonly<Record<string, unknown>>,
        });
      },
    );
    let stopped = false;
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        browser.stop();
      },
    };
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.bonjour.destroy();
  }
}

export interface LanDiscoveryControllerOptions {
  readonly documentSecret: Uint8Array;
  readonly enabled?: boolean;
  readonly clock?: () => number;
  readonly backendFactory?: () => DiscoveryBackend;
}

const normalizeTxt = (input: Readonly<Record<string, unknown>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      Buffer.isBuffer(value) ? value.toString('utf8') : String(value),
    ]),
  );

export const isPrivateLanAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.local')) return true;
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      (octets[0] === 169 && octets[1] === 254) ||
      octets[0] === 127
    );
  }
  if (isIP(normalized) === 6) {
    return (
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }
  return false;
};

export class LanDiscoveryController {
  private readonly documentSecret: Buffer;
  private readonly clock: () => number;
  private readonly backendFactory: () => DiscoveryBackend;
  private enabled: boolean;
  private backend: DiscoveryBackend | undefined;
  private advertisement: DiscoveryHandle | undefined;
  private readonly browsers = new Set<DiscoveryHandle>();
  private destroyed = false;

  public constructor(options: LanDiscoveryControllerOptions) {
    this.documentSecret = normalizeDocumentSecret(options.documentSecret);
    this.enabled = options.enabled ?? false;
    this.clock = options.clock ?? (() => Date.now());
    this.backendFactory = options.backendFactory ?? (() => new BonjourDiscoveryBackend());
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  public advertise(invitation: ManualInvitation): void {
    this.assertEnabled();
    const parsed = manualInvitationSchema.parse(invitation);
    if (parsed.expiresAtMs <= this.clock()) {
      throw new CollaborationError('INVALID_REQUEST', 'Expired invitations cannot be advertised.');
    }
    this.advertisement?.stop();
    const hint = createDiscoveryHint(this.documentSecret, {
      sessionId: parsed.sessionId,
      certificateFingerprint: parsed.certificateFingerprint,
      port: parsed.port,
      expiresAtMs: parsed.expiresAtMs,
    });
    this.advertisement = this.getBackend().publish({
      name: `HTMLlelujah ${parsed.sessionId.slice(0, 8)}`,
      type: HTMLLELUJAH_DISCOVERY_TYPE,
      protocol: 'tcp',
      port: parsed.port,
      txt: {
        v: String(COLLABORATION_PROTOCOL_VERSION),
        sid: parsed.sessionId,
        fp: parsed.certificateFingerprint,
        exp: String(parsed.expiresAtMs),
        hint,
      },
    });
  }

  public browse(onInvitation: (invitation: ManualInvitation) => void): () => void {
    this.assertEnabled();
    const handle = this.getBackend().browse((service) => {
      let txt;
      try {
        txt = discoveryTxtSchema.parse(normalizeTxt(service.txt));
      } catch {
        return;
      }
      const expiresAtMs = Number(txt.exp);
      if (expiresAtMs <= this.clock()) return;
      const expectedHint = createDiscoveryHint(this.documentSecret, {
        sessionId: txt.sid,
        certificateFingerprint: txt.fp,
        port: service.port,
        expiresAtMs,
      });
      if (!constantTimeEqual(txt.hint, expectedHint)) return;
      const host = service.addresses.find(isPrivateLanAddress) ?? service.host;
      if (!isPrivateLanAddress(host)) return;
      onInvitation(
        manualInvitationSchema.parse({
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          host,
          port: service.port,
          sessionId: txt.sid,
          certificateFingerprint: txt.fp,
          expiresAtMs,
        }),
      );
    });
    this.browsers.add(handle);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      handle.stop();
      this.browsers.delete(handle);
    };
  }

  public stop(): void {
    this.advertisement?.stop();
    this.advertisement = undefined;
    this.browsers.forEach((browser) => browser.stop());
    this.browsers.clear();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.backend?.destroy();
    this.backend = undefined;
    this.documentSecret.fill(0);
  }

  private assertEnabled(): void {
    if (this.destroyed) {
      throw new CollaborationError('INVALID_REQUEST', 'Discovery controller is destroyed.');
    }
    if (!this.enabled) {
      throw new CollaborationError(
        'INVALID_REQUEST',
        'LAN discovery requires explicit user opt-in.',
      );
    }
  }

  private getBackend(): DiscoveryBackend {
    this.backend ??= this.backendFactory();
    return this.backend;
  }
}

export const encodeManualInvitation = (invitation: ManualInvitation): string =>
  Buffer.from(JSON.stringify(manualInvitationSchema.parse(invitation)), 'utf8').toString(
    'base64url',
  );

export const decodeManualInvitation = (encoded: string): ManualInvitation => {
  try {
    return manualInvitationSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    );
  } catch {
    throw new CollaborationError('INVALID_REQUEST', 'Manual invitation is malformed.');
  }
};
