import type { AppInfo } from '../preload/preload';

declare global {
  interface Window {
    htmllelujah: {
      getAppInfo: () => Promise<AppInfo>;
    };
  }
}

export {};
