import {createRequire} from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {archiveName, withPackageStage} from './package-stage.mjs';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const file = archiveName(source);
await withPackageStage(root, stage => {
  const result = spawnSync(process.execPath, [vsce, 'package', '--no-dependencies', '--out', path.join(root, file)], {cwd: stage, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('VSIX packaging failed with exit status ' + result.status);
});
const sha256 = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
fs.writeFileSync(path.join(root, file + '.sha256'), `${sha256}  ${file}\n`);
console.log(JSON.stringify({file, sha256}));
