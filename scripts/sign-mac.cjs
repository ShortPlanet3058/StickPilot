// electron-builder afterSign hook (macOS): signs the app with a stable identity so
// macOS keeps its privacy permissions (Accessibility, Local Network) across updates.
//
// Uses the code-signing certificate named by STICKPILOT_SIGN_IDENTITY, default
// "StickPilot Local Signing" (a self-signed certificate made in Keychain Access).
// Without it, falls back to an ad-hoc signature, whose identity changes every build.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDENTITY = process.env.STICKPILOT_SIGN_IDENTITY || 'StickPilot Local Signing';

function hasIdentity(name) {
  try {
    // Without -v: a self-signed certificate isn't "trusted", but codesign can still use it
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    return out.includes(`"${name}"`);
  } catch {
    return false;
  }
}

function machO(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    const m = b.readUInt32BE(0);
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m);
  } catch {
    return false;
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = hasIdentity(IDENTITY) ? IDENTITY : '-';
  const sign = (target, deep) => execFileSync('codesign',
    ['--force', ...(deep ? ['--deep'] : []), '--sign', identity, '--timestamp=none', target], { stdio: 'inherit' });

  // Executables bundled as resources (adb, the helpers, native modules) aren't covered
  // by --deep, so sign them first; then the app itself, which seals them.
  const resources = path.join(app, 'Contents', 'Resources');
  for (const f of walk(resources)) if (machO(f)) sign(f, false);
  sign(app, true);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed with ${identity === '-' ? 'an ad-hoc signature (no "' + IDENTITY + '" certificate found)' : `"${identity}"`}`);
};
