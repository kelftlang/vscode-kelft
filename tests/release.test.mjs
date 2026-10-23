import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {packageManifest} from '../scripts/package-stage.mjs';
import {releaseIdentity, releaseContext, changelogSection, githubSignature, verifyGitHubKey,
  assertTag, existingRelease, attestationArgs, releaseNotes, prepareDraft, inspectVSIX, githubClient, repository, workflow} from '../scripts/release.mjs';

const require = createRequire(import.meta.url);
const yazl = createRequire(require.resolve('@vscode/vsce/package.json'))('yazl');
const yaml = createRequire(require.resolve('@vscode/vsce/package.json'))('js-yaml');
const source = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const identity = releaseIdentity(source), sha = 'a'.repeat(40), other = 'b'.repeat(40);
const context = {sha, run: `https://github.com/${repository}/actions/runs/123/attempts/1`};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = [identity.file, identity.checksum, identity.bundle].map(name => ({name, bytes: Buffer.from(name)}));
const env = {GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1'};

test('release identity, exact manual main source, and one matching changelog section are mandatory', () => {
  assert.equal(identity.tag, 'v0.1.2'); assert.equal(identity.title, 'Kelft for VS Code v0.1.2');
  assert.equal(identity.file, 'vscode-0.1.2.vsix'); assert.equal(identity.prerelease, false);
  assert.equal(releaseIdentity({...source, version: '0.2.0-beta.1'}).prerelease, true);
  for (const patch of [{name: 'vscode'}, {publisher: 'other'}, {version: '01.0.0'}]) assert.throws(() => releaseIdentity({...source, ...patch}));
  assert.deepEqual(releaseContext(env), context);
  for (const patch of [{GITHUB_REF: 'refs/heads/dev'}, {GITHUB_EVENT_NAME: 'push'}, {GITHUB_SHA: 'main'}, {GITHUB_REPOSITORY: 'other/repo'}, {GITHUB_RUN_ATTEMPT: ''}]) assert.throws(() => releaseContext({...env, ...patch}));
  assert.equal(changelogSection('# Changes\r\n\r\n## 0.1.2\r\n\r\n- New features.\r\n\r\n## 0.0.1\r\nOlder', '0.1.2'), '- New features.');
  for (const text of ['## 0.2.0\nMissing', '## 0.1.2\n', '## 0.1.2\nFirst\n## 0.1.2\nDuplicate']) assert.throws(() => changelogSection(text, '0.1.2'), /section/);
});

test('source signature rejects unsigned, invalid and differently signed commits', () => {
  const commit = {sha, committer: {login: 'web-flow'}, commit: {committer: {email: 'noreply@github.com'},
    verification: {verified: true, reason: 'valid', signature: '-----BEGIN PGP SIGNATURE-----\ntest', payload: 'commit payload'}}};
  assert.equal(githubSignature(commit, sha), commit.commit.verification);
  for (const mutate of [c => c.sha = other, c => c.commit.verification.verified = false, c => c.commit.verification.reason = 'unknown_key',
    c => c.committer.login = 'someone', c => c.commit.committer.email = 'someone@example.com', c => c.commit.verification.signature = '']) {
    const invalid = structuredClone(commit); mutate(invalid); assert.throws(() => githubSignature(invalid, sha));
  }
});

test('GitHub key verification uses an isolated keyring and cleans up after success and failure', () => {
  for (const fail of [false, true]) {
    let temporary, calls = 0;
    const command = (name, args, options) => {
      assert.equal(name, 'gpg'); temporary = args[args.indexOf('--homedir') + 1]; calls++;
      assert.ok(fs.existsSync(temporary)); assert.ok(args.includes('--no-options')); assert.ok(args.includes('--no-auto-key-retrieve'));
      if (args.includes('--import')) {assert.match(options.input, /PUBLIC KEY/); return '';}
      assert.equal(fs.readFileSync(args.at(-1), 'utf8'), 'payload');
      return fail ? '[GNUPG:] BADSIG' : '[GNUPG:] VALIDSIG ' + 'A'.repeat(40) + ' 2026-10-22';
    };
    const run = () => verifyGitHubKey({signature: 'signature', payload: 'payload'}, '-----BEGIN PGP PUBLIC KEY BLOCK-----', command);
    if (fail) assert.throws(run, /does not verify/); else assert.equal(run(), 'A'.repeat(40));
    assert.equal(calls, 2); assert.ok(!fs.existsSync(temporary));
  }
  assert.throws(() => verifyGitHubKey({}, 'not keys'), /unavailable/);
});

async function zipFixture(t, mutate = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kelft-release-test-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('kelft-release-test-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  });
  const rows = new Map(['LICENSE.txt','LICENSE-MIT','LICENSE-APACHE','LICENSES/MIT-0.txt','THIRD-PARTY-NOTICES.md','readme.md','changelog.md','docs/licensing.md','docs/releasing.md','licensing.json','dist/extension.cjs',
    'assets/icon.png','assets/intrinsics.json','assets/kelft-icon-light.svg','assets/kelft-icon-dark.svg','syntaxes/kelft.tmLanguage.json','snippets/kelft.json'].map(name => ['extension/' + name, 'fixture']));
  rows.set('extension/package.json', JSON.stringify(packageManifest(source)));
  rows.set('extension.vsixmanifest', '<Identity Id="vscode" Version="0.1.2" Publisher="kelftlang" />');
  mutate(rows);
  const zip = new yazl.ZipFile(), chunks = [];
  const complete = new Promise((resolve, reject) => {zip.outputStream.on('data', bytes => chunks.push(bytes));zip.outputStream.on('end', resolve);zip.outputStream.on('error', reject);});
  for (const [name, text] of rows) zip.addBuffer(Buffer.from(text), name);
  zip.end(); await complete;
  const bytes = Buffer.concat(chunks), file = path.join(directory, identity.file);
  fs.writeFileSync(file, bytes);
  return {file, checksum: hash(bytes) + '  ' + identity.file + '\n', bytes};
}

test('VSIX inspection enforces normalized manifest, version, required contents and checksum', async t => {
  const fixture = await zipFixture(t);
  assert.equal((await inspectVSIX(fixture.file, source, fixture.checksum)).sha256, hash(fixture.bytes));
  await assert.rejects(inspectVSIX(fixture.file, source, 'bad checksum'), /checksum/);
  await assert.rejects(inspectVSIX(fixture.file, {...source, version: '0.2.0'}, fixture.checksum), /file or size/);
  for (const mutate of [rows => rows.delete('extension/LICENSE.txt'), rows => rows.set('extension/package.json', JSON.stringify(source)),
    rows => rows.set('extension.vsixmanifest', '<Identity Id="vscode" Version="0.2.0" Publisher="kelftlang" />'),
    rows => rows.set('extension/scripts/private.mjs', 'private'), rows => rows.set('extension/LICENSES/CC-BY-4.0.txt', 'obsolete')]) {
    const invalid = await zipFixture(t, mutate); await assert.rejects(inspectVSIX(invalid.file, source, invalid.checksum));
  }
});

function mockGitHub({tag = null, release = null, corruptUpload = false, corruptDownload = false, publishOnUpload = false, tagAfterCreate, tagAfterUpload, tagOnReady, tagLookupMissing = false, releasePages, listingError, patchResponse, patchReadback} = {}) {
  if (release) release = {html_url: `https://github.com/${repository}/releases/tag/${identity.tag}`, ...release};
  const calls = [], bytes = new Map(); let next = 10;
  const copy = value => value && structuredClone(value);
  const api = async (method, route, body) => {
    calls.push({method, route, body});
    if (method === 'GET' && route.startsWith('/git/ref/tags/')) return copy(tag);
    if (method === 'POST' && route === '/git/refs') {
      const created = {ref: body.ref, object: {type: 'commit', sha: body.sha}};
      tag = tagAfterCreate === undefined ? created : copy(tagAfterCreate);
      return copy(created);
    }
    if (method === 'GET' && route.startsWith('/releases/tags/')) return tagLookupMissing ? null : copy(release);
    if (method === 'GET' && route === '/releases/1') return copy(release);
    if (method === 'GET' && route.startsWith('/releases?')) {
      if (listingError) throw new Error(listingError);
      const page = Number(new URLSearchParams(route.split('?')[1]).get('page'));
      return releasePages ? copy(releasePages[page - 1] ?? []) : release ? [copy(release)] : [];
    }
    // GitHub may retain a branch name here when an existing tag determines the source.
    if (method === 'POST' && route === '/releases') {release = {...body, target_commitish: 'main', id: 1, assets: [], html_url: `https://github.com/${repository}/releases/tag/${identity.tag}`};return copy(release);}
    if (method === 'PATCH' && route === '/releases/1') {
      // GitHub drops a draft's tag association if an update omits tag_name.
      Object.assign(release, body, {tag_name: body.tag_name ?? 'untagged-01e1fcbb027e1701ab94'});
      if (body.body === 'Completed release notes' && tagOnReady !== undefined) tag = copy(tagOnReady);
      const response = {...copy(release), ...(typeof patchResponse === 'function' ? patchResponse(body) : patchResponse)};
      if (patchReadback) Object.assign(release, typeof patchReadback === 'function' ? patchReadback(body) : patchReadback);
      return response;
    }
    if (method === 'DELETE' && route.startsWith('/releases/assets/')) {release.assets = release.assets.filter(a => a.id !== Number(route.split('/').at(-1)));return null;}
    throw new Error('Unexpected mocked request ' + method + ' ' + route);
  };
  const upload = async (id, asset) => {
    calls.push({method: 'UPLOAD', name: asset.name}); assert.equal(id, 1);
    const row = {id: next++, name: asset.name, size: asset.bytes.length, digest: 'sha256:' + (corruptUpload ? '0'.repeat(64) : hash(asset.bytes)), state: 'uploaded'};
    bytes.set(row.id, asset.bytes); release.assets.push(row);
    if (publishOnUpload) {release.draft = false; release.published_at = '2026-10-22T12:00:00Z';}
    if (tagAfterUpload !== undefined) tag = copy(tagAfterUpload);
    return copy(row);
  };
  const download = async id => corruptDownload ? Buffer.from('corrupted') : bytes.get(id);
  return {api, upload, download, calls, current: () => release};
}
const options = client => ({...client, identity, context, notes: 'Completed release notes', assets});

test('draft creation and same-commit refresh use the tag despite target_commitish being main', async () => {
  const client = mockGitHub();
  const first = await prepareDraft(options(client)); assert.equal(first.draft, true); assert.equal(first.body, 'Completed release notes');
  assert.equal(first.target_commitish, 'main');
  assert.equal(first.assets.length, 3); assert.equal(client.calls.filter(c => c.method === 'UPLOAD').length, 3);
  await prepareDraft(options(client)); assert.equal(client.calls.filter(c => c.method === 'UPLOAD').length, 3);
  const changed = assets.map((asset, index) => index === 2 ? {...asset, bytes: Buffer.from('new provenance for same source')} : asset);
  await prepareDraft({...options(client), assets: changed});
  assert.equal(client.calls.filter(c => c.method === 'UPLOAD').length, 4);
  assert.equal(client.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(client.calls.filter(c => c.method === 'POST' && c.route === '/git/refs').length, 1);
  assert.ok(client.calls.filter(c => c.method === 'PATCH').every(c => c.body.tag_name === identity.tag && c.body.draft === true));
  assert.equal(client.current().id, first.id);
  assert.equal(client.current().tag_name, identity.tag);
});

test('a 404 tag lookup falls back to authenticated listings and refreshes the same draft ID', async () => {
  const client = mockGitHub({tagLookupMissing: true});
  const first = await prepareDraft(options(client));
  const second = await prepareDraft(options(client));
  assert.equal(second.id, first.id); assert.equal(second.tag_name, identity.tag);
  assert.equal(client.calls.filter(c => c.method === 'POST' && c.route === '/releases').length, 1);
  assert.equal(client.calls.filter(c => c.method === 'UPLOAD').length, 3);
  assert.ok(client.calls.some(c => c.route === '/releases?per_page=100&page=1'));
});

test('draft listing fallback traverses pages and matches the exact tag, not title or untagged slugs', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  const release = {id: 1, draft: true, tag_name: identity.tag, target_commitish: 'main', assets: []};
  const unrelated = Array.from({length: 100}, (_, index) => ({id: index + 10, draft: true, tag_name: 'untagged-' + index, name: identity.title}));
  const client = mockGitHub({tag, release, tagLookupMissing: true, releasePages: [unrelated, [release]]});
  const ready = await prepareDraft(options(client));
  assert.equal(ready.id, 1);
  assert.ok(client.calls.some(c => c.route === '/releases?per_page=100&page=2'));
  assert.ok(!client.calls.some(c => c.method === 'POST'));
  const absent = mockGitHub({tag, tagLookupMissing: true, releasePages: [unrelated, []]});
  assert.equal(await existingRelease(absent.api, identity, sha), null);
  assert.ok(absent.calls.every(c => c.method === 'GET'));
});

test('listing fallback rejects duplicate tags, incomplete searches and malformed responses before mutations', async () => {
  const release = {id: 1, draft: true, tag_name: identity.tag, target_commitish: 'main', assets: []};
  const filler = Array.from({length: 100}, (_, index) => ({id: index + 10, tag_name: 'other-' + index}));
  const duplicateFirstPage = [release, ...filler.slice(1)];
  for (const [pages, message] of [
    [[duplicateFirstPage, [{...release, id: 2}]], /Multiple releases/],
    [Array.from({length: 10}, () => filler), /exceeded 10 pages/],
    [[{unexpected: 'object'}], /Invalid release listing/],
    [[Array.from({length: 101}, (_, index) => ({tag_name: 'other-' + index}))], /Invalid release listing/]
  ]) {
    const client = mockGitHub({tagLookupMissing: true, releasePages: pages});
    await assert.rejects(prepareDraft(options(client)), message);
    assert.ok(client.calls.every(c => c.method === 'GET'));
    assert.ok(client.calls.filter(c => c.route.startsWith('/releases?')).length <= 10);
  }
});

test('lookup permission failures and listed published releases cannot become new drafts', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  const denied = mockGitHub({tagLookupMissing: true, listingError: 'GitHub API request failed with status 403'});
  await assert.rejects(prepareDraft(options(denied)), /403/);
  assert.ok(denied.calls.every(c => c.method === 'GET'));
  for (const lifecycle of [{draft: false}, {draft: true, immutable: true}]) {
    const release = {id: 1, tag_name: identity.tag, ...lifecycle};
    const client = mockGitHub({tag, release, tagLookupMissing: true});
    await assert.rejects(prepareDraft(options(client)), /published, immutable or not a draft/);
    assert.ok(client.calls.every(c => c.method === 'GET'));
  }
  const direct = mockGitHub({tag, release: {id: 1, draft: true, tag_name: identity.tag, assets: []}, listingError: 'Must not list after a successful lookup'});
  assert.equal((await prepareDraft(options(direct))).id, 1);
  assert.ok(!direct.calls.some(c => c.route?.startsWith('/releases?')));
});

test('both draft update responses and readbacks must retain ID, lifecycle and tag association', async () => {
  for (const field of ['patchResponse', 'patchReadback']) {
    for (const phase of ['progress', 'ready']) {
      for (const invalid of [{id: 2}, {tag_name: 'untagged-unrelated'}, {draft: false}, {immutable: true}]) {
        const inject = body => (body.body === 'Completed release notes') === (phase === 'ready') ? invalid : {};
        const client = mockGitHub({[field]: inject});
        await assert.rejects(prepareDraft(options(client)), /ID mismatch|tag mismatch|published, immutable or not a draft/);
        assert.ok(client.calls.filter(c => c.method === 'PATCH').every(c => c.body.tag_name === identity.tag && c.body.draft === true));
      }
    }
  }
});

test('conflicting tags and published, immutable or wrongly tagged drafts fail before mutations', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  const draft = {id: 1, draft: true, target_commitish: sha, tag_name: identity.tag, assets: []};
  for (const configuration of [
    {tag: {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha: other}}},
    {release: draft},
    ...[{draft: false}, {immutable: true}, {published_at: '2026-10-22'}, {tag_name: 'v0.2.0'}, {id: 0}].map(patch => ({tag, release: {...draft, ...patch}}))
  ]) {
    const client = mockGitHub(configuration); await assert.rejects(prepareDraft(options(client)));
    assert.ok(client.calls.every(c => c.method === 'GET'));
  }
});

