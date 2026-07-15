import type { HtmllelujahDesktopApi } from '../shared/desktop-api';

declare global {
  interface Window {
    readonly htmllelujah: HtmllelujahDesktopApi;
  }
}

export {};
