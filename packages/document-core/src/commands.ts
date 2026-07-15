import { z } from 'zod';

import type { Element, Frame, Slide } from './model.js';
import { elementSchema, frameSchema, slideSchema } from './schemas.js';

interface ElementContainerTarget {
  /** Omit to target the slide root; otherwise targets the named group. */
  readonly containerId?: string | undefined;
}

export interface CreateSlideCommand {
  readonly type: 'slide.create';
  readonly slide: Slide;
  readonly index?: number | undefined;
}

export interface DeleteSlideCommand {
  readonly type: 'slide.delete';
  readonly slideId: string;
}

export interface ReorderSlideCommand {
  readonly type: 'slide.reorder';
  readonly slideId: string;
  readonly toIndex: number;
}

export interface InsertElementCommand extends ElementContainerTarget {
  readonly type: 'element.insert';
  readonly slideId: string;
  readonly element: Element;
  readonly index?: number | undefined;
}

export interface UpdateElementCommand extends ElementContainerTarget {
  readonly type: 'element.update';
  readonly slideId: string;
  readonly elementId: string;
  /** Complete replacement keeps updates discriminated and runtime-validatable. */
  readonly replacement: Element;
}

export interface DeleteElementsCommand extends ElementContainerTarget {
  readonly type: 'element.delete';
  readonly slideId: string;
  readonly elementIds: readonly string[];
}

export interface ElementFrameUpdate {
  readonly elementId: string;
  readonly frame: Frame;
}

export interface TransformElementsCommand extends ElementContainerTarget {
  readonly type: 'element.transform';
  readonly slideId: string;
  readonly transforms: readonly ElementFrameUpdate[];
}

export type AlignMode =
  'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-middle' | 'bottom';

export interface AlignElementsCommand extends ElementContainerTarget {
  readonly type: 'element.align';
  readonly slideId: string;
  readonly elementIds: readonly string[];
  readonly mode: AlignMode;
  readonly relativeTo: 'selection' | 'container';
}

export interface DistributeElementsCommand extends ElementContainerTarget {
  readonly type: 'element.distribute';
  readonly slideId: string;
  readonly elementIds: readonly string[];
  readonly axis: 'horizontal' | 'vertical';
  readonly relativeTo: 'selection' | 'container';
}

export interface GroupElementsCommand extends ElementContainerTarget {
  readonly type: 'element.group';
  readonly slideId: string;
  readonly elementIds: readonly string[];
  readonly groupId: string;
  readonly name: string;
}

export interface UngroupElementsCommand extends ElementContainerTarget {
  readonly type: 'element.ungroup';
  readonly slideId: string;
  readonly groupId: string;
}

export type DocumentCommand =
  | CreateSlideCommand
  | DeleteSlideCommand
  | ReorderSlideCommand
  | InsertElementCommand
  | UpdateElementCommand
  | DeleteElementsCommand
  | TransformElementsCommand
  | AlignElementsCommand
  | DistributeElementsCommand
  | GroupElementsCommand
  | UngroupElementsCommand;

const identifierSchema = z.string().uuid();
const containerShape = { containerId: identifierSchema.optional() } as const;
const elementIdsSchema = z.array(identifierSchema).min(1);
const uniqueElementIdsSchema = elementIdsSchema.refine(
  (identifiers) => new Set(identifiers).size === identifiers.length,
  { message: 'Element identifiers must be unique within a command.' },
);

export const documentCommandSchema: z.ZodType<DocumentCommand> = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('slide.create'),
      slide: slideSchema,
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('slide.delete'),
      slideId: identifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('slide.reorder'),
      slideId: identifierSchema,
      toIndex: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.insert'),
      slideId: identifierSchema,
      element: elementSchema,
      index: z.number().int().min(0).optional(),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.update'),
      slideId: identifierSchema,
      elementId: identifierSchema,
      replacement: elementSchema,
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.delete'),
      slideId: identifierSchema,
      elementIds: uniqueElementIdsSchema,
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.transform'),
      slideId: identifierSchema,
      transforms: z
        .array(
          z
            .object({
              elementId: identifierSchema,
              frame: frameSchema,
            })
            .strict(),
        )
        .min(1)
        .refine(
          (transforms) =>
            new Set(transforms.map((transform) => transform.elementId)).size === transforms.length,
          { message: 'Each element may be transformed only once per command.' },
        ),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.align'),
      slideId: identifierSchema,
      elementIds: uniqueElementIdsSchema.min(2),
      mode: z.enum(['left', 'horizontal-center', 'right', 'top', 'vertical-middle', 'bottom']),
      relativeTo: z.enum(['selection', 'container']),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.distribute'),
      slideId: identifierSchema,
      elementIds: uniqueElementIdsSchema.min(3),
      axis: z.enum(['horizontal', 'vertical']),
      relativeTo: z.enum(['selection', 'container']),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.group'),
      slideId: identifierSchema,
      elementIds: uniqueElementIdsSchema.min(2),
      groupId: identifierSchema,
      name: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      ...containerShape,
      type: z.literal('element.ungroup'),
      slideId: identifierSchema,
      groupId: identifierSchema,
    })
    .strict(),
]);

export type TransactionOrigin = 'user' | 'agent' | 'import' | 'remote' | 'system';

export interface TransactionMetadata {
  readonly transactionId: string;
  readonly actorId: string;
  readonly origin: TransactionOrigin;
  readonly label: string;
  readonly timestamp: string;
}

export interface TransactionOptions {
  readonly expectedRevision?: string | undefined;
  readonly metadata: TransactionMetadata;
}

export const transactionMetadataSchema: z.ZodType<TransactionMetadata> = z
  .object({
    transactionId: identifierSchema,
    actorId: z.string().trim().min(1),
    origin: z.enum(['user', 'agent', 'import', 'remote', 'system']),
    label: z.string().trim().min(1),
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();
