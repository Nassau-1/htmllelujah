import type {
  CommentAnchor,
  CommentMessage,
  CommentThread,
  DeckDocument,
} from '@htmllelujah/document-core';
import { Check, CornerUpLeft, MessageSquarePlus, RotateCcw } from 'lucide-react';
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';

export type ReviewScope = 'slide' | 'deck';
export type ReviewStatus = 'open' | 'resolved' | 'all';

export const isCommentUnread = (thread: CommentThread, actorId: string): boolean =>
  !thread.readBy.includes(actorId);

export const commentAnchorLabel = (document: DeckDocument, thread: CommentThread): string => {
  const slideIndex = document.slides.findIndex((slide) => slide.id === thread.anchor.slideId);
  const slide = document.slides[slideIndex];
  const slideLabel =
    slide === undefined ? 'Missing slide' : `Slide ${slideIndex + 1}: ${slide.name}`;
  if (thread.anchor.elementId === undefined || slide === undefined) return slideLabel;
  const visit = (elements: DeckDocument['slides'][number]['elements']): string | undefined => {
    for (const element of elements) {
      if (element.id === thread.anchor.elementId) return element.name;
      if (element.type === 'group') {
        const nested = visit(element.children);
        if (nested !== undefined) return nested;
      }
    }
    return undefined;
  };
  const elementName = visit(slide.elements);
  return elementName === undefined ? slideLabel : `${slideLabel} · ${elementName}`;
};

export const reviewThreads = (
  document: DeckDocument,
  activeSlideId: string,
  scope: ReviewScope,
  status: ReviewStatus,
): readonly CommentThread[] =>
  [...(document.comments ?? [])]
    .filter((thread) => scope === 'deck' || thread.anchor.slideId === activeSlideId)
    .filter(
      (thread) => status === 'all' || (status === 'resolved' ? thread.resolved : !thread.resolved),
    )
    .sort((left, right) => {
      const leftTime = left.messages.at(-1)?.createdAt ?? '';
      const rightTime = right.messages.at(-1)?.createdAt ?? '';
      return rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id);
    });

const timestampLabel = (timestamp: string): string => timestamp.slice(0, 16).replace('T', ' ');

const Message = ({ message }: { readonly message: CommentMessage }): ReactElement => (
  <article className="review-message">
    <header>
      <strong>{message.authorName ?? message.authorId}</strong>
      <time dateTime={message.createdAt}>{timestampLabel(message.createdAt)}</time>
    </header>
    <p>{message.body}</p>
  </article>
);

export interface ReviewPanelProps {
  readonly document: DeckDocument;
  readonly activeSlideId: string;
  readonly selectedElementId?: string | undefined;
  readonly actorId: string;
  readonly actorName?: string | undefined;
  readonly onCreate: (anchor: CommentAnchor, body: string) => void | Promise<void>;
  readonly onReply: (threadId: string, body: string) => void | Promise<void>;
  readonly onSetResolved: (threadId: string, resolved: boolean) => void | Promise<void>;
  readonly onMarkRead: (threadId: string) => void | Promise<void>;
  readonly onSelectAnchor: (anchor: CommentAnchor) => void;
}

