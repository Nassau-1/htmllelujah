import { createHash } from 'node:crypto';

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

export const buildHtmlDocument = (input: HtmlDocumentInput): string => {
  const script = escapeInlineScript(input.script);
  const css = escapeInlineStyle(input.css);
  const csp = createContentSecurityPolicy(script, css);
  const extraAttributes = Object.entries(input.htmlDataAttributes ?? {})
    .map(([name, value]) => ` data-${name}="${escapeHtmlAttribute(value)}"`)
    .join('');
  return `<!doctype html>
<html lang="${escapeHtmlAttribute(input.locale)}" data-htmllelujah-export="${input.kind}-v1"${extraAttributes}>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtmlText(input.title)}</title>
<style>${css}</style>
</head>
<body>
${input.body}
<script>${script}</script>
</body>
</html>`;
};
