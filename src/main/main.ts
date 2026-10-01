import { app, BrowserWindow, clipboard, ipcMain, Menu, shell, systemPreferences } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DeviceManager, normalizeHost } from './devices';
import { profileSetFor } from './profiles';
import { detectEncoder, listApps, Session } from './scrcpy';
import { flushSettings, getSettings, updateSettings } from './settings';
import { appArt, cachedAppArt } from './appIcons';
import { adbPath } from './paths';
import { Recorder } from './recorder';
import { DoubleTap } from './doubleTap';
import { TrayRemote } from './tray';
import { Typer } from './typing';
import { adb, shutdownAdb } from './adb';
import type { AppInfo, ProfileSet, SessionMode, SessionStatus, Settings } from '../shared/types';

// Before StickPilot the app was called "firetv", which named its data folder:
// carry the settings and cached app logos over once
function migrateUserData(): void {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'firetv');
  if (fs.existsSync(path.join(now, 'settings.json')) || !fs.existsSync(old) || old === now) return;
  fs.mkdirSync(now, { recursive: true });
  for (const item of ['settings.json', 'app-icons']) {
    const from = path.join(old, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(now, item), { recursive: true });
  }
}
migrateUserData();

let win: BrowserWindow | null = null;
const devices = new DeviceManager();
const session = new Session();
const typer = new Typer(session);
const recorder = new Recorder();
// Development aid: with STICKPILOT_DEBUG, scripts/main-eval.mjs can reach these objects
if (process.env.STICKPILOT_DEBUG) Object.assign(globalThis, { __stickpilot: { session, recorder, devices } });
const encoderBySerial = new Map<string, 'hardware' | 'software'>();
let status: SessionStatus = { state: 'idle' };

