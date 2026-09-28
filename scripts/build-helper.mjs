// Builds helper/dist/stickpilot-helper.jar (dex) from helper/src. The result is
// committed, so the app runs without a JDK; this is only needed after changing it.
// Needs a JDK and tools/build/r8.jar (Google's D8 dex compiler, from dl.google.com/android/maven2).
// The Android classes it uses are compile-time stand-ins in helper/stubs; only helper/src is dexed.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';

const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin') : '';
const bin = (name) => (java ? path.join(java, name) : name);
const r8 = 'tools/build/r8.jar';
if (!existsSync(r8)) { console.error(`Missing ${r8} (see scripts/build-helper.mjs)`); process.exit(1); }

const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f);
  return statSync(p).isDirectory() ? files(p) : [p];
});

const out = 'tools/build/helper-classes';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync('helper/dist', { recursive: true });
execFileSync(bin('javac'), ['--release', '8', '-nowarn', '-d', out, '-sourcepath', 'helper/stubs', ...files('helper/src')], { stdio: 'inherit' });
const own = files(path.join(out, 'app'));
execFileSync(bin('java'), ['-cp', r8, 'com.android.tools.r8.D8', '--release', '--min-api', '21', '--output', 'helper/dist/stickpilot-helper.jar', ...own], { stdio: 'inherit' });
console.log('Built helper/dist/stickpilot-helper.jar');
