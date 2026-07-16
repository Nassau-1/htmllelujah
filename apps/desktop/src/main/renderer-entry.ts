const APP_RENDERER_ENTRY = 'htmllelujah-app://app/index.html';
const DEV_RENDERER_ORIGIN = 'http://127.0.0.1:5173';

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const isExactDevServerBase = (url: URL): boolean =>
  url.origin === DEV_RENDERER_ORIGIN &&
  url.username === '' &&
  url.password === '' &&
  url.pathname === '/' &&
  url.search === '' &&
  url.hash === '';

export const isTrustedRendererUrl = (value: string, packaged: boolean): boolean => {
  const url = parseUrl(value);
  if (url === undefined || url.username !== '' || url.password !== '') return false;
  if (
    url.protocol === 'htmllelujah-app:' &&
    url.hostname === 'app' &&
    url.pathname.startsWith('/')
  ) {
    return true;
  }
  return !packaged && url.origin === DEV_RENDERER_ORIGIN;
};

export const resolveRendererEntryUrl = ({
  packaged,
  devServerUrl,
  query,
}: {
  readonly packaged: boolean;
  readonly devServerUrl?: string;
  readonly query?: URLSearchParams;
}): string => {
  let entry = new URL(APP_RENDERER_ENTRY);
  if (!packaged && devServerUrl !== undefined && devServerUrl !== '') {
    const candidate = parseUrl(devServerUrl);
    if (candidate === undefined || !isExactDevServerBase(candidate)) {
      throw new Error('The development renderer URL must be the pinned loopback Vite origin.');
    }
    entry = candidate;
  }
  if (query !== undefined) {
    for (const [key, value] of query) entry.searchParams.set(key, value);
  }
  return entry.toString();
};
