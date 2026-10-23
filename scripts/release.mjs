import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {packageManifest, archiveName} from './package-stage.mjs';

const require = createRequire(import.meta.url);
const dependency = createRequire(require.resolve('@vscode/vsce/package.json'));
const semver = dependency('semver');
const yauzl = dependency('yauzl');
export const repository = 'kelftlang/vscode-kelft';
export const workflow = repository + '/.github/workflows/release.yml';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => {if (!condition) throw new Error(message);};

export function releaseIdentity(source) {
  const manifest = packageManifest(source);
  check(source.name === '@kelftlang/vscode' && manifest.name === 'vscode' && manifest.publisher === 'kelftlang', 'Release identity must be @kelftlang/vscode / kelftlang.vscode.');
  check(semver.valid(manifest.version) === manifest.version, 'Release version must be canonical SemVer.');
  const file = archiveName(source);
  return {version: manifest.version, tag: 'v' + manifest.version, title: 'Kelft for VS Code v' + manifest.version,
    prerelease: semver.prerelease(manifest.version) !== null, file, checksum: file + '.sha256', bundle: file + '.sigstore.json'};
}

export function releaseContext(env) {
  check(env.GITHUB_REPOSITORY === repository && env.GITHUB_SERVER_URL === 'https://github.com', 'Prepare release runs only in ' + repository + ' on github.com.');
  check(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main', 'Manually run Prepare release from main.');
  check(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ''), 'Missing exact triggering commit.');
  check(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'Missing workflow run identity.');
  return {sha: env.GITHUB_SHA, run: `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`};
}

export function changelogSection(text, version) {
  const sections = [...text.matchAll(/^##[ \t]+([^\r\n]+)[ \t]*\r?$/gm)];
  const matching = sections.map((match, index) => ({match, index})).filter(({match}) => match[1].trim() === version);
  check(matching.length === 1, 'CHANGELOG.md must contain exactly one section for ' + version + '.');
  const {match, index} = matching[0];
  const body = text.slice(match.index + match[0].length, sections[index + 1]?.index ?? text.length).trim();
  check(body.length > 0, 'Release changelog section is empty.');
  return body;
}

export function githubSignature(commit, sha) {
  const verification = commit?.commit?.verification;
  check(commit?.sha === sha, 'GitHub returned a different source commit.');
  check(verification?.verified === true && verification.reason === 'valid', 'The source commit must have a valid GitHub-verified signature. Merge through GitHub before preparing a release.');
  check(commit.committer?.login === 'web-flow' && commit.commit.committer?.email === 'noreply@github.com', 'The source must be signed by GitHub web-flow, not a different signing identity.');
  check(typeof verification.payload === 'string' && verification.payload.length > 0 && typeof verification.signature === 'string' && verification.signature.startsWith('-----BEGIN PGP SIGNATURE-----'), 'Missing GitHub OpenPGP verification material.');
  return verification;
}

export function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {windowsHide: true, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20, ...options});
  if (result.error) throw new Error('Cannot run ' + executable + ': ' + result.error.message);
  check(result.status === 0, executable + ' failed: ' + (result.stderr || '').slice(0, 2000));
  return result.stdout;
}

