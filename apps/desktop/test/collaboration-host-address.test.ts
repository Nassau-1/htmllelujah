import { describe, expect, it } from 'vitest';

import { reconcileHostAddressSelection } from '../src/renderer/collaboration-host-address.js';

const adapters = [
  { name: 'VPN adapter', address: '10.0.0.8' },
  { name: 'Wi-Fi', address: '192.168.4.20' },
] as const;

describe('collaboration host address selection', () => {
  it('requires an explicit first choice when multiple adapters are available', () => {
    expect(reconcileHostAddressSelection('', adapters)).toEqual({
      address: '',
      requiresConfirmation: false,
    });
    expect(reconcileHostAddressSelection('192.168.4.20', adapters)).toEqual({
      address: '192.168.4.20',
      requiresConfirmation: false,
    });
  });

  it('clears a disappeared choice instead of silently switching networks', () => {
    expect(reconcileHostAddressSelection('192.168.4.20', [adapters[0]])).toEqual({
      address: '',
      requiresConfirmation: true,
    });
    expect(reconcileHostAddressSelection('', [adapters[0]], true)).toEqual({
      address: '',
      requiresConfirmation: true,
    });
    expect(reconcileHostAddressSelection('', [adapters[0]])).toEqual({
      address: '10.0.0.8',
      requiresConfirmation: false,
    });
  });
});