test('existing draft source comes only from its verified tag, not unused target metadata', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  for (const target of ['main', other, undefined]) {
    const release = {id: 1, draft: true, target_commitish: target, tag_name: identity.tag, assets: []};
    const client = mockGitHub({tag, release});
    const ready = await prepareDraft(options(client));
    assert.equal(ready.body, 'Completed release notes');
    assert.equal(ready.target_commitish, target);
    assert.ok(!client.calls.some(c => c.method === 'POST' && c.route === '/git/refs'));
  }
});

test('tag disappearance or drift during preparation and final verification cannot report readiness', async () => {
  const moved = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha: other}};
  for (const tag of [null, moved]) {
    const duringUpload = mockGitHub({tagAfterUpload: tag});
    await assert.rejects(prepareDraft(options(duringUpload)), /missing|different commit/);
    assert.ok(!duringUpload.calls.some(c => c.method === 'PATCH' && c.body.body === 'Completed release notes'));
    const finalCheck = mockGitHub({tagOnReady: tag});
    await assert.rejects(prepareDraft(options(finalCheck)), /missing|different commit/);
  }
});

test('newly created tags are verified before any draft is created', async () => {
  for (const tag of [null, {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha: other}}]) {
    const client = mockGitHub({tagAfterCreate: tag});
    await assert.rejects(prepareDraft(options(client)), /missing|different commit/);
    assert.ok(!client.calls.some(c => c.method === 'POST' && c.route === '/releases'));
  }
});