export function verifyGitHubKey(verification, publicKeys, command = runCommand) {
  check(typeof publicKeys === 'string' && publicKeys.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----'), 'GitHub signing keys are unavailable.');
  const parent = fs.realpathSync(os.tmpdir()), home = fs.mkdtempSync(path.join(parent, 'kelft-release-gpg-'));
  fs.chmodSync(home, 0o700);
  const args = ['--no-options', '--homedir', home, '--batch', '--no-auto-key-retrieve'];
  try {
    command('gpg', [...args, '--import'], {input: publicKeys});
    const signature = path.join(home, 'commit.asc'), payload = path.join(home, 'commit.txt');
    fs.writeFileSync(signature, verification.signature); fs.writeFileSync(payload, verification.payload);
    const status = command('gpg', [...args, '--status-fd', '1', '--verify', signature, payload]);
    const valid = /^\[GNUPG:\] VALIDSIG ([A-F0-9]{40,64})\b/m.exec(status);
    check(valid, 'Commit signature does not verify against GitHub web-flow keys.');
    return valid[1];
  } finally {
    const resolved = path.resolve(home);
    check(path.dirname(resolved) === parent && path.basename(resolved).startsWith('kelft-release-gpg-') && !fs.lstatSync(resolved).isSymbolicLink(), 'Unsafe signing-check cleanup path.');
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}

export function assertDraft(release, identity, sha) {
  if (!release) return;
  check(release.draft === true && release.immutable !== true && !release.published_at, 'This version is published or immutable; bump the version instead of replacing it.');
  check(release.tag_name === identity.tag && release.target_commitish === sha, 'Existing draft belongs to a different version or source commit.');
  check(Number.isSafeInteger(release.id) && release.id > 0, 'Invalid draft release identity.');
}

export async function assertTag(api, identity, sha) {
  const ref = await api('GET', `/git/ref/tags/${encodeURIComponent(identity.tag)}`, undefined, {missing: true});
  if (!ref) return null;
  check(ref.ref === 'refs/tags/' + identity.tag, 'Unexpected tag reference.');
  let object = ref.object;
  // Resolve bounded annotated-tag chains as well as ordinary lightweight tags.
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    check(/^[a-f0-9]{40}$/.test(object.sha ?? ''), 'Invalid annotated tag.');
    object = (await api('GET', '/git/tags/' + object.sha)).object;
  }
  check(object?.type === 'commit' && object.sha === sha, 'The version tag points to a different commit; it will not be moved.');
  return ref;
}

export async function existingRelease(api, identity, sha) {
  await assertTag(api, identity, sha);
  const release = await api('GET', '/releases/tags/' + encodeURIComponent(identity.tag), undefined, {missing: true});
  assertDraft(release, identity, sha);
  return release;
}

export async function inspectVSIX(file, source, checksum) {
  const identity = releaseIdentity(source), bytes = fs.readFileSync(file), rows = new Map();
  check(path.basename(file) === identity.file && bytes.length > 0 && bytes.length <= 64 << 20, 'Unexpected VSIX file or size.');
  check(checksum.trim() === `${digest(bytes)}  ${identity.file}`, 'VSIX checksum does not match its receipt.');
  await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {lazyEntries: true}, (error, zip) => {
    if (error) return reject(error);
    let total = 0;
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', entry => {
      const name = entry.fileName;
      if (rows.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || (total += entry.uncompressedSize) > 128 << 20 || entry.uncompressedSize > 16 << 20) {
        zip.close(); reject(new Error('Unsafe or oversized VSIX entry.')); return;
      }
      if (name.endsWith('/')) {rows.set(name, Buffer.alloc(0));zip.readEntry();return;}
      zip.openReadStream(entry, (error, input) => {
        if (error) return reject(error);
        const chunks = []; input.on('data', chunk => chunks.push(chunk)); input.on('error', reject);
        input.on('end', () => {rows.set(name, Buffer.concat(chunks));zip.readEntry();});
      });
    });zip.readEntry();
  }));
  const manifest = JSON.parse(rows.get('extension/package.json')?.toString() ?? 'null');
  check(manifest && JSON.stringify(manifest) === JSON.stringify(packageManifest(source)), 'Packaged manifest differs from the normalized source manifest.');
  const xml = rows.get('extension.vsixmanifest')?.toString() ?? '';
  check(new RegExp(`<Identity\\b[^>]*\\bId="vscode"[^>]*\\bVersion="${identity.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*\\bPublisher="kelftlang"`).test(xml), 'VSIX identity/version does not match the release.');
  for (const name of ['LICENSE.txt','LICENSE-MIT','LICENSE-APACHE','LICENSES/MIT-0.txt','THIRD-PARTY-NOTICES.md','readme.md','changelog.md','docs/licensing.md','docs/releasing.md','licensing.json','dist/extension.cjs','assets/icon.png','assets/intrinsics.json','assets/kelft-icon-light.svg','assets/kelft-icon-dark.svg','syntaxes/kelft.tmLanguage.json','snippets/kelft.json']) check(rows.has('extension/' + name), 'Required package content missing: ' + name);
  for (const name of rows.keys()) check(!/^extension\/(?:src|scripts|tests|node_modules|\.github|\.package)\//.test(name) && !name.endsWith('.publication.json') && !name.includes('CC-BY-4.0'), 'Unexpected package content: ' + name);
  return {sha256: digest(bytes), bytes: bytes.length, files: rows.size};
}

export function attestationArgs(file, bundle, sha) {
  return ['attestation', 'verify', file, '--bundle', bundle, '--repo', repository, '--signer-workflow', workflow,
    '--signer-digest', sha, '--source-ref', 'refs/heads/main', '--source-digest', sha, '--deny-self-hosted-runners', '--format', 'json'];
}