export function ReviewPanel({
  document,
  activeSlideId,
  selectedElementId,
  actorId,
  actorName,
  onCreate,
  onReply,
  onSetResolved,
  onMarkRead,
  onSelectAnchor,
}: ReviewPanelProps): ReactElement {
  const [scope, setScope] = useState<ReviewScope>('slide');
  const [status, setStatus] = useState<ReviewStatus>('open');
  const [newBody, setNewBody] = useState('');
  const [replyByThread, setReplyByThread] = useState<Readonly<Record<string, string>>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const threads = useMemo(
    () => reviewThreads(document, activeSlideId, scope, status),
    [activeSlideId, document, scope, status],
  );
  const activeAnchor: CommentAnchor = {
    slideId: activeSlideId,
    ...(selectedElementId === undefined ? {} : { elementId: selectedElementId }),
  };

  const run = async (key: string, action: () => void | Promise<void>): Promise<boolean> => {
    if (pendingKey !== null) return false;
    setPendingKey(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The review action failed.');
      return false;
    } finally {
      setPendingKey(null);
    }
  };

  const createComment = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const body = newBody.trim();
    if (body.length === 0 || activeSlideId.length === 0) return;
    void run('create', () => onCreate(activeAnchor, body)).then((created) => {
      if (created) setNewBody('');
    });
  };

  return (
    <section
      className="review-panel"
      aria-label="Presentation review"
      aria-busy={pendingKey !== null}
    >
      <header className="review-panel-header">
        <div>
          <span className="eyebrow">Review</span>
          <h2>Comments</h2>
        </div>
        <span className="review-count" aria-label={`${threads.length} visible comments`}>
          {threads.length}
        </span>
      </header>

      <div className="review-filter-row">
        <label>
          Scope
          <select
            value={scope}
            onChange={(event) => setScope(event.currentTarget.value as ReviewScope)}
          >
            <option value="slide">Current slide</option>
            <option value="deck">Whole deck</option>
          </select>
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value as ReviewStatus)}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      <form className="review-compose" onSubmit={createComment}>
        <label htmlFor="review-new-comment">
          {selectedElementId === undefined
            ? 'Comment on this slide'
            : 'Comment on the selected object'}
        </label>
        <textarea
          id="review-new-comment"
          value={newBody}
          maxLength={20_000}
          placeholder="Add a precise review note…"
          onChange={(event) => setNewBody(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="review-action is-primary"
          disabled={newBody.trim().length === 0 || pendingKey !== null}
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
          Add comment
        </button>
      </form>

      {error === null ? null : (
        <p className="review-error" role="alert">
          {error}
        </p>
      )}

      <div className="review-thread-list" aria-live="polite">
        {threads.length === 0 ? (
          <p className="review-empty">
            No {status === 'all' ? '' : `${status} `}comments in this scope.
          </p>
        ) : (
          threads.map((thread) => {
            const unread = isCommentUnread(thread, actorId);
            const reply = replyByThread[thread.id] ?? '';
            return (
              <article
                key={thread.id}
                className={`review-thread${thread.resolved ? ' is-resolved' : ''}${unread ? ' is-unread' : ''}`}
                data-comment-thread-id={thread.id}
              >
                <header className="review-thread-header">
                  <button
                    type="button"
                    className="review-anchor"
                    onClick={() => {
                      onSelectAnchor(thread.anchor);
                      if (unread) void run(`read:${thread.id}`, () => onMarkRead(thread.id));
                    }}
                  >
                    {commentAnchorLabel(document, thread)}
                  </button>
                  {unread ? <span className="review-unread">New</span> : null}
                </header>
                <div className="review-messages">
                  {thread.messages.map((message) => (
                    <Message key={message.id} message={message} />
                  ))}
                </div>
                <form
                  className="review-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const body = reply.trim();
                    if (body.length === 0) return;
                    void run(`reply:${thread.id}`, () => onReply(thread.id, body)).then(
                      (replied) => {
                        if (replied) {
                          setReplyByThread((current) => ({
                            ...current,
                            [thread.id]: '',
                          }));
                        }
                      },
                    );
                  }}
                >
                  <label className="sr-only" htmlFor={`review-reply-${thread.id}`}>
                    Reply as {actorName ?? actorId}
                  </label>
                  <textarea
                    id={`review-reply-${thread.id}`}
                    maxLength={20_000}
                    value={reply}
                    placeholder="Reply…"
                    onChange={(event) =>
                      setReplyByThread((current) => ({
                        ...current,
                        [thread.id]: event.currentTarget.value,
                      }))
                    }
                  />
                  <div className="review-thread-actions">
                    <button
                      type="submit"
                      className="review-action"
                      disabled={reply.trim().length === 0 || pendingKey !== null}
                    >
                      <CornerUpLeft size={15} aria-hidden="true" />
                      Reply
                    </button>
                    <button
                      type="button"
                      className="review-action is-ghost"
                      disabled={pendingKey !== null}
                      onClick={() =>
                        void run(`resolve:${thread.id}`, () =>
                          onSetResolved(thread.id, !thread.resolved),
                        )
                      }
                    >
                      {thread.resolved ? (
                        <RotateCcw size={15} aria-hidden="true" />
                      ) : (
                        <Check size={15} aria-hidden="true" />
                      )}
                      {thread.resolved ? 'Reopen' : 'Resolve'}
                    </button>
                  </div>
                </form>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
