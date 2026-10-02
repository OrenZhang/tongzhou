import { contextBridge, ipcRenderer } from 'electron';
import type { TongzhouAPI } from '../src/shared/types';
const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke('tongzhou:' + method, ...args);
const api: TongzhouAPI = {
  savePlugin: (p) => call('savePlugin', p),
  deletePlugin: (id) => call('deletePlugin', id),
  testPlugin: (id) => call('testPlugin', id),
  importSkill: () => call('importSkill'),
  saveSkill: (s) => call('saveSkill', s),
  deleteSkill: (id) => call('deleteSkill', id),
  computerStatus: () => call('computerStatus'),
  computerPermission: () => call('computerPermission'),
  emergencyStop: () => call('emergencyStop'),
  snapshot: () => call('snapshot'),
  messages: (id) => call('messages', id),
  saveProvider: (p) => call('saveProvider', p),
  deleteProvider: (id) => call('deleteProvider', id),
  testProvider: (id, model) => call('testProvider', id, model),
  models: (id) => call('models', id),
  saveAgent: (a) => call('saveAgent', a),
  deleteAgent: (id) => call('deleteAgent', id),
  addProject: () => call('addProject'),
  createSession: (id) => call('createSession', id),
  updateSession: (id, p) => call('updateSession', id, p),
  run: (input) => call('run', input),
  team: (input, ids) => call('team', input, ids),
  cancel: (id) => call('cancel', id),
  approve: (id, allow) => call('approve', id, allow),
  listFiles: (id, p) => call('listFiles', id, p),
  readFile: (id, p) => call('readFile', id, p),
  diff: (id) => call('diff', id),
  importCCSwitch: () => call('importCCSwitch'),
  exportSession: (id) => call('exportSession', id),
  nativeStatus: (engine) => call('nativeStatus', engine),
  nativeLogin: (engine, region) => call('nativeLogin', engine, region),
  nativeCancel: (engine) => call('nativeCancel', engine),
  nativeOpen: (engine) => call('nativeOpen', engine),
  nativeCopyCode: (engine) => call('nativeCopyCode', engine),
  nativeLogout: (engine) => call('nativeLogout', engine),
  codexStatus: () => call('codexStatus'),
  codexLogin: (method) => call('codexLogin', method),
  codexLoginRetry: (method) => call('codexLoginRetry', method),
  codexLoginCancel: () => call('codexLoginCancel'),
  codexLoginOpen: () => call('codexLoginOpen'),
  codexLoginCopyCode: () => call('codexLoginCopyCode'),
  codexLogout: () => call('codexLogout'),
  onEvent: (callback) => {
    const listener = (_event: unknown, payload: any) => callback(payload);
    ipcRenderer.on('tongzhou:event', listener);
    return () => ipcRenderer.removeListener('tongzhou:event', listener);
  },
};
contextBridge.exposeInMainWorld('tongzhou', api);
