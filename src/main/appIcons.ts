// App logos: StickPilot's helper (helper/src) runs on the device and has Android
// render each app's TV banner and launcher icon to PNG. They're cached on disk
// by package name, so each image is fetched once.

import { app } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { adb } from './adb';
import { adbPath, helperPath } from './paths';
import type { AppArt } from '../shared/types';

const DEVICE_HELPER = '/data/local/tmp/stickpilot-helper.jar';
const ICON_SIZE = 128;

const cacheDir = () => path.join(app.getPath('userData'), 'app-icons');
const safe = (pkg: string) => pkg.replace(/[^\w.-]/g, '_');
const file = (pkg: string, kind: 'banner' | 'icon') => path.join(cacheDir(), `${safe(pkg)}.${kind}.png`);
const dataUrl = (p: string) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;

function fromCache(pkgs: string[]): Record<string, AppArt> {
  const out: Record<string, AppArt> = {};
  for (const pkg of pkgs) {
    const art: AppArt = {};
    for (const kind of ['banner', 'icon'] as const) if (fs.existsSync(file(pkg, kind))) art[kind] = dataUrl(file(pkg, kind));
    if (art.banner || art.icon) out[pkg] = art;
  }
  return out;
}

/** Banners and icons for the given packages; fetches only those not cached (all of them with refresh) */
export async function appArt(serial: string, pkgs: string[], refresh = false): Promise<Record<string, AppArt>> {
  fs.mkdirSync(cacheDir(), { recursive: true });
  // A marker file records packages already asked for, including those without any image
  const missing = refresh ? pkgs : pkgs.filter((p) => !fs.existsSync(file(p, 'icon')) && !fs.existsSync(file(p, 'banner'))
    && !fs.existsSync(path.join(cacheDir(), `${safe(p)}.none`)));
  if (missing.length) {
    await adb(['push', helperPath(), DEVICE_HELPER], { serial });
    const out = await new Promise<string>((resolve, reject) => {
      execFile(adbPath(), ['-s', serial, 'shell', `CLASSPATH=${DEVICE_HELPER}`, 'app_process', '/',
        'app.stickpilot.helper.IconDumper', String(ICON_SIZE), ...missing],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const got = new Set<string>();
    for (const line of out.split('\n')) {
      const [pkg, kind, b64] = line.trim().split('\t');
      if (!pkg || (kind !== 'banner' && kind !== 'icon') || !b64) continue;
      fs.writeFileSync(file(pkg, kind), Buffer.from(b64, 'base64'));
      got.add(pkg);
    }
    for (const p of missing) {
      const marker = path.join(cacheDir(), `${safe(p)}.none`);
      if (got.has(p)) fs.rmSync(marker, { force: true });
      else fs.writeFileSync(marker, '');
    }
  }
  return fromCache(pkgs);
}

/** Cached images only, instantly (for the favorites row before the device is asked) */
export function cachedAppArt(pkgs: string[]): Record<string, AppArt> {
  return fs.existsSync(cacheDir()) ? fromCache(pkgs) : {};
}