test('release diagnostics distinguish missing tags, commit conflicts, tag names and lifecycle failures', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'commit', sha}};
  const release = {id: 1, draft: true, tag_name: identity.tag, target_commitish: 'main', assets: []};
  await assert.rejects(prepareDraft(options(mockGitHub({release}))), error => error.message.includes('Required tag ' + identity.tag) && error.message.includes(sha));
  await assert.rejects(prepareDraft(options(mockGitHub({tag: {...tag, object: {type: 'commit', sha: other}}}))), error => error.message.includes(sha) && error.message.includes(other));
  await assert.rejects(prepareDraft(options(mockGitHub({tag, release: {...release, tag_name: 'v0.2.0'}}))), error => error.message.includes('Release tag mismatch') && error.message.includes(identity.tag) && error.message.includes('v0.2.0'));
  await assert.rejects(prepareDraft(options(mockGitHub({tag, release: {...release, draft: false}}))), /published, immutable or not a draft/);
  await assert.rejects(assertTag(async () => null, identity, sha, {required: true}), /Required tag.*missing/);
});

test('annotated tags are bounded and must ultimately name the exact source commit', async () => {
  const tag = {ref: 'refs/tags/' + identity.tag, object: {type: 'tag', sha: other}};
  await assertTag(async (_method, route) => route.startsWith('/git/ref/') ? tag : {object: {type: 'commit', sha}}, identity, sha);
  let calls = 0;
  await assert.rejects(assertTag(async () => {calls++;return {...tag, object: tag.object};}, identity, sha), /different commit/);
  assert.equal(calls, 9);
});

