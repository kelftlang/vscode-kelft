import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('restricted workspaces activate syntax support without launching or resolving a compiler',async()=>{
  const file=path.resolve(import.meta.dirname,'../dist/extension.cjs');
  assert.ok(fs.existsSync(file),'Run pnpm build before extension API tests.');
  const commands=new Map(),messages=[],providers={},noop=()=>({dispose(){}});
  const doc={languageId:'kelft',version:1,isClosed:false,getText:()=> 'pri',offsetAt:()=>3,positionAt:n=>({line:0,character:n}),uri:{scheme:'file',toString:()=> 'file:///main.kelft'}};
  const api={
    StatusBarAlignment:{Left:1},
    languages:{createDiagnosticCollection:()=>({clear(){},set(){},dispose(){}}),registerCompletionItemProvider:(s,p)=>{providers.completion=p;return noop();},registerHoverProvider:(s,p)=>{providers.hover=p;return noop();},registerDefinitionProvider:noop},
    CompletionItemKind:{Keyword:1,Class:2,Function:3,Folder:4,File:5},
    CompletionItem:class {constructor(label,kind){this.label=label;this.kind=kind;}},
    CompletionList:class {constructor(items){this.items=items;}},
    Range:class {constructor(start,end){this.start=start;this.end=end;}},
    MarkdownString:class {appendCodeblock(){}appendText(){}},
    Hover:class {},
    window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),createStatusBarItem:()=>({dispose(){}}),showInformationMessage:message=>messages.push(message),activeTextEditor:{document:doc}},
    commands:{registerCommand:(name,handler)=>{commands.set(name,handler);return noop();}},
    workspace:{isTrusted:false,textDocuments:[doc],getConfiguration:()=>({get:()=>true}),getWorkspaceFolder:()=>{throw new Error('Untrusted workspace resolved a compiler root');},onDidOpenTextDocument:noop,onDidSaveTextDocument:noop,onDidChangeTextDocument:noop,onDidCloseTextDocument:noop,onDidChangeConfiguration:noop,onDidGrantWorkspaceTrust:noop}
  };
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,require:id=>{
    if(id==='vscode')return api;
    if(id==='node:child_process')return {spawn(){throw new Error('Untrusted workspace launched a process');}};
    return require(id);
  },console,Buffer,process,AbortController,setTimeout,clearTimeout},{filename:file});
  const context={subscriptions:[]};module.exports.activate(context);
  await commands.get('kelft.checkFile')();await commands.get('kelft.buildFile')();
  assert.equal(messages.length,2);assert.ok(messages.every(m=>m.includes('Trust')));
  const suggestions=await providers.completion.provideCompletionItems(doc,{}, {isCancellationRequested:false});
  assert.ok(suggestions.items.some(item=>item.label==='print'));
  const hoverDoc={...doc,getText:()=> 'print',offsetAt:()=>2};
  assert.ok(providers.hover.provideHover(hoverDoc,{}, {isCancellationRequested:false}));
  context.subscriptions.forEach(item=>item.dispose());
});
