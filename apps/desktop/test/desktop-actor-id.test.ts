import { describe, expect, it } from 'vitest';

import { actorIdForWebContents } from '../src/shared/desktop-api';

describe('desktop review actor identity', () => {
  it('derives a stable, non-secret actor id from the renderer identity', () => {
    expect(actorIdForWebContents(42)).toBe('desktop-42');
    expect(actorIdForWebContents(42)).toBe(actorIdForWebContents(42));
    expect(actorIdForWebContents(43)).not.toBe(actorIdForWebContents(42));
  });
});
