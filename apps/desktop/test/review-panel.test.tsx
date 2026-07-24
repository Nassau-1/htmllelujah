import { createDefaultDeck, type DeckDocument } from '@htmllelujah/document-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  commentAnchorLabel,
  isCommentUnread,
  ReviewPanel,
  reviewThreads,
} from '../src/renderer/components/ReviewPanel';

const ids = (() => {
  let index = 0;
  return () => {
    index += 1;
    return `eeeeeeee-eeee-4eee-8eee-${index.toString(16).padStart(12, '0')}`;
  };
})();

const fixture = (): DeckDocument => {
  const document = createDefaultDeck({
    idFactory: ids,
    now: () => '2026-07-24T08:00:00.000Z',
  });
  const slide = document.slides[0]!;
  const element = slide.elements[0]!;
  return {
    ...document,
    comments: [
      {
        id: ids(),
        anchor: { slideId: slide.id, elementId: element.id },
        messages: [
          {
            id: ids(),
            authorId: 'author',
            authorName: 'Alice',
            createdAt: '2026-07-24T08:01:00.000Z',
            body: 'Use a more specific headline.',
          },
        ],
        resolved: false,
        readBy: ['author'],
      },
      {
        id: ids(),
        anchor: { slideId: slide.id },
        messages: [
          {
            id: ids(),
            authorId: 'reviewer',
            createdAt: '2026-07-24T08:02:00.000Z',
            body: 'Resolved slide-level note.',
          },
        ],
        resolved: true,
        resolvedAt: '2026-07-24T08:03:00.000Z',
        resolvedBy: 'reviewer',
        readBy: ['reviewer'],
      },
    ],
  };
};

describe('ReviewPanel', () => {
  it('filters by scope/status and exposes stable anchor and unread labels', () => {
    const document = fixture();
    const slide = document.slides[0]!;
    const open = reviewThreads(document, slide.id, 'slide', 'open');
    const resolved = reviewThreads(document, slide.id, 'slide', 'resolved');

    expect(open).toHaveLength(1);
    expect(resolved).toHaveLength(1);
    expect(commentAnchorLabel(document, open[0]!)).toContain('Title');
    expect(isCommentUnread(open[0]!, 'reviewer')).toBe(true);
    expect(isCommentUnread(open[0]!, 'author')).toBe(false);
  });

  it('renders comments as review UI without adding them to the slide surface', () => {
    const document = fixture();
    const slide = document.slides[0]!;
    const markup = renderToStaticMarkup(
      <ReviewPanel
        document={document}
        activeSlideId={slide.id}
        selectedElementId={slide.elements[0]!.id}
        actorId="reviewer"
        actorName="Reviewer"
        onCreate={() => undefined}
        onReply={() => undefined}
        onSetResolved={() => undefined}
        onMarkRead={() => undefined}
        onSelectAnchor={() => undefined}
      />,
    );

    expect(markup).toContain('Presentation review');
    expect(markup).toContain('Use a more specific headline.');
    expect(markup).toContain('Comment on the selected object');
    expect(markup).toContain('data-comment-thread-id');
    expect(markup).not.toContain('Resolved slide-level note.');
  });
});
