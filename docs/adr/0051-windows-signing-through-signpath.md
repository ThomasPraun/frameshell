---
status: accepted
---

# Windows builds signed through SignPath Foundation

SPEC decision 16 ships Windows as an unsigned beta ("signing cost only on macOS at v0.1"), and the roadmap puts "Windows stable + signed" at v1.0. People installing on Windows meet SmartScreen's "Windows protected your PC" window and have to find **More info** → **Run anyway**, which reads as a warning about malware. The owner decided on 2026-11-22: **sign the Windows app and installer now, with the free SignPath Foundation programme for open source projects**, instead of a paid certificate (Azure Trusted Signing is not offered to individuals in the owner's country; a commercial OV certificate costs about US$200-400 a year). Windows stays a beta platform; only its signing changes. This ADR amends decision 16 and the Packaging row of the SPEC.

## Decisions

1. **Who signs.** SignPath.io signs with a certificate issued to SignPath Foundation, which is shown as the publisher. The project keeps the Foundation's conditions (`signpath.org/terms`): OSI licence (Apache 2.0) for all components, no proprietary code, multi-factor authentication for every team member on GitHub and SignPath, a public code signing policy (`CODE_SIGNING_POLICY.md`, linked from the README and frameshell.dev) and a privacy statement (`PRIVACY.md`).
2. **Only CI signs.** Signing requests come from the Release workflow on GitHub-hosted runners, with SignPath's origin verification (the GitHub trusted build system). Nobody signs a local build. Every signing request waits for a maintainer's manual approval on signpath.io.
3. **What is signed.** `Frameshell.exe` and the NSIS installer. The installer is built from the already signed app (`package.mjs --installer`, electron-builder `--prepackaged`), so the installed app is signed too. Two requests per release, two approvals. Electron's and other upstream DLLs stay as their authors shipped them. The NSIS uninstaller, written by electron-builder during the installer build, stays unsigned.
4. **What SignPath checks.** The two artifact configurations live in `.signpath/artifact-configurations/` and are reviewed like code. Each restricts the product name to `Frameshell` and the product version to the app's own `ProductVersion`, read from the built `Frameshell.exe` and passed to both requests, so a file of another build is refused.
5. **No-op until configured.** The workflow signs only when the secret `SIGNPATH_API_TOKEN` and the variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG` and `SIGNPATH_SIGNING_POLICY_SLUG` all exist. None: an unsigned build, as before, with the SmartScreen warning in the job summary. Some: the job fails and names what is missing, like macOS. Pull requests never sign. The token never reaches electron-builder; the build only sees whether it exists.

## Consequences

- SmartScreen can still warn on the first downloads of a signed release until the certificate gathers reputation; it no longer says "Unknown publisher".
- A release waits for two approvals on signpath.io before its Windows job finishes (up to an hour each, then the job fails).
- Windows still gets the update banner, not electron-updater installs: that stays for later, now unblocked by signing.
- If SignPath Foundation declines the project or ends the subscription, removing the settings returns to unsigned builds without a code change.
