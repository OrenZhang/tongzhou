import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createClientAPI } from '../src/shared/client-api';

contextBridge.exposeInMainWorld(
  'tongzhou',
  createClientAPI(
    (method, ...args) => ipcRenderer.invoke('tongzhou:' + method, ...args),
    (callback) => {
      const listener = (_event: unknown, payload: any) => callback(payload);
      ipcRenderer.on('tongzhou:event', listener);
      return () => ipcRenderer.removeListener('tongzhou:event', listener);
    },
    (file) => webUtils.getPathForFile(file),
  ),
);
