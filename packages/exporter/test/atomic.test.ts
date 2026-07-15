import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { writeHtmlAtomically, type AtomicHtmlOutputCapability } from '../src/index.js';

describe('writeHtmlAtomically', () => {
  it('stages, verifies and commits UTF-8 bytes through an opaque capability', async () => {
    const calls: string[] = [];
    let stagedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const capability: AtomicHtmlOutputCapability = {
      stage: async (input) => {
        calls.push('stage');
        stagedBytes = input.bytes;
        expect(input.mediaType).toBe('text/html');
        expect(input.sha256).toBe(createHash('sha256').update(input.bytes).digest('hex'));
        return {
          verify: async () => {
            calls.push('verify');
            return true;
          },
          commit: async () => {
            calls.push('commit');
          },
          discard: async () => {
            calls.push('discard');
          },
        };
      },
    };

    const result = await writeHtmlAtomically(capability, '<p>Unicode 😀</p>');

    expect(calls).toEqual(['stage', 'verify', 'commit']);
    expect(new TextDecoder().decode(stagedBytes)).toBe('<p>Unicode 😀</p>');
    expect(result.byteLength).toBe(stagedBytes.byteLength);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('discards a failed staged output and exposes only a safe code', async () => {
    const calls: string[] = [];
    const capability: AtomicHtmlOutputCapability = {
      stage: async () => ({
        verify: async () => false,
        commit: async () => {
          throw new Error('must not commit');
        },
        discard: async () => {
          calls.push('discard');
        },
      }),
    };

    await expect(writeHtmlAtomically(capability, 'secret deck content')).rejects.toMatchObject({
      code: 'EXPORT_FAILED',
    });
    expect(calls).toEqual(['discard']);
  });
});
