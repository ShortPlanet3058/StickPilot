// Copies adb and scrcpy-server from a local scrcpy release into vendor/,
// where the app looks first. Usage: npm run vendor [-- /path/to/scrcpy-folder]
// The folder's platform is detected from its adb: a Windows release (adb.exe and its
// DLLs) goes to vendor/win32-x64, so a Windows build can be made from a Mac.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

const src = process.argv[2] || process.env.STICKPILOT_SCRCPY_DIR
  || path.join(os.homedir(), 'Documents/tools/scrcpy-macos-x86_64-v4.1');
const windows = existsSync(path.join(src, 'adb.exe'));
const tools = windows ? ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'] : ['adb'];
const platformDir = path.join('vendor', windows ? 'win32-x64' : `${process.platform}-${process.arch}`);

for (const f of ['scrcpy-server', ...tools]) {
  if (!existsSync(path.join(src, f))) { console.error(`Missing ${f} in ${src}`); process.exit(1); }
}
mkdirSync(platformDir, { recursive: true });
copyFileSync(path.join(src, 'scrcpy-server'), 'vendor/scrcpy-server');
for (const f of tools) copyFileSync(path.join(src, f), path.join(platformDir, f));
if (!windows) chmodSync(path.join(platformDir, 'adb'), 0o755);
if (existsSync(path.join(src, 'LICENSE'))) copyFileSync(path.join(src, 'LICENSE'), 'vendor/scrcpy-LICENSE');
console.log(`Copied scrcpy-server and ${tools.join(', ')} from ${src} into ${platformDir}`);
