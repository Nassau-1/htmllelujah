import type {
  DeckDocument,
  DocumentCommand,
  Element,
  ImageElement,
} from '@htmllelujah/document-core';
import { z } from 'zod';

import type { ImageImportPreset, ImageImportTarget } from '../shared/desktop-api.js';
import { imageFrameForPage } from './image-import-validation.js';

export const imageImportTargetSchema: z.ZodType<ImageImportTarget> = z.discriminatedUnion(
  'surface',
  [
    z.object({ surface: z.literal('slide'), slideId: z.string().uuid() }).strict(),
    z.object({ surface: z.literal('layout'), layoutId: z.string().uuid() }).strict(),
    z.object({ surface: z.literal('master'), masterId: z.string().uuid() }).strict(),
  ],
);

export const imageImportPresetSchema: z.ZodType<ImageImportPreset> = z.literal('watermark');

export type ImageImportMutationErrorCode =
  'TARGET_NOT_FOUND' | 'IMAGE_NOT_FOUND' | 'IMAGE_LOCKED' | 'INVALID_PRESET';

export class ImageImportMutationError extends Error {
  public constructor(
    public readonly code: ImageImportMutationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImageImportMutationError';
  }
}

interface LocatedElement {
  readonly element: Element;
  readonly containerId?: string | undefined;
  readonly locked: boolean;
}

