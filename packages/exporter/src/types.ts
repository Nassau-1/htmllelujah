import type { DeckDocumentInput } from '@htmllelujah/document-core';

export type HiddenSlidePolicy = 'exclude' | 'include';

export interface ExportRasterAsset {
  readonly id: string;
  readonly bytes: Uint8Array;
}

/** Compatible with the asset map returned by the .hdeck parser. */
export type ExportAssets = ReadonlyMap<string, Uint8Array> | readonly ExportRasterAsset[];

export interface BaseHtmlExportOptions {
  readonly hiddenSlides?: HiddenSlidePolicy | undefined;
  readonly title?: string | undefined;
}

export interface StandaloneHtmlOptions extends BaseHtmlExportOptions {
  readonly startSlideId?: string | undefined;
  readonly clickNavigation?: boolean | undefined;
}

export interface PrintHtmlOptions extends BaseHtmlExportOptions {
  readonly readinessDeadlineMs?: number | undefined;
}

export type ExporterErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'ASSET_INVALID'
  | 'ASSET_LIMIT_EXCEEDED'
  | 'EXPORT_LIMIT_EXCEEDED'
  | 'RENDER_NOT_READY'
  | 'EXPORT_FAILED';

export class ExporterError extends Error {
  public readonly code: ExporterErrorCode;

  public constructor(code: ExporterErrorCode, message: string) {
    super(message);
    this.name = 'ExporterError';
    this.code = code;
  }
}

export interface CreateExportInput {
  readonly deck: DeckDocumentInput;
  readonly assets: ExportAssets;
}

export interface StagedHtmlOutput {
  verify(): Promise<boolean>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** Trusted-process capability. It contains no renderer-supplied path. */
export interface AtomicHtmlOutputCapability {
  stage(
    input: Readonly<{
      bytes: Uint8Array;
      sha256: string;
      mediaType: 'text/html';
    }>,
  ): Promise<StagedHtmlOutput>;
}

export interface AtomicHtmlWriteResult {
  readonly byteLength: number;
  readonly sha256: string;
}
