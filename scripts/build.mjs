// Bundles main, preload and renderer into dist/ and copies the static files.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'tray.html', 'phone.html', 'styles.css', 'phone.css', 'logo.png']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const configs = [
  // uiohook-napi is a native module: loaded from node_modules at runtime, not bundled
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron', 'uiohook-napi'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' },
  { ...common, entryPoints: ['src/renderer/tray.ts'], outfile: 'dist/renderer/tray.js', platform: 'browser', format: 'iife' },
  // The phone remote page, served to phones by src/main/phoneRemote.ts (Safari 15+, Chrome 100+)
  { ...common, entryPoints: ['src/renderer/phone.ts'], outfile: 'dist/renderer/phone.js', platform: 'browser', format: 'iife', target: ['safari15', 'chrome100'], sourcemap: false },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
