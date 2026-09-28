// Copies adb and scrcpy-server from a local scrcpy release into vendor/,
// where the app looks first. Usage: npm run vendor [-- /path/to/scrcpy-folder]
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const src = process.argv[2] || process.env.FIRETV_SCRCPY_DIR
  || path.join(os.homedir(), 'Documents/tools/scrcpy-macos-x86_64-v4.1');
const adb = process.platform === 'win32' ? 'adb.exe' : 'adb';
const platformDir = path.join('vendor', `${process.platform}-${process.arch}`);

for (const f of ['scrcpy-server', adb]) {
  if (!existsSync(path.join(src, f))) { console.error(`Missing ${f} in ${src}`); process.exit(1); }
}
mkdirSync(platformDir, { recursive: true });
copyFileSync(path.join(src, 'scrcpy-server'), 'vendor/scrcpy-server');
copyFileSync(path.join(src, adb), path.join(platformDir, adb));
chmodSync(path.join(platformDir, adb), 0o755);
if (existsSync(path.join(src, 'LICENSE'))) copyFileSync(path.join(src, 'LICENSE'), 'vendor/scrcpy-LICENSE');
console.log(`Copied scrcpy-server and ${adb} from ${src} into vendor/`);
