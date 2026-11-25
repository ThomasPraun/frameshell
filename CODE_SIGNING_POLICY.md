# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

This applies to the Windows app (`Frameshell.exe`) and its installer (`Frameshell-<version>-win-x64.exe`) on the [GitHub releases](https://github.com/ThomasPraun/frameshell/releases). The macOS app is signed and notarized with the project's own Apple Developer ID. Linux packages are not code-signed.

## How a release is signed

- Only the [Release workflow](.github/workflows/release.yml) signs, on GitHub-hosted runners, from a version tag of this repository. SignPath verifies that each file was built by that workflow from this repository's source (origin verification). No build from a personal computer is signed.
- Every signing request is approved by hand by an approver below.
- What SignPath may sign is fixed in [`.signpath/artifact-configurations/`](.signpath/artifact-configurations/), reviewed like any other code.
- Every binary signed is built from the source in this repository. Third-party components (Electron and its libraries) are shipped as their authors published them.

## Team roles

| Role | Members |
|---|---|
| Committers and reviewers | [Thomas Praun](https://github.com/ThomasPraun) (owner) |
| Approvers | [Thomas Praun](https://github.com/ThomasPraun) |

Changes from anyone else, including AI coding agents working for a committer, reach `main` only through a pull request reviewed and merged by a committer. All team members use multi-factor authentication on GitHub and SignPath.

## Privacy

See the [privacy policy](PRIVACY.md): Frameshell sends nothing to other systems unless you ask it to, except a check for new versions that you can turn off.

## Report a problem

If you think a file signed under this policy was not built from this repository, or behaves maliciously, open an [issue](https://github.com/ThomasPraun/frameshell/issues) or write to SignPath Foundation at [signpath.org](https://signpath.org).
