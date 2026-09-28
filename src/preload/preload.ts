import { contextBridge, ipcRenderer } from 'electron';
import type { FireTvApi } from '../shared/types';

const api: FireTvApi = {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  onDevices: (cb) => { ipcRenderer.on('devices:changed', (_e, list) => cb(list)); },
  connectNetwork: (host) => ipcRenderer.invoke('devices:connectNetwork', host),
  forgetNetwork: (host) => ipcRenderer.invoke('devices:forgetNetwork', host),
  profilesFor: (serial) => ipcRenderer.invoke('profiles:for', serial),
  start: (serial, profileId) => ipcRenderer.invoke('session:start', serial, profileId),
  stop: () => ipcRenderer.invoke('session:stop'),
  onStatus: (cb) => { ipcRenderer.on('session:status', (_e, s) => cb(s)); },
  onConfig: (cb) => { ipcRenderer.on('video:config', (_e, c) => cb(c)); },
  onPacket: (cb) => { ipcRenderer.on('video:packet', (_e, p) => cb(p)); },
  key: (keycode, action, repeat = 0) => ipcRenderer.send('key', keycode, action, repeat),
  tap: (keycode) => ipcRenderer.send('tap', keycode),
  type: (text) => ipcRenderer.send('type', text),
  backspace: () => ipcRenderer.send('backspace'),
  quickSettings: () => ipcRenderer.send('quickSettings'),
  pasteClipboard: () => ipcRenderer.send('pasteClipboard'),
  toggleFullscreen: () => ipcRenderer.send('window:toggleFullscreen'),
  onFullscreen: (cb) => { ipcRenderer.on('window:fullscreen', (_e, on) => cb(on)); },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
};

contextBridge.exposeInMainWorld('firetv', api);
