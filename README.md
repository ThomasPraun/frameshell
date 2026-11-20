# Frameshell

**An IDE for video.** The workflow of VS Code or Cursor, but the build output is a video.

Website: [frameshell.dev](https://frameshell.dev)

Edit a video by asking for it. You talk to an AI app you already use (Claude Desktop, the ChatGPT desktop app or a coding agent), it edits the project, and you watch every change live in the preview and the multitrack timeline. Fix what you don't like by hand and the AI picks up from your changes.

> **Status: alpha.** Latest release: [v0.18.0](https://github.com/ThomasPraun/frameshell/releases/latest). Expect rough edges, and file an [issue](https://github.com/ThomasPraun/frameshell/issues) when you hit one.

## Get started

1. **Download the app** from the [latest release](https://github.com/ThomasPraun/frameshell/releases/latest):

   | Platform | File | Notes |
   |---|---|---|
   | macOS (Apple silicon, Intel) | `.dmg` | Signed and notarized. |
   | Linux x64 | `.deb`, `.AppImage` | Beta: built and tested in CI, not yet verified by hand. On Linux arm64, HyperFrames and Remotion clips cannot render. |
   | Windows x64 | `.exe` | Unsigned: SmartScreen warns on first run ("More info" → "Run anyway"). |

2. **Open or start a project.** On the Welcome screen choose **New from video, audio or image…** (or drop your files there), or **Open folder…** for a folder you already have. If you tick **Transcribe what is said** and the transcription tool is not on your computer yet, Frameshell tells you the download size and asks first (**Download and transcribe** or **Skip transcription**).
3. **Connect your AI.** This needs Frameshell 0.19 or later. With 0.18, open a project and click **Connect Claude Desktop** above the terminal instead (the ChatGPT desktop app needs 0.19 or later). Install Claude Desktop or the ChatGPT desktop app and open it once first: a card offers **Connect** only after the app has made its settings folder. Then click **Connect your AI** in the project window's title bar (or the card on the Welcome screen). Claude Desktop and the ChatGPT desktop app come first, each with one **Connect** button; quit and reopen the app once to finish. **Disconnect** undoes it, and Frameshell keeps a copy of the app's settings before changing them. Once connected, **Open Claude Desktop** or **Open ChatGPT** on the card starts the app and copies a starter phrase to paste there as your first message; **Download Claude Desktop** or **Download ChatGPT** shows when the app looks not installed. ChatGPT on the web is not supported (it needs a public server), and the ChatGPT desktop app may need its Codex mode to use the connection: not verified yet. On Linux, Frameshell has no Connect button for Claude Desktop, and we know of no ChatGPT desktop app for it; use a developer tool or the Cursor / VS Code snippet from the "For developers" group.
4. **Talk to it.** In your AI app, ask in your own words: "remove the silences", "add subtitles", "make a vertical short of the best moment". With the project open in Frameshell, the AI works on it and you see each change on the timeline. It offers options and asks before it installs, downloads or spends anything, and History lets you revert any change, yours or the AI's.

Plugins are optional extras (transcription, HTML or React animations, Blender scenes, cloud voices). Open the **Plugins** view in the sidebar to see what each one needs, costs and downloads, and to install or remove it; your AI can suggest one too, and nothing is installed without your yes. The same view lists what Frameshell has downloaded to this computer (ffmpeg, transcription, headless Chrome, models) with sizes and a Remove button.

The terminal inside Frameshell is optional and starts folded in new projects. Click its rail on the right, or choose **View → Terminal** (Ctrl+\ on Windows and Linux, Cmd+\ on macOS), to open it.

## For developers

Frameshell also works from a terminal. Open a folder in the app, then run `frameshell init` in its integrated terminal if the folder is not a project yet. ffmpeg, whisper.cpp and headless Chrome download on first use.

Coding agents (Claude Code, Codex, Gemini CLI, OpenCode and others) run in the integrated terminal and edit the project through the `frameshell` CLI. The Connect your AI panel has a smaller "For developers" group for Claude Code, Codex CLI, Gemini CLI and a snippet for Cursor, VS Code and other MCP clients. From a shell, `frameshell setup claude-code|codex|gemini` connects Claude Code (the MCP server plus the hook behind Chat about this), Codex (the ChatGPT desktop app shares its file) or Gemini CLI; `claude mcp add frameshell -- frameshell mcp` registers only the MCP server in Claude Code. See the [MCP server](docs/mcp.md) page.

The `frameshell` CLI is on the PATH of the app's integrated terminals. To use it from any other terminal (and to register the MCP server), choose **File → Install 'frameshell' Command in PATH**: on macOS it links `/usr/local/bin/frameshell` (asks for your password if needed), on Windows it adds the command to your user PATH. The command follows app updates; **Uninstall 'frameshell' Command from PATH** removes it. On Linux the `.deb` installs `/usr/bin/frameshell` itself; the AppImage cannot provide the command.

Official plugins install per project from the CLI too; `frameshell plugin catalog` lists them with what each needs:

```sh
frameshell plugin install @frameshell/whisper-cpp   # transcription
frameshell plugin install @frameshell/hyperframes   # HTML motion graphics
frameshell plugin install @frameshell/remotion      # Remotion (React) compositions
frameshell plugin install @frameshell/blender       # Blender scenes (your own Blender)
```

`frameshell doctor` lists the downloads on this computer; `frameshell doctor --remove <name>` deletes one.

To run from source: `pnpm install && pnpm build && pnpm --filter @frameshell/desktop start` (Node >= 22).

## What it does

- **Your AI, your way**: connect Claude Desktop or the ChatGPT desktop app in one click, or run a coding agent, ffmpeg or scripts in the optional integrated terminal.
- **Live preview**: see what the AI built as it builds it.
- **Multitrack timeline**: move, trim and split clips; overlays; audio; subtitles.
- **Transcript view**: word-level transcript synced with the timeline; restore a cut by clicking a word.
- **Declarative project**: the timeline is a JSON file with a published schema, edited by you, the AI and the `frameshell` CLI alike.
- **Any video engine**: clips can come from footage, [HyperFrames](https://github.com/heygen-com/hyperframes) HTML compositions, [Remotion](https://www.remotion.dev) components (including your own app's React code), [Blender](https://www.blender.org) scenes (your own install) or other engines through plugins.
- **Fast export**: the timeline compiles to ffmpeg.
- **Agent history**: AI changes are grouped into transactions you can review and revert.

## Two ways to use it

1. **Scripted and motion video**: explainers, demos, shorts. Built from a Markdown script, assets, voice-over and code-based motion graphics.
2. **Transcript-driven editing**: long recordings cut by the AI (silences, repeated takes, intro, subtitles, loudness), then reviewed and corrected by you.

## Documentation

- [Specification](docs/SPEC.md): vision, decisions, architecture, data model, MVP and roadmap.
- [MCP server](docs/mcp.md): drive a project from Claude Desktop, the ChatGPT desktop app, Claude Code or any MCP client.
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## License

[Apache License 2.0](LICENSE). "Frameshell" and its logo are trademarks of the project; forks must use a different name.
