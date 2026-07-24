export type PresentationImportErrorCode =
  | 'INPUT_LIMIT_EXCEEDED'
  | 'ZIP_INVALID'
  | 'ZIP_LIMIT_EXCEEDED'
  | 'ZIP_UNSUPPORTED'
  | 'CRC_MISMATCH'
  | 'UNSAFE_PACKAGE'
  | 'XML_INVALID'
  | 'XML_LIMIT_EXCEEDED'
  | 'XML_UNSAFE'
  | 'RELATIONSHIP_UNSAFE'
  | 'MISSING_PART'
  | 'UNSUPPORTED_DOCUMENT'
  | 'INVALID_PRESENTATIONML';

export class PresentationImportError extends Error {
  readonly code: PresentationImportErrorCode;
  readonly part: string | undefined;

  constructor(
    code: PresentationImportErrorCode,
    message: string,
    options: { readonly part?: string | undefined; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PresentationImportError';
    this.code = code;
    this.part = options.part;
  }
}

export const importFailure = (
  code: PresentationImportErrorCode,
  message: string,
  part?: string,
): never => {
  throw new PresentationImportError(code, message, part === undefined ? {} : { part });
};
