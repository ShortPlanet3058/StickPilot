import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Settings } from '../shared/types';

const DEFAULTS: Settings = {
  profileBySerial: {},
  networkHosts: [],
  remoteVisible: true,
  showStats: false,
  autoConnect: false,
  transportByDevice: {},
  homeTab: 'firetv',
  remoteOnTop: false,
  favoriteApps: {},
  audioEnabled: false,
  mediaKeys: false,
};

const file = () => path.join(app.getPath('userData'), 'settings.json');

let current: Settings | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export function getSettings(): Settings {
  if (!current) {
    try {
      current = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
    } catch {
      current = { ...DEFAULTS };
    }
  }
  return current!;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 300);
  return current;
}

export function flushSettings(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(current, null, 2));
}
