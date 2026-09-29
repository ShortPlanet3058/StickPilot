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

/**
 * SHA-1 of the signing identity called `name`, or null. Several certificates can share a
 * name (codesign then refuses it as ambiguous): the one valid the longest is used, so
 * builds keep one identity.
 */
function findIdentity(name) {
  try {
    // Without -v: a self-signed certificate isn't "trusted", but codesign can still use it
    const out = execFileSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8' });
    const hashes = [...out.matchAll(/\b([0-9A-F]{40}) "([^"]+)"/g)].filter((m) => m[2] === name).map((m) => m[1]);
    if (hashes.length <= 1) return hashes[0] ?? null;
    const expiry = (hash) => {
      const pem = execFileSync('security', ['find-certificate', '-a', '-c', name, '-Z', '-p'], { encoding: 'utf8' })
        .split(/(?=SHA-256 hash:)/).find((block) => block.includes(hash));
      const end = pem && execFileSync('openssl', ['x509', '-noout', '-enddate'], { input: pem.slice(pem.indexOf('-----BEGIN')), encoding: 'utf8' });
      return end ? Date.parse(end.replace('notAfter=', '')) : 0;
    };
    return hashes.sort((a, b) => expiry(b) - expiry(a))[0];
  } catch {
    return null;
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
  const identity = findIdentity(IDENTITY) ?? '-';
  const sign = (target, deep) => execFileSync('codesign',
    ['--force', ...(deep ? ['--deep'] : []), '--sign', identity, '--timestamp=none', target], { stdio: 'inherit' });

  // Executables bundled as resources (adb, the helpers, native modules) aren't covered
  // by --deep, so sign them first; then the app itself, which seals them.
  const resources = path.join(app, 'Contents', 'Resources');
  for (const f of walk(resources)) if (machO(f)) sign(f, false);
  sign(app, true);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • signed with ${identity === '-' ? 'an ad-hoc signature (no "' + IDENTITY + '" certificate found)' : `"${IDENTITY}" (${identity})`}`);
};
