# Releasing Frameshell

The desktop app ships as a macOS DMG (arm64 and x64), a Linux AppImage and `.deb` (x64), and an unsigned Windows beta installer (NSIS, x64) (SPEC §4, decision 16). `.github/workflows/release.yml` builds them with electron-builder (`apps/desktop/electron-builder.yml`) through `apps/desktop/scripts/release/package.mjs`.

## What the pipeline does

| Trigger | Builds and smoke-tests | Signs macOS | Publishes |
|---|---|---|---|
| Push of a tag `v<major>.<minor>.<patch>[-pre]` | yes | if the secrets exist | a **draft** GitHub release with the installers and `SHA256SUMS.txt` |
| Actions → Release → Run workflow (`workflow_dispatch`) | yes | if the secrets exist | nothing: installers are workflow artifacts (14 days) |
| Pull request that touches packaging files | yes | never (no secrets on PRs) | nothing |

Each OS job:

1. `pnpm build`, then `package.mjs`. It stamps the version from the tag into the app (`0.0.0-ci.<run>` for untagged runs), picks the signing mode, writes a line about it to the job summary, and calls electron-builder with `--publish never`. electron-builder never publishes on its own.
2. Runs the Playwright smoke suite (`apps/desktop/e2e`) against the **packaged** app (`FRAMESHELL_E2E_APP`). The suite runs `frameshell status` in the integrated terminal, so it fails if the bundled CLI or daemon is broken.
3. On macOS, when notarized: `stapler validate` and `spctl --assess` on each app.

The draft release is published by hand after review. A tag with a `-` (for example `v0.1.0-beta.1`) is marked as a prerelease.

### Bundled CLI and daemon

`@frameshell/cli` and `@frameshell/core` are dependencies of the app, so they ship inside `app.asar`. At startup the app writes a `frameshell` shim into `<userData>/bin` that runs the CLI with the app's own executable in Node mode (`ELECTRON_RUN_AS_NODE`). Integrated terminals put that directory first on `PATH`. The daemon is started the same way. The app does not install `frameshell` system-wide.

Keep Electron's `RunAsNode` fuse enabled. Turning it off breaks the CLI in the terminal and daemon auto-start.

## macOS signing secrets

If none of these secrets exist, the macOS job builds **unsigned** DMGs and puts a warning in the job summary. Gatekeeper then blocks the app on first launch. If only some of them exist, the job **fails** and names the missing secrets. It never falls back to an unsigned build silently.

Add them under **Settings → Secrets and variables → Actions → New repository secret**, or with `gh secret set <NAME>`. The names must match exactly.

| Secret | Required | Value |
|---|---|---|
| `MACOS_CERTIFICATE_P12_BASE64` | always, to sign | Developer ID Application certificate and private key, exported as `.p12`, base64-encoded |
| `MACOS_CERTIFICATE_PASSWORD` | always, to sign | Password chosen when exporting the `.p12` |
| `APPLE_API_KEY_P8_BASE64` | option A (recommended) | App Store Connect API key file `AuthKey_<KEYID>.p8`, base64-encoded |
| `APPLE_API_KEY_ID` | option A | Key ID of that API key (10 characters) |
| `APPLE_API_ISSUER` | option A | Issuer ID (UUID) shown above the API keys list |
| `APPLE_ID` | option B | Apple Account email of a member of the developer team |
| `APPLE_APP_SPECIFIC_PASSWORD` | option B | App-specific password for that Apple Account |
| `APPLE_TEAM_ID` | option B | 10-character Team ID |

Set the certificate and **one** notarization option. Option A (API key) is recommended because it is not tied to a person's Apple Account or its 2FA. If both options are set, the job uses option A.

### Create the Developer ID certificate

Only the Account Holder of the Apple Developer team can create a Developer ID certificate.

