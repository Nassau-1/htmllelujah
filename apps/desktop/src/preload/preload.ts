import { contextBridge, ipcRenderer } from 'electron';

export type AppInfo = {
  name: string;
  version: string;
  platform: string;
};

const desktopApi = Object.freeze({
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:get-info') as Promise<AppInfo>,
});

contextBridge.exposeInMainWorld('htmllelujah', desktopApi);
