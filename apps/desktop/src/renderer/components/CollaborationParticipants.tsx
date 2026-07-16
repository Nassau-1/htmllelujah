import { Check, Clock3, UserRound, X } from 'lucide-react';

import type { CollaborationStatus } from '../../shared/desktop-api.js';
import '../../styles/collaboration.css';

export interface CollaborationParticipantsProps {
  readonly status: CollaborationStatus;
  readonly decidingJoinId: string | null;
  readonly decisionError: string | null;
  readonly nowMs: number;
  readonly onDecideJoin: (joinRequestId: string, decision: 'accept' | 'reject') => void;
}

const secondsRemaining = (expiresAtMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));

export function CollaborationParticipants({
  status,
  decidingJoinId,
  decisionError,
  nowMs,
  onDecideJoin,
}: CollaborationParticipantsProps) {
  const canApprove = status.mode === 'host';
  return (
    <section className="collaboration-people" aria-labelledby="collaboration-people-title">
      <header>
        <div>
          <h3 id="collaboration-people-title">People in this session</h3>
          <p aria-live="polite">
            {status.participants.length === 0
              ? 'No active participants are visible.'
              : `${status.participants.length} active participant${status.participants.length === 1 ? '' : 's'}.`}
          </p>
        </div>
      </header>

      {canApprove ? (
        <div className="collaboration-join-requests">
          <h4>Join requests</h4>
          {status.pendingJoins.length === 0 ? (
            <p className="collaboration-empty-state">No one is waiting for approval.</p>
          ) : (
            <ul>
              {status.pendingJoins.map((request) => {
                const remaining = secondsRemaining(request.expiresAtMs, nowMs);
                const deciding = decidingJoinId === request.joinRequestId;
                return (
                  <li key={request.joinRequestId}>
                    <div className="collaboration-person-copy">
                      <strong>{request.displayName}</strong>
                      <span>
                        <Clock3 aria-hidden="true" size={14} />
                        {remaining > 0
                          ? `Awaiting your confirmation · ${remaining}s remaining`
                          : 'Request expired · refreshing status'}
                      </span>
                    </div>
                    <div
                      className="collaboration-join-actions"
                      aria-label={`Decide ${request.displayName}'s join request`}
                    >
                      <button
                        type="button"
                        className="primary-inspector-action"
                        disabled={deciding || remaining === 0}
                        aria-label={`Accept ${request.displayName}`}
                        onClick={() => onDecideJoin(request.joinRequestId, 'accept')}
                      >
                        <Check aria-hidden="true" size={15} />
                        {deciding ? 'Working…' : 'Accept'}
                      </button>
                      <button
                        type="button"
                        className="secondary-action"
                        disabled={deciding || remaining === 0}
                        aria-label={`Reject ${request.displayName}`}
                        onClick={() => onDecideJoin(request.joinRequestId, 'reject')}
                      >
                        <X aria-hidden="true" size={15} />
                        Reject
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {decisionError === null ? null : (
            <p className="collaboration-inline-error" role="alert">
              {decisionError}
            </p>
          )}
        </div>
      ) : null}

      <div className="collaboration-participant-list">
        <h4>Participants</h4>
        {status.participants.length === 0 ? (
          <p className="collaboration-empty-state">
            {status.mode === 'guest'
              ? 'The host is unavailable. This copy stays read-only while reconnecting.'
              : 'Start or join a session to see presence.'}
          </p>
        ) : (
          <ul>
            {status.participants.map((participant) => (
              <li key={participant.clientId}>
                <UserRound aria-hidden="true" size={16} />
                <div className="collaboration-person-copy">
                  <strong>
                    {participant.displayName}
                    {participant.isSelf ? ' (you)' : ''}
                  </strong>
                  <span>
                    {participant.role === 'host' ? 'Host' : 'Guest'} ·{' '}
                    {participant.connection === 'active'
                      ? 'Active'
                      : participant.connection === 'reconnecting'
                        ? 'Reconnecting · read-only'
                        : 'Disconnected · read-only'}
                    {participant.editingElementId === undefined
                      ? participant.selectedElementCount > 0
                        ? ` · ${participant.selectedElementCount} selected`
                        : ''
                      : ' · Editing text'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
