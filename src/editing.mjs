import path from 'node:path';
import fs from 'node:fs/promises';
import intrinsics from '../assets/intrinsics.json' with {type: 'json'};
import {inside} from './compiler.mjs';

export const coreKeywords = 'fn let mut struct enum match if else while for in return break continue pub import as type inout true false'.split(' ');
export const coreTypes = 'i32 u8 bool string void Array Map Option Result String Vec Bytes'.split(' ');
export const intentKeywords = 'app context entity behavior endpoint scenario reference feature unknown build change capability roles when intent must ensures prefer may given and then eventually source applies decision because image match allow deny ask blocks use implementation ownership preserve evolve require verify target agent tool method path request response status error extensible where inout true false'.split(' ');
export const intentTypes = 'Text UUID i32 u8 bool void Array Map Option Result string'.split(' ');
const clauses = new Set('intent must ensures prefer may given and when then eventually source applies decision because image match allow deny ask blocks use implementation ownership preserve evolve require verify target agent tool method path request response status error extensible'.split(' '));
const cancelled = token => token?.isCancellationRequested;
const reference = 'Static Kelft language reference; this is not a resolved symbol or an inferred type.';
const summaries = {
  print: 'Write text to standard output.', println: 'Write text followed by a newline to standard output.', eprint: 'Write text to standard error.',
  i32_to_string: 'Convert an i32 to decimal text.', string_to_i32: 'Parse decimal text into a recoverable i32 result.', i32_from_u8: 'Widen a byte to i32.', u8_from_i32: 'Convert an i32 to a byte.',
  string_len: 'Return the UTF-8 byte length.', string_byte: 'Read a UTF-8 byte at a byte index.', string_slice: 'Slice text using UTF-8 byte offsets aligned to code-point boundaries.',
  string_find: 'Find a literal substring starting at a byte offset.', string_replace: 'Replace literal, nonoverlapping occurrences.', string_split: 'Split on a nonempty literal separator, preserving empty segments.',
  string_from_codepoint: 'Construct text from a Unicode scalar value.', string_to_bytes: 'Encode text as UTF-8 bytes.', bytes_to_string: 'Decode UTF-8 bytes, trapping on invalid encoding.', utf8_decode: 'Decode UTF-8 bytes as a recoverable result.',
  array_len: 'Return the number of array elements.', array_push: 'Append a value through an explicit inout array argument.', array_pop: 'Remove the last element through inout, returning an Option.', array_slice: 'Return an array slice.',
  map_new: 'Create an empty map with explicit key/value type arguments.', map_len: 'Return the number of map entries.', map_get: 'Look up a key, returning an Option.', map_set: 'Insert or replace a value through an inout map argument.', map_remove: 'Remove a key through an inout map argument.',
  args: 'Return program argument strings.', read_file: 'Read file bytes within granted read roots.', read_text: 'Read file text within granted read roots.', write_file: 'Write file bytes within granted write roots.', write_text: 'Write file text within granted write roots.',
  resolve_path: 'Resolve a path against a base using host path rules.', path_dirname: 'Return the parent directory of a path.', path_relative: 'Return a relative path with forward-slash separators.', canonical_path: 'Resolve a canonical filesystem path under read authority.',
  artifact_run: 'Execute an emitted artifact through the authorized target registry.', create_dir: 'Create a directory within granted write roots.', write_once: 'Write text exclusively, permitting an identical-content retry.',
  process_run: 'Submit a versioned process-service request; execution requires explicit authority.', filesystem_read: 'Submit a versioned filesystem read-service request.', filesystem_write: 'Submit a versioned filesystem write-service request.', current_dir: 'Return the current working directory.', exit: 'Terminate the program with an exit code.'
};

