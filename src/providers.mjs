import * as vscode from 'vscode';
import path from 'node:path';
import {contextAt, staticSuggestions, intrinsicReference, importSuggestions, importDefinition} from './editing.mjs';

function rootFor(document) {
  if (document.uri.scheme !== 'file') return null;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder || folder.uri.scheme !== 'file') return null;
  const configured = vscode.workspace.getConfiguration('kelft', document.uri).get('projectRoot', '');
  if (typeof configured !== 'string') return null;
  return path.resolve(folder.uri.fsPath, configured || '.');
}

function markdown(row) {
  const result = new vscode.MarkdownString();
  result.appendCodeblock(row.signature, 'kelft');
  result.appendText('\n\n' + row.documentation);
  return result;
}

export function registerEditing(context) {
  const selector = {language: 'kelft'};
  const range = (document, start, end) => new vscode.Range(document.positionAt(start), document.positionAt(end));
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, {
      async provideCompletionItems(document, position, token) {
        const version = document.version, offset = document.offsetAt(position);
        const state = contextAt(document.getText(), offset, token);
        let rows;
        if (state?.mode === 'import') {
          const root = rootFor(document);
          if (!root) return [];
          rows = await importSuggestions(state, offset, document.uri.fsPath, root, token);
        } else rows = staticSuggestions(state);
        if (token.isCancellationRequested || version !== document.version || document.isClosed) return [];
        const kinds = {keyword: vscode.CompletionItemKind.Keyword, type: vscode.CompletionItemKind.Class, function: vscode.CompletionItemKind.Function, folder: vscode.CompletionItemKind.Folder, file: vscode.CompletionItemKind.File};
        const items = rows.map(row => {
          const item = new vscode.CompletionItem(row.label, kinds[row.kind]);
          item.range = range(document, row.start ?? state.start, row.end ?? state.end);
          item.insertText = row.insertText ?? row.label;
          item.detail = row.detail ?? 'Relative Kelft import';
          if (row.kind === 'function') item.documentation = markdown({signature: row.detail, documentation: row.documentation});
          if (row.kind === 'folder') item.command = {command: 'editor.action.triggerSuggest', title: 'Continue import path'};
          return item;
        });
        return new vscode.CompletionList(items, state?.mode === 'import');
      }
    }, '/', '.', ':'),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position, token) {
        const state = contextAt(document.getText(), document.offsetAt(position), token);
        if (state?.mode !== 'core' || state.qualified || !state.word || token.isCancellationRequested) return null;
        const row = intrinsicReference(state.word);
        return row ? new vscode.Hover([markdown(row)], range(document, state.start, state.end)) : null;
      }
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const version = document.version, root = rootFor(document);
        if (!root) return null;
        const state = contextAt(document.getText(), document.offsetAt(position), token);
        const target = await importDefinition(state, document.uri.fsPath, root, token);
        if (!target || token.isCancellationRequested || version !== document.version || document.isClosed) return null;
        return new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0));
      }
    })
  );
}
