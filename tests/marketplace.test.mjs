import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {marketplaceRequest, checkCredentialAvailability, resolveRelease, verifyRelease,
  publishVerified, publisherArgs, marketplaceSummary} from '../scripts/marketplace.mjs';
import {packageManifest} from '../scripts/package-stage.mjs';
import {releaseIdentity, repository, workflow} from '../scripts/release.mjs';

const require = createRequire(import.meta.url), dependency = createRequire(require.resolve('@vscode/vsce/package.json'));
const yazl = dependency('yazl'), yaml = dependency('js-yaml');
const source = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const identity = releaseIdentity(source), sha = 'a'.repeat(40), main = 'b'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const env = {GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: main, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1',
  RELEASE_TAG: identity.tag, MARKETPLACE_DESTINATION: 'both', HAS_VSCE_PAT: 'true', HAS_OVSX_PAT: 'true'};
const request = marketplaceRequest(env);
const vscode = 'visual-studio-marketplace', openvsx = 'open-vsx';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelft-marketplace-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kelft-marketplace-test-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const names = ['LICENSE.txt','LICENSE-MIT','LICENSE-APACHE','LICENSES/MIT-0.txt','THIRD-PARTY-NOTICES.md','readme.md',
    'changelog.md','docs/licensing.md','docs/releasing.md','licensing.json','dist/extension.cjs','assets/icon.png',
    'assets/intrinsics.json','assets/kelft-icon-light.svg','assets/kelft-icon-dark.svg','syntaxes/kelft.tmLanguage.json','snippets/kelft.json'];
  const zip = new yazl.ZipFile(), chunks = [];
  for (const name of names) zip.addBuffer(Buffer.from('fixture'), 'extension/' + name);
  zip.addBuffer(Buffer.from(JSON.stringify(packageManifest(source))), 'extension/package.json');
  zip.addBuffer(Buffer.from(`<Identity Id="vscode-kelft" Version="${identity.version}" Publisher="kelftlang" />`), 'extension.vsixmanifest');
  const complete = new Promise((resolve, reject) => {zip.outputStream.on('data', chunk => chunks.push(chunk));zip.outputStream.on('error', reject);zip.outputStream.on('end', resolve);});
  zip.end();await complete;
  const archive = Buffer.concat(chunks);
  const bytes = [archive, Buffer.from(`${hash(archive)}  ${identity.file}\n`), Buffer.from('{"fixture":"provenance"}')];
  const assets = [identity.file, identity.checksum, identity.bundle].map((name, i) => ({name, id: i + 1, size: bytes[i].length, digest: 'sha256:' + hash(bytes[i]), state: 'uploaded'}));
  const release = {id: 10, tag_name: identity.tag, draft: false, immutable: true, prerelease: false, published_at: '2026-10-24T00:00:00Z', assets};
  const ref = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  const manifest = {type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(source)).toString('base64')};
  const calls = [], commands = [], uploads = [];
  const api = async (method, route) => {
    calls.push({method, route});assert.equal(method, 'GET');
    if (route.startsWith('/releases/')) return structuredClone(release);
    if (route.startsWith('/git/ref/')) return structuredClone(ref);
    if (route === '/contents/package.json?ref=' + sha) return structuredClone(manifest);
    throw new Error('Unexpected API route: ' + route);
  };
  const client = {api, download: async id => bytes[id - 1]};
  const command = (executable, args) => {commands.push({executable, args});assert.equal(executable, 'gh');return args[0] === 'attestation' ? '[{"verified":true}]' : '';};
  const verify = (options = {}) => verifyRelease({request, client, directory, command, ...options});
  const publish = (state, target, options = {}) => publishVerified({state, request, target, directory,
    env: {...env, VSCE_PAT: 'vscode-test-token', OVSX_PAT: 'openvsx-test-token'}, cli: 'test-cli',
    command: (executable, args, options) => uploads.push({executable, args, options}), ...options});
  return {directory, release, ref, manifest, assets, bytes, calls, commands, uploads, api, client, command, verify, publish};
}

test('manual main context, canonical numeric tag and explicit destination are mandatory', () => {
  assert.deepEqual(request.targets, [vscode, openvsx]);
  assert.deepEqual(marketplaceRequest({...env, MARKETPLACE_DESTINATION: openvsx}).targets, [openvsx]);
  for (const patch of [{GITHUB_REF: 'refs/heads/dev'}, {GITHUB_REPOSITORY: 'other/repo'}, {GITHUB_EVENT_NAME: 'push'},
    ...['', 'main', 'v01.2.3', 'v1.2.3-beta.1', 'v1.2.3+build', 'v1.2.3\n', '../../escape'].map(RELEASE_TAG => ({RELEASE_TAG})),
    {MARKETPLACE_DESTINATION: 'arbitrary'}]) assert.throws(() => marketplaceRequest({...env, ...patch}));
});

