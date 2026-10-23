import fs from 'node:fs';
import path from 'node:path';

export function packageManifest(source) {
  const match = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(source.name ?? '');
  const name = match ? match[2] : source.name;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? '')) throw new Error('Invalid extension package name.');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(source.publisher ?? '')) throw new Error('Invalid extension publisher.');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(source.version ?? '')) throw new Error('Invalid extension version.');
  return {...source, name};
}

export function archiveName(source) {
  const manifest = packageManifest(source);
  return `${manifest.name}-${manifest.version}.vsix`;
}

function copyEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('Package input must not be a symlink: ' + source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const name of fs.readdirSync(source).sort()) copyEntry(path.join(source, name), path.join(destination, name));
  } else if (stat.isFile()) fs.copyFileSync(source, destination);
  else throw new Error('Package input must be a regular file: ' + source);
}

export async function withPackageStage(sourceRoot, run) {
  const root = fs.realpathSync(sourceRoot);
  const original = fs.readFileSync(path.join(root, 'package.json'));
  const manifest = packageManifest(JSON.parse(original));
  const parent = path.join(root, '.package');
  if (fs.existsSync(parent) && (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory())) throw new Error('Package staging parent must be a regular directory.');
  fs.mkdirSync(parent, {recursive: true});
  const stage = fs.mkdtempSync(path.join(parent, 'vsix-'));
  try {
    for (const name of ['README.md','CHANGELOG.md','CONTRIBUTING.md','DCO','LICENSE','LICENSE-MIT','LICENSE-APACHE','THIRD-PARTY-NOTICES.md','TRADEMARKS.md','licensing.json','language-configuration.json','.vscodeignore']) copyEntry(path.join(root, name), path.join(stage, name));
    for (const name of ['src','scripts','assets','syntaxes','snippets','docs','LICENSES']) copyEntry(path.join(root, name), path.join(stage, name));
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    return await run(stage, manifest);
  } finally {
    // Delete only this invocation's absolute mkdtemp child, never a source path.
    const resolved = path.resolve(stage);
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('vsix-') || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe package staging cleanup path.');
    fs.rmSync(resolved, {recursive: true, force: true});
  }
}
