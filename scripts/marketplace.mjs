import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {repository, extensionID, releaseContext, releaseIdentity, assertTag, githubClient,
  inspectVSIX, attestationArgs, runCommand} from './release.mjs';

const require = createRequire(import.meta.url);
const check = (condition, message) => {if (!condition) throw new Error(message);};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = ['visual-studio-marketplace', 'open-vsx'];
const numericVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function marketplaceRequest(env) {
  const context = releaseContext(env);
  const tag = env.RELEASE_TAG ?? '', destination = env.MARKETPLACE_DESTINATION ?? '';
  check(tag.startsWith('v') && numericVersion.test(tag.slice(1)), 'Select an exact release tag vMAJOR.MINOR.PATCH; prerelease channels are not supported.');
  check(destination === 'both' || targets.includes(destination), 'Select both, visual-studio-marketplace or open-vsx.');
  return {context, tag, destination, targets: destination === 'both' ? targets : [destination]};
}

export function checkCredentialAvailability(request, env) {
  for (const target of request.targets) {
    const name = target === targets[0] ? 'VSCE_PAT' : 'OVSX_PAT';
    check(env['HAS_' + name] === 'true', `Configure the ${name} repository secret before publishing to ${target}.`);
  }
}

function assertPublished(release, tag) {
  check(release && Number.isSafeInteger(release.id) && release.id > 0 && release.tag_name === tag,
    'Published release is missing or has the wrong identity.');
  check(release.draft === false && release.immutable === true && typeof release.published_at === 'string' && release.published_at.length > 0,
    'Publish the reviewed GitHub release with release immutability enabled before marketplace submission.');
  check(release.prerelease === false, 'Prerelease channels are not supported by this publishing workflow.');
}

export async function resolveRelease(api, tag) {
  const release = await api('GET', '/releases/tags/' + encodeURIComponent(tag));
  assertPublished(release, tag);
  const ref = await api('GET', '/git/ref/tags/' + encodeURIComponent(tag));
  check(ref?.ref === 'refs/tags/' + tag, 'Release tag is missing or has the wrong identity.');
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    check(/^[a-f0-9]{40}$/.test(object.sha ?? ''), 'Invalid annotated release tag.');
    object = (await api('GET', '/git/tags/' + object.sha)).object;
  }
  check(object?.type === 'commit' && /^[a-f0-9]{40}$/.test(object.sha ?? ''), 'Release tag must resolve to an exact commit within eight tag objects.');
  const sha = object.sha;
  const file = await api('GET', '/contents/package.json?ref=' + sha);
  check(file?.type === 'file' && file.encoding === 'base64' && typeof file.content === 'string' && file.content.length <= 1 << 20,
    'Source manifest is missing or oversized at the release commit.');
  const source = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  const identity = releaseIdentity(source);
  check(identity.tag === tag && numericVersion.test(identity.version), 'Release tag and marketplace manifest version do not match.');
  const assets = [identity.file, identity.checksum, identity.bundle].map(name => {
    const matches = release.assets?.filter(asset => asset.name === name) ?? [];
    check(matches.length === 1, 'Expected exactly one release asset: ' + name);
    const asset = matches[0], limit = name === identity.file ? 64 << 20 : name === identity.bundle ? 16 << 20 : 1024;
    check(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= limit && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''),
      'Invalid release asset metadata: ' + name);
    return asset;
  });
  return {release, sha, source, identity, assets};
}

export async function verifyRelease({request, client, directory, command = runCommand}) {
  const selected = await resolveRelease(client.api, request.tag);
  const {identity, sha, source, assets} = selected;
  fs.mkdirSync(directory, {recursive: true});
  for (const asset of assets) {
    const bytes = await client.download(asset.id);
    check(bytes.length === asset.size && 'sha256:' + digest(bytes) === asset.digest, 'Downloaded release asset failed verification: ' + asset.name);
    fs.writeFileSync(path.join(directory, asset.name), bytes);
  }
  const archive = path.join(directory, identity.file), receipt = path.join(directory, identity.checksum), bundle = path.join(directory, identity.bundle);
  const inspection = await inspectVSIX(archive, source, fs.readFileSync(receipt, 'utf8'));
  command('gh', ['release', 'verify', identity.tag, '--repo', repository]);
  for (const asset of assets) command('gh', ['release', 'verify-asset', identity.tag, path.join(directory, asset.name), '--repo', repository]);
  for (const file of [archive, receipt]) {
    const verified = JSON.parse(command('gh', attestationArgs(file, bundle, sha)));
    check(Array.isArray(verified) && verified.length > 0, 'No verified build provenance result.');
  }
  await assertTag(client.api, identity, sha, {required: true});
  const current = await client.api('GET', '/releases/' + selected.release.id);
  assertPublished(current, identity.tag);
  check(current.id === selected.release.id && assets.every(asset => {
    const matches = current.assets?.filter(row => row.name === asset.name) ?? [];
    return matches.length === 1 && matches[0].id === asset.id && matches[0].digest === asset.digest && matches[0].size === asset.size && matches[0].state === 'uploaded';
  }), 'Release identity or assets changed during verification.');
  return {request, sha, source, identity, assets, inspection, verified: true, results: {}};
}