test('all selected credential availability flags must pass before uploads, without exposing tokens', () => {
  checkCredentialAvailability(request, env);
  for (const name of ['HAS_VSCE_PAT', 'HAS_OVSX_PAT']) {
    assert.throws(() => checkCredentialAvailability(request, {...env, [name]: 'false'}), /repository secret/);
  }
  checkCredentialAvailability(marketplaceRequest({...env, MARKETPLACE_DESTINATION: vscode}), {...env, HAS_OVSX_PAT: 'false'});
  checkCredentialAvailability(marketplaceRequest({...env, MARKETPLACE_DESTINATION: openvsx}), {...env, HAS_VSCE_PAT: 'false'});
});

test('release resolution uses its tag commit manifest, independently of the current main version', async t => {
  const f = await fixture(t), selected = await resolveRelease(f.api, identity.tag);
  assert.equal(selected.sha, sha);assert.notEqual(selected.sha, main);
  assert.ok(f.calls.some(call => call.route === '/contents/package.json?ref=' + sha));
  assert.deepEqual(selected.source, source);assert.equal(selected.identity.tag, identity.tag);
});

test('missing, draft, mutable, unpublished, prerelease and mismatched releases fail before downloading', async t => {
  const f = await fixture(t);
  for (const patch of [{id: 0}, {tag_name: 'v9.0.0'}, {draft: true}, {immutable: false}, {published_at: null}, {prerelease: true}]) {
    const api = async (method, route) => route.startsWith('/releases/') ? {...f.release, ...patch} : f.api(method, route);
    await assert.rejects(f.verify({client: {...f.client, api}}));
  }
  await assert.rejects(f.verify({client: {...f.client, api: async () => null}}), /missing/);
  assert.equal(f.commands.length, 0);assert.equal(f.uploads.length, 0);
});

test('source manifest and release assets reject old identity, wrong version, missing and duplicate assets', async t => {
  const f = await fixture(t), original = f.manifest.content;
  for (const patch of [{name: '@kelftlang/vscode'}, {publisher: 'other'}, {version: '0.2.0'}]) {
    f.manifest.content = Buffer.from(JSON.stringify({...source, ...patch})).toString('base64');
    await assert.rejects(f.verify());
  }
  f.manifest.content = original;
  const assets = structuredClone(f.release.assets);
  for (const invalid of [assets.slice(1), [...assets, assets[0]], [{...assets[0], digest: 'bad'}, ...assets.slice(1)],
    [{...assets[0], state: 'new'}, ...assets.slice(1)], [{...assets[0], size: 65 << 20}, ...assets.slice(1)]]) {
    f.release.assets = invalid;await assert.rejects(f.verify(), /asset/);
  }
  assert.equal(f.commands.length, 0);
});

test('annotated tags are bounded and final tag/asset drift cannot pass verification', async t => {
  const f = await fixture(t), tagSha = 'c'.repeat(40);
  f.ref.object = {type: 'tag', sha: tagSha};
  const api = async (method, route) => route === '/git/tags/' + tagSha ? {object: {type: 'commit', sha}} : f.api(method, route);
  await f.verify({client: {...f.client, api}});
  await assert.rejects(f.verify({client: {...f.client, api: async (method, route) => route === '/git/tags/' + tagSha ? {object: f.ref.object} : f.api(method, route)}}), /eight tag/);
  f.ref.object = {type: 'commit', sha};
  for (const drift of ['tag', 'asset', 'release']) {
    let tagReads = 0;
    await assert.rejects(f.verify({client: {...f.client, api: async (method, route) => {
      if (route === '/releases/10') return {...f.release, ...(drift === 'asset' ? {assets: []} : drift === 'release' ? {id: 11} : {})};
      if (drift === 'tag' && route.startsWith('/git/ref/') && ++tagReads === 2) return {...f.ref, object: {type: 'commit', sha: main}};
      return f.api(method, route);
    }}}));
  }
});

test('verification checks release integrity, all asset bytes and source-bound hosted build provenance', async t => {
  const f = await fixture(t), state = await f.verify();
  assert.equal(state.verified, true);assert.equal(state.inspection.sha256, hash(f.bytes[0]));
  assert.equal(f.commands.filter(call => call.args[0] === 'release' && call.args[1] === 'verify-asset').length, 3);
  for (const {args} of f.commands.filter(call => call.args[0] === 'attestation')) {
    for (const [flag, value] of [['--signer-workflow', workflow], ['--source-digest', sha], ['--signer-digest', sha], ['--source-ref', 'refs/heads/main']]) {
      assert.equal(args[args.indexOf(flag) + 1], value);
    }
    assert.ok(args.includes('--deny-self-hosted-runners'));
  }
  assert.equal(f.uploads.length, 0);
});

test('corrupt downloads, invalid receipt, and failed integrity or provenance cannot authorize upload', async t => {
  const f = await fixture(t);
  await assert.rejects(f.verify({client: {...f.client, download: async () => Buffer.from('tampered')}}), /Downloaded/);
  const receipt = f.bytes[1];f.bytes[1] = Buffer.from('invalid receipt');
  f.assets[1].size = f.bytes[1].length;f.assets[1].digest = 'sha256:' + hash(f.bytes[1]);
  await assert.rejects(f.verify(), /checksum/);
  f.bytes[1] = receipt;f.assets[1].size = receipt.length;f.assets[1].digest = 'sha256:' + hash(receipt);
  await assert.rejects(f.verify({command: () => {throw new Error('integrity failed');}}), /integrity failed/);
  await assert.rejects(f.verify({command: (_exe, args) => args[0] === 'attestation' ? '[]' : ''}), /provenance/);
  assert.equal(f.uploads.length, 0);
});

