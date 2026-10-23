const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vscode=require('vscode');
exports.run=async()=>{
  const extension=vscode.extensions.getExtension('kelftlang.vscode');assert.ok(extension,'Packaged extension is installed in the development host.');
  assert.equal(extension.packageJSON.name,'vscode');assert.equal(extension.packageJSON.publisher,'kelftlang');assert.equal(extension.packageJSON.version,'0.1.0');
  await extension.activate();
  assert.ok((await vscode.languages.getLanguages()).includes('kelft'));
  const commands=await vscode.commands.getCommands();assert.ok(commands.includes('kelft.checkFile'));assert.ok(commands.includes('kelft.buildFile'));
  const workspace=process.env.KELFT_EDITOR_SMOKE_WORKSPACE,uri=vscode.Uri.file(path.join(workspace,'main.kelft'));
  const configuration=vscode.workspace.getConfiguration('kelft',uri);
  await configuration.update('checkOnSave',false,vscode.ConfigurationTarget.Workspace);
  if(process.env.KELFT_SMOKE_COMPILER)await configuration.update('compilerPath',process.env.KELFT_SMOKE_COMPILER,vscode.ConfigurationTarget.Workspace);
  fs.writeFileSync(uri.fsPath,'fn main()->void {println("é😀"); missing();}');
  const document=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(document);
  assert.equal(document.languageId,'kelft');
  // These providers must work on unsaved text without a native compiler.
  async function buffer(text, name='editing.kelft') {
    const target=vscode.Uri.file(path.join(workspace,name));
    if(!fs.existsSync(target.fsPath))fs.writeFileSync(target.fsPath,'');
    const doc=await vscode.workspace.openTextDocument(target);
    const edit=new vscode.WorkspaceEdit();edit.replace(target,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),text);
    await vscode.workspace.applyEdit(edit);await vscode.window.showTextDocument(doc);return doc;
  }
  const code=await buffer('// é😀\nfn main()->void { array_p }');
  assert.equal(code.isDirty,true);
  let completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',code.uri,code.positionAt(code.getText().indexOf('array_p')+7));
  const push=completions.items.find(item=>item.label==='array_push');assert.ok(push);
  assert.match(push.detail,/inout arg0: Array<T0>/);assert.match(push.documentation.value,/static|Static/);
  const hoverDoc=await buffer('fn main()->void { println("text"); }','hover.kelft');
  const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',hoverDoc.uri,hoverDoc.positionAt(hoverDoc.getText().indexOf('println')+2));
  assert.ok(hovers.some(h=>h.contents.some(c=>c.value?.replaceAll('&nbsp;',' ').includes('not a resolved symbol'))));
  const intentDoc=await buffer('app Example {\n beh\n}','intent-editing.kelft');
  completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',intentDoc.uri,intentDoc.positionAt(intentDoc.getText().indexOf('beh')+3));
  assert.ok(completions.items.some(item=>item.label==='behavior'));assert.ok(!completions.items.some(item=>item.label==='println'));
  const target=vscode.Uri.file(path.join(workspace,'lib space.kelft'));fs.writeFileSync(target.fsPath,'pub fn helper()->void {}');
  const imports=await buffer('import "./lib space.kelft" as lib;','imports.kelft');
  completions=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',imports.uri,imports.positionAt('import "./lib'.length));
  assert.ok(completions.items.some(item=>item.label==='lib space.kelft'));
  const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',imports.uri,imports.positionAt('import "./lib'.length));
  assert.ok(definitions.some(item=>(item.uri||item.targetUri).toString()===target.toString()));
  const second=process.env.KELFT_EDITOR_SMOKE_SECOND_WORKSPACE;
  assert.equal(vscode.workspace.workspaceFolders.length,2);
  fs.mkdirSync(path.join(second,'nested'));
  const secondUri=vscode.Uri.file(path.join(second,'nested','entry.kelft'));
  const secondTarget=vscode.Uri.file(path.join(second,'nested','lib.kelft'));
  fs.writeFileSync(secondUri.fsPath,'import "./lib.kelft" as lib;');fs.writeFileSync(secondTarget.fsPath,'pub fn helper()->void {}');
  fs.writeFileSync(path.join(second,'outside.kelft'),'');
  await vscode.workspace.getConfiguration('kelft',secondUri).update('projectRoot','nested',vscode.ConfigurationTarget.WorkspaceFolder);
  const secondDoc=await vscode.workspace.openTextDocument(secondUri);
  const secondDefinitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',secondUri,secondDoc.positionAt(12));
  assert.ok(secondDefinitions.some(item=>(item.uri||item.targetUri).toString()===secondTarget.toString()));
  const outEdit=new vscode.WorkspaceEdit();outEdit.replace(secondUri,new vscode.Range(secondDoc.positionAt(0),secondDoc.positionAt(secondDoc.getText().length)),'import "../outside.kelft" as lib;');
  await vscode.workspace.applyEdit(outEdit);
  assert.deepEqual(await vscode.commands.executeCommand('vscode.executeDefinitionProvider',secondUri,secondDoc.positionAt(14)),[]);
  const suppressed=await buffer('app Example { must describe println(text) }','prose.kelft');
  const noHover=await vscode.commands.executeCommand('vscode.executeHoverProvider',suppressed.uri,suppressed.positionAt(suppressed.getText().indexOf('println')+2));
  assert.ok(!noHover.some(h=>h.contents.some(c=>c.value?.replaceAll('&nbsp;',' ').includes('Static Kelft'))));
  await vscode.window.showTextDocument(document);
  if(process.env.KELFT_SMOKE_COMPILER){
    await vscode.commands.executeCommand('kelft.checkFile');
    const errors=vscode.languages.getDiagnostics(uri);assert.ok(errors.length>0,'Native errors reach the editor diagnostic collection.');
    assert.equal(errors[0].source,'Kelft');assert.ok(errors[0].range.start.character<=document.lineAt(0).text.length);
    const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),'fn main()->void {println("é😀");}');
    await vscode.workspace.applyEdit(edit);await document.save();await vscode.commands.executeCommand('kelft.checkFile');assert.equal(vscode.languages.getDiagnostics(uri).length,0);
    await vscode.commands.executeCommand('kelft.buildFile');
    const output=path.join(workspace,'build','vscode',process.platform==='win32'?'main.exe':'main');assert.ok(fs.statSync(output).size>0,'The native build command creates an artifact.');
  }
  if(process.env.KELFT_ICON_REVIEW){
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('workbench.files.action.showActiveFileInExplorer');
    for(const [name,theme,icons] of [['light','Default Light+','vs-seti'],['dark','Default Dark+','vs-seti'],['override','Default Dark+','kelft-test-override']]){
      await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Workspace);
      await vscode.workspace.getConfiguration('workbench').update('iconTheme',icons,vscode.ConfigurationTarget.Workspace);
      const request=path.join(workspace,'..','review-request.json'),ack=path.join(workspace,'..','review-'+name+'.json');
      fs.writeFileSync(request,JSON.stringify({name,theme,icons}));
      const deadline=Date.now()+20000;
      while(!fs.existsSync(ack)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok(fs.existsSync(ack),'Icon review completed: '+name);
      const report=JSON.parse(fs.readFileSync(ack,'utf8'));assert.equal(report.status,'passed',JSON.stringify(report));
    }
  }
  console.log('Kelft packaged editor smoke passed; generated programs were not executed.');
};
