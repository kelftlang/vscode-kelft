import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {bytePosition, diagnosticFile, projectPaths, prepareBuildDirectory, invocation, decodeResult, decodeCapabilities, runCompiler, isIntent} from '../src/compiler.mjs';

const envelope = (status, data=null, diagnostics='') => ({code:status==='success'?0:1,stdout:JSON.stringify({schema:'kelft.command-result/1',command:'check',status,data,diagnostics}),stderr:''});
test('native envelope preserves checks, compiler diagnostics, operational failures and blocked Intent',()=>{
  assert.equal(decodeResult(envelope('success'),'check').success,true);
  const diagnostic={code:'K0101',message:'expected identifier',span:{file:'main.kelft',start:4,end:6}};
  assert.deepEqual(decodeResult(envelope('failure',null,JSON.stringify(diagnostic)+'\n'),'check').diagnostics,[diagnostic]);
  assert.deepEqual(decodeResult(envelope('failure',null,'error[K0101]: expected identifier\n  /project/main.kelft:4-6\n'),'check').diagnostics,[{...diagnostic,span:{...diagnostic.span,file:'/project/main.kelft'}}]);
  const blocked=decodeResult(envelope('failure',{state:'needs-human',obligations:[{method:'blocked'}]}),'check');
  assert.equal(blocked.needsHuman,true);assert.equal(blocked.diagnostics.length,0);
  assert.equal(decodeResult({code:1,stdout:JSON.stringify({schema:'kelft.command-result/1',command:'check',status:'failure',error:{code:'INSTALLED_INPUTS',message:'changed'}}),stderr:''},'check').diagnostics[0].code,'INSTALLED_INPUTS');
  for(const result of [{code:0,stdout:'not json',stderr:''},{...envelope('failure'),code:0},envelope('failure',null,'unrecognized compiler output'),envelope('failure',null,JSON.stringify({...diagnostic,span:{...diagnostic.span,start:-1}}))])assert.throws(()=>decodeResult(result,'check'));
  assert.throws(()=>decodeResult(envelope('success'),'build'));
  assert.throws(()=>decodeCapabilities({code:0,stdout:'{}'}));
  assert.equal(decodeCapabilities({code:0,stdout:JSON.stringify({schema:'kelft.capabilities/1',commands:['check','build']})}).commands.length,2);
});
test('UTF-8 compiler offsets become UTF-16 editor positions including CRLF and mid-codepoint bounds',()=>{
  const text='é😀x\r\nβ';
  assert.deepEqual(bytePosition(text,2),{line:0,character:1});
  assert.deepEqual(bytePosition(text,5),{line:0,character:1});
  assert.deepEqual(bytePosition(text,6),{line:0,character:3});
  assert.deepEqual(bytePosition(text,9),{line:1,character:0});
  assert.deepEqual(bytePosition(text,8),{line:0,character:4});
  assert.deepEqual(bytePosition(text,100),{line:1,character:1});
  assert.throws(()=>bytePosition(text,-1));
});
test('multi-root and nested project invocation preserves Unicode paths and rejects escapes',()=>{
  const folder=path.resolve('workspace hé 😀'),file=path.join(folder,'pkg','src','main.kelft');
  const {root,output}=projectPaths(file,folder,'pkg','build/vscode','win32');
  assert.equal(root,path.join(folder,'pkg'));assert.equal(output,path.join(root,'build','vscode','src','main.exe'));
  const args=invocation('build',file,root,output);assert.deepEqual(args,['build',file,'--project-root',root,'--json','-o',output]);
  assert.throws(()=>projectPaths(path.resolve('elsewhere/main.kelft'),folder));
  assert.throws(()=>projectPaths(file,folder,'pkg','../outside'));
  assert.throws(()=>projectPaths(file,undefined));
  assert.equal(diagnosticFile('/project/src/main.kelft',root),path.join(root,'src','main.kelft'));
  assert.equal(diagnosticFile('/work/src/main.kelft',root),path.join(root,'src','main.kelft'));
  assert.throws(()=>diagnosticFile('../outside.kelft',root));
});
test('process arguments are literal, process output is bounded and cancellation terminates checks',async()=>{
  const marker='a space; $(never-run) & 😀';
  const result=await runCompiler(process.execPath,['-e','process.stdout.write(process.argv[1])',marker],{timeout:2000});
  assert.equal(result.stdout,marker);
  await assert.rejects(runCompiler(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeout:30}),/timeout/);
  await assert.rejects(runCompiler(process.execPath,['-e','process.stdout.write("x".repeat(8192))'],{limit:128}),/limit/);
  const controller=new AbortController();const pending=runCompiler(process.execPath,['-e','setTimeout(()=>{},10000)'],{signal:controller.signal});controller.abort();await assert.rejects(pending,/cancelled/);
  await assert.rejects(runCompiler(path.resolve('missing-native-kelft'),[],{timeout:500}),/Cannot launch/);
});
test('only top-level app source is classified as Intent',()=>{
  assert.equal(isIntent('// comment\n/* block */ app Example {}'),true);
  assert.equal(isIntent('fn main()->void {let app:string="app";}'),false);
});
test('build output never creates directories through an existing project symlink',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kelft-editor-output-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project'),outside=path.join(root,'outside');fs.mkdirSync(project);fs.mkdirSync(outside);
  await prepareBuildDirectory(project,path.join(project,'safe','nested','main.exe'));
  assert.ok(fs.statSync(path.join(project,'safe','nested')).isDirectory());
  fs.symlinkSync(outside,path.join(project,'linked'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(prepareBuildDirectory(project,path.join(project,'linked','unwanted','main.exe')),/symlink/);
  assert.equal(fs.existsSync(path.join(outside,'unwanted')),false);
  await assert.rejects(prepareBuildDirectory(project,path.join(outside,'main.exe')),/escapes/);
});
