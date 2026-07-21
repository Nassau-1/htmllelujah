import type { CollaborationHostAddress } from '../shared/desktop-api.js';

/** Keeps an explicit choice, auto-selects only an unambiguous first choice, and never falls over. */
export const reconcileHostAddressSelection = (
  current: string,
  available: readonly CollaborationHostAddress[],
  requiresConfirmation = false,
): { readonly address: string; readonly requiresConfirmation: boolean } => {
  if (current !== '' && available.some((entry) => entry.address === current)) {
    return { address: current, requiresConfirmation };
  }
  if (current !== '') return { address: '', requiresConfirmation: true };
  if (requiresConfirmation) return { address: '', requiresConfirmation: true };
  if (available.length === 1) {
    return { address: available[0]?.address ?? '', requiresConfirmation: false };
  }
  return { address: '', requiresConfirmation: false };
};
