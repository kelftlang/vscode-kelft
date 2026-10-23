import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {contextAt, staticSuggestions, intrinsicSignature, intrinsicReference, importSuggestions, importDefinition} from '../src/editing.mjs';

const state = source => {const at = source.indexOf('|'); return contextAt(source.replace('|', ''), at);};
const labels = source => staticSuggestions(state(source)).map(row => row.label);
test('static completion and reference signatures use the intrinsic contract', () => {
  assert.ok(labels('fn main()->void { pri| }').includes('print'));
  assert.ok(labels('fn main()->void { let x: Arr| }').includes('Array'));
  assert.ok(labels('ap|').includes('app'));
  assert.equal(intrinsicSignature('array_push'), 'fn array_push<T0>(inout arg0: Array<T0>, arg1: T0) -> void');
  assert.match(intrinsicSignature('map_get'), /T0, T1/);
  assert.match(intrinsicReference('array_push').documentation, /explicit inout/);
  assert.match(intrinsicReference('read_file').documentation, /Effects: fs.read/);
  assert.match(intrinsicReference('array_len').documentation, /not a resolved symbol/);
  assert.equal(intrinsicSignature('toString'), null);
});

test('context ignores comments, escaped/unfinished strings and qualified names', () => {
  for (const source of ['// pri|', '/* pri| */', '/* incomplete pri|', 'let s:string="escaped \\" pri|";', 'let s:string="unfinished pri|', 'app A { intent """line\n pri|\n""" }']) assert.equal(state(source), null, source);
  for (const source of ['x::pri|', 'x. pri|', 'x /* c */ :: /* c */ pri|']) assert.deepEqual(labels(source), []);
  assert.ok(labels('// text\npri|').includes('print'));
  assert.ok(labels('"unfinished\npri|').includes('print'));
  assert.ok(labels('/* done */ pri|').includes('print'));
});

test('Intent keywords/types, prose suppression and explicit formal expressions stay distinct', () => {
  assert.ok(labels('/* module */ app A {\n beh|').includes('behavior'));
  assert.ok(labels('app A { entity X { field: Te| } }').includes('Text'));
  assert.ok(!labels('app A {\n pri|').includes('print'));
  for (const source of ['app A { must pri| }', 'app A { must describe print(pri|) }', 'app A { when a user pri| }', 'app A { intent "hello" pri| }']) assert.equal(state(source), null, source);
  assert.ok(labels('app A { must (string_l|) }').includes('string_len'));
  assert.ok(labels('app A { must named: (string_l|) }').includes('string_len'));
  assert.ok(labels('app A { must (true)\n beh|').includes('behavior'));
  assert.equal(state('app A { must (true) trailing pri| }'), null);
});

test('UTF-16 ranges, partial source, cancellation and document bounds', () => {
  const source = '// é😀\r\nfn main()->void { prin|tln(', position = source.indexOf('|');
  const context = state(source);
  assert.equal(context.start, source.indexOf('println'.slice(0, 4)));
  assert.equal(context.end, position + 3); // marker removed; remaining tln has length 3
  assert.equal(context.prefix, 'prin');
  assert.equal(contextAt('print', 2, {isCancellationRequested: true}), null);
  assert.equal(contextAt(' '.repeat((2 << 20) + 1), 1), null);
});

async function fixture(t) {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'kelft-editing-'));
  t.after(async () => {
    const resolved = path.resolve(outer);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(resolved, {recursive: true, force: true});
  });
  const root = path.join(outer, 'project'), file = path.join(root, 'src', 'main.kelft');
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.mkdir(path.join(root, 'src', 'dir space'));
  for (const name of ['src/main.kelft', 'src/lib é😀.kelft', 'src/ignore.json', 'shared.kelft']) await fs.writeFile(path.join(root, name), '');
  await fs.writeFile(path.join(outer, 'outside.kelft'), '');
  return {outer, root, file};
}
const importState = source => {const context = state(source); assert.equal(context.mode, 'import'); return context;};
test('relative import completion replaces one segment and navigation resolves saved targets', async t => {
  const {root, file} = await fixture(t);
  let context = importState('import "./li|" as lib;');
  let rows = await importSuggestions(context, context.start + context.prefix.length, file, root);
  assert.deepEqual(rows.map(r => r.label), ['lib é😀.kelft']);
  assert.equal(rows[0].start, context.start + 2); assert.equal(rows[0].end, context.end);
  context = importState('import "./di|r space/other.kelft" as lib;');
  rows = await importSuggestions(context, context.start + context.prefix.length, file, root);
  assert.equal(rows[0].insertText, 'dir space');
  assert.equal(rows[0].end, context.start + './dir space'.length);
  context = importState('import "../sha|red.kelft" as lib;');
  assert.deepEqual((await importSuggestions(context, 0, file, root)).map(r => r.label), ['shared.kelft']);
  assert.equal(await importDefinition(context, file, root), path.join(root, 'shared.kelft'));
  context = importState('import /* comment */ "./lib é😀.ke|lft" as lib;');
  assert.equal(await importDefinition(context, file, root), path.join(root, 'src', 'lib é😀.kelft'));
  context = importState('import "|" as lib;');
  assert.deepEqual((await importSuggestions(context, 0, file, root)).map(r => r.label), ['./', '../']);
});

test('imports reject escapes, missing targets, outside roots and cancelled requests', async t => {
  const {root, file} = await fixture(t);
  for (const value of ['../../outside.kelft', './missing.kelft', './ignore.json', './dir space', 'C:/outside.kelft', './file:stream.kelft', './lib\\u{20}x.kelft']) {
    const context = importState(`import "${value}|" as lib;`);
    assert.equal(await importDefinition(context, file, root), null, value);
  }
  const context = importState('import "../../|" as lib;');
  assert.deepEqual(await importSuggestions(context, 0, file, root), []);
  const valid = importState('import "../shared.ke|lft" as lib;');
  assert.equal(await importDefinition(valid, file, path.join(root, 'src')), null);
  assert.equal(await importDefinition(valid, file, root, {isCancellationRequested: true}), null);
  assert.deepEqual(await importSuggestions(valid, 0, file, root, {isCancellationRequested: true}), []);
  assert.equal(await importDefinition(valid, file, path.join(root, 'missing')), null);
});

test('canonical confinement excludes directory symlink escapes from completion and navigation', async t => {
  const {outer, root, file} = await fixture(t), link = path.join(root, 'src', 'escape');
  await fs.symlink(outer, link, process.platform === 'win32' ? 'junction' : 'dir');
  const context = importState('import "./|" as lib;');
  assert.ok(!(await importSuggestions(context, 0, file, root)).some(r => r.label === 'escape/'));
  const escaped = importState('import "./escape/outside.ke|lft" as lib;');
  assert.equal(await importDefinition(escaped, file, root), null);
  const escapeFolder = importState('import "./escape/|" as lib;');
  assert.deepEqual(await importSuggestions(escapeFolder, 0, file, root), []);
});

test('language icon declarations point to packaged light/dark SVGs', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  for (const variant of ['light', 'dark']) {
    const name = pkg.contributes.languages[0].icon[variant];
    assert.match(await fs.readFile(path.join(root, name), 'utf8'), /<svg/);
  }
});
