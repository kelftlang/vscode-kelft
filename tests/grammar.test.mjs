import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..');
await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
const raw=JSON.parse(fs.readFileSync(path.join(root,'syntaxes/kelft.tmLanguage.json')));
const registry=new textmate.Registry({onigLib:Promise.resolve({createOnigScanner:s=>new oniguruma.OnigScanner(s),createOnigString:s=>new oniguruma.OnigString(s)}),loadGrammar:async scope=>scope==='source.kelft'?raw:null});
const grammar=await registry.loadGrammar('source.kelft');
function tokens(source){let state=textmate.INITIAL;return source.split('\n').map(line=>{const result=grammar.tokenizeLine(line,state);state=result.ruleStack;return result.tokens.map(t=>({text:line.slice(t.startIndex,t.endIndex),scopes:t.scopes}));});}
const has=(rows,text,scope)=>rows.flat().some(t=>t.text===text&&t.scopes.some(s=>s.startsWith(scope)));
test('Core grammar recognizes declarations, escaped strings, nonnested comments and operators',()=>{
  const rows=tokens('pub fn main() -> void {\n // app is a comment\n let text:string="hello\\n";\n /* comment */ return;\n}');
  assert.ok(has(rows,'fn','keyword.control'));assert.ok(has(rows,'string','storage.type'));assert.ok(has(rows,'\\n','constant.character.escape'));
  assert.ok(rows[1].filter(t=>t.text.trim()).every(t=>t.scopes.includes('comment.line.double-slash.kelft')));
  assert.ok(has(rows,'return','keyword.control'));assert.ok(!rows.flat().some(t=>t.scopes.includes('meta.intent.kelft')));
});
test('Intent prose is contextual and multiline strings survive line boundaries',()=>{
  const rows=tokens('app Example {\n entity Input { name: Text }\n must if return then describe an outcome\n intent """first line\n fn is still text }\n last"""\n behavior echo(input: Text) -> Text {\n must (input != "")\n }\n}');
  assert.ok(has(rows,'app','keyword.declaration.intent'));assert.ok(has(rows,'entity','keyword.declaration.intent'));
  assert.ok(!rows[2].some(t=>t.scopes.includes('keyword.control.kelft')));
  assert.ok(rows[4].every(t=>t.scopes.includes('string.quoted.triple.kelft')));
  assert.ok(has(rows,'!=','keyword.operator'));assert.ok(rows[7].some(t=>t.scopes.includes('meta.expression.formal.kelft')));
});
test('unfinished strings and comments remain bounded on incomplete input',()=>{
  assert.ok(tokens('app A {\n intent """unfinished\n next').at(-1).every(t=>t.scopes.includes('string.quoted.triple.kelft')));
  assert.ok(tokens('/* unfinished\n app A {').at(-1).every(t=>t.scopes.includes('comment.block.kelft')));
  assert.ok(tokens('fn main()->void { let x:string="unfinished\n return;').at(-1).some(t=>t.text==='return'&&t.scopes.includes('keyword.control.kelft')));
});