const locateElement = (
  elements: readonly Element[],
  elementId: string,
  parentGroupId?: string,
  ancestorLocked = false,
): LocatedElement | undefined => {
  for (const element of elements) {
    const locked = ancestorLocked || element.locked;
    if (element.id === elementId) {
      return {
        element,
        ...(parentGroupId === undefined ? {} : { containerId: parentGroupId }),
        locked,
      };
    }
    if (element.type === 'group') {
      const nested = locateElement(element.children, elementId, element.id, locked);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const replaceElement = (
  elements: readonly Element[],
  elementId: string,
  replacement: ImageElement,
): readonly Element[] =>
  elements.map((element): Element => {
    if (element.id === elementId) return replacement;
    if (element.type !== 'group') return element;
    return {
      ...element,
      children: replaceElement(element.children, elementId, replacement),
    };
  });

const defaultImageElement = (
  assetId: string,
  elementId: string,
  widthPx: number,
  heightPx: number,
  document: DeckDocument,
): ImageElement => ({
  id: elementId,
  type: 'image',
  name: 'Image',
  frame: imageFrameForPage(widthPx, heightPx, document.page),
  opacity: 1,
  visible: true,
  locked: false,
  assetId,
  altText: 'Presentation image',
  fit: 'cover',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
});

const watermarkImageElement = (
  assetId: string,
  elementId: string,
  document: DeckDocument,
): ImageElement => ({
  id: elementId,
  type: 'image',
  name: 'Image watermark',
  frame: {
    xPt: document.page.widthPt * 0.15,
    yPt: document.page.heightPt * 0.15,
    widthPt: document.page.widthPt * 0.7,
    heightPt: document.page.heightPt * 0.7,
    rotationDeg: 0,
  },
  opacity: 0.16,
  visible: true,
  locked: true,
  assetId,
  altText: 'Watermark image',
  fit: 'contain',
  crop: { top: 0, right: 0, bottom: 0, left: 0 },
});

const replacementImage = (
  elements: readonly Element[],
  elementId: string,
  assetId: string,
): { readonly element: ImageElement; readonly containerId?: string | undefined } => {
  const located = locateElement(elements, elementId);
  if (located?.element.type !== 'image') {
    throw new ImageImportMutationError(
      'IMAGE_NOT_FOUND',
      'The image to replace no longer exists on the selected surface.',
    );
  }
  if (located.locked) {
    throw new ImageImportMutationError(
      'IMAGE_LOCKED',
      'Unlock the image and its containing groups before replacing it.',
    );
  }
  return {
    element: { ...located.element, assetId },
    ...(located.containerId === undefined ? {} : { containerId: located.containerId }),
  };
};

export interface PrepareImageImportMutationInput {
  readonly document: DeckDocument;
  readonly target: ImageImportTarget;
  readonly assetId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly replaceElementId?: string | undefined;
  readonly preset?: ImageImportPreset | undefined;
  readonly createElementId: () => string;
}

export interface PreparedImageImportMutation {
  readonly element: ImageElement;
  readonly commands: readonly DocumentCommand[];
}

/**
 * Builds the one typed document command that depends on an imported asset. The runtime
 * prepends asset.register and commits both pieces at one revision/history boundary.
 */
export const prepareImageImportMutation = (
  input: PrepareImageImportMutationInput,
): PreparedImageImportMutation => {
  const { document, target } = input;
  if (
    input.preset === 'watermark' &&
    (target.surface !== 'master' || input.replaceElementId !== undefined)
  ) {
    throw new ImageImportMutationError(
      'INVALID_PRESET',
      'An image watermark must create a new element on a master.',
    );
  }

  switch (target.surface) {
    case 'slide': {
      const slide = document.slides.find((candidate) => candidate.id === target.slideId);
      if (slide === undefined) {
        throw new ImageImportMutationError(
          'TARGET_NOT_FOUND',
          'The destination slide no longer exists.',
        );
      }
      if (input.replaceElementId === undefined) {
        const element = defaultImageElement(
          input.assetId,
          input.createElementId(),
          input.widthPx,
          input.heightPx,
          document,
        );
        return {
          element,
          commands: [{ type: 'element.insert', slideId: slide.id, element }],
        };
      }
      const replacement = replacementImage(slide.elements, input.replaceElementId, input.assetId);
      return {
        element: replacement.element,
        commands: [
          {
            type: 'element.update',
            slideId: slide.id,
            elementId: input.replaceElementId,
            replacement: replacement.element,
            ...(replacement.containerId === undefined
              ? {}
              : { containerId: replacement.containerId }),
          },
        ],
      };
    }
    case 'layout': {
      const layout = document.layouts.find((candidate) => candidate.id === target.layoutId);
      if (layout === undefined) {
        throw new ImageImportMutationError(
          'TARGET_NOT_FOUND',
          'The destination layout no longer exists.',
        );
      }
      if (input.replaceElementId === undefined) {
        const element = defaultImageElement(
          input.assetId,
          input.createElementId(),
          input.widthPx,
          input.heightPx,
          document,
        );
        return {
          element,
          commands: [
            {
              type: 'layout.update',
              layoutId: layout.id,
              replacement: { ...layout, elements: [...layout.elements, element] },
            },
          ],
        };
      }
      const replacement = replacementImage(layout.elements, input.replaceElementId, input.assetId);
      return {
        element: replacement.element,
        commands: [
          {
            type: 'layout.update',
            layoutId: layout.id,
            replacement: {
              ...layout,
              elements: replaceElement(
                layout.elements,
                input.replaceElementId,
                replacement.element,
              ),
            },
          },
        ],
      };
    }
    case 'master': {
      const master = document.masters.find((candidate) => candidate.id === target.masterId);
      if (master === undefined) {
        throw new ImageImportMutationError(
          'TARGET_NOT_FOUND',
          'The destination master no longer exists.',
        );
      }
      if (input.replaceElementId === undefined) {
        const element =
          input.preset === 'watermark'
            ? watermarkImageElement(input.assetId, input.createElementId(), document)
            : defaultImageElement(
                input.assetId,
                input.createElementId(),
                input.widthPx,
                input.heightPx,
                document,
              );
        return {
          element,
          commands: [
            {
              type: 'master.update',
              masterId: master.id,
              replacement: { ...master, elements: [...master.elements, element] },
            },
          ],
        };
      }
      const replacement = replacementImage(master.elements, input.replaceElementId, input.assetId);
      return {
        element: replacement.element,
        commands: [
          {
            type: 'master.update',
            masterId: master.id,
            replacement: {
              ...master,
              elements: replaceElement(
                master.elements,
                input.replaceElementId,
                replacement.element,
              ),
            },
          },
        ],
      };
    }
  }
};