test('tampered uploads/downloads and publication during upload never mark the draft ready', async () => {
  for (const configuration of [{corruptUpload: true}, {corruptDownload: true}, {publishOnUpload: true}]) {
    const client = mockGitHub(configuration); await assert.rejects(prepareDraft(options(client)));
    assert.ok(!client.calls.some(c => c.method === 'PATCH' && c.body.body === 'Completed release notes'));
  }
});

test('verification pins provenance to the repository, hosted workflow and exact main commit', () => {
  const args = attestationArgs(identity.file, identity.bundle, sha);
  for (const [flag, value] of [['--repo', repository], ['--signer-workflow', workflow], ['--signer-digest', sha], ['--source-ref', 'refs/heads/main'], ['--source-digest', sha]]) assert.equal(args[args.indexOf(flag) + 1], value);
  assert.ok(args.includes('--deny-self-hosted-runners'));
  const notes = releaseNotes(identity, '- Features', context, 'c'.repeat(64), `https://github.com/${repository}/attestations/123`);
  for (const text of ['- Features', context.sha, context.run, 'gh attestation verify', 'gh release verify-asset', identity.tag]) assert.ok(notes.includes(text));
  assert.throws(() => releaseNotes(identity, '', context, '', 'https://elsewhere.invalid/'), /attestation URL/);
});

