import * as vscode from 'vscode';
import path from 'node:path';
import fs from 'node:fs/promises';
import {registerEditing} from './providers.mjs';
import {inside, projectPaths, prepareBuildDirectory, invocation, runCompiler, decodeCapabilities, decodeResult, bytePosition, diagnosticFile, isIntent} from './compiler.mjs';

export function activate(context) {
  registerEditing(context);
  const collection = vscode.languages.createDiagnosticCollection('kelft');
  const output = vscode.window.createOutputChannel('Kelft');
  const pending = new Map(), published = new Map(), probes = new Map();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  context.subscriptions.push(collection, output, status, {dispose() { for (const p of pending.values()) p.controller.abort(); }});
  function refresh() {
    collection.clear();
    const merged = new Map();
    for (const records of published.values()) for (const [uri, diagnostics] of records) {
      const key = uri.toString(); const row = merged.get(key) || [uri, []]; row[1].push(...diagnostics); merged.set(key, row);
    }
    for (const [uri, diagnostics] of merged.values()) collection.set(uri, diagnostics);
  }
  function clear(entry) { published.delete(entry); refresh(); }
  async function operate(document, command, automatic = false) {
    if (!document || document.languageId !== 'kelft' || document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    pending.get(key)?.controller.abort();
    if (!vscode.workspace.isTrusted) {
      clear(key);
      if (!automatic) vscode.window.showInformationMessage('Trust this workspace to run the native Kelft compiler.');
      return;
    }
    if (document.isDirty) {
      if (automatic) return;
      const save = await vscode.window.showInformationMessage('Save this file before invoking native Kelft?', 'Save');
      if (save !== 'Save' || !await document.save()) return;
    }
    pending.get(key)?.controller.abort();
    const controller = new AbortController(), version = document.version;
    const operation = {controller, version}; pending.set(key, operation);
    const current = () => pending.get(key) === operation && document.version === version && !document.isDirty && !document.isClosed && !controller.signal.aborted;
    try {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
      const config = vscode.workspace.getConfiguration('kelft', document.uri);
      const {root, output: destination} = projectPaths(document.uri.fsPath, folder, config.get('projectRoot', ''), config.get('buildOutputDirectory', 'build/vscode'));
      const canonicalRoot = await fs.realpath(root), canonicalFile = await fs.realpath(document.uri.fsPath);
      if (!inside(canonicalRoot, canonicalFile)) throw new Error('The source resolves outside the project root.');
      const executable = config.get('compilerPath', 'kelft');
      if (typeof executable !== 'string' || !executable.trim()) throw new Error('Set kelft.compilerPath to a native executable.');
      const probeKey = executable + '\0' + root;
      if (!probes.has(probeKey)) probes.set(probeKey, runCompiler(executable, ['capabilities', '--json'], {cwd: root, timeout: 10000}).then(decodeCapabilities).catch(error => {probes.delete(probeKey); throw error;}));
      await probes.get(probeKey);
      if (!current()) return;
      if (command === 'build') {
        if (isIntent(document.getText())) throw new Error('Build File accepts Core source. Intent generation and acceptance use the reviewed authoring workflow.');
        await prepareBuildDirectory(root,destination);
      }
      const args = invocation(command, document.uri.fsPath, root, destination);
      output.appendLine(JSON.stringify({executable, args, cwd: root}));
      const run = async progressToken => {
        const cancellation = progressToken?.onCancellationRequested(() => controller.abort());
        try { return await runCompiler(executable, args, {cwd: root, timeout: command === 'check' ? config.get('checkTimeoutMs', 60000) : 600000, signal: controller.signal}); }
        finally { cancellation?.dispose(); }
      };
      const result = automatic ? await run() : await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: `Kelft: ${command}`, cancellable: true}, (_, token) => run(token));
      const decoded = decodeResult(result, command);
      if (!current()) return;
      const grouped = new Map();
      for (const item of decoded.diagnostics) {
        const file = item.span?.file ? diagnosticFile(item.span.file, root) : document.uri.fsPath;
        const uri = vscode.Uri.file(file), target = vscode.workspace.textDocuments.find(d=>d.uri.toString()===uri.toString());
        if (target?.isDirty) continue;
        const text = target ? target.getText() : await fs.readFile(file,'utf8');
        const start = bytePosition(text, item.span?.start || 0), end = bytePosition(text, item.span?.end || 0);
        const diagnostic = new vscode.Diagnostic(new vscode.Range(start.line, start.character, end.line, end.character), item.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'Kelft'; diagnostic.code = item.code;
        const bucket = grouped.get(uri.toString()) || [uri, []]; bucket[1].push(diagnostic); grouped.set(uri.toString(), bucket);
      }
      if (!current()) return;
      published.set(key, [...grouped.values()]); refresh();
      status.text = decoded.needsHuman ? 'Kelft: needs human' : decoded.success ? (command === 'build' ? 'Kelft: built' : 'Kelft: checked') : 'Kelft: errors';
      status.tooltip = decoded.needsHuman ? 'Intent contains blocked decisions; checking is not verification.' : 'Native compiler result; checking declarations does not prove their requirements.';
      status.show();
      output.appendLine(JSON.stringify(decoded.value));
      if (!automatic && command === 'build' && decoded.success) vscode.window.showInformationMessage(`Kelft built ${destination}`);
    } catch (error) {
      if (!current()) return;
      clear(key); status.text = 'Kelft: unavailable'; status.tooltip = error.message; status.show();
      output.appendLine(error.message);
      if (!automatic) vscode.window.showErrorMessage(error.message);
    } finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  const auto = document => {
    if (vscode.workspace.getConfiguration('kelft', document.uri).get('checkOnSave', true)) void operate(document, 'check', true);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('kelft.checkFile', () => operate(vscode.window.activeTextEditor?.document, 'check')),
    vscode.commands.registerCommand('kelft.buildFile', () => operate(vscode.window.activeTextEditor?.document, 'build')),
    vscode.workspace.onDidOpenTextDocument(auto), vscode.workspace.onDidSaveTextDocument(auto),
    vscode.workspace.onDidChangeTextDocument(event => { if(event.document.languageId==='kelft'){for(const p of pending.values())p.controller.abort();published.clear();collection.clear();} }),
    vscode.workspace.onDidCloseTextDocument(document => {const key = document.uri.toString(); pending.get(key)?.controller.abort(); pending.delete(key); clear(key);}),
    vscode.workspace.onDidChangeConfiguration(event => {if (event.affectsConfiguration('kelft')) {probes.clear(); for (const p of pending.values()) p.controller.abort(); published.clear(); collection.clear();}}),
    vscode.workspace.onDidGrantWorkspaceTrust(() => vscode.workspace.textDocuments.forEach(auto))
  );
  vscode.workspace.textDocuments.forEach(auto);
}

export function deactivate() {}
