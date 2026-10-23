import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {reviewIcons} from './icon-review.mjs';
import {archiveName} from './package-stage.mjs';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const yauzl=createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');
const archive=path.join(root,archiveName(JSON.parse(fs.readFileSync(path.join(root,'package.json')))));
if(!fs.existsSync(archive))throw new Error('Run pnpm package before the packaged editor smoke test.');
const executable=process.env.KELFT_VSCODE_EXECUTABLE;
if(!executable||!fs.existsSync(executable))throw new Error('Set KELFT_VSCODE_EXECUTABLE to an existing VS Code-compatible editor executable. No editor is downloaded automatically.');
const parent=path.join(root,'.vscode-test');fs.mkdirSync(parent,{recursive:true});
const directory=fs.mkdtempSync(path.join(parent,'smoke-')),unpacked=path.join(directory,'vsix'),workspace=path.join(directory,'workspace hé 😀');
fs.mkdirSync(unpacked);fs.mkdirSync(workspace);
const secondWorkspace=path.join(directory,'second project'),workspaceFile=path.join(directory,'review.code-workspace');
fs.mkdirSync(secondWorkspace);fs.writeFileSync(workspaceFile,JSON.stringify({folders:[{path:workspace},{path:secondWorkspace}]}));
await new Promise((resolve,reject)=>yauzl.open(archive,{lazyEntries:true},(error,zip)=>{
  if(error)return reject(error);
  zip.on('error',reject);zip.on('end',resolve);
  zip.on('entry',entry=>{
    const file=path.resolve(unpacked,entry.fileName),relative=path.relative(unpacked,file);
    if(relative.startsWith('..')||path.isAbsolute(relative)||entry.uncompressedSize>16<<20){zip.close();reject(new Error('Unsafe VSIX entry.'));return;}
    if(entry.fileName.endsWith('/')){fs.mkdirSync(file,{recursive:true});zip.readEntry();return;}
    fs.mkdirSync(path.dirname(file),{recursive:true});
    zip.openReadStream(entry,(error,input)=>{if(error){reject(error);return;}const output=fs.createWriteStream(file);input.on('error',reject);output.on('error',reject);output.on('finish',()=>zip.readEntry());input.pipe(output);});
  });zip.readEntry();
}));
const env={...process.env,KELFT_EDITOR_SMOKE_WORKSPACE:workspace,KELFT_EDITOR_SMOKE_SECOND_WORKSPACE:secondWorkspace,KELFT_SMOKE_COMPILER:process.env.KELFT_SMOKE_COMPILER?path.resolve(process.env.KELFT_SMOKE_COMPILER):''};
for(const name of Object.keys(env))if(/^(VSCODE_|ELECTRON_)/i.test(name)||['NODE_OPTIONS','NODE_PATH'].includes(name))delete env[name];
const args=[workspaceFile,'--extensionDevelopmentPath='+path.join(unpacked,'extension'),'--extensionTestsPath='+path.join(root,'tests/editor/index.cjs'),'--user-data-dir',path.join(directory,'user-data'),'--extensions-dir',path.join(directory,'extensions'),'--disable-extensions','--skip-welcome','--skip-release-notes','--disable-updates','--disable-workspace-trust','--disable-gpu','--disable-telemetry','--log','error'];
let port;
if(process.env.KELFT_ICON_REVIEW){
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const fixture=path.join(directory,'icon-theme');fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'kelft-icon-review',publisher:'local-test',version:'0.0.0',engines:{vscode:'*'},contributes:{iconThemes:[{id:'kelft-test-override',label:'Kelft review override fixture',path:'theme.json'}]}}));
  fs.writeFileSync(path.join(fixture,'theme.json'),JSON.stringify({iconDefinitions:{test:{iconPath:'override.svg'}},fileExtensions:{kelft:'test'}}));
  fs.writeFileSync(path.join(fixture,'override.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="#ff9900"/></svg>');
  args.push('--extensionDevelopmentPath='+fixture,'--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1');
}
const controller=new AbortController();
let reviewFailure;
const review=port?reviewIcons(directory,port,controller.signal).catch(error=>{reviewFailure=error;}):Promise.resolve();
try {
await new Promise((resolve,reject)=>{
  const child=spawn(path.resolve(executable),args,{env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  const timer=setTimeout(()=>{child.kill();reject(new Error('Editor smoke exceeded 120 seconds.'));},120000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();code===0?resolve():reject(new Error('Editor smoke exited '+code));});
});
} finally {controller.abort();await review;}
if(reviewFailure)throw reviewFailure;
const report={editor:executable,vsix:archive,vsixSHA256:createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),workspace,nativeCompiler:!!process.env.KELFT_SMOKE_COMPILER,iconReview:!!port,status:'passed'};
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