/** To the main window only (video and sound) */
function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** To every window, including the menu-bar remote (status, devices, notices) */
function sendAll(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function setStatus(next: SessionStatus): void {
  // A recording belongs to one mirroring session; any change ends it
  if (recorder.active && !(next.state === 'running' && next.mode === 'mirror')) send('record:stopped', recorder.stop());
  status = next;
  sendAll('session:status', status);
  const notice = tray.updateMediaKeys(status.state === 'running');
  if (notice) sendAll('notice', notice);
}

// ---- Devices

devices.on('changed', (list) => {
  sendAll('devices:changed', list);
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
session.on('packet', (p) => { send('video:packet', p); recorder.push(p.data, p.key, p.pts); });
session.on('audio-config', (c) => send('audio:config', c));
session.on('audio-packet', (p) => send('audio:packet', p));
session.on('audio-ended', () => send('audio:ended', null));
session.on('log', (line: string) => { if (process.env.STICKPILOT_DEBUG) process.stdout.write(`[server] ${line}`); });
session.on('ended', (reason: string) => {
  if (status.state === 'running') setStatus({ state: 'ended', serial: status.serial, reason, cause: 'error' });
});

async function start(serial: string, profileId: string, mode: SessionMode): Promise<void> {
  await session.stop();
  const dev = devices.get(serial);
  if (!dev || dev.state !== 'device') throw new Error('This device is not ready.');
  const set = await profilesFor(serial);
  const profile = set.profiles.find((p) => p.id === profileId) || set.profiles.find((p) => p.id === set.defaultId)!;
  updateSettings({ lastSerial: serial, profileBySerial: { ...getSettings().profileBySerial, [serial]: profile.id } });
  const audio = getSettings().audioEnabled;
  setStatus({ state: 'connecting', serial, profileId: profile.id, mode, audio });
  try {
    await session.start(serial, mode === 'mirror' ? profile : null, audio);
    setStatus({ state: 'running', serial, profileId: profile.id, mode, audio });
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
function rememberHost(host: string): void {
  const hosts = getSettings().networkHosts;
  const h = normalizeHost(host);
  if (!hosts.includes(h)) updateSettings({ networkHosts: [...hosts, h] });
}
ipcMain.handle('devices:enableWifi', async (_e, serial: string) => {
  const result = await devices.enableWifi(serial);
  if (result.ok && result.serial) rememberHost(result.serial);
  return result;
});
ipcMain.handle('devices:scan', () => devices.scanNetwork());
ipcMain.handle('devices:remove', async (_e, key: string, serials: string[]) => {
  if ((status.state === 'running' || status.state === 'connecting') && serials.includes(status.serial)) {
    await session.stop();
    setStatus({ state: 'idle' });
  }
  const s = getSettings();
  const network = serials.filter((x) => x.includes(':'));
  for (const host of network) await devices.disconnectNetwork(host);
  const drop = <T>(rec: Record<string, T>, keys: string[]) => Object.fromEntries(Object.entries(rec).filter(([k]) => !keys.includes(k)));
  // Still plugged in over USB: it would come straight back, so keep it out of the lists
  const stillPresent = devices.list().some((d) => serials.includes(d.serial) && d.transport === 'usb');
  updateSettings({
    networkHosts: s.networkHosts.filter((h) => !network.includes(h)),
    favoriteApps: drop(s.favoriteApps, [key]),
    transportByDevice: drop(s.transportByDevice, [key]),
    profileBySerial: drop(s.profileBySerial, serials),
    lastSerial: s.lastSerial && serials.includes(s.lastSerial) ? undefined : s.lastSerial,
    hiddenDevices: stillPresent ? [...new Set([...s.hiddenDevices, key])] : s.hiddenDevices.filter((h) => h !== key),
  });
});

// ---- Apps

const appsCache = new Map<string, { at: number; apps: AppInfo[] }>();
ipcMain.handle('apps:list', async (_e, serial: string, refresh: boolean) => {
  const hit = appsCache.get(serial);
  if (hit && !refresh && Date.now() - hit.at < 5 * 60_000) return hit.apps;
  const apps = await listApps(serial);
  appsCache.set(serial, { at: Date.now(), apps });
  return apps;
});
ipcMain.handle('apps:art', (_e, serial: string, pkgs: string[], refresh: boolean) => appArt(serial, pkgs, refresh));
ipcMain.handle('apps:cachedArt', (_e, pkgs: string[]) => cachedAppArt(pkgs));
ipcMain.handle('apps:launch', async (_e, serial: string, pkg: string) => {
  typer.invalidate();
  // TV apps declare the leanback launcher category; phone apps the regular one
  for (const category of ['android.intent.category.LEANBACK_LAUNCHER', 'android.intent.category.LAUNCHER']) {
    const out = await adb(['shell', 'monkey', '-p', pkg, '-c', category, '1'], { serial, timeout: 10000 }).catch((e) => String(e));
    if (/Events injected: 1/.test(out)) return true;
  }
  return false;
});
ipcMain.handle('apps:stop', async (_e, serial: string, pkg: string) => {
  await adb(['shell', 'am', 'force-stop', pkg], { serial }).catch(() => {});
});
ipcMain.handle('apps:current', async (_e, serial: string) => {
  const out = await adb(['shell', 'dumpsys window | grep -m1 mCurrentFocus'], { serial, timeout: 3000 }).catch(() => '');
  const m = /u0 ([\w.]+)\//.exec(out);
  return m ? m[1] : null;
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
ipcMain.handle('session:start', (_e, serial: string, profileId: string, mode: SessionMode) => start(serial, profileId, mode));
ipcMain.handle('session:stop', async () => {
  const serial = status.state === 'idle' ? '' : status.serial;
  await session.stop();
  setStatus(serial ? { state: 'ended', serial, cause: 'user', reason: '' } : { state: 'idle' });
});
ipcMain.handle('session:status', () => status);
ipcMain.handle('session:connectRemote', async (_e, serial?: string) => {
  const target = serial || getSettings().lastSerial;
  if (!target) throw new Error('No device used yet.');
  await start(target, getSettings().profileBySerial[target] ?? '', 'remote');
});
ipcMain.on('window:showMain', () => showMain());
ipcMain.on('system:openAccessibility', () => {
  // Asking through the system prompt adds this exact build to the Accessibility list; a
  // leftover entry from an older build can look switched on without applying to this one
  if (systemPreferences.isTrustedAccessibilityClient(true)) return;
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

// ---- Screenshots and recordings

function mediaFile(kind: 'pictures' | 'videos', ext: string): string {
  const dir = path.join(app.getPath(kind), 'StickPilot');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} at ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
  return path.join(dir, `StickPilot ${stamp}.${ext}`);
}

// screencap runs on the device at its full resolution, whatever the streaming profile
ipcMain.handle('capture:screenshot', (_e, serial: string) => new Promise((resolve) => {
  execFile(adbPath(), ['-s', serial, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15000, windowsHide: true },
    (err, stdout) => {
      if (err || stdout.length < 100 || stdout.readUInt32BE(0) !== 0x89504e47) {
        resolve({ ok: false, message: 'The device did not return a screenshot.' });
        return;
      }
      const file = mediaFile('pictures', 'png');
      fs.writeFileSync(file, stdout);
      resolve({ ok: true, file });
    });
}));
ipcMain.handle('record:start', (_e, width: number, height: number) => {
  if (status.state !== 'running' || status.mode !== 'mirror') throw new Error('Recording needs the picture to be showing.');
  if (recorder.active) return;
  recorder.start(mediaFile('videos', 'mp4'), width, height);
  session.resetVideo(); // start on a fresh key frame now instead of waiting up to 10 s
});
ipcMain.handle('record:stop', () => recorder.stop());
ipcMain.on('shell:showItem', (_e, file: string) => shell.showItemInFolder(file));

// ---- Device panel

ipcMain.handle('device:info', (_e, serial: string) => devices.statusInfo(serial));
ipcMain.handle('device:power', async (_e, serial: string, action: 'sleep' | 'wake' | 'reboot') => {
  if (action === 'reboot') {
    if (status.state !== 'idle' && status.state !== 'ended' && status.serial === serial) await session.stop();
    await adb(['reboot'], { serial }).catch(() => {});
    return;
  }
  // KEYCODE_SLEEP / KEYCODE_WAKEUP, verified on Fire OS 8
  await adb(['shell', 'input', 'keyevent', action === 'sleep' ? '223' : '224'], { serial }).catch(() => {});
});

// ---- Dropped files

const shortError = (e: unknown) => String((e as Error).message ?? e).split('\n').filter(Boolean).pop()?.replace(/^adb \w+: /, '') ?? '';

ipcMain.handle('files:install', async (_e, serial: string, file: string) => {
  try {
    // -r replaces an installed version (keeps its data)
    const out = await adb(['install', '-r', file], { serial, timeout: 5 * 60_000 });
    return /Success/.test(out) ? { ok: true, message: `${path.basename(file)} installed.` } : { ok: false, message: out.trim() };
  } catch (e) {
    const msg = shortError(e);
    const hint = /INSUFFICIENT_STORAGE/.test(msg) ? 'not enough free space on the device.'
      : /VERSION_DOWNGRADE/.test(msg) ? 'a newer version is already installed.'
      : /UPDATE_INCOMPATIBLE|SIGNATURES/.test(msg) ? 'an incompatible version is installed; uninstall it on the device first.'
      : /NO_MATCHING_ABIS/.test(msg) ? "it isn't built for this device."
      : /INSTALL_PARSE_FAILED|NOT_APK/.test(msg) ? "the file isn't a valid APK."
      // Otherwise keep just the error code, e.g. INSTALL_FAILED_...
      : /Failure \[(\w+)/.exec(msg)?.[1] ?? msg;
    return { ok: false, message: `${path.basename(file)} could not be installed: ${hint}` };
  }
});
ipcMain.handle('files:push', async (_e, serial: string, file: string) => {
  try {
    await adb(['push', file, '/sdcard/Download/'], { serial, timeout: 10 * 60_000 });
    return { ok: true, message: `${path.basename(file)} copied to Download on the device.` };
  } catch (e) {
    return { ok: false, message: `${path.basename(file)} could not be copied: ${shortError(e)}` };
  }
});
ipcMain.on('key', (_e, keycode: number, action: 0 | 1, repeat: number) => {
  session.key(keycode, action, repeat);
  typer.invalidate(); // navigation may have changed the focused screen
});
ipcMain.on('tap', (_e, keycode: number) => { session.tap(keycode); typer.invalidate(); });
ipcMain.on('text', (_e, text: string) => session.text(text));
ipcMain.on('type', (_e, text: string) => typer.type(text));
ipcMain.on('backspace', () => typer.backspace());
ipcMain.on('pasteClipboard', async () => { const t = await clipboard.readText(); if (t) typer.type(t); });
// Fire OS opens quick settings only for a key with the long-press flag, which scrcpy's
// injection can't set, so this goes through adb (about 1 s).
ipcMain.handle('quickSettings', async () => {
  if (status.state !== 'running') return;
  typer.invalidate();
  await adb(['shell', 'input', 'keyevent', '--longpress', '3'], { serial: status.serial }).catch(() => {});
});
ipcMain.on('window:toggleFullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });

// Remote-only view: shrink to a remote-sized window, and restore the size afterwards
const FULL_MIN = { width: 960, height: 560 };
const COMPACT = { width: 360, height: 760 };
let savedBounds: Electron.Rectangle | null = null;
ipcMain.on('window:compact', (_e, on: boolean) => {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  if (on && !savedBounds) {
    savedBounds = win.getBounds();
    win.setMinimumSize(320, 520);
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - COMPACT.width, y: b.y, ...COMPACT }, true);
  } else if (!on && savedBounds) {
    win.setBounds(savedBounds, true);
    win.setMinimumSize(FULL_MIN.width, FULL_MIN.height);
    savedBounds = null;
    win.setAlwaysOnTop(false);
  }
});
ipcMain.on('window:onTop', (_e, on: boolean) => win?.setAlwaysOnTop(on, 'floating'));
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => { updateSettings(patch); });

// ---- App lifecycle

/** App icon files live in assets/ (generated by scripts/make-icons.py) */
const assetPath = (name: string) => (app.isPackaged
  ? path.join(process.resourcesPath, 'assets', name)
  : path.join(app.getAppPath(), 'assets', name));

function createWindow(): void {
  win = new BrowserWindow({
    // Windows and Linux show this in the title bar and taskbar; macOS uses the app bundle's icon
    icon: process.platform === 'darwin' ? undefined : assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    width: 1400,
    height: 820,
    minWidth: 960,
    minHeight: 560,
    title: 'StickPilot',
    backgroundColor: '#0f1012',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Closing the window keeps the app in the menu bar. Nobody sees the picture any
  // more, so a mirroring session drops to remote only (no encoding on the device).
  win.on('close', (e) => {
    if (quitting) return;
    if (!getSettings().stayInMenuBar) { app.quit(); return; }
    e.preventDefault();
    if (win?.isFullScreen()) win.setFullScreen(false);
    win?.hide();
    // Menu bar only from now on: no Dock icon, not in ⌘Tab, until the window is opened again
    if (process.platform === 'darwin') app.dock?.hide();
    // Windows: nothing on screen says the app is still running, so say it once
    else if (!getSettings().trayHintShown) {
      updateSettings({ trayHintShown: true });
      tray.hint('StickPilot is still running', 'Click its icon in the notification area to open the remote; right-click for more, or to quit.');
    }
    if (status.state === 'running' && status.mode === 'mirror') void start(status.serial, status.profileId, 'remote').catch(() => {});
  });
  win.on('enter-full-screen', () => send('window:fullscreen', true));
  win.on('leave-full-screen', () => send('window:fullscreen', false));

  // Development aid: STICKPILOT_SCREENSHOT=out.png saves the window after it settles
  const shot = process.env.STICKPILOT_SCREENSHOT;
  if (shot) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const image = await win?.webContents.capturePage();
      if (image) fs.writeFileSync(shot, image.toPNG());
    }, Number(process.env.STICKPILOT_SCREENSHOT_DELAY || 4000)));
  }
}

// ---- Menu-bar remote and window lifecycle

let quitting = false;

const tray = new TrayRemote({
  icon: process.platform === 'darwin' ? null : assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
  preload: path.join(__dirname, '..', 'preload', 'preload.js'),
  page: path.join(__dirname, '..', 'renderer', 'tray.html'),
  showMain: () => showMain(),
  quit: () => app.quit(),
  tap: (code) => { if (status.state !== 'running') return false; session.tap(code); return true; },
  mediaKeysEnabled: () => getSettings().mediaKeys,
  doubleShiftEnabled: () => getSettings().doubleShift,
  setDoubleShift: (on) => {
    updateSettings({ doubleShift: on });
    applyDoubleShift(true);
  },
  stayInMenuBar: () => getSettings().stayInMenuBar,
  setStayInMenuBar: (on) => { updateSettings({ stayInMenuBar: on }); },
  setMediaKeys: (on) => {
    updateSettings({ mediaKeys: on });
    const notice = tray.updateMediaKeys(status.state === 'running');
    if (notice) sendAll('notice', notice);
  },
});

const doubleShift = new DoubleTap(() => tray.toggle());

let accessWatch: NodeJS.Timeout | null = null;

/** Starts or stops the Right Shift shortcut to match the setting; explains when it can't start */
function applyDoubleShift(explain: boolean): void {
  if (!getSettings().doubleShift) { doubleShift.stop(); return; }
  const problem = doubleShift.start();
  if (!problem) return;
  const needsAccess = process.platform === 'darwin' && /Accessibility/.test(problem);
  if (explain) send('notice', { message: problem, action: needsAccess ? 'accessibility' : undefined });
  // macOS applies the permission to the running app: start as soon as it's granted, no restart needed
  if (needsAccess && !accessWatch) {
    accessWatch = setInterval(() => {
      if (!getSettings().doubleShift || doubleShift.start() === null) {
        clearInterval(accessWatch!);
        accessWatch = null;
        if (doubleShift.active) send('notice', { message: 'Double-tap Right Shift now opens the mini remote.' });
      }
    }, 3000);
  }
}

function showMain(): void {
  if (!win || win.isDestroyed()) createWindow();
  // The Dock icon comes back with the window (it was hidden when the window closed)
  if (process.platform === 'darwin' && !app.dock?.isVisible()) void app.dock?.show();
  win!.show();
  win!.focus();
}

// One StickPilot at a time: opening it again (Start menu, desktop shortcut) shows the running one
// (packaged only, so a development copy can run next to the installed app)
if (app.isPackaged && !app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showMain());
// Windows groups the taskbar button and notifications by this; must match the installer's appId
if (process.platform === 'win32') app.setAppUserModelId('app.stickpilot');

app.on('before-quit', () => { quitting = true; });
app.on('activate', () => showMain());

app.whenReady().then(async () => {
  // A packaged app gets its Dock icon from StickPilot.icns; during development
  // Electron's own icon would show instead
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(assetPath('icon.png'));
  // Windows and Linux would show Electron's File / Edit / View menu bar in the window; nothing in it is needed
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  tray.create();
  // The notice would arrive before the window can show it, so wait for it to load
  win?.webContents.once('did-finish-load', () => applyDoubleShift(true));
  await devices.start();
  // Reconnect remembered network devices quietly; failures just leave them absent
  for (const host of getSettings().networkHosts) void devices.connectNetwork(host);
});

app.on('will-quit', (e) => {
  // Stop the device-side server before exiting
  if (session.active) {
    e.preventDefault();
    void session.stop().then(() => app.quit());
    return;
  }
  devices.stop();
  shutdownAdb();
  doubleShift.stop();
  tray.destroy();
  flushSettings();
});
