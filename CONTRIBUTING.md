# Contributing

Issues and pull requests are welcome.

## Reporting issues and requesting features

Search existing issues before opening a new one. For a bug, include your editor
and extension versions, operating system, steps to reproduce, expected behavior,
and actual behavior. Include a small `.kelft` example when possible. For compiler
checks or builds, include the native compiler version and relevant Kelft output.
Remove credentials and private data from logs and examples.

For a feature request, describe the workflow it would improve and an example of
the desired behavior. Discuss substantial changes in an issue before starting a
large implementation.

## Development and pull requests

Use Node 24 and pnpm 11.19.0:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm package
```

Keep changes focused, explain their purpose, and describe the validation you ran.
Add relevant regression coverage for behavior changes and screenshots for visual
changes. Preserve third-party notices and follow existing code conventions.

`pnpm package` creates `vscode-0.1.2.vsix` and a SHA-256 receipt. The source package
is named `@kelftlang/vscode`; packaging uses a temporary manifest with the unscoped
name `vscode`, producing extension ID `kelftlang.vscode` without changing the
source manifest.

To test the packaged extension in an isolated editor profile, set
`KELFT_VSCODE_EXECUTABLE` to an existing VS Code or VSCodium executable and run
`pnpm test:editor`. Set `KELFT_SMOKE_COMPILER` to an installed native Kelft compiler
to include check/build tests. `KELFT_ICON_REVIEW=1` adds light/dark and overriding
icon-theme screenshots. These tests leave your normal editor profile unchanged.

Maintainers preparing a release should follow [the release guide](docs/releasing.md)
for the manual GitHub Actions trigger, signed source requirement, draft review
and marketplace submissions.

## Contribution terms

Software, grammar, and documentation contributions use **MIT OR Apache-2.0**.
Snippets and copyable examples use **MIT-0**. Preserve separately identified
third-party and brand terms. See [the licensing guide](docs/licensing.md).

Sign off each commit under [Developer Certificate of Origin 1.1](DCO):

```sh
git commit -s
```

Contributors retain ownership of their work. No copyright assignment or CLA is
required.