test('upload rejects unverified, stale, unselected or changed artifacts and missing tokens', async t => {
  const f = await fixture(t), state = await f.verify();
  for (const invalid of [{...state, verified: false}, {...state, request: {...request, context: {...request.context, run: 'another run'}}}]) {
    await assert.rejects(f.publish(invalid, vscode), /verification/);
  }
  await assert.rejects(f.publish(state, 'other'), /not selected/);
  await assert.rejects(f.publish(state, openvsx), /before Open VSX/);
  await assert.rejects(f.publish(state, vscode, {env: {...env, VSCE_PAT: ''}}), /Missing VSCE_PAT/);
  fs.appendFileSync(path.join(f.directory, identity.file), 'tampered');
  await assert.rejects(f.publish(state, vscode), /changed before upload/);
  assert.equal(f.uploads.length, 0);
});

test('both submissions use the same verified VSIX and isolate registry tokens without rebuilding', async t => {
  const f = await fixture(t), state = await f.verify();
  await f.publish(state, vscode);await f.publish(state, openvsx);
  assert.deepEqual(state.results, {[vscode]: 'submitted', [openvsx]: 'submitted'});
  assert.equal(f.uploads.length, 2);
  const archive = path.join(f.directory, identity.file);
  assert.deepEqual(f.uploads[0].args, ['test-cli', ...publisherArgs(vscode, archive)]);
  assert.deepEqual(f.uploads[1].args, ['test-cli', ...publisherArgs(openvsx, archive)]);
  assert.equal(f.uploads[0].options.env.OVSX_PAT, undefined);assert.equal(f.uploads[1].options.env.VSCE_PAT, undefined);
  assert.ok(f.uploads.every(call => !call.args.includes('--skip-duplicate') && !call.args.includes('package')));
});

test('partial failure stays visible and the remaining registry can be selected in a new run', async t => {
  const f = await fixture(t), state = await f.verify();
  await f.publish(state, vscode);
  await assert.rejects(f.publish(state, openvsx, {command: () => {throw new Error('registry rejected upload');}}), /registry rejected/);
  assert.deepEqual(state.results, {[vscode]: 'submitted', [openvsx]: 'failed'});
  const summary = marketplaceSummary(state);
  for (const expected of [identity.tag, sha, 'kelftlang.vscode-kelft', state.inspection.sha256, 'submitted', 'failed', 'rerun']) assert.ok(summary.includes(expected));
  const retry = marketplaceRequest({...env, MARKETPLACE_DESTINATION: openvsx, GITHUB_RUN_ID: '124'});
  const retryState = await f.verify({request: retry});await f.publish(retryState, openvsx, {request: retry});
  assert.deepEqual(retryState.results, {[openvsx]: 'submitted'});
  assert.match(marketplaceSummary(null), /no uploads were authorized/);
});

test('manual workflow pins actions, verifies first, isolates secrets and never builds or writes GitHub', () => {
  const workflow = yaml.load(fs.readFileSync(new URL('../.github/workflows/marketplaces.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, {contents: 'read'});assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag.required, true);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.destination.options, ['both', vscode, openvsx]);
  assert.equal(workflow.on.workflow_dispatch.inputs.destination.default, 'both');
  assert.deepEqual(Object.keys(workflow.jobs), ['publish']);
  const job = workflow.jobs.publish;
  assert.equal(job['runs-on'], 'ubuntu-24.04');assert.equal(job['timeout-minutes'], 8);assert.equal(job.permissions, undefined);
  assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));assert.ok(job.if.includes(repository));
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');assert.equal(job.steps[0].with['persist-credentials'], false);
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const verify = job.steps.findIndex(step => step.run === 'node scripts/marketplace.mjs verify');
  const first = job.steps.findIndex(step => step.run === 'node scripts/marketplace.mjs publish-vscode');
  const second = job.steps.findIndex(step => step.run === 'node scripts/marketplace.mjs publish-open-vsx');
  assert.ok(verify > 0 && first > verify && second > first);
  assert.deepEqual(Object.keys(job.steps[verify].env), ['GH_TOKEN', 'HAS_VSCE_PAT', 'HAS_OVSX_PAT']);
  assert.deepEqual(Object.keys(job.steps[first].env), ['VSCE_PAT']);assert.deepEqual(Object.keys(job.steps[second].env), ['OVSX_PAT']);
  assert.ok(job.steps[first].if.includes(vscode));assert.ok(job.steps[second].if.includes(openvsx));
  assert.equal(job.steps.at(-1).if, 'always()');assert.equal(job.steps.at(-1).run, 'node scripts/marketplace.mjs summary');
  assert.ok(!job.steps.some(step => step['continue-on-error'] || /pnpm (build|test|package)|release\.mjs/.test(step.run ?? '')));
});