export function releaseNotes(identity, section, context, hash, attestationURL) {
  check(attestationURL.startsWith(`https://github.com/${repository}/attestations/`), 'Unexpected attestation URL.');
  return `${section}\n\n## Build and verification\n\n- Source: [\`${context.sha}\`](https://github.com/${repository}/commit/${context.sha}) (GitHub-signed and verified).\n- Build: [GitHub Actions run](${context.run}).\n- Provenance: [verified build attestation](${attestationURL}).\n- Extension ID: \`kelftlang.vscode\`.\n- SHA-256 of \`${identity.file}\`: \`${hash}\`.\n\nVerify the downloaded extension:\n\n\`\`\`sh\ngh attestation verify ${identity.file} --repo ${repository} --signer-workflow ${workflow} --source-digest ${context.sha}\ngh release verify ${identity.tag} --repo ${repository}\ngh release verify-asset ${identity.tag} ${identity.file} --repo ${repository}\n\`\`\`\n\nThe Verified Git signature applies to the source commit. The version tag points to that commit. Release integrity verification is available after publication with release immutability enabled.\n`;
}

export async function prepareDraft({api, upload, download, identity, context, notes, assets}) {
  let release = await existingRelease(api, identity, context.sha);
  const ref = await assertTag(api, identity, context.sha);
  if (!ref) await api('POST', '/git/refs', {ref: 'refs/tags/' + identity.tag, sha: context.sha});
  if (!release) release = await api('POST', '/releases', {tag_name: identity.tag, target_commitish: context.sha, name: identity.title, body: 'Release preparation is running. Review the completed Actions summary before publishing.', draft: true, prerelease: identity.prerelease});
  assertDraft(release, identity, context.sha);
  const getDraft = async () => {
    await assertTag(api, identity, context.sha);
    const current = await api('GET', '/releases/' + release.id);
    assertDraft(current, identity, context.sha);return current;
  };
  // A failed refresh cannot leave a previously successful readiness notice.
  await getDraft();
  await api('PATCH', '/releases/' + release.id, {body: 'Release preparation is running. Review the completed Actions summary before publishing.', draft: true});
  for (const asset of assets) {
    const current = await getDraft();
    const previous = current.assets?.filter(row => row.name === asset.name) ?? [];
    check(previous.length <= 1, 'Duplicate release asset name.');
    const hash = 'sha256:' + digest(asset.bytes);
    if (previous[0] && previous[0].digest === hash && previous[0].size === asset.bytes.length && previous[0].state === 'uploaded') continue;
    if (previous[0]) {
      check(Number.isSafeInteger(previous[0].id), 'Invalid release asset identity.');
      await api('DELETE', '/releases/assets/' + previous[0].id);
    }
    await getDraft();
    const uploaded = await upload(release.id, asset);
    check(uploaded.name === asset.name && uploaded.digest === hash && uploaded.size === asset.bytes.length && uploaded.state === 'uploaded', 'Uploaded asset digest does not match: ' + asset.name);
  }
  const complete = await getDraft();
  const expected = new Set(assets.map(asset => asset.name));
  check((complete.assets ?? []).length === expected.size && complete.assets.every(asset => expected.has(asset.name)), 'Draft contains unexpected or missing assets.');
  for (const asset of assets) {
    const remote = complete.assets.find(row => row.name === asset.name);
    check(remote.digest === 'sha256:' + digest(asset.bytes) && remote.state === 'uploaded', 'Release asset metadata failed verification.');
    check(digest(await download(remote.id)) === digest(asset.bytes), 'Downloaded release asset failed verification: ' + asset.name);
  }
  await getDraft();
  const ready = await api('PATCH', '/releases/' + release.id, {name: identity.title, body: notes, draft: true, prerelease: identity.prerelease});
  assertDraft(ready, identity, context.sha);
  check(ready.html_url?.startsWith(`https://github.com/${repository}/releases/`), 'Unexpected draft URL.');
  return ready;
}

