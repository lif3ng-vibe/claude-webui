// Electron preload：把 desktop bridge 通过 contextBridge 注入 window.__claudeWebuiDesktop。
// 形状与 Tauri initialization_script 注入的对象一致（见 src-tauri 的 init script）。
import { contextBridge, ipcRenderer } from 'electron';

const logSubs = new Map<number, (e: unknown) => void>();
let nextSub = 1;

ipcRenderer.on('service:log', (_e, id: number, entry: unknown) => {
  logSubs.get(id)?.(entry);
});

contextBridge.exposeInMainWorld('__claudeWebuiDesktop', {
  kind: 'electron',
  openWindow: (path: string) => ipcRenderer.send('desktop:openWindow', path),
  minimize: () => ipcRenderer.send('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:toggleMaximize'),
  close: () => ipcRenderer.send('desktop:close'),
  setAlwaysOnTop: (v: boolean) => ipcRenderer.send('desktop:setAlwaysOnTop', v),
  openDevTools: () => ipcRenderer.send('desktop:openDevTools'),
  isAlwaysOnTop: () => ipcRenderer.invoke('desktop:isAlwaysOnTop') as Promise<boolean>,
  service: {
    status: () => ipcRenderer.invoke('service:status'),
    start: () => ipcRenderer.invoke('service:start'),
    stop: () => ipcRenderer.invoke('service:stop'),
    restart: () => ipcRenderer.invoke('service:restart'),
    getLogs: () => ipcRenderer.invoke('service:getLogs'),
    onLog: (cb: (e: unknown) => void) => {
      const id = nextSub++;
      logSubs.set(id, cb);
      ipcRenderer.send('service:onLog', id);
      return () => { logSubs.delete(id); ipcRenderer.send('service:unsubLog', id); };
    },
  },
});