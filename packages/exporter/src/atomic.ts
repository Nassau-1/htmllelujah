import { TextEncoder } from 'node:util';

import { sha256Hex } from './assets.js';
import {
  ExporterError,
  type AtomicHtmlOutputCapability,
  type AtomicHtmlWriteResult,
  type StagedHtmlOutput,
} from './types.js';

export const writeHtmlAtomically = async (
  capability: AtomicHtmlOutputCapability,
  html: string,
): Promise<AtomicHtmlWriteResult> => {
  const bytes = new TextEncoder().encode(html);
  const sha256 = sha256Hex(bytes);
  let staged: StagedHtmlOutput | undefined;
  try {
    staged = await capability.stage({ bytes, sha256, mediaType: 'text/html' });
    if (!(await staged.verify())) {
      throw new ExporterError('EXPORT_FAILED', 'The staged export failed verification.');
    }
    await staged.commit();
    return { byteLength: bytes.byteLength, sha256 };
  } catch (error: unknown) {
    if (staged !== undefined) await staged.discard().catch(() => undefined);
    if (error instanceof ExporterError) throw error;
    throw new ExporterError('EXPORT_FAILED', 'The atomic export capability failed.');
  }
};
