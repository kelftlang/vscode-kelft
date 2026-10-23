import {build} from 'esbuild';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
await build({absWorkingDir: root, entryPoints: ['src/extension.mjs'], outfile: 'dist/extension.cjs', tsconfigRaw: {}, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], legalComments: 'none'});
