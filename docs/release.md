# Releasing Frameshell

The desktop app ships as a macOS DMG (arm64 and x64), a Linux AppImage and `.deb` (x64), and an unsigned Windows beta installer (NSIS, x64) (SPEC §4, decision 16). `.github/workflows/release.yml` builds them with electron-builder (`apps/desktop/electron-builder.yml`) through `apps/desktop/scripts/release/package.mjs`.

## What the pipeline does

| Trigger | Builds and smoke-tests | Signs macOS | Publishes |
|---|---|---|---|
| Push of a tag `v<major>.<minor>.<patch>[-pre]` | yes | if the secrets exist | a **draft** GitHub release with the installers and `SHA256SUMS.txt` |
| Actions → Release → Run workflow (`workflow_dispatch`) | yes | if the secrets exist | nothing: installers are workflow artifacts (14 days) |
| Pull request that touches packaging files | yes | never (no secrets on PRs) | nothing |
| **Publish** of that draft release (by hand) | no | no | the official plugins to npm (see [npm plugins](#npm-plugins)) |

Each OS job:

1. `pnpm build`, then `package.mjs`. It stamps the version from the tag into the app (`0.0.0-ci.<run>` for untagged runs), picks the signing mode, writes a line about it to the job summary, and calls electron-builder with `--publish never`. electron-builder never publishes on its own.
2. Runs the Playwright smoke suite (`apps/desktop/e2e`) against the **packaged** app (`FRAMESHELL_E2E_APP`). The suite runs `frameshell status` in the integrated terminal, so it fails if the bundled CLI or daemon is broken.
3. On macOS, when notarized: `stapler validate` and `spctl --assess` on each app.

The draft release is published by hand after review. A tag with a `-` (for example `v0.1.0-beta.1`) is marked as a prerelease.

Before drafting, the publish job checks the ffmpeg mirror: the GitHub release named in the manifest must exist, and its `SHA256SUMS.txt` must match every pinned archive and source. The app release itself attaches no ffmpeg binary. The mirror is its own release, published by `.github/workflows/binaries-mirror.yml` together with the corresponding source, a written offer and the licence (see `docs/binaries.md`, "Mirror and licence obligations"). If the check fails, run **Actions → Binary mirror → Run workflow** on `main`, then re-run the release.

### Bundled CLI and daemon

`@frameshell/cli` and `@frameshell/core` are dependencies of the app, so they ship inside `app.asar`. At startup the app writes a `frameshell` shim into `<userData>/bin` that runs the CLI with the app's own executable in Node mode (`ELECTRON_RUN_AS_NODE`). Integrated terminals put that directory first on `PATH`. The daemon is started the same way, from a short-lived utility process (`out/main/daemon-spawner.js`) so it holds none of the app's stdio handles (#112). The app does not install `frameshell` system-wide.

Keep Electron's `RunAsNode` fuse enabled. Turning it off breaks the CLI in the terminal and daemon auto-start.

## npm plugins

The official plugins `@frameshell/whisper-cpp` and `@frameshell/hyperframes` (`plugins/*`) are published to npm, so `frameshell plugin install @frameshell/whisper-cpp` works outside the repo. `scripts/plugins-npm.mjs` does the work. The `npm plugins` job of the Release workflow runs it on every trigger.

| Command | Does |
|---|---|
| `node scripts/plugins-npm.mjs verify` | Checks each `package.json` and `frameshell-plugin.json`: `@frameshell/` name, semver version equal in both files, Apache-2.0, `publishConfig` (`access: public`, `provenance: true`), `repository` with `directory`, `files` covering `dist`, the manifest and its skills, no `workspace:` runtime dependency. Needs no build and no network. `pnpm test` runs it. |
| `node scripts/plugins-npm.mjs dry-run [dir]` | `verify`, then `pnpm pack` each plugin (pnpm rewrites `workspace:` ranges, npm would not), checks the tarball has `package.json`, the manifest, its `main`, its skills, `README.md` and `LICENSE` and no `src/` or `test/`, then `npm publish <tarball> --dry-run`. Needs the plugins built. CI runs it on every pull request (`ci.yml`, Linux). Tarballs land in `dir` (default: a temp dir). |
| `node scripts/plugins-npm.mjs publish` | `dry-run`, then `npm publish <tarball> --access public --provenance` for each version npm does not have yet. Release workflow only. |

**Versions.** Each plugin has its own semver version in its `package.json`, and `frameshell-plugin.json` must carry the same one. A release publishes only versions npm lacks, so bump a plugin's version (both files) when it changed; an unchanged plugin is skipped, never republished. A prerelease version (`0.2.0-beta.1`) goes to the `next` dist-tag, any other to `latest`. A plugin's version is part of the clip render cache key (SPEC §6.5), so bumping `@frameshell/hyperframes` re-renders its clips.

**When.** Nothing reaches npm from a tag alone. Publishing the reviewed draft release (step 5 of [Cut a release](#cut-a-release)) fires the `release: published` event, and the `npm plugins` job publishes. Its summary lists each package as published or skipped.

**Provenance.** Each package is signed with the workflow's GitHub OIDC identity (`id-token: write`), and npm shows where it was built. npm accepts provenance only from a **public** repository whose URL matches `repository.url`; while the repository is private, the publish step fails.

### Without npm: install from a tarball

Until a version is on npm (or for a build of a branch), install the packed plugin directly. `frameshell plugin install` takes a local tarball made by `npm pack` or `pnpm pack`:

```sh
node scripts/plugins-npm.mjs dry-run ./packs        # after building: writes ./packs/frameshell-whisper-cpp-<version>.tgz, …
cp ./packs/frameshell-whisper-cpp-*.tgz <project>/vendor/
cd <project> && frameshell plugin install ./vendor/frameshell-whisper-cpp-0.1.0.tgz
```

The pin is `file:<path>#sha256=<digest>`: project-relative when the tarball is inside the project (so a clone that carries it installs it too), absolute otherwise (works only on that machine). Trust covers those bytes: a tarball whose content no longer matches the digest is never installed, and the plugin shows as failed until it is reinstalled. Directories are refused; pack them first.

### npm setup (once, by the maintainer)

1. Create the `frameshell` organization on [npmjs.com](https://www.npmjs.com/org/create) (free plan, public packages). It owns the `@frameshell` scope.
2. Create a **granular access token**: npmjs.com → Access Tokens → Generate New Token → Granular. Permissions: *Read and write*, limited to the `@frameshell` scope (or to the two packages once they exist). Pick an expiry and note it.
3. Store it as the repository secret `NPM_TOKEN`:

   ```sh
   gh secret set NPM_TOKEN -R ThomasPraun/frameshell   # paste the token
   ```

Without `NPM_TOKEN` the publish step fails and names the secret. Renew the token before it expires. Pull requests never see it.

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

1. On `main`, move the `[Unreleased]` entries in `CHANGELOG.md` under `## [x.y.z] - YYYY-MM-DD`, bump the version of each official plugin that changed since its last npm release (its `package.json` and `frameshell-plugin.json`), and merge that change.
2. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.1.0 -m "Frameshell 0.1.0"
   git push origin v0.1.0
   ```

3. Wait for the **Release** workflow. Read each job summary: the macOS job must say *notarized*. If it says *unsigned*, the secrets are missing. Delete the draft and the tag, add the secrets, and tag again.
4. Open the draft release. Download the DMG on a Mac that has never run Frameshell and open it: the app must start with no Gatekeeper warning. `spctl --assess --type execute -vv /Applications/Frameshell.app` must print `source=Notarized Developer ID`.
5. Edit the notes if needed, then **Publish release**. This publishes the official plugins whose version is new to npm: check the `npm plugins` job, then `npm view @frameshell/whisper-cpp version`.

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

- **Linux arm64 and Windows arm64** are not built.
- **Auto-update** is not set up: no update metadata is published.
