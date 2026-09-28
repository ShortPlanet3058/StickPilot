// Types shared by the main process, the preload bridge and the renderer.

export type Transport = 'usb' | 'network';

/** adb's own states, plus 'unknown' for anything new adb may report */
export type AdbState = 'device' | 'unauthorized' | 'offline' | 'authorizing' | 'connecting' | 'unknown';

export type DeviceKind = 'firetv' | 'tv' | 'phone' | 'unknown';

export interface DeviceInfo {
  serial: string;
  state: AdbState;
  transport: Transport;
  /** Friendly name, e.g. "Vignon's Fire TV"; falls back to manufacturer + model */
  name: string;
  model: string;
  manufacturer: string;
  kind: DeviceKind;
  /** e.g. "Fire OS 8.1.8.2" or "Android 14" */
  osLabel: string;
  /** Hardware serial number: the same device over USB and Wi-Fi shares it */
  hardwareId: string;
  /** false until the device has been queried (it can't be while unauthorized) */
  identified: boolean;
}

export interface Profile {
  id: string;
  label: string;
  description: string;
  fps: number;
  size: number;
  bitrate: number;
}

export interface ProfileSet {
  id: string;
  /** Shown under the profile picker, e.g. whether the numbers were measured */
  note: string;
  measured: boolean;
  defaultId: string;
  profiles: Profile[];
}

/** mirror = picture + remote; remote = control only, no video */
export type SessionMode = 'mirror' | 'remote';

export type SessionStatus =
  | { state: 'idle' }
  | { state: 'connecting'; serial: string; profileId: string; mode: SessionMode; audio: boolean }
  | { state: 'running'; serial: string; profileId: string; mode: SessionMode; audio: boolean }
  | { state: 'ended'; serial: string; reason: string; cause: 'user' | 'unplugged' | 'error' };

export interface Settings {
  lastSerial?: string;
  profileBySerial: Record<string, string>;
  networkHosts: string[];
  remoteVisible: boolean;
  showStats: boolean;
  /** Connect to lastSerial on launch when it is available */
  autoConnect: boolean;
  /** Preferred connection per physical device (hardwareId) when it has several */
  transportByDevice: Record<string, Transport>;
  /** Device screen tab */
  homeTab: DeviceKind;
  /** Keep the compact remote window above other windows */
  remoteOnTop: boolean;
  /** Pinned apps (package names) per physical device (hardwareId) */
  favoriteApps: Record<string, string[]>;
  /** Devices removed while still plugged in (hardwareId or serial), kept out of the lists */
  hiddenDevices: string[];
  /** Play the device's sound on this computer (the device goes silent meanwhile on Android 11-12) */
  audioEnabled: boolean;
  /** Media keys (play/pause, previous, next) control the device while connected */
  mediaKeys: boolean;
  /** Double-tapping Right Shift anywhere opens the menu-bar remote */
  doubleShift: boolean;
  /** Closing the window keeps StickPilot in the menu bar (and out of the Dock) instead of quitting */
  stayInMenuBar: boolean;
}

export interface VideoPacket {
  data: Uint8Array;
  key: boolean;
  pts: number;
  lagMs: number;
}

export interface NetworkResult {
  ok: boolean;
  message: string;
  serial?: string;
}

export interface AppInfo {
  name: string;
  pkg: string;
  /** Preinstalled with the system (as opposed to installed by the user) */
  system: boolean;
}

export interface DeviceStatusInfo {
  storage: { totalKB: number; usedKB: number; freeKB: number } | null;
  memory: { totalKB: number; availableKB: number } | null;
  /** CPU temperature in °C and whether the system is throttling because of heat */
  cpuTemp: number | null;
  throttled: boolean;
  wifi: { rssi: number; linkMbps: number; freqMHz: number } | null;
  uptimeSec: number | null;
  screen: string;
  ip: string | null;
  abi: string;
  cores: number | null;
  awake: boolean | null;
}

/** App artwork as data: URLs */
export interface AppArt {
  /** Wide TV launcher banner (usually 320x180) */
  banner?: string;
  /** Square launcher icon */
  icon?: string;
}

export interface ScanResult {
  /** host:port to connect to over adb */
  host: string;
  ip: string;
  /** The TV's own name when it publishes one (Fire TV and Android TV do), else the router's name for it */
  name: string;
  model: string;
  kind: DeviceKind;
  /** The adb port answers: connecting will work (after approval on the device) */
  adb: boolean;
  /** Already connected in StickPilot */
  connected: boolean;
}