export function githubClient(token, fetcher = fetch) {
  check(typeof token === 'string' && token.length > 0, 'GH_TOKEN is required only inside the release workflow.');
  async function request(url, options = {}) {
    const response = await fetcher(url, {signal: AbortSignal.timeout(60000), ...options,
      headers: {accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', ...options.headers}});
    if (response.status === 404 && options.missing) return null;
    check(response.ok, `GitHub API request failed with status ${response.status}; check repository permissions and feature availability.`);
    if (response.status === 204) return null;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {size += chunk.length;check(size <= 64 << 20, 'GitHub response exceeded the release limit.');chunks.push(chunk);}
    const bytes = Buffer.concat(chunks);
    return options.binary ? bytes : JSON.parse(bytes.toString('utf8'));
  }
  const base = 'https://api.github.com/repos/' + repository;
  return {
    api: (method, route, body, options = {}) => {
      check(route.startsWith('/') && !route.includes('..') && !route.includes('://'), 'Invalid GitHub API route.');
      return request(base + route, {method, ...options, ...(body === undefined ? {} : {body: JSON.stringify(body), headers: {'content-type': 'application/json'}})});
    },
    upload: (id, asset) => {
      check(Number.isSafeInteger(id) && id > 0, 'Invalid release ID.');
      return request(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`, {method: 'POST', body: asset.bytes, headers: {'content-type': 'application/octet-stream'}});
    },
    download: id => {check(Number.isSafeInteger(id) && id > 0, 'Invalid asset ID.');return request(base + '/releases/assets/' + id, {binary: true, headers: {accept: 'application/octet-stream'}});}
  };
}

function writeJSON(file, value) {fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');}

export async function runCLI(command, root = path.resolve(import.meta.dirname, '..'), env = process.env) {
  const identity = releaseIdentity(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))));
  const context = releaseContext(env);
  check(runCommand('git', ['rev-parse', 'HEAD'], {cwd: root}).trim() === context.sha, 'Checkout does not match the triggering commit.');
  const state = path.join(root, '.release');fs.mkdirSync(state, {recursive: true});
  const client = githubClient(env.GH_TOKEN);
  if (command === 'preflight') {
    const verification = githubSignature(await client.api('GET', '/commits/' + context.sha), context.sha);
    const keys = await fetch('https://github.com/web-flow.gpg', {signal: AbortSignal.timeout(30000)});
    check(keys.ok, 'Cannot retrieve GitHub signing keys.');
    const fingerprint = verifyGitHubKey(verification, await keys.text());
    changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), identity.version);
    await existingRelease(client.api, identity, context.sha);
    writeJSON(path.join(state, 'source.json'), {...context, fingerprint});
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `file=${identity.file}\nchecksum=${identity.checksum}\nbundle=${identity.bundle}\ntag=${identity.tag}\n`);
    return;
  }
  const source = JSON.parse(fs.readFileSync(path.join(state, 'source.json')));
  check(source.sha === context.sha && source.run === context.run, 'Release preflight belongs to a different run.');
  const archive = path.join(root, identity.file), checksum = path.join(root, identity.checksum);
  const inspection = await inspectVSIX(archive, JSON.parse(fs.readFileSync(path.join(root, 'package.json'))), fs.readFileSync(checksum, 'utf8'));
  if (command === 'inspect') {writeJSON(path.join(state, 'inspection.json'), inspection);return;}
  check(command === 'draft', 'Usage: release.mjs preflight|inspect|draft');
  check(env.ATTESTATION_BUNDLE && fs.statSync(env.ATTESTATION_BUNDLE).isFile(), 'Build attestation is unavailable; check public-repository / Enterprise support and workflow permissions.');
  const bundle = path.join(state, identity.bundle);fs.copyFileSync(env.ATTESTATION_BUNDLE, bundle);
  for (const file of [archive, checksum]) {
    const output = runCommand('gh', attestationArgs(file, bundle, context.sha), {cwd: root});
    check(Array.isArray(JSON.parse(output)) && JSON.parse(output).length > 0, 'No verified provenance result.');
  }
  const notes = releaseNotes(identity, changelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), identity.version), context, inspection.sha256, env.ATTESTATION_URL ?? '');
  const assets = [identity.file, identity.checksum, identity.bundle].map(name => ({name, bytes: fs.readFileSync(name === identity.bundle ? bundle : path.join(root, name))}));
  const ready = await prepareDraft({...client, identity, context, notes, assets});
  writeJSON(path.join(state, 'ready.json'), {url: ready.html_url, ...context, ...inspection, attestation: env.ATTESTATION_URL});
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## Release draft ready\n\n[Review and publish ${identity.tag}](${ready.html_url})\n\n- GitHub commit signature: verified (\`${source.fingerprint}\`).\n- Source: \`${context.sha}\`.\n- VSIX inspection, SHA-256 receipt, build provenance and all uploaded asset bytes: verified.\n- [Build attestation](${env.ATTESTATION_URL}).\n- VSIX SHA-256: \`${inspection.sha256}\`.\n\nReview the draft and click **Publish release** with release immutability enabled. Marketplace publishing remains separate.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {await runCLI(process.argv[2]);} catch (error) {console.error(error.message);process.exitCode = 1;}
}