test('GitHub API client rejects unavailable features and supports authenticated binary asset checks', async () => {
  const calls = [];
  const client = githubClient('test-token', async (url, init) => {
    calls.push({url, init});
    if (url.endsWith('/missing')) return new Response('', {status: 404});
    if (url.endsWith('/denied')) return new Response('', {status: 403});
    return init.headers.accept === 'application/octet-stream' ? new Response(Buffer.from('archive')) : Response.json({id: 1});
  });
  assert.equal(await client.api('GET', '/missing', undefined, {missing: true}), null);
  await assert.rejects(client.api('GET', '/denied'), /permissions and feature availability/);
  assert.equal((await client.download(1)).toString(), 'archive');
  assert.deepEqual(await client.upload(1, {name: 'has space.vsix', bytes: Buffer.from('archive')}), {id: 1});
  assert.ok(calls.at(-1).url.startsWith('https://uploads.github.com/repos/' + repository));
  assert.ok(calls.at(-1).url.endsWith('name=has%20space.vsix'));
  assert.ok(calls.every(call => call.init.headers.authorization === 'Bearer test-token'));
  assert.throws(() => client.api('GET', '/../outside'), /Invalid/);
});

test('release workflow isolates write permissions, pins actions and orders verification before draft creation', () => {
  const release = yaml.load(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const validation = yaml.load(fs.readFileSync(new URL('../.github/workflows/extension.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(release.on), ['workflow_dispatch']);
  assert.deepEqual(validation.permissions, {contents: 'read'});
  assert.ok(Object.values(validation.jobs).every(job => !job.permissions));
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(Object.keys(release.jobs).length, 1);
  const job = release.jobs.prepare;
  assert.equal(job['runs-on'], 'ubuntu-24.04'); assert.equal(job['timeout-minutes'], 8);
  assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));
  assert.deepEqual(job.permissions, {contents: 'write', attestations: 'write', 'id-token': 'write'});
  for (const step of job.steps.filter(step => step.uses)) assert.match(step.uses, /@[a-f0-9]{40}$/);
  const checkout = job.steps[0];
  assert.equal(checkout.with.ref, '${{ github.sha }}'); assert.equal(checkout.with['persist-credentials'], false);
  const preflight = job.steps.findIndex(step => step.run === 'node scripts/release.mjs preflight');
  const inspect = job.steps.findIndex(step => step.run === 'node scripts/release.mjs inspect');
  const attest = job.steps.findIndex(step => step.id === 'provenance');
  const draft = job.steps.findIndex(step => step.run === 'node scripts/release.mjs draft');
  assert.ok(preflight > 0 && preflight < inspect && inspect < attest && attest < draft);
  assert.ok(!job.steps.some(step => step['continue-on-error']));
});
