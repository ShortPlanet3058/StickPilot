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

export type SessionStatus =
  | { state: 'idle' }
  | { state: 'connecting'; serial: string; profileId: string }
  | { state: 'running'; serial: string; profileId: string }
  | { state: 'ended'; serial: string; reason: string; cause: 'user' | 'unplugged' | 'error' };

export interface Settings {
  lastSerial?: string;
  profileBySerial: Record<string, string>;
  networkHosts: string[];
  remoteVisible: boolean;
  showStats: boolean;
  /** Connect to lastSerial on launch when it is available */
  autoConnect: boolean;
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

/** API exposed to the renderer as window.firetv */
export interface FireTvApi {
  listDevices(): Promise<DeviceInfo[]>;
  onDevices(cb: (devices: DeviceInfo[]) => void): void;
  connectNetwork(host: string): Promise<NetworkResult>;
  forgetNetwork(host: string): Promise<void>;
  profilesFor(serial: string): Promise<ProfileSet>;
  start(serial: string, profileId: string): Promise<void>;
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
  /** Long-press Home: Fire TV quick settings */
  quickSettings(): void;
  /** Types the computer's clipboard text on the device */
  pasteClipboard(): void;
  toggleFullscreen(): void;
  onFullscreen(cb: (on: boolean) => void): void;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
}
