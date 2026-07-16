import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CollaborationParticipants } from '../src/renderer/components/CollaborationParticipants.js';
import type { CollaborationStatus } from '../src/shared/desktop-api.js';

const hostStatus = (overrides: Partial<CollaborationStatus> = {}): CollaborationStatus => ({
  mode: 'host',
  connectedPeers: 1,
  discoveryEnabled: false,
  participants: [
    {
      clientId: 'host-id',
      displayName: 'Host',
      role: 'host',
      isSelf: true,
      connection: 'active',
      selectedElementCount: 0,
    },
    {
      clientId: 'guest-id',
      displayName: 'Guest',
      role: 'guest',
      isSelf: false,
      connection: 'active',
      selectedElementCount: 2,
    },
  ],
  pendingJoins: [],
  note: 'One guest connected.',
  ...overrides,
});

describe('CollaborationParticipants', () => {
  it('renders bounded pending approval actions with explicit accessible labels', () => {
    const markup = renderToStaticMarkup(
      <CollaborationParticipants
        status={hostStatus({
          pendingJoins: [
            {
              joinRequestId: '94000000-0000-4000-8000-000000000099',
              displayName: 'Alice',
              expiresAtMs: 31_000,
            },
          ],
        })}
        decidingJoinId={null}
        decisionError={null}
        nowMs={1_000}
        onDecideJoin={vi.fn()}
      />,
    );
    expect(markup).toContain('Alice');
    expect(markup).toContain('30s remaining');
    expect(markup).toContain('aria-label="Accept Alice"');
    expect(markup).toContain('aria-label="Reject Alice"');
    expect(markup).toContain('Host');
    expect(markup).toContain('Guest');
    expect(markup).toContain('2 selected');
  });

  it('disables expired and in-flight decisions and exposes errors without color alone', () => {
    const markup = renderToStaticMarkup(
      <CollaborationParticipants
        status={hostStatus({
          pendingJoins: [
            {
              joinRequestId: '94000000-0000-4000-8000-000000000098',
              displayName: 'Expired',
              expiresAtMs: 1_000,
            },
          ],
        })}
        decidingJoinId="94000000-0000-4000-8000-000000000098"
        decisionError="The request expired. Ask the guest to try again."
        nowMs={2_000}
        onDecideJoin={vi.fn()}
      />,
    );
    expect(markup).toContain('Request expired · refreshing status');
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('The request expired. Ask the guest to try again.');
  });

  it('renders host-loss and empty states for a disconnected guest', () => {
    const markup = renderToStaticMarkup(
      <CollaborationParticipants
        status={{
          mode: 'guest',
          connectedPeers: 0,
          discoveryEnabled: false,
          participants: [],
          pendingJoins: [],
          note: 'Host unavailable.',
        }}
        decidingJoinId={null}
        decisionError={null}
        nowMs={0}
        onDecideJoin={vi.fn()}
      />,
    );
    expect(markup).toContain('No active participants are visible.');
    expect(markup).toContain('The host is unavailable. This copy stays read-only');
    expect(markup).not.toContain('Join requests');
  });

  it('escapes untrusted names in the rendered approval list', () => {
    const markup = renderToStaticMarkup(
      <CollaborationParticipants
        status={hostStatus({
          pendingJoins: [
            {
              joinRequestId: '94000000-0000-4000-8000-000000000097',
              displayName: '<img src=x onerror=alert(1)>',
              expiresAtMs: 10_000,
            },
          ],
        })}
        decidingJoinId={null}
        decisionError={null}
        nowMs={0}
        onDecideJoin={vi.fn()}
      />,
    );
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
  });
});