// Editing context only: tolerate unfinished source without assigning bindings,
// accepting programs, or invoking a compiler. Offsets are editor UTF-16 offsets.
export function contextAt(text, offset, token) {
  if (cancelled(token) || text.length > 2 << 20 || offset < 0 || offset > text.length) return null;
  let at = 0, first = true, intent = false, prose = false, formalAllowed = false, formal = 0, previous = '', importNext = false;
  const mode = () => intent && !formal ? 'intent' : 'core';
  const base = () => ({mode: mode(), initial: first, qualified: previous === '.' || previous === '::'});
  while (at < text.length) {
    if ((at & 1023) === 0 && cancelled(token)) return null;
    const start = at, c = text[at];
    if (/\s/.test(c)) {
      if (at === offset) return prose && !formal ? null : {...base(), start: at, end: at, prefix: ''};
      if (c === '\n' || c === '\r') prose = false;
      at++; continue;
    }
    if (text.startsWith('//', at) || text.startsWith('/*', at)) {
      const line = text[at + 1] === '/';
      const close = text.indexOf(line ? '\n' : '*/', at + 2);
      at = close < 0 ? text.length : close + (line ? 0 : 2);
      if (offset >= start && (offset < at || close < 0 && offset === at)) return null;
      continue;
    }
    if (c === '"') {
      const triple = text.startsWith('"""', at), width = triple ? 3 : 1;
      at += width;
      const valueStart = at;
      let closed = false;
      while (at < text.length) {
        if ((at & 1023) === 0 && cancelled(token)) return null;
        if (text.startsWith(triple ? '"""' : '"', at)) {closed = true; break;}
        if (!triple && (text[at] === '\n' || text[at] === '\r')) break;
        if (!triple && text[at] === '\\') at++;
        at++;
      }
      const valueEnd = at;
      if (closed) at += width;
      if (offset >= start && offset <= valueEnd) {
        if (!triple && !intent && importNext && offset >= valueStart) {
          return {mode: 'import', start: valueStart, end: valueEnd, value: text.slice(valueStart, valueEnd), prefix: text.slice(valueStart, offset)};
        }
        return null;
      }
      importNext = false; previous = 'string'; first = false; formalAllowed = false;
      continue;
    }
    if (prose && !formal && !(c === '(' && formalAllowed) && c !== ';' && c !== '}') {
      if (at === offset) return null;
      if (formalAllowed) {
        const label = /^[A-Za-z_][A-Za-z_0-9]*[ \t]*:(?!:)/.exec(text.slice(at));
        if (label) {
          if (offset < at + label[0].length) return null;
          at += label[0].length; formalAllowed = false;
          // A formal predicate may immediately follow an optional clause label.
          while (text[at] === ' ' || text[at] === '\t') at++;
          if (offset < at) return null;
          formalAllowed = text[at] === '(';
          continue;
        }
        formalAllowed = false;
      }
      at++; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      at++;
      while (at < text.length && /[A-Za-z_0-9]/.test(text[at])) at++;
      const word = text.slice(start, at), before = base();
      if (offset >= start && offset <= at) return {...before, start, end: at, word, prefix: text.slice(start, offset)};
      if (first) {intent = word === 'app'; first = false;}
      importNext = !intent && word === 'import';
      if (intent && !formal && clauses.has(word)) {prose = true; formalAllowed = true;}
      previous = word; continue;
    }
    if (at === offset) return prose && !formal ? null : {...base(), start: at, end: at, prefix: ''};
    if (intent) {
      if (c === '(' && (formalAllowed || formal)) {formal++; formalAllowed = false;}
      else if (c === ')' && formal) formal--;
      else if (!formal && (c === ';' || c === '}')) prose = false;
    }
    if (text.startsWith('::', at)) {previous = '::'; at += 2;}
    else {previous = c; at++;}
    importNext = false; first = false;
  }
  return prose && !formal || cancelled(token) ? null : {...base(), start: offset, end: offset, prefix: ''};
}

export function intrinsicSignature(name) {
  const entry = Object.hasOwn(intrinsics, name) && intrinsics[name];
  if (!entry) return null;
  const types = Array.from({length: entry.generics}, (_, i) => 'T' + i);
  const display = type => type.replace(/\$(\d+)/g, (_, i) => 'T' + i);
  const generic = types.length ? '<' + types.join(', ') + '>' : '';
  const parameters = entry.params.map((type, i) => `${entry.inout?.includes(i) ? 'inout ' : ''}arg${i}: ${display(type)}`);
  return `fn ${name}${generic}(${parameters.join(', ')}) -> ${display(entry.result)}`;
}

export function intrinsicReference(name) {
  const signature = intrinsicSignature(name);
  if (!signature) return null;
  const entry = intrinsics[name];
  return {signature, documentation: `${summaries[name] || 'Language intrinsic.'}\n\n${reference}\n\n${entry.generics ? 'Generic type arguments must be explicit at call sites.\n\n' : ''}${entry.inout?.length ? 'Parameters marked inout require an explicit inout argument.\n\n' : ''}Effects: ${entry.effect || 'none declared in the signature contract'}. Parameter names arg0, arg1, … are reference placeholders.`};
}