/** API exposed to the renderer as window.stickpilot */
export interface StickPilotApi {
  listDevices(): Promise<DeviceInfo[]>;
  onDevices(cb: (devices: DeviceInfo[]) => void): void;
  connectNetwork(host: string): Promise<NetworkResult>;
  forgetNetwork(host: string): Promise<void>;
  /** Adds a Wi-Fi connection to a USB device, reading its IP address itself */
  enableWifi(serial: string): Promise<NetworkResult>;
  scanNetwork(): Promise<ScanResult[]>;
  /**
   * Forgets a device: disconnects its Wi-Fi connections and clears what StickPilot saved
   * for it. A device still plugged in is hidden instead (it would reappear at once).
   */
  removeDevice(key: string, serials: string[]): Promise<void>;
  listApps(serial: string, refresh?: boolean): Promise<AppInfo[]>;
  /** Real app logos, fetched from the device once and cached */
  appArt(serial: string, pkgs: string[], refresh?: boolean): Promise<Record<string, AppArt>>;
  cachedAppArt(pkgs: string[]): Promise<Record<string, AppArt>>;
  launchApp(serial: string, pkg: string): Promise<boolean>;
  forceStopApp(serial: string, pkg: string): Promise<void>;
  /** Package of the app in front on the device, if any */
  currentApp(serial: string): Promise<string | null>;
  profilesFor(serial: string): Promise<ProfileSet>;
  start(serial: string, profileId: string, mode: SessionMode): Promise<void>;
  stop(): Promise<void>;
  onStatus(cb: (status: SessionStatus) => void): void;
  onConfig(cb: (config: { codec: string }) => void): void;
  onPacket(cb: (packet: VideoPacket) => void): void;
  onAudioConfig(cb: (config: { description: Uint8Array }) => void): void;
  onAudioPacket(cb: (packet: { data: Uint8Array; pts: number }) => void): void;
  /** The device stopped sending sound (not supported, or capture failed) */
  onAudioEnded(cb: () => void): void;
  key(keycode: number, action: 0 | 1, repeat?: number): void;
  /** Sends a single key press (down + up) */
  tap(keycode: number): void;
  /** Types text into whatever is focused on the device (text field or on-screen letter grid) */
  type(text: string): void;
  /** Deletes the character before the cursor */
  backspace(): void;
  /** Long-press Home: Fire TV quick settings. Resolves once the press is done (about 1 s) */
  quickSettings(): Promise<void>;
  /** Types the computer's clipboard text on the device */
  pasteClipboard(): void;
  toggleFullscreen(): void;
  /** Compact window for the remote-only view; restores the previous size when turned off */
  setCompact(on: boolean): void;
  setAlwaysOnTop(on: boolean): void;
  onFullscreen(cb: (on: boolean) => void): void;
  getStatus(): Promise<SessionStatus>;
  /** Remote-only connection to the given device, or to the last used one */
  connectRemote(serial?: string): Promise<void>;
  showMainWindow(): void;
  /** Full-resolution screenshot taken on the device, saved to Pictures/StickPilot */
  screenshot(serial: string): Promise<{ ok: boolean; file?: string; message?: string }>;
  /** Records the incoming video to Movies/StickPilot (mirroring only) */
  startRecording(width: number, height: number): Promise<void>;
  stopRecording(): Promise<{ file: string; seconds: number } | null>;
  /** The recording ended on its own (disconnected, profile changed) */
  onRecordingStopped(cb: (result: { file: string; seconds: number } | null) => void): void;
  showInFolder(file: string): void;
  /** Local path of a dropped file */
  pathForFile(file: File): string;
  installApk(serial: string, path: string): Promise<{ ok: boolean; message: string }>;
  deviceInfo(serial: string): Promise<DeviceStatusInfo>;
  /** Sleep, wake or restart the device */
  devicePower(serial: string, action: 'sleep' | 'wake' | 'reboot'): Promise<void>;
  /** Copies a file or folder to the device's Download folder */
  pushFile(serial: string, path: string): Promise<{ ok: boolean; message: string }>;
  /** Messages from the main process to show as notices; 'accessibility' adds an Open Settings button */
  onNotice(cb: (notice: { message: string; action?: 'accessibility' }) => void): void;
  /** Opens macOS's Privacy & Security → Accessibility page (the user grants access there) */
  openAccessibilitySettings(): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
}
