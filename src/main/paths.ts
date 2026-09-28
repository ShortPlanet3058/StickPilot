// Locates the adb binary and the scrcpy-server jar.
// Order: explicit env override, bundled copy (vendor/ in development, the app's
// resources folder when packaged), then a local scrcpy download.

import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ADB_NAME = process.platform === 'win32' ? 'adb.exe' : 'adb';
const PLATFORM_DIR = `${process.platform}-${process.arch}`; // e.g. darwin-x64, win32-x64, linux-x64

function bundledRoot(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'vendor') : path.join(app.getAppPath(), 'vendor');
}

function localScrcpyDir(): string {
  return process.env.STICKPILOT_SCRCPY_DIR
    || path.join(os.homedir(), 'Documents/tools/scrcpy-macos-x86_64-v4.1');
}

function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => fs.existsSync(p));
}

export function adbPath(): string {
  return process.env.STICKPILOT_ADB
    || firstExisting([path.join(bundledRoot(), PLATFORM_DIR, ADB_NAME), path.join(localScrcpyDir(), ADB_NAME)])
    || ADB_NAME; // last resort: adb on PATH
}

export function serverPath(): string {
  const found = firstExisting([path.join(bundledRoot(), 'scrcpy-server'), path.join(localScrcpyDir(), 'scrcpy-server')]);
  if (!found) throw new Error('scrcpy-server not found. Run "npm run vendor" or set STICKPILOT_SCRCPY_DIR.');
  return found;
}

/** StickPilot's own on-device helper (app icons), built from helper/src */
export function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'helper', 'stickpilot-helper.jar')
    : path.join(app.getAppPath(), 'helper', 'dist', 'stickpilot-helper.jar');
}

/** The server protocol changes between versions, so the client is pinned to this one */
export const SERVER_VERSION = '4.1';
