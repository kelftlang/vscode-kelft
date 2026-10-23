import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';

export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function projectPaths(file, folder, configuredRoot = '', outputDirectory = 'build/vscode', platform = process.platform) {
  if (!folder) throw new Error('Open a workspace folder before invoking the native compiler.');
  const root = path.resolve(folder, configuredRoot || '.');
  if (!inside(root, file)) throw new Error('The source file is outside the configured project root.');
  const outputRoot = path.resolve(root, outputDirectory);
  if (!inside(root, outputRoot) || outputRoot === root) throw new Error('The build output directory must be below the project root.');
  const relative = path.relative(root, file);
  if (!relative.endsWith('.kelft')) throw new Error('The source must use .kelft.');
  const output = path.join(outputRoot, relative.slice(0, -6) + (platform === 'win32' ? '.exe' : ''));
  if (output === file) throw new Error('Build output overlaps the source.');
  return {root, output};
}

export function invocation(command, file, root, output) {
  if (!['check', 'build'].includes(command)) throw new Error('Unsupported editor compiler command.');
  const args = [command, file, '--project-root', root, '--json'];
  if (command === 'build') {
    if (!output) throw new Error('Build output is required.');
    args.push('-o', output);
  }
  return args;
}

export async function prepareBuildDirectory(root, output) {
  const canonicalRoot=await fs.realpath(root),relative=path.relative(root,path.dirname(output));
  if(!inside(root,output))throw new Error('Build output escapes the project root.');
  let directory=root;
  for(const part of relative.split(path.sep).filter(Boolean)){
    directory=path.join(directory,part);
    let stat;
    try{stat=await fs.lstat(directory);}catch(error){
      if(error.code!=='ENOENT')throw error;
      try{await fs.mkdir(directory);}catch(created){if(created.code!=='EEXIST')throw created;}
      stat=await fs.lstat(directory);
    }
    if(stat.isSymbolicLink()||!stat.isDirectory()||!inside(canonicalRoot,await fs.realpath(directory)))throw new Error('The build output directory must not traverse a symlink or leave the project.');
  }
  try{const stat=await fs.lstat(output);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Build output must be a regular file, not a symlink.');}catch(error){if(error.code!=='ENOENT')throw error;}
}

export function runCompiler(executable, args, {cwd, timeout = 60000, signal, limit = 16 << 20} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Kelft operation cancelled.'));
    let child, stdout = [], stderr = [], bytes = 0, failure, timer;
    const stop = message => { if (!failure) failure = new Error(message); child?.kill(); };
    try { child = spawn(executable, args, {cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (error) { reject(error); return; }
    const abort = () => stop('Kelft operation cancelled.');
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => stop(`Kelft exceeded the ${timeout} ms timeout.`), timeout);
    timer.unref();
    const collect = destination => chunk => {
      bytes += chunk.length;
      if (bytes > limit) { stop('Kelft output exceeded the configured limit.'); return; }
      destination.push(chunk);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { failure = new Error(`Cannot launch native Kelft: ${error.message}. Set kelft.compilerPath to an installed executable.`); });
    child.on('close', (code, childSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (childSignal) reject(new Error(`Kelft terminated with ${childSignal}.`));
      else resolve({code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8')});
    });
  });
}

export function decodeCapabilities(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('Native Kelft did not return JSON capabilities; install a current native package.'); }
  if (result.code !== 0 || value.schema !== 'kelft.capabilities/1' || !['check', 'build'].every(c => value.commands?.includes(c))) {
    throw new Error('This Kelft installation must expose native check and build commands.');
  }
  return value;
}

export function decodeResult(result, command) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error(`Kelft returned malformed JSON. ${result.stderr.trim()}`); }
  if (value.schema !== 'kelft.command-result/1' || value.command !== command || !['success', 'failure'].includes(value.status)) {
    throw new Error('Unsupported native Kelft command-result contract.');
  }
  const needsHuman = command === 'check' && value.data?.state === 'needs-human';
  if (!needsHuman && ((result.code === 0) !== (value.status === 'success'))) throw new Error('Kelft exit status contradicts its JSON result.');
  const diagnostics = [];
  if (value.error) {
    if (typeof value.error.message !== 'string') throw new Error('Malformed Kelft operational error.');
    diagnostics.push({code: String(value.error.code || 'KELFT'), message: value.error.message});
  }
  const raw = value.diagnostics ?? '';
  if (typeof raw !== 'string') throw new Error('Unsupported Kelft diagnostics payload.');
  const lines=raw.split(/\r?\n/).filter(s=>s.trim());
  for (let index=0;index<lines.length;index++) {
    const line=lines[index];
    // The native envelope preserves worker stderr, which can use the established
    // error[CODE] + byte-span format even when the coordinator emits JSON.
    const human=/^error\[([A-Za-z0-9_]+)\]:\s*(.+)$/.exec(line);
    if(human){
      const diagnostic={code:human[1],message:human[2]};
      const span=/^[ \t]+(.+):(\d+)-(\d+)\s*$/.exec(lines[index+1]||'');
      if(span){const start=Number(span[2]),end=Number(span[3]);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start)throw new Error('Invalid native diagnostic span.');diagnostic.span={file:span[1],start,end};index++;}
      diagnostics.push(diagnostic);continue;
    }
    try {
      const diagnostic = JSON.parse(line);
      if (typeof diagnostic.code !== 'string' || typeof diagnostic.message !== 'string') throw new Error('invalid');
      if (diagnostic.span && (typeof diagnostic.span.file !== 'string' || !Number.isInteger(diagnostic.span.start) || !Number.isInteger(diagnostic.span.end) || diagnostic.span.start < 0 || diagnostic.span.end < diagnostic.span.start)) throw new Error('invalid');
      diagnostics.push(diagnostic);
    } catch { throw new Error(`Kelft returned a non-JSON diagnostic: ${line.slice(0, 240)}`); }
  }
  if (!needsHuman && value.status === 'failure' && diagnostics.length === 0) diagnostics.push({code: 'KELFT', message: `Native ${command} failed without a diagnostic. ${result.stderr.trim()}`.trim()});
  return {value, diagnostics, needsHuman, success: value.status === 'success'};
}

// Compiler spans count UTF-8 bytes. Editor positions count UTF-16 code units.
export function bytePosition(text, offset) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid UTF-8 byte offset.');
  let bytes = 0, line = 0, character = 0;
  for (let at=0;at<text.length;) {
    const codepoint=String.fromCodePoint(text.codePointAt(at));
    const width = Buffer.byteLength(codepoint);
    if (bytes + width > offset) break;
    bytes += width;
    if (codepoint === '\n' || codepoint === '\r' && text[at+1] !== '\n') { line++; character = 0; }
    else if(codepoint === '\r') { /* CR in CRLF is not a display column. */ }
    else character += codepoint.length;
    at+=codepoint.length;
  }
  return {line, character};
}

export function diagnosticFile(file, root) {
  // Installed host boundaries use /project or /work for the mapped project.
  const normal = file.replaceAll('\\', '/');
  const guest = ['/project','/work'].find(prefix=>normal===prefix||normal.startsWith(prefix+'/'));
  const mapped = guest ? path.resolve(root, '.' + normal.slice(guest.length)) : path.resolve(root, file);
  if (!inside(root, mapped)) throw new Error('Kelft returned a diagnostic outside the project root.');
  return mapped;
}

export function isIntent(text) {
  return /^[ \t\r\n\v\f]*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)[ \t\r\n\v\f]*)*app[ \t\r\n\v\f]/.test(text);
}