export function staticSuggestions(context) {
  if (!context || context.qualified || context.mode === 'import') return [];
  const isCore = context.mode === 'core';
  const keywords = isCore ? [...coreKeywords, ...(context.initial ? ['app'] : [])] : intentKeywords;
  const rows = [...keywords.map(label => ({label, kind: 'keyword', detail: 'Kelft keyword — static suggestion'})),
    ...(isCore ? coreTypes : intentTypes).map(label => ({label, kind: 'type', detail: 'Kelft built-in type — static suggestion'}))];
  if (isCore) for (const label of Object.keys(intrinsics)) rows.push({label, kind: 'function', detail: intrinsicSignature(label), documentation: intrinsicReference(label).documentation});
  return rows.filter(row => row.label.startsWith(context.prefix));
}

function relativeImport(value) {
  // Source import paths use forward slashes. Reject encoded/escaped paths and
  // Windows drive/stream syntax rather than interpreting it as a filesystem path.
  return /^(?:\.\/|\.\.\/)/.test(value) && !/[\\\x00-\x1f:"<>|?*]/.test(value);
}

async function confined(file, root, target, token) {
  if (cancelled(token) || !inside(root, file) || !inside(root, target)) return false;
  const [realRoot, realFile, realTarget] = await Promise.all([fs.realpath(root), fs.realpath(file), fs.realpath(target)]);
  return !cancelled(token) && inside(realRoot, realFile) && inside(realRoot, realTarget);
}

export async function importSuggestions(context, _offset, file, root, token) {
  if (context?.mode !== 'import' || cancelled(token)) return [];
  if (!relativeImport(context.value)) {
    if (!['', '.', '..'].includes(context.value) || context.prefix !== context.value) return [];
    const rows = [];
    for (const label of ['./', '../']) {
      if (!label.startsWith(context.prefix)) continue;
      try {
        if (await confined(file, root, path.resolve(path.dirname(file), label), token)) rows.push({label, insertText: label, kind: 'folder', start: context.start, end: context.end});
      } catch { /* A missing source/root has no filesystem suggestions. */ }
    }
    return cancelled(token) ? [] : rows;
  }
  const slash = context.prefix.lastIndexOf('/'), directory = context.prefix.slice(0, slash + 1);
  const prefix = context.prefix.slice(slash + 1), tail = context.value.indexOf('/', context.prefix.length);
  const end = tail < 0 ? context.end : context.start + tail;
  const target = path.resolve(path.dirname(file), directory);
  try {
    if (!await confined(file, root, target, token)) return [];
    const rows = [];
    // Read one directory, never recursively index a workspace. Bound both work
    // and suggestions for large folders, and stop when the request is cancelled.
    const stream = await fs.opendir(target);
    let examined = 0;
    for await (const entry of stream) {
        if (cancelled(token)) return [];
        if (++examined > 4096) break;
        if (!entry.name.startsWith(prefix) || /[\\\x00-\x1f:"<>|?*]/.test(entry.name)) continue;
        const candidate = path.join(target, entry.name);
        let stat;
        try {
          if (!await confined(file, root, candidate, token)) continue;
          stat = await fs.stat(candidate);
        } catch { continue; }
        const folder = stat.isDirectory();
        if (!folder && (!stat.isFile() || !entry.name.endsWith('.kelft'))) continue;
        rows.push({label: entry.name + (folder ? '/' : ''), insertText: entry.name + (folder && tail < 0 ? '/' : ''), kind: folder ? 'folder' : 'file', start: context.start + slash + 1, end});
        if (rows.length === 256) break;
    }
    return cancelled(token) ? [] : rows.sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  } catch { return []; }
}

export async function importDefinition(context, file, root, token) {
  if (context?.mode !== 'import' || !relativeImport(context.value) || !context.value.endsWith('.kelft') || cancelled(token)) return null;
  const target = path.resolve(path.dirname(file), context.value);
  try {
    if (!await confined(file, root, target, token) || !(await fs.stat(target)).isFile() || cancelled(token)) return null;
    return target;
  } catch { return null; }
}
