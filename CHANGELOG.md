# Changelog

## 0.1.3

- Rename the extension to `vscode-kelft` (ID `kelftlang.vscode-kelft`) so its
  Marketplace name no longer collides with `vscode`.
- Add manually triggered publishing of verified immutable GitHub release artifacts
  to Visual Studio Marketplace and Open VSX, with separate destination retries.
- Users of `kelftlang.vscode` must install the renamed extension; the new identity
  does not automatically replace the previous installation. Settings and commands
  retain their existing `kelft.*` names.

## 0.1.2

Initial release of Kelft for VS Code and compatible editors.

- Kelft Core and Intent syntax highlighting, snippets, comments, brackets,
  indentation, and folding.
- Dedicated light and dark Kelft file icons in Explorer and editor tabs.
- Static keyword, type, and built-in function completion.
- Built-in reference hover with signatures, generic parameters, parameter modes,
  and declared effects.
- Relative import completion and navigation to imported files.
- Native compiler diagnostics on opening and saving files, plus explicit check
  and build commands.
- Workspace Trust, multiple-folder project configuration, cancellation, and
  protection against stale diagnostics and import paths outside the project root.
