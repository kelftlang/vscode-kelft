import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {archiveName, packageManifest, withPackageStage} from '../scripts/package-stage.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('scoped package identity becomes a valid VSIX identity without altering other metadata', () => {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const manifest = packageManifest(source);
  assert.equal(source.name, '@kelftlang/vscode-kelft');
  assert.equal(manifest.name, 'vscode-kelft');
  assert.equal(manifest.publisher, 'kelftlang');
  assert.equal(manifest.version, '0.1.3');
  assert.equal(archiveName(source), 'vscode-kelft-0.1.3.vsix');
  assert.deepEqual({...manifest, name: source.name}, source);
  for (const name of ['@scope/../../bad', 'bad/name', '../vscode', '@scope/']) assert.throws(() => packageManifest({...source, name}), /Invalid/);
  assert.throws(() => packageManifest({...source, version: '../bad'}), /Invalid/);
});

test('package staging preserves the source manifest and removes its temporary tree on success and failure', async () => {
  const sourceFile = path.join(root, 'package.json'), before = fs.readFileSync(sourceFile);
  for (const fail of [false, true]) {
    let temporary;
    const run = () => withPackageStage(root, async (stage, manifest) => {
      temporary = stage;
      assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'package.json'))).name, 'vscode-kelft');
      assert.equal(manifest.publisher + '.' + manifest.name, 'kelftlang.vscode-kelft');
      assert.ok(fs.existsSync(path.join(stage, 'LICENSES/MIT-0.txt')));
      assert.ok(!fs.existsSync(path.join(stage, 'LICENSES/CC-BY-4.0.txt')));
      assert.deepEqual(fs.readFileSync(sourceFile), before);
      if (fail) throw new Error('simulated packaging failure');
      return 'packaged';
    });
    if (fail) await assert.rejects(run, /simulated packaging failure/);
    else assert.equal(await run(), 'packaged');
    assert.ok(!fs.existsSync(temporary));
    assert.deepEqual(fs.readFileSync(sourceFile), before);
  }
});
