# Kelft for VS Code

Language support for [Kelft](https://www.kelft.com) in VS Code, VSCodium, and
compatible editors. Open a `.kelft` file to get Core and Intent highlighting,
file icons, editing assistance, and native compiler integration.

## Installation

Use **Extensions: Install from VSIX...** and select `vscode-kelft-0.1.3.vsix`, then
reload the editor if prompted. You can also install from the command line:

```sh
code --install-extension vscode-kelft-0.1.3.vsix
```

In VSCodium, use `codium` in place of `code`.

The extension ID is `kelftlang.vscode-kelft`. If you previously installed
`kelftlang.vscode` from a VSIX, uninstall that extension and install this renamed
one to avoid duplicate providers. Existing `kelft.*` settings and commands keep
their names; the old installation will not automatically update to the new ID.

## Features

- **Syntax and editing:** Core and Intent highlighting, comment shortcuts,
  bracket matching and closing, indentation, folding, and snippets.
- **Static completion:** type `pri` in Core code and press Ctrl+Space for
  `print`/`println`, or type `beh` inside an Intent app for `behavior`.
- **Built-in reference hover:** hover over `array_push` to see its signature,
  explicit `inout` mode, description, and declared effects. Generic names `T0`/`T1`
  and parameter names `arg0`/`arg1` are reference placeholders.
- **Import assistance:** start an import with `import "./` to complete directories
  and `.kelft` files. Ctrl/Cmd-click a complete import path, or use Go to Definition,
  to open the imported file.
- **Native checks and builds:** see compiler diagnostics in the editor and
  Problems panel, and build saved Core files from the Command Palette.

Text assistance works on unsaved buffers without a compiler. Comments, strings,
and Intent prose suppress unrelated suggestions; explicit parenthesized formal
clauses use Core suggestions. Completion and hover provide static language
reference information. They do not infer local variables, resolve shadowed
symbols, or provide member completion.

### File icons

Kelft icons appear in Explorer and editor tabs on light and dark themes. Enable
a file-icon theme such as built-in **Seti** through **Preferences: File Icon
Theme**. Your selected theme can override or disable language icons; the
extension preserves that choice.

## Native compiler setup

Install a native Kelft compiler supporting `capabilities --json`, `check`, and
`build`. Put its executable on `PATH`, or set `kelft.compilerPath` to its full
path. The extension does not bundle or automatically download the compiler.
For remote workspaces, install it on the workspace host.

Compiler commands require a trusted workspace and saved, file-backed source.
Manual commands prompt before saving modified files. Syntax and static text
assistance also work in restricted and virtual workspaces. Import assistance
requires an existing file in a file-backed workspace; its source and targets must
remain inside the configured project root, including when resolving symlinks.

## Commands and settings

| Command | Behavior |
| --- | --- |
| **Kelft: Check File** | Check a saved Core or Intent file and show diagnostics. |
| **Kelft: Build File** | Build saved Core source for the native host without running it. |

Automatic checks run when saved files are opened or saved. Build outputs go under
`build/vscode`, preserving source subdirectories, with `.exe` on Windows.

| Setting | Default | Purpose |
| --- | --- | --- |
| `kelft.compilerPath` | `kelft` | Native executable path or command on `PATH`; shell arguments are not accepted. |
| `kelft.projectRoot` | Containing workspace folder | Absolute or workspace-relative project root, configurable per folder. |
| `kelft.checkOnSave` | `true` | Check saved files on opening and saving. |
| `kelft.checkTimeoutMs` | `60000` | Check timeout in milliseconds; range 1000 to 600000. |
| `kelft.buildOutputDirectory` | `build/vscode` | Build destination relative to the project root. |

The **Kelft** output channel records compiler invocations and errors. A **checked**
status indicates source validation; it does not prove Intent requirements.
Blocked Intent decisions appear as **needs human**.

## Troubleshooting and limitations

- **Compiler unavailable:** check `kelft.compilerPath` and the compiler's required
  command support. Inspect the Kelft output channel for details.
- **Import not offered or opened:** use a relative forward-slash path, confirm the
  target exists, and check that source and target are inside `kelft.projectRoot`.
- **Operation taking too long:** cancel it from the progress notification or
  adjust the check timeout. Superseded checks cannot publish stale diagnostics.
- Text assistance supports documents up to 2 MiB. Import completion examines one
  directory at a time and returns up to 256 suggestions.

Version 0.1.3 provides static completion and import navigation. General semantic
completion, symbol navigation, references, rename, formatting, and debugging are
not included. Building a program does not run it or generate an Intent implementation.

## Contributing and licenses

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for
reporting, development, testing, and contribution requirements.

Software, grammar, and documentation use **MIT OR Apache-2.0**, at your option.
Snippets and copyable examples use **MIT-0**. Brand artwork follows
[TRADEMARKS.md](TRADEMARKS.md) and asset provenance. See the
[licensing guide](docs/licensing.md) and [distribution notices](THIRD-PARTY-NOTICES.md).

Public specification: [www.kelft.com](https://www.kelft.com).
