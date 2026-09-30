# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- One user-directory resolver, `resolveAppDirs()` (now in `@frameshell/protocol`), for the binary manager, the plugin trust store and the desktop app. Data (binaries, downloads, caches, desktop app data under `<dataDir>/desktop`) and config (global `config.json`, `trust.json`) follow OS conventions; overrides are `FRAMESHELL_DATA_DIR` and `FRAMESHELL_CONFIG_DIR` only (`FRAMESHELL_APP_DATA`, `FRAMESHELL_USER_DATA_DIR` and `resolveAppDataDir` removed). Linux trust decisions stored in the data dir by earlier builds are still found and move to the config dir on the next decision. `startDaemon` takes `dirs` instead of `appDataDir`. New "Real binaries" CI workflow downloads and runs every pinned ffmpeg/ffprobe build (weekly, on dispatch, and on PRs touching the binary manager); the opt-in real-download test now encodes and probes H.264 and VP9-with-alpha clips.

### Added

- Media import (SPEC §6.3, ADR 0001): `frameshell import <file…> [--link] [--wait]` copies or hard-links files into `assets/`, and a watcher picks up files dropped there. A daemon job queue then probes each asset and builds a CFR proxy (H.264 at project fps, GOP 15, no B-frames, faststart, short side at most 540 px; VFR sources resampled with A/V sync kept), a mono s16le 48 kHz PCM sidecar, a waveform and thumbnails under `.frameshell/`. Outputs are cached by content hash, so unchanged or renamed assets are not re-encoded. Jobs belong to the daemon: they keep running after the client disconnects, and the daemon does not idle out while any runs. Progress shows in `status`; new daemon methods `asset.import`, `asset.list` and `job.list`, error code `AssetNotFound`; protocol v4. Tests generate tiny synthetic media, a VFR clip included, with the managed ffmpeg (cached in CI).
- Desktop app (`apps/desktop`, Electron + electron-vite + React): opens a project folder, auto-starts or reconnects to `frameshelld`, and lays out explorer/history/plugins, preview and editor tabs, timeline and a full-height terminal panel (SPEC §10). Explorer updates live from a file watcher. Markdown and JSON open in Monaco, with the project JSON Schemas; saves go through the daemon. Terminals are real login shells (node-pty + xterm.js) with `FRAMESHELL_SOCKET`, `FRAMESHELL_PROJECT`, `FRAMESHELL_SESSION` and a bundled `frameshell` on `PATH`. Panels resize and collapse; layout is saved per project. Playwright smoke test of the built app in CI.
- Daemon method `file.write`: atomic text-file writes inside a project, schema-checked for `frameshell.json` and timelines. Confinement checks real paths: symlinks cannot escape the project and `.frameshell/` is refused in any letter case. Error code `OutsideProject`.
- `status` reports `caller` (client and terminal session). The CLI sends `FRAMESHELL_SESSION` in the handshake, so calls from an app terminal are attributed to it. Protocol bumped to v3.
- pnpm workspaces monorepo (`packages/schema`, `protocol`, `core`, `cli`), TypeScript strict, Vitest, ESLint.
- `@frameshell/schema`: Zod models for `frameshell.json` and timeline files (`schemaVersion` 1) with generated JSON Schema (`pnpm gen:json-schema`).
- `frameshelld` daemon: JSON-RPC 2.0 over a unix socket (macOS/Linux) or named pipe (Windows), protocol-version handshake with a clear mismatch error, idle-timeout shutdown and stale socket cleanup.
- `frameshell init [dir] [--name]` scaffolds the project layout; `frameshell status [--json]` auto-starts the daemon and reports the enclosing project.
- GitHub Actions CI on macOS, Linux and Windows.
- Product and architecture specification (`docs/SPEC.md`).
- Project-level agent skills and `CLAUDE.md` router.
- README, contributing guide with DCO sign-off, and this changelog.
- Plugin system (SPEC §8): `frameshell-plugin.json` manifest schema with plugin API version check, public `@frameshell/plugin-api` types, and a daemon plugin host. `frameshell plugin install|remove|list` installs from `github:user/repo`, `git+<url>` or npm into `.frameshell/plugins` (regenerable) and pins the commit or exact version in `frameshell.json`. Projects that declare plugins load them only after the user trusts them (`--trust` or a prompt; decisions stored per user and re-asked when the plugin list changes). Plugin commands run as `frameshell <plugin> <command>`; plugins also contribute export presets. New daemon methods `project.trust`, `plugin.*` and `export.presets`.
- `@frameshell/protocol`: Zod method registry declaring every daemon method once (params, result, model-facing description). The daemon rejects invalid params with `InvalidParams` naming each field, and `methodJsonSchemas()` exports per-method JSON Schema for MCP tool generation. Daemon startup errors (bad `FRAMESHELL_IDLE_TIMEOUT_MS`, a non-socket file or an over-long unix socket path) now reach the CLI instead of a generic 10 s timeout.
- Managed native binaries and `frameshell doctor [--install] [--json]`: the daemon downloads pinned GPL static ffmpeg/ffprobe builds (x264, libvpx VP9 encode and decode) for macOS arm64/x64, Linux x64/arm64 and Windows x64 on first use, verifies SHA-256 and installs atomically under the app data dir. `binaries` in `frameshell.json` or the global `config.json` points at system binaries instead. `doctor` reports sources, versions and encoders/decoders (x264, libvpx, VideoToolbox, NVENC, VAAPI, hardware ones test-encoded). New `doctor` daemon method and binary error codes; protocol version 2. Sources and licences: `docs/binaries.md`.
