import { createHash } from 'node:crypto';

import { EXPORT_LIMITS } from './limits.js';
import { ExporterError } from './types.js';

export interface HtmlDocumentInput {
  readonly kind: 'standalone' | 'print';
  readonly locale: string;
  readonly title: string;
  readonly css: string;
  readonly script: string;
  readonly body: string;
  readonly htmlDataAttributes?: Readonly<Record<string, string>> | undefined;
}

export const escapeHtmlText = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const escapeHtmlAttribute = (value: string): string =>
  escapeHtmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const escapeInlineScript = (value: string): string =>
  value.replace(/<\/script/gi, '<\\/script');

const escapeInlineStyle = (value: string): string => value.replace(/<\/style/gi, '<\\/style');

export const sha256Base64 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64');

export const createContentSecurityPolicy = (script: string, css: string): string => {
  const scriptHash = sha256Base64(script);
  const styleHash = sha256Base64(css);
  return [
    "default-src 'none'",
    `script-src 'sha256-${scriptHash}'`,
    `script-src-elem 'sha256-${scriptHash}'`,
    "script-src-attr 'none'",
    "style-src 'unsafe-inline'",
    `style-src-elem 'sha256-${styleHash}'`,
    "style-src-attr 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
    "trusted-types 'none'",
    "require-trusted-types-for 'script'",
  ].join('; ');
};

export class BoundedUtf8Builder {
  readonly #fragments: string[] = [];
  readonly #maxBytes: number;
  #byteLength = 0;

  public constructor(maxBytes: number = EXPORT_LIMITS.maxOutputUtf8Bytes) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > EXPORT_LIMITS.maxOutputUtf8Bytes
    ) {
      throw new ExporterError(
        'INVALID_REQUEST',
        'The output limit must only lower the production ceiling.',
      );
    }
    this.#maxBytes = maxBytes;
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public append(fragment: string): this {
    const bytes = Buffer.byteLength(fragment, 'utf8');
    if (!Number.isSafeInteger(bytes) || this.#byteLength > this.#maxBytes - bytes) {
      throw new ExporterError('EXPORT_LIMIT_EXCEEDED', 'The HTML output exceeds its byte limit.');
    }
    this.#byteLength += bytes;
    this.#fragments.push(fragment);
    return this;
  }

  public toString(): string {
    return this.#fragments.join('');
  }
}

export const buildHtmlDocument = (
  input: HtmlDocumentInput,
  maxUtf8Bytes: number = EXPORT_LIMITS.maxOutputUtf8Bytes,
): string => {
  const script = escapeInlineScript(input.script);
  const css = escapeInlineStyle(input.css);
  const csp = createContentSecurityPolicy(script, css);
  const output = new BoundedUtf8Builder(maxUtf8Bytes);
  output.append(`<!doctype html>
<html lang="${escapeHtmlAttribute(input.locale)}" data-htmllelujah-export="${input.kind}-v1"`);
  for (const [name, value] of Object.entries(input.htmlDataAttributes ?? {})) {
    output.append(` data-${name}="${escapeHtmlAttribute(value)}"`);
  }
  output.append(`>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtmlText(input.title)}</title>
<style>${css}</style>
</head>
<body>
`);
  output.append(input.body);
  output.append(`
<script>${script}</script>
</body>
</html>`);
  return output.toString();
};
