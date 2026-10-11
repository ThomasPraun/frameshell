# Frameshell

**An IDE for video.** The workflow of VS Code or Cursor, but the build output is a video.

Your AI agent (Claude Code, Codex, Gemini CLI…) runs in Frameshell's integrated terminal and edits the project. You watch every change live in the preview and the multitrack timeline, fix what you don't like by hand, and the agent picks up from your changes.

> **Status: alpha.** First public release: [v0.3.0](https://github.com/ThomasPraun/frameshell/releases/latest). Expect rough edges, and file an [issue](https://github.com/ThomasPraun/frameshell/issues) when you hit one.

## Install

Download the app from the [latest release](https://github.com/ThomasPraun/frameshell/releases/latest):

| Platform | File | Notes |
|---|---|---|
| macOS (Apple silicon, Intel) | `.dmg` | Signed and notarized. |
| Linux x64 | `.deb`, `.AppImage` | Beta: built and tested in CI, not yet verified by hand. On Linux arm64, HyperFrames and Remotion clips cannot render. |
| Windows x64 | `.exe` | Unsigned: SmartScreen warns on first run ("More info" → "Run anyway"). |

Open a folder in the app, then run `frameshell init` in its integrated terminal. ffmpeg, whisper.cpp and headless Chrome download on first use.

The `frameshell` CLI is on the PATH of the app's integrated terminals, where your agent runs. To use it from any other terminal (and to register the [MCP server](docs/mcp.md)), choose **File → Install 'frameshell' Command in PATH**: on macOS it links `/usr/local/bin/frameshell` (asks for your password if needed), on Linux `~/.local/bin/frameshell` (`.deb` install only, not the AppImage), on Windows it adds the command to your user PATH. The command follows app updates; **Uninstall 'frameshell' Command from PATH** removes it.

Official plugins, installed per project:

```sh
frameshell plugin install @frameshell/whisper-cpp   # transcription
frameshell plugin install @frameshell/hyperframes   # HTML motion graphics
frameshell plugin install @frameshell/remotion      # Remotion (React) compositions
```

To run from source: `pnpm install && pnpm build && pnpm --filter @frameshell/desktop start` (Node >= 22).

## What it does

- **Integrated terminal**: run your own agent, ffmpeg or scripts against the project.
- **Live preview**: see what the agent built as it builds it.
- **Multitrack timeline**: move, trim and split clips; overlays; audio; subtitles.
- **Transcript view**: word-level transcript synced with the timeline; restore a cut by clicking a word.
- **Declarative project**: the timeline is a JSON file with a published schema, edited by you, the agent and the `frameshell` CLI alike.
- **Any video engine**: clips can come from footage, [HyperFrames](https://github.com/heygen-com/hyperframes) HTML compositions, [Remotion](https://www.remotion.dev) components (including your own app's React code) or other engines through plugins.
- **Fast export**: the timeline compiles to ffmpeg.
- **Agent history**: agent changes are grouped into transactions you can review and revert.

## Two ways to use it

1. **Scripted and motion video**: explainers, demos, shorts. Built from a Markdown script, assets, voice-over and code-based motion graphics.
2. **Transcript-driven editing**: long recordings cut by the agent (silences, repeated takes, intro, subtitles, loudness), then reviewed and corrected by you.

## Documentation

- [Specification](docs/SPEC.md): vision, decisions, architecture, data model, MVP and roadmap.
- [MCP server](docs/mcp.md): drive a project from Claude Code or any MCP client (`claude mcp add frameshell -- frameshell mcp`).
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE). "Frameshell" and its logo are trademarks of the project; forks must use a different name.
