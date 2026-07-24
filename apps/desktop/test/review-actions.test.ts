import {
  createDefaultDeck,
  documentCommandSchema,
  type Element,
  type GroupElement,
} from '@htmllelujah/document-core';
import { describe, expect, it } from 'vitest';

import {
  createCommentCommand,
  markCommentReadCommand,
  replyCommentCommand,
  setCommentResolvedCommand,
  topLevelSelectionForCommentAnchor,
  type ReviewCommandContext,
} from '../src/renderer/editor/review-actions';

const identifiers = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
] as const;

const context = (actorName = ' Alice '): ReviewCommandContext => {
  let index = 0;
  return {
    actorId: 'desktop-42',
    actorName,
    createId: () => identifiers[index++]!,
    now: () => '2026-07-24T12:34:56.000Z',
  };
};

describe('review actions', () => {
  it('builds schema-valid attributed commands with normalized display names', () => {
    const anchor = {
      slideId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      elementId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    };
    const create = createCommentCommand(context(), anchor, '  Focus the headline.  ');
    expect(documentCommandSchema.parse(create)).toEqual(create);
    expect(create).toMatchObject({
      type: 'comment.create',
      anchor,
      message: {
        authorId: 'desktop-42',
        authorName: 'Alice',
        createdAt: '2026-07-24T12:34:56.000Z',
        body: 'Focus the headline.',
      },
    });

    const reply = replyCommentCommand(context('   '), create.threadId, '  Agreed.  ');
    expect(documentCommandSchema.parse(reply)).toEqual(reply);
    expect(reply.message).not.toHaveProperty('authorName');
    expect(reply.message.body).toBe('Agreed.');

    const resolved = setCommentResolvedCommand(context(), create.threadId, true);
    expect(documentCommandSchema.parse(resolved)).toEqual(resolved);
    expect(resolved.actorId).toBe('desktop-42');

    const read = markCommentReadCommand(context(), create.threadId);
    expect(documentCommandSchema.parse(read)).toEqual(read);
    expect(read.actorId).toBe('desktop-42');
  });

  it('selects the top-level group when a comment targets a nested object', () => {
    const document = createDefaultDeck();
    const child = document.slides[0]!.elements[0]!;
    const group: GroupElement = {
      id: 'group',
      type: 'group',
      name: 'Grouped review target',
      frame: child.frame,
      opacity: 1,
      visible: true,
      locked: false,
      coordinateSpace: {
        widthPt: child.frame.widthPt,
        heightPt: child.frame.heightPt,
      },
      children: [{ ...child, id: 'nested-child' }],
    };
    const elements: readonly Element[] = [group, child];

    expect(topLevelSelectionForCommentAnchor(elements, 'nested-child')).toEqual(['group']);
    expect(topLevelSelectionForCommentAnchor(elements, child.id)).toEqual([child.id]);
    expect(topLevelSelectionForCommentAnchor(elements, 'missing')).toEqual([]);
    expect(topLevelSelectionForCommentAnchor(elements, undefined)).toEqual([]);
  });
});
