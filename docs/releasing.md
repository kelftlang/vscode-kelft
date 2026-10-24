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
   section to `CHANGELOG.md`. The renamed extension starts at `0.1.3`. Run `pnpm test` and
   `pnpm package`, then review and merge through GitHub.
2. Open **Actions → Prepare release → Run workflow** and select **main**. The
   workflow definition must already be on the default branch for manual dispatch.
3. Wait for the run to succeed. Its single Ubuntu job has an eight-minute limit.
   It tests the extension, packages the scoped manifest as `kelftlang.vscode-kelft`,
   inspects its identity and contents, attests the VSIX and checksum, and verifies
   that provenance against the exact source commit and hosted workflow.
4. Follow the draft link in the Actions summary. Review its changelog notes,
   source commit, build and attestation links, checksum and three attached assets:
   `vscode-kelft-0.1.3.vsix`, `vscode-kelft-0.1.3.vsix.sha256`, and
   `vscode-kelft-0.1.3.vsix.sigstore.json`. Asset metadata and downloaded bytes have been
   checked before the workflow marks the draft ready.
5. Confirm release immutability is enabled and click **Publish release**. GitHub
   locks the tag and assets and creates the release attestation. Check that the
   release displays **Immutable**.

The version determines the tag (`v0.1.3`) and title (**Kelft for VS Code v0.1.3**).
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

Every draft update explicitly retains its intended tag and unpublished status;
the workflow validates both the update response and a fresh readback. It does not
accept an `untagged-…` tag association. The review URL itself can contain an
`untagged-…` slug; use the actual draft link returned by GitHub.

If lookup by tag returns 404, the workflow searches authenticated release
listings for the exact tag name, up to ten pages of 100 releases. A duplicate
match, incomplete search or permission failure stops preparation. A matching
title is insufficient to select a draft. Older incomplete drafts are not adopted
or repaired automatically.

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
gh attestation verify vscode-kelft-0.1.3.vsix --repo kelftlang/vscode-kelft --signer-workflow kelftlang/vscode-kelft/.github/workflows/release.yml --source-digest SOURCE_COMMIT
gh release verify v0.1.3 --repo kelftlang/vscode-kelft
gh release verify-asset v0.1.3 vscode-kelft-0.1.3.vsix --repo kelftlang/vscode-kelft
```

Replace `SOURCE_COMMIT` with the release's full commit SHA. To use the attached
provenance bundle, add `--bundle vscode-kelft-0.1.3.vsix.sigstore.json` to the first
command. The release verification commands apply after immutable publication.
The checksum receipt provides a separate SHA-256 comparison; on PowerShell use
`Get-FileHash ./vscode-kelft-0.1.3.vsix -Algorithm SHA256`.

## Marketplace listings

Maintain publisher ownership of `kelftlang` in Visual Studio Marketplace and the
matching namespace in Open VSX. Complete each service's account and publisher
requirements before the first submission, including the Eclipse Publisher
Agreement and namespace publishing access for Open VSX. The extension name is
`vscode-kelft`, display name **Kelft for VS Code**, and installed ID
`kelftlang.vscode-kelft`. The former `vscode` name was rejected as already taken;
local packaging cannot reserve a name or establish registry acceptance.

### Configure publishing credentials

In `kelftlang/vscode-kelft`, configure **Settings → Secrets and variables →
Actions → Repository secrets**:

- `VSCE_PAT`: an Azure DevOps Marketplace publishing token for an account with
  publishing access to `kelftlang`. Grant the required **Marketplace: Manage**
  scope and follow Microsoft's current token organization requirements.
- `OVSX_PAT`: an Open VSX access token for an account authorized to publish in
  the `kelftlang` namespace.

Use dedicated tokens, set expirations where supported, rotate before expiry, and
revoke old tokens after replacing the secrets. Never store tokens in source,
workflow inputs, shell arguments, or release assets. Global Azure DevOps PATs
are scheduled for retirement on December 1, 2026; follow Microsoft's current
[authentication guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
when creating or rotating credentials. This initial workflow uses token secrets;
federated publishing is not configured.

### Manually submit a published release

1. Run **Prepare release** from `main`, review the completed draft, and publish
   it with release immutability enabled using the process above.
2. Open **Actions → Publish marketplaces → Run workflow**, select `main`, enter
   the exact release tag (initially `v0.1.3`), and select `both`,
   `visual-studio-marketplace`, or `open-vsx`.
3. The workflow checks all selected credentials are configured, resolves the
   release tag to its exact commit, and reads that commit's source manifest.
   It accepts published immutable releases with numeric `major.minor.patch`
   versions only; drafts, mutable releases and prerelease channels are rejected.
4. A single eight-minute Ubuntu job downloads the VSIX, SHA-256 receipt and
   provenance bundle. It inspects both embedded identities and package contents,
   verifies downloaded bytes, GitHub release integrity, and the hosted build
   attestation for the exact release commit. It never rebuilds the extension.
5. The workflow uploads the **same verified release VSIX** to the selected
   registries, Visual Studio Marketplace first when both are selected. Each
   upload step receives only its own registry token; preflight sees availability
   flags rather than token values. GitHub permissions remain read-only.
6. Review the Actions summary and each registry's validation status. A successful
   submission does not guarantee approval or immediate listing availability.

Runs serialize without cancellation. If the first registry fails, the second is
not attempted. If one submission succeeds and the other fails, correct the cause
and run the workflow again with **only the remaining destination** and the same
release tag. The workflow does not suppress duplicate-version errors, overwrite
registry versions, move tags, or change GitHub releases. A changed package needs
a new version and a new reviewed immutable release.

**Prepare release** remains separate and holds no marketplace credentials.
Neither PR validation nor publishing a GitHub release automatically triggers
marketplace submission. The publishing workflow must be on `main` before its
manual trigger is available. Existing installs of `kelftlang.vscode` must install
the renamed extension explicitly; see the README migration note.

### Manual upload alternative

Download the three assets from the published immutable release and verify them
using the commands above. Publish the **same release VSIX** to both registries,
preserving extension ID, version and bytes. Provide credentials through the
`VSCE_PAT` and `OVSX_PAT` environment variables:

```sh
pnpm exec vsce publish --packagePath vscode-kelft-0.1.3.vsix
pnpm exec ovsx publish vscode-kelft-0.1.3.vsix --registryUrl https://open-vsx.org
```

Do not publish directly from the scoped source manifest or rebuild the package
between submissions. Manual web uploads are also possible using that same VSIX.

See [Visual Studio Marketplace publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [Open VSX publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Publishing-Extensions).
