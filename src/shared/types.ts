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
  | { state: 'connecting'; serial: string; profileId: string; mode: SessionMode }
  | { state: 'running'; serial: string; profileId: string; mode: SessionMode }
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

export interface ScanResult {
  host: string;
  /** Reverse DNS name if the router provides one */
  name: string;
  connected: boolean;
}

/** API exposed to the renderer as window.firetv */
export interface FireTvApi {
  listDevices(): Promise<DeviceInfo[]>;
  onDevices(cb: (devices: DeviceInfo[]) => void): void;
  connectNetwork(host: string): Promise<NetworkResult>;
  forgetNetwork(host: string): Promise<void>;
  /** Adds a Wi-Fi connection to a USB device, reading its IP address itself */
  enableWifi(serial: string): Promise<NetworkResult>;
  scanNetwork(): Promise<ScanResult[]>;
  listApps(serial: string, refresh?: boolean): Promise<AppInfo[]>;
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
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
}
