import type { CommentAnchor, DocumentCommand, Element } from '@htmllelujah/document-core';

export interface ReviewCommandContext {
  readonly actorId: string;
  readonly actorName?: string | undefined;
  readonly createId: () => string;
  readonly now: () => string;
}

type CreateCommentCommand = Extract<DocumentCommand, { readonly type: 'comment.create' }>;
type ReplyCommentCommand = Extract<DocumentCommand, { readonly type: 'comment.reply' }>;
type SetResolvedCommand = Extract<DocumentCommand, { readonly type: 'comment.set-resolved' }>;
type MarkReadCommand = Extract<DocumentCommand, { readonly type: 'comment.mark-read' }>;

const authorNamePatch = (
  actorName: string | undefined,
): Readonly<{ authorName?: string | undefined }> => {
  const normalized = actorName?.trim();
  return normalized === undefined || normalized === '' ? {} : { authorName: normalized };
};

export const createCommentCommand = (
  context: ReviewCommandContext,
  anchor: CommentAnchor,
  body: string,
): CreateCommentCommand => ({
  type: 'comment.create',
  threadId: context.createId(),
  anchor,
  message: {
    id: context.createId(),
    authorId: context.actorId,
    ...authorNamePatch(context.actorName),
    createdAt: context.now(),
    body: body.trim(),
  },
});

export const replyCommentCommand = (
  context: ReviewCommandContext,
  threadId: string,
  body: string,
): ReplyCommentCommand => ({
  type: 'comment.reply',
  threadId,
  message: {
    id: context.createId(),
    authorId: context.actorId,
    ...authorNamePatch(context.actorName),
    createdAt: context.now(),
    body: body.trim(),
  },
});

export const setCommentResolvedCommand = (
  context: ReviewCommandContext,
  threadId: string,
  resolved: boolean,
): SetResolvedCommand => ({
  type: 'comment.set-resolved',
  threadId,
  resolved,
  actorId: context.actorId,
  timestamp: context.now(),
});

export const markCommentReadCommand = (
  context: Pick<ReviewCommandContext, 'actorId'>,
  threadId: string,
): MarkReadCommand => ({
  type: 'comment.mark-read',
  threadId,
  actorId: context.actorId,
});

export const topLevelSelectionForCommentAnchor = (
  elements: readonly Element[],
  elementId: string | undefined,
): readonly string[] => {
  if (elementId === undefined) return [];
  const contains = (element: Element): boolean =>
    element.id === elementId ||
    (element.type === 'group' && element.children.some((child) => contains(child)));
  const selectable = elements.find((element) => contains(element));
  return selectable === undefined ? [] : [selectable.id];
};
