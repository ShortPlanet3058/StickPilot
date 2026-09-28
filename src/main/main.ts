import { app, BrowserWindow, clipboard, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { DeviceManager, normalizeHost } from './devices';
import { profileSetFor } from './profiles';
import { detectEncoder, Session } from './scrcpy';
import { flushSettings, getSettings, updateSettings } from './settings';
import { Typer } from './typing';
import { adb } from './adb';
import type { ProfileSet, SessionStatus, Settings } from '../shared/types';

let win: BrowserWindow | null = null;
const devices = new DeviceManager();
const session = new Session();
const typer = new Typer(session);
const encoderBySerial = new Map<string, 'hardware' | 'software'>();
let status: SessionStatus = { state: 'idle' };

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(next: SessionStatus): void {
  status = next;
  send('session:status', status);
}

// ---- Devices

devices.on('changed', (list) => {
  send('devices:changed', list);
  // The mirrored device disappeared (unplugged, network drop, TV turned off)
  const s = status;
  if ((s.state === 'running' || s.state === 'connecting')
      && !list.some((d: { serial: string; state: string }) => d.serial === s.serial && d.state === 'device')) {
    const serial = s.serial;
    void session.stop().then(() => setStatus({
      state: 'ended', serial, cause: 'unplugged',
      reason: serial.includes(':') ? 'The network connection to the device was lost.' : 'The device was unplugged.',
    }));
  }
});

async function profilesFor(serial: string): Promise<ProfileSet> {
  let encoder = encoderBySerial.get(serial);
  if (!encoder) {
    try {
      encoder = await detectEncoder(serial);
      encoderBySerial.set(serial, encoder);
    } catch {
      encoder = 'software'; // the safe, measured set
    }
  }
  return profileSetFor(encoder);
}

// ---- Session

session.on('config', (c) => send('video:config', c));
session.on('packet', (p) => send('video:packet', p));
session.on('log', (line: string) => { if (process.env.FIRETV_DEBUG) process.stdout.write(`[server] ${line}`); });
session.on('ended', (reason: string) => {
  if (status.state === 'running') setStatus({ state: 'ended', serial: status.serial, reason, cause: 'error' });
});

async function start(serial: string, profileId: string): Promise<void> {
  await session.stop();
  const dev = devices.get(serial);
  if (!dev || dev.state !== 'device') throw new Error('This device is not ready.');
  const set = await profilesFor(serial);
  const profile = set.profiles.find((p) => p.id === profileId) || set.profiles.find((p) => p.id === set.defaultId)!;
  updateSettings({ lastSerial: serial, profileBySerial: { ...getSettings().profileBySerial, [serial]: profile.id } });
  setStatus({ state: 'connecting', serial, profileId: profile.id });
  try {
    await session.start(serial, profile);
    setStatus({ state: 'running', serial, profileId: profile.id });
  } catch (e) {
    setStatus({ state: 'ended', serial, cause: 'error', reason: (e as Error).message });
    throw e;
  }
}

// ---- IPC

ipcMain.handle('devices:list', () => devices.list());
ipcMain.handle('devices:connectNetwork', async (_e, host: string) => {
  const result = await devices.connectNetwork(host);
  if (result.ok) {
    const hosts = getSettings().networkHosts;
    const h = normalizeHost(host);
    if (!hosts.includes(h)) updateSettings({ networkHosts: [...hosts, h] });
  }
  return result;
});
ipcMain.handle('devices:forgetNetwork', async (_e, host: string) => {
  const h = normalizeHost(host);
  if (status.state !== 'idle' && status.state !== 'ended' && status.serial === h) {
    await session.stop();
    setStatus({ state: 'idle' });
  }
  await devices.disconnectNetwork(h);
  updateSettings({ networkHosts: getSettings().networkHosts.filter((x) => x !== h) });
});
ipcMain.handle('profiles:for', (_e, serial: string) => profilesFor(serial));
ipcMain.handle('session:start', (_e, serial: string, profileId: string) => start(serial, profileId));
ipcMain.handle('session:stop', async () => {
  const serial = status.state === 'idle' ? '' : status.serial;
  await session.stop();
  setStatus(serial ? { state: 'ended', serial, cause: 'user', reason: '' } : { state: 'idle' });
});
ipcMain.handle('session:status', () => status);
ipcMain.on('key', (_e, keycode: number, action: 0 | 1, repeat: number) => {
  session.key(keycode, action, repeat);
  typer.invalidate(); // navigation may have changed the focused screen
});
ipcMain.on('tap', (_e, keycode: number) => { session.tap(keycode); typer.invalidate(); });
ipcMain.on('text', (_e, text: string) => session.text(text));
ipcMain.on('type', (_e, text: string) => typer.type(text));
ipcMain.on('backspace', () => typer.backspace());
ipcMain.on('pasteClipboard', async () => { const t = await clipboard.readText(); if (t) typer.type(t); });
// scrcpy key injection has no long-press flag, so use adb's; a short delay is fine for a menu
ipcMain.on('quickSettings', () => {
  if (status.state !== 'running') return;
  void adb(['shell', 'input', 'keyevent', '--longpress', '3'], { serial: status.serial }).catch(() => {});
  typer.invalidate();
});
ipcMain.on('window:toggleFullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => { updateSettings(patch); });

// ---- App lifecycle

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 820,
    minWidth: 960,
    minHeight: 560,
    title: 'Fire TV',
    backgroundColor: '#0f1012',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));

  // Development aid: FIRETV_SCREENSHOT=out.png saves the window after it settles
  const shot = process.env.FIRETV_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const image = await win?.webContents.capturePage();
      if (image) fs.writeFileSync(shot, image.toPNG());
    }, Number(process.env.FIRETV_SCREENSHOT_DELAY || 4000)));
  }
}

app.whenReady().then(async () => {
  createWindow();
  await devices.start();
  // Reconnect remembered network devices quietly; failures just leave them absent
  for (const host of getSettings().networkHosts) void devices.connectNetwork(host);
});

app.on('window-all-closed', async () => {
  await session.stop();
  devices.stop();
  flushSettings();
  app.quit();
});
