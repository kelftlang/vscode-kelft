# Distribution notices

The extension runtime bundles first-party JavaScript under MIT OR Apache-2.0.
VS Code supplies the `vscode` API. No Kelft compiler or native SDK is bundled.
Build and test dependencies in pnpm-lock.yaml retain their own licenses and are
excluded from the VSIX. esbuild builds the JavaScript bundle and is not included
in the extension runtime.

`assets/icon.png`, `assets/kelft-icon-light.svg`, and `assets/kelft-icon-dark.svg`
are approved brand artwork. Their provenance and SHA-256 identities appear in
assets/provenance.json. The software licenses do not grant rights to artwork
or marks; see TRADEMARKS.md.

`assets/intrinsics.json` contains first-party intrinsic signature reference data
under MIT OR Apache-2.0. Snippets use MIT-0.
