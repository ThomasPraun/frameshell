# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- pnpm workspaces monorepo (`packages/schema`, `protocol`, `core`, `cli`), TypeScript strict, Vitest, ESLint.
- `@frameshell/schema`: Zod models for `frameshell.json` and timeline files (`schemaVersion` 1) with generated JSON Schema (`pnpm gen:json-schema`).
- `frameshelld` daemon: JSON-RPC 2.0 over a unix socket (macOS/Linux) or named pipe (Windows), protocol-version handshake with a clear mismatch error, idle-timeout shutdown and stale socket cleanup.
- `frameshell init [dir] [--name]` scaffolds the project layout; `frameshell status [--json]` auto-starts the daemon and reports the enclosing project.
- GitHub Actions CI on macOS, Linux and Windows.
- Product and architecture specification (`docs/SPEC.md`).
- Project-level agent skills and `CLAUDE.md` router.
- README, contributing guide with DCO sign-off, and this changelog.
- `@frameshell/protocol`: Zod method registry declaring every daemon method once (params, result, model-facing description). The daemon rejects invalid params with `InvalidParams` naming each field, and `methodJsonSchemas()` exports per-method JSON Schema for MCP tool generation. Daemon startup errors (bad `FRAMESHELL_IDLE_TIMEOUT_MS`, a non-socket file or an over-long unix socket path) now reach the CLI instead of a generic 10 s timeout.
