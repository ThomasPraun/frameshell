# Managed binaries

frameshelld downloads native tools on first use instead of bundling them (SPEC §9). This page records which builds are pinned, where they come from, their licences, and how to re-pin. The manifest itself is `packages/core/src/binaries/manifest.ts`.

## How it works

- Pins are per platform (`<os>-<arch>`): version, URLs (first one is canonical, later ones are mirrors), SHA-256, size, and the path of each executable inside the archive.
- Install location: `<dataDir>/binaries/<package>/<version>/<platform>/`, with an `install.json` recording the source URL, checksum and licence. `dataDir` is `~/Library/Application Support/Frameshell` (macOS), `$XDG_DATA_HOME/frameshell` or `~/.local/share/frameshell` (Linux), `%LOCALAPPDATA%\Frameshell` (Windows), or `FRAMESHELL_DATA_DIR`.
- Install steps: download to a private staging directory while hashing, abort on checksum mismatch, extract only the pinned members with the system `tar`, then publish with one directory rename. A failed install leaves nothing behind. Concurrent requests share one download.
- Extraction uses the system `tar`: bsdtar on macOS and Windows (`%SystemRoot%\System32\tar.exe`) reads zip and tar; GNU tar on Linux needs `xz` for `.tar.xz`. So Linux pins must be tar archives.
- `frameshell doctor` only reports. It downloads only with `--install`. Other features call `BinaryManager.ensure()`, which downloads on first use.

## Overrides

Set `binaries` in `frameshell.json` (project) or in `<configDir>/config.json` (global; `configDir` is the data dir on macOS, `$XDG_CONFIG_HOME/frameshell` on Linux, `%APPDATA%\Frameshell` on Windows, or `FRAMESHELL_CONFIG_DIR`):

```json
{ "binaries": { "ffmpeg": "/opt/homebrew/bin/ffmpeg" } }
```

- The value is `"managed"` or a path. Relative paths resolve against the project root (project config) or the config directory (global config).
- Precedence: project, then global, then managed. `"managed"` in the project cancels a global override.
- Overriding one tool of a package also takes its siblings from the same directory (`ffprobe` next to `ffmpeg`), unless the sibling has its own entry.

## ffmpeg and ffprobe

Requirements: GPL build with libx264, and libvpx with both the VP9 encoder and decoder. The native `vp9` decoder drops alpha (ADR 0002). Static builds only, so nothing depends on system libraries.

| Platform | Version | Builder | Archive | Licence |
|---|---|---|---|---|
| darwin-arm64 | 9.0.2 | [Martin Riedl](https://ffmpeg.martin-riedl.de) | `ffmpeg.zip` + `ffprobe.zip` (28 MB each) | GPL-3.0-or-later (`--enable-gpl --enable-version3`, no `--enable-nonfree`) |
| darwin-x64 | 9.0.2 | Martin Riedl | `ffmpeg.zip` + `ffprobe.zip` (34 MB each) | GPL-3.0-or-later |
| linux-x64 | n9.0.1-11-ge47273f4d9 | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) `autobuild-2026-08-31-13-27` | `linux64-gpl-9.0.tar.xz` (127 MB) | GPL-3.0-or-later (`--enable-gpl --enable-version3`) |
| linux-arm64 | n9.0.1-11-ge47273f4d9 | BtbN | `linuxarm64-gpl-9.0.tar.xz` (109 MB) | GPL-3.0-or-later |
| win32-x64 | n9.0.1-11-ge47273f4d9 | BtbN | `win64-gpl-9.0.zip` (169 MB) | GPL-3.0-or-later |

Why these builders:

- **Martin Riedl (macOS).** He publishes static macOS arm64 and x64 builds with a SHA-256 next to each file and a `versions.txt` showing the configure line. His builds include libx264, libx265, libvpx and VideoToolbox. Each tool is a separate zip, so ffmpeg and ffprobe are two archives.
- **Martin Riedl's Linux builds were rejected.** They are configured with `--enable-nonfree` (DeckLink), which makes the binaries non-redistributable, so they are not GPL builds.
- **BtbN (Linux, Windows).** These are the builds linked from ffmpeg.org. They are static, the `gpl` variant includes libx264, libvpx, NVENC (ffnvcodec), VAAPI and AMF, and GitHub publishes a SHA-256 digest for each asset. Daily autobuilds are pruned, but the last autobuild of each month is kept (back to 2024-10 when this was pinned). Always pin a month-end autobuild.
- **gyan.dev (Windows) was not chosen.** Its `essentials` build has no NVENC, and its `full` build is larger than BtbN's for no gain here.

Verified when pinning (2026-09-29): every SHA-256 matched the published value, each archive layout was listed, the configure line of each Linux and Windows `ffmpeg` was read from the binary, and the darwin-arm64 build was run (`-encoders` and `-decoders` list libx264, libvpx-vp9 encode and decode, and VideoToolbox; its outputs are the test fixtures in `packages/core/test/fixtures/`).

### Licence obligations

We do not redistribute these binaries: the user's machine downloads them from the builder. SPEC §9 plans a mirror on Frameshell GitHub Releases. Mirroring is redistribution, so under GPL-3.0 the mirror must also offer the corresponding source (FFmpeg plus every enabled library at the exact versions, and the build scripts), or a written offer for it. Set that up before adding a mirror URL.

## Re-pinning

1. Pick a release build: for Martin Riedl, the "Release Build" section; for BtbN, the last autobuild of a month and the `n<major>.<minor>` `gpl` (not `gpl-shared`) assets.
2. Record the size and SHA-256 of each archive: Martin Riedl publishes `<file>.sha256`, and for BtbN run `gh release view <tag> -R BtbN/FFmpeg-Builds --json assets`. Check them against your own download.
3. Check the configure line (`versions.txt`, or `strings ffmpeg | grep -- --enable-gpl`): it must have `--enable-gpl`, `--enable-libx264` and `--enable-libvpx`, and must not have `--enable-nonfree`.
4. List the archive (`tar -tf`) and update the member paths in `files`.
5. Update the manifest and this table, then run `FRAMESHELL_TEST_REAL_DOWNLOAD=1 pnpm test` on each platform you can reach. This opt-in test downloads the real pin, then checks the version and the required codecs.
