# Frameshell

**An IDE for video.** The workflow of VS Code or Cursor, but the build output is a video.

Your AI agent (Claude Code, Codex, Gemini CLI…) runs in Frameshell's integrated terminal and edits the project. You watch every change live in the preview and the multitrack timeline, fix what you don't like by hand, and the agent picks up from your changes.

> **Status: pre-alpha.** The specification is settled; implementation has just started (walking skeleton: `frameshell init` / `status`, the `frameshelld` daemon and the desktop shell: explorer, editor, terminals). Run the app from source with `pnpm install && pnpm build && pnpm --filter @frameshell/desktop start`. Nothing is installable yet. Watch the repo or read the spec to follow along.

## What it does

- **Integrated terminal**: run your own agent, ffmpeg or scripts against the project.
- **Live preview**: see what the agent built as it builds it.
- **Multitrack timeline**: move, trim and split clips; overlays; audio; subtitles.
- **Transcript view**: word-level transcript synced with the timeline; restore a cut by clicking a word.
- **Declarative project**: the timeline is a JSON file with a published schema, edited by you, the agent and the `frameshell` CLI alike.
- **Any video engine**: clips can come from footage, [HyperFrames](https://github.com/heygen-com/hyperframes) HTML compositions, Remotion components or other engines through plugins.
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