1. On a Mac: **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**. Enter your email, choose "Saved to disk", and save the `.certSigningRequest`.
2. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/add), choose **Developer ID Application**, upload the request, and download the `.cer`.
3. Double-click the `.cer` to add it to the login keychain. It must appear together with its private key under **My Certificates**.
4. In Keychain Access, right-click **Developer ID Application: <name> (<TEAMID>)** → **Export** → `.p12`, and set a strong password.
5. Store both secrets:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MACOS_CERTIFICATE_P12_BASE64 -R ThomasPraun/frameshell
   gh secret set MACOS_CERTIFICATE_PASSWORD -R ThomasPraun/frameshell   # paste the export password
   ```

6. Delete the exported `.p12` from disk.

### Option A: App Store Connect API key

1. In [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api), open **Team Keys** and generate a key with the **Developer** role.
2. Download `AuthKey_<KEYID>.p8`. Apple lets you download it only once.
3. Note the **Key ID** (in the key's row) and the **Issuer ID** (above the table).
4. Store the three secrets:

   ```sh
   base64 -i AuthKey_ABC123DEFG.p8 | gh secret set APPLE_API_KEY_P8_BASE64 -R ThomasPraun/frameshell
   gh secret set APPLE_API_KEY_ID -R ThomasPraun/frameshell --body ABC123DEFG
   gh secret set APPLE_API_ISSUER -R ThomasPraun/frameshell --body 00000000-0000-0000-0000-000000000000
   ```

### Option B: Apple ID and app-specific password

1. At [account.apple.com](https://account.apple.com) → **Sign-In and Security → App-Specific Passwords**, generate a password named for example `frameshell-notarize`.
2. Find the Team ID at [developer.apple.com/account](https://developer.apple.com/account) → **Membership details**.
3. Store `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` with `gh secret set`.

### Check the secrets without releasing

After the workflow is on `main`, run **Actions → Release → Run workflow**. The macOS job summary should say "Signed with the Developer ID certificate and notarized", and the "Check notarization" step should pass. Nothing is published.

Linux and Windows need no secrets. Windows builds stay unsigned at v0.1: SmartScreen warns on first run.

## Cut a release

1. On `main`, move the `[Unreleased]` entries in `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD` and merge that change.
2. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.1.0 -m "Frameshell 0.1.0"
   git push origin v0.1.0
   ```

3. Wait for the **Release** workflow. Read each job summary: the macOS job must say *notarized*. If it says *unsigned*, the secrets are missing. Delete the draft and the tag, add the secrets, and tag again.
4. Open the draft release. Download the DMG on a Mac that has never run Frameshell and open it: the app must start with no Gatekeeper warning. `spctl --assess --type execute -vv /Applications/Frameshell.app` must print `source=Notarized Developer ID`.
5. Edit the notes if needed, then **Publish release**.

A broken tag can be deleted before publishing: `git push --delete origin v0.1.0 && git tag -d v0.1.0`, then delete the draft.

## Build locally

```sh
pnpm install && pnpm build
node apps/desktop/scripts/release/package.mjs --dir   # unpacked app for this machine only
node apps/desktop/scripts/release/package.mjs          # installers for this OS
FRAMESHELL_E2E_APP="$PWD/apps/desktop/release/mac-arm64/Frameshell.app/Contents/MacOS/Frameshell" \
  pnpm --filter @frameshell/desktop exec playwright test
```

Local builds are unsigned unless you export the signing variables above. Output goes to `apps/desktop/release/`, which git ignores.

## Not done yet

- **Binary mirror.** SPEC §9 plans a mirror of the managed ffmpeg builds on GitHub Releases. That is redistribution of GPL binaries, so it must be published together with the matching source (FFmpeg and every enabled library at the exact versions, plus build scripts) or a written offer, in the same release. The pipeline attaches no ffmpeg binaries. Add the mirror, the source bundle and the manifest mirror URLs together, in one change (see `docs/binaries.md`).
- **App icon.** The builds use the default Electron icon until `apps/desktop/build/icon.png` (1024×1024) exists. electron-builder uses that file automatically once it is added.
- **Linux arm64 and Windows arm64** are not built.
- **Auto-update** is not set up: no update metadata is published.