export function publisherArgs(target, archive) {
  check(targets.includes(target), 'Unknown marketplace destination.');
  return target === targets[0] ? ['publish', '--packagePath', archive] : ['publish', archive, '--registryUrl', 'https://open-vsx.org'];
}

export async function publishVerified({state, request, target, directory, env, command = runCommand, cli}) {
  check(state?.verified === true && JSON.stringify(state.request) === JSON.stringify(request), 'Marketplace verification belongs to a different request or workflow run.');
  check(request.targets.includes(target), 'Destination was not selected for this run.');
  check(target !== targets[1] || request.targets.length !== 2 || state.results[targets[0]] === 'submitted',
    'Submit to Visual Studio Marketplace successfully before Open VSX when both are selected.');
  const token = target === targets[0] ? 'VSCE_PAT' : 'OVSX_PAT';
  check(typeof env[token] === 'string' && env[token].trim().length > 0, 'Missing ' + token + ' for upload.');
  const identity = releaseIdentity(state.source);
  check(identity.tag === request.tag && JSON.stringify(identity) === JSON.stringify(state.identity), 'Verified manifest no longer matches the request.');
  for (const asset of state.assets) {
    const bytes = fs.readFileSync(path.join(directory, asset.name));
    check(bytes.length === asset.size && 'sha256:' + digest(bytes) === asset.digest, 'Verified release asset changed before upload: ' + asset.name);
  }
  const archive = path.join(directory, identity.file);
  const inspection = await inspectVSIX(archive, state.source, fs.readFileSync(path.join(directory, identity.checksum), 'utf8'));
  check(inspection.sha256 === state.inspection.sha256, 'Verified VSIX changed before upload.');
  if (cli === undefined) {
    const name = target === targets[0] ? '@vscode/vsce' : 'ovsx';
    const manifest = require.resolve(name + '/package.json'), pkg = JSON.parse(fs.readFileSync(manifest));
    cli = path.resolve(path.dirname(manifest), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[target === targets[0] ? 'vsce' : 'ovsx']);
  }
  const uploadEnv = {...env};
  delete uploadEnv[target === targets[0] ? 'OVSX_PAT' : 'VSCE_PAT'];
  try {
    command(process.execPath, [cli, ...publisherArgs(target, archive)], {env: uploadEnv, stdio: 'inherit', cwd: path.dirname(directory)});
    state.results[target] = 'submitted';
  } catch (error) {state.results[target] = 'failed';throw error;}
}

export function marketplaceSummary(state) {
  if (!state?.verified) return '## Marketplace publishing\n\nRelease verification did not complete; no uploads were authorized.\n';
  const {request, identity, sha, inspection} = state;
  return `## Marketplace publishing\n\n- Release: \`${identity.tag}\`.\n- Source: \`${sha}\`.\n- Extension: \`${extensionID}\` ${identity.version}.\n- VSIX: \`${identity.file}\`.\n- SHA-256: \`${inspection.sha256}\`.\n\n` +
    request.targets.map(target => `- ${target}: ${state.results[target] ?? 'not attempted'}.`).join('\n') +
    '\n\nSuccessful submission does not establish registry acceptance or listing availability. If one destination failed, rerun with only that destination selected.\n';
}

export async function runCLI(action, root = path.resolve(import.meta.dirname, '..'), env = process.env) {
  const request = marketplaceRequest(env), directory = path.join(root, '.release', 'marketplaces');
  const stateFile = path.join(directory, 'verified.json');
  if (action === 'summary') {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
    const text = marketplaceSummary(JSON.stringify(state?.request) === JSON.stringify(request) ? state : null);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    else console.log(text);
    return;
  }
  check(runCommand('git', ['rev-parse', 'HEAD'], {cwd: root}).trim() === request.context.sha, 'Checkout does not match the triggering main commit.');
  if (action === 'verify') {
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(stateFile, JSON.stringify({request, verified: false}));
    checkCredentialAvailability(request, env);
    const state = await verifyRelease({request, client: githubClient(env.GH_TOKEN), directory});
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
    return;
  }
  const target = action === 'publish-vscode' ? targets[0] : action === 'publish-open-vsx' ? targets[1] : null;
  check(target, 'Usage: marketplace.mjs verify|publish-vscode|publish-open-vsx|summary');
  const state = JSON.parse(fs.readFileSync(stateFile));
  try {
    await publishVerified({state, request, target, directory, env});
  } catch (error) {
    if (state.results) state.results[target] = 'failed';
    throw error;
  } finally {fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {await runCLI(process.argv[2]);} catch (error) {console.error(error.message);process.exitCode = 1;}
}
