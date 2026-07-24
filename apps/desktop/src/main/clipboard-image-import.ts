import { z } from 'zod';

import type { ClipboardImageMediaType } from '../shared/desktop-api.js';
import { MAX_DESKTOP_IMAGE_BYTES } from './image-import-validation.js';

export const clipboardImageMediaTypeSchema: z.ZodType<ClipboardImageMediaType> = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export const clipboardImageFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => value !== '.' && value !== '..')
  .refine((value) => !/[\u0000-\u001f<>:"/\\|?*]/u.test(value))
  .refine((value) => !/^[a-z][a-z0-9+.-]*:/iu.test(value));

export const clipboardImageBytesSchema = z
  .instanceof(Uint8Array)
  .refine((bytes) => bytes.byteLength > 0)
  .refine((bytes) => bytes.byteLength <= MAX_DESKTOP_IMAGE_BYTES);

/**
 * The strict IPC source envelope deliberately has no field capable of carrying a path or URL.
 * Main-process byte/header/decode validation remains authoritative after this structural gate.
 */
export const clipboardImageImportSourceSchema = z
  .object({
    bytes: clipboardImageBytesSchema,
    mediaType: clipboardImageMediaTypeSchema,
    fileName: clipboardImageFileNameSchema,
  })
  .strict();
