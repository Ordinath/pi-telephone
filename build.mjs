import { build } from 'esbuild';
import { readFile, chmod } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const entries = [
  ['src/exchange/main.ts', 'dist/exchange.mjs'],
  ['src/cli.ts', 'dist/cli.mjs'],
];
for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20',
    define: { __PACKAGE_VERSION__: JSON.stringify(version) },
    banner: outfile === 'dist/cli.mjs' ? { js: '#!/usr/bin/env node' } : undefined,
  });
}
await chmod('dist/cli.mjs', 0o755);
