# Releasing Kelft for VS Code

The **Prepare release** GitHub Actions workflow builds the extension and attaches
its VSIX, SHA-256 receipt and signed provenance bundle to a draft release. A
maintainer reviews the completed draft and clicks **Publish release**. There is
no manual download, extraction or re-upload step in preparing that draft.

## Before the first release

- Enable **Settings → General → Releases → Enable release immutability** in
  `kelftlang/vscode-kelft`. Enable it before publishing the first draft.
- Build attestations require a public repository on GitHub Free, Pro or Team, or
  an eligible private/internal repository on GitHub Enterprise Cloud. Preparation
  fails if attestation support or the required token permissions are unavailable.
- Review and merge the release changes into `main` through GitHub's web interface.
  Use a GitHub-signed merge or squash commit. Rebase merging does not automatically
  create GitHub-signed commits. The workflow checks the exact triggering commit's
  API verification result and verifies its signature against GitHub's `web-flow`
  signing keys. An unsigned or differently signed commit stops preparation.

See [signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification),
[attestation availability](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations),
and [enabling release immutability](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).

## Prepare and approve a release

1. Set the intended version in `package.json` and add the matching `## VERSION`
   section to `CHANGELOG.md`. The first release uses `0.1.1`. Run `pnpm test` and
   `pnpm package`, then review and merge through GitHub.
2. Open **Actions → Prepare release → Run workflow** and select **main**. The
   workflow definition must already be on the default branch for manual dispatch.
3. Wait for the run to succeed. Its single Ubuntu job has an eight-minute limit.
   It tests the extension, packages the scoped manifest as `kelftlang.vscode`,
   inspects its identity and contents, attests the VSIX and checksum, and verifies
   that provenance against the exact source commit and hosted workflow.
4. Follow the draft link in the Actions summary. Review its changelog notes,
   source commit, build and attestation links, checksum and three attached assets:
   `vscode-0.1.1.vsix`, `vscode-0.1.1.vsix.sha256`, and
   `vscode-0.1.1.vsix.sigstore.json`. Asset metadata and downloaded bytes have been
   checked before the workflow marks the draft ready.
5. Confirm release immutability is enabled and click **Publish release**. GitHub
   locks the tag and assets and creates the release attestation. Check that the
   release displays **Immutable**.

The version determines the tag (`v0.1.1`) and title (**Kelft for VS Code v0.1.1**).
The tag points to the triggering commit and is not separately signed. GitHub's
**Verified** Git badge describes the source commit. The VSIX has a cryptographically
signed build attestation linking its bytes to the repository, commit and workflow;
this is separate from an embedded VSIX package signature or marketplace signing.
GitHub's release attestation is generated after immutable publication.

Preparation runs are serialized. A rerun can refresh a draft only when the tag
and draft identify the same source commit. Existing conflicting tags, published
releases and unexpected draft assets stop preparation. Tags are never moved. If
preparation fails, inspect the failed step before rerunning the same commit; a
partially prepared draft is not ready to publish. For changed source, use a new
version when the previous version already has a tag. Do not publish a draft while
its preparation run is still active.

The tag's resolved commit establishes a draft's source identity. GitHub's
`target_commitish` metadata may contain a branch name and is unused when the tag
already exists. A draft whose tag is missing or resolves to a different commit
cannot be refreshed. See [the release API contract](https://docs.github.com/en/rest/releases/releases#create-a-release).

After changing release code or package contents, merge the changes and start a
new **Prepare release** run from main with a new version if the previous tag
exists. Rerunning an old failed job uses its original workflow and source commit;
it does not pick up a repair merged afterward.

The PR workflow retains read-only permissions and does not create releases.
**Prepare release** never publishes a release or sends a package to a marketplace.

## Verify a downloaded release

The release notes include the exact source commit and checksum. With a current
[GitHub CLI](https://cli.github.com/manual/gh_attestation_verify), run:

```sh
gh attestation verify vscode-0.1.1.vsix --repo kelftlang/vscode-kelft --signer-workflow kelftlang/vscode-kelft/.github/workflows/release.yml --source-digest SOURCE_COMMIT
gh release verify v0.1.1 --repo kelftlang/vscode-kelft
gh release verify-asset v0.1.1 vscode-0.1.1.vsix --repo kelftlang/vscode-kelft
```

Replace `SOURCE_COMMIT` with the release's full commit SHA. To use the attached
provenance bundle, add `--bundle vscode-0.1.1.vsix.sigstore.json` to the first
command. The release verification commands apply after immutable publication.
The checksum receipt provides a separate SHA-256 comparison; on PowerShell use
`Get-FileHash ./vscode-0.1.1.vsix -Algorithm SHA256`.

## Marketplace listings

Maintain publisher ownership of `kelftlang` in Visual Studio Marketplace and the
matching namespace in Open VSX. Complete each service's account and publisher
requirements before the first submission. Publish the **same release VSIX** to
both registries, preserving extension ID `kelftlang.vscode`, version and bytes:

```sh
pnpm exec vsce publish --packagePath vscode-0.1.1.vsix
```

For Open VSX, use its web upload or `ovsx publish vscode-0.1.1.vsix` with an
authenticated Open VSX CLI. Keep marketplace credentials out of the repository.
Do not publish directly from the scoped source manifest or rebuild the package
between submissions. This workflow does not hold marketplace credentials.

See [Visual Studio Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [Open VSX publishing](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions).
