// Bundles main, preload and renderer into dist/ and copies the static files.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });
for (const f of ['index.html', 'styles.css']) cpSync(`src/renderer/${f}`, `dist/renderer/${f}`);

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };
const configs = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] },
  { ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
