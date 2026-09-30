# Frameshell — Specification

> Status: draft v0.1 · 2026-09-29 · Author: Thomas Praun
> Scope: product and architecture definition before implementation. No code exists yet.

---

## 1. Vision

Frameshell is an open source **IDE for video**: the workflow of VS Code / Cursor, but the build output is a video.

The user and an AI agent work on **the same project**:

1. The agent (Claude Code, Codex, Gemini CLI…) runs in Frameshell's integrated terminal and edits the project through the `frameshell` CLI.
2. The user sees every change live in the preview and the multitrack timeline.
3. The user corrects by hand (timeline, transcript view).
4. The agent reads what the user changed and continues from there.

Frameshell does **not** ship its own LLM. Its value is what agent CLIs lack: a declarative timeline model, a live preview, a visual timeline, a transcript view, and a fast export pipeline.

### Target use cases

| Case | Description | Example |
|---|---|---|
| **A: Scripted / motion video** | Explainers, tutorials, product demos, shorts. Built from a script, assets, voice-over, subtitles and code-based motion graphics (HyperFrames, Remotion). | "Turn `scripts/launch.md` into a 60 s 9:16 promo." |
| **B: Transcript-driven footage editing** | Long recordings (talks, YouTube videos) cut by the agent from a word-level transcript: silences, repeated takes, intro, subtitles, loudness. | "Edit this video, add the intro, remove silences, prepare it for YouTube." |

Case B follows the workflow published by Facundo Corengia ("El prompt para no editar más"): the agent edits and the human's only job is to watch it once and correct. Frameshell makes that review step visual and reversible.

Out of scope: a manual, Premiere-style NLE for multi-hour 4K footage (color grading, advanced keyframing, multicam).

---

## 2. Decision log

| # | Topic | Decision | Rationale | Rejected |
|---|---|---|---|---|
| 1 | Use case | A (scripted/motion) + B (transcript-driven editing) on one model | The agent does the heavy lifting and the human reviews; both cases share "clips on tracks" | Classic manual NLE |
| 2 | App format | **Desktop app: Electron + React + TypeScript** | Real terminal (node-pty + xterm.js, same as VS Code); bundled Chromium + Node, both required by HTML/React video engines; proven IDE pattern | Tauri (per-OS webview codec issues, Node sidecar anyway, Rust), Flutter desktop (Remotion player would need a webview, weak terminal), VS Code extension (webviews lack H.264, panel-bound UI), plain local web app |
| 3 | Source of truth | **Declarative timeline JSON**; clips reference media or compositions of any engine through **adapters** | Human and agent edit the same structured data; moving a clip = changing a number; not tied to one engine | Remotion TSX as truth (timeline edits would require rewriting arbitrary code), OTIO native (verbose, poor fit for code compositions; export only) |
| 4 | Preview | **Hybrid**: `media` clips play directly from proxies; generated clips play from a per-clip render cache; live preview of the active clip later | Preview matches export; a new engine works with `render()` only | All-live multi-engine sync (hard, preview/export drift), render-only (too slow to feel live) |
| 5 | Final export | **ffmpeg as compositor**; core compiles timeline → ffmpeg graph, rendered in segments | Minutes, not hours, for 30-min cut videos; loudnorm/atempo native; engines only produce clips | Remotion as full compositor (frame-by-frame capture, licence leaks into core), MLT (painful cross-platform bundling, second model to sync) |
| 6 | Agent integration | **`frameshell` CLI** and **MCP server** as equal first-class paths, both clients of the daemon; direct file edits allowed (guarded by `revision`); bundled **agent skill** | Validated ops, low token cost, works with any agent or script (CLI) and with typed tools for MCP clients; each op is undoable | File-only (invalid JSON, token-heavy, races), MCP-only (excludes scripts) |
| 7 | On-disk format | **JSON + published JSON Schema**, split files (see §5) | Agents edit JSON reliably; small diffs; nested sequences; transcripts isolated | YAML (type gotchas; comments lost on rewrite anyway), single file (huge diffs) |
| 8 | Time unit | **Decimal seconds**, snapped by core to project frame grid, 3 decimals; **CFR proxies** for VFR sources | Native to humans, agents, whisper and ffmpeg; VFR (OBS, phones) handled at import | Integer frames (conversions everywhere, fps change rewrites all), rationals (hostile to agents) |
| 9 | AI | **Bring your own agent**: no built-in LLM. The UI injects context references from the user's selection into the agent terminal (decision 21) | Zero model cost; does not compete with agents that improve monthly | Built-in chat/agent |
| 10 | Media AI services | **Transcription is first-class** (`frameshell transcribe`, provider interface, whisper.cpp default, `--verify`). TTS, video, image, music = assets produced by the agent | The data model needs word timestamps in one format; everything else changes too fast to own | Everything built in, nothing built in |
| 11 | Licence | **Apache 2.0** + protected "Frameshell" trademark + DCO | Adoption and ecosystem over protection; patent grant; monetize via services | MIT (no patent grant), GPLv3/AGPLv3 + CLA (lower adoption) |
| 12 | Native binaries | **Downloaded on first use**: pinned versions + checksums (ffmpeg GPL build with x264, whisper.cpp, whisper models). Override with system binaries. `frameshell doctor` | Small installer; controlled versions; x264 quality; Frameshell does not redistribute GPL binaries | Bundled in installer (size, GPL obligations), system only (version chaos) |
| 13 | Plugins | **Node/TS packages** + `frameshell-plugin.json`; official adapters built on the same API; GitHub topic discovery; per-project pinning; project trust | herdr-style zero-friction ecosystem; API proven by first-party plugins; every plugin teaches the agent via its skill | Curated marketplace, UI extension points in MVP |
| 14 | Scripts | **Markdown with optional conventions** (`##` = scene, optional frontmatter); clips carry `scriptRef` | Free writing; traceability when useful; generation stays with the agent | Structured script format |
| 15 | Agent changes | **Applied immediately, grouped in transactions**; history with author; diff review; revert whole tx or single ops | Keeps autonomy (agent works for an hour unattended) and adds review afterwards; `history --since` lets the agent resume from human edits | Plain undo, blocking proposal/diff mode (v0.2 opt-in) |
| 16 | Platforms | **macOS + Linux stable, Windows beta**; CI on all three from day one | Focus plus early detection of OS assumptions; signing cost only on macOS at v0.1 | macOS only, all three stable |
| 17 | Layout | **Terminal right (full height), preview + editor tabs center, timeline bottom, explorer/history/plugins left** | Agent, preview and timeline visible together | Terminal tabbed with timeline, free docking |
| 18 | MVP | **End-to-end Case B scenario + one adapter (HyperFrames)** | Validates the core loop with a real workflow; HyperFrames is Apache 2.0, HTML, agent-friendly | Feature-list MVP, Remotion first |
| 19 | Core process | **`frameshelld` daemon** per user, JSON-RPC + events over local socket; UI and CLI are clients | Renders survive closing the window; single writer; agent works with app closed; MCP/cloud become more clients | Core inside Electron, dual cores with file locks |
| 20 | MCP scope | **Project + observe + navigate**: every core operation as a typed tool, frame capture as images, UI state (playhead, selection, open tab) and navigation (seek, play, select, open file, show transaction diff) | Model can see what it built and resolve "this" from the user's selection; UI actions are already core operations | Project-only (model edits blind), full UI automation (clicks/drags: fragile, adds no capability) |
| 21 | Ask agent from selection | **"Ask agent" action** (Cmd/Ctrl+L, context menu) writes a compact text reference of the current selection into the active agent terminal's prompt, unsent. Selectable: clips, words/subtitles, time ranges, assets, script scenes, and a **rectangular region of the preview frame** | Removes "which one?" round trips; plain text works with any agent CLI; ids let the agent fetch detail via CLI/MCP | Agent-pull only via `ui_state` (user must still explain), chat panel (decision 9) |

### Cross-cutting rules

- **Core is the only writer** of project files.
- UI persists every operation immediately. No "unsaved" state.
- Every timeline file carries `revision`; stale direct edits are rejected (see §6.4).
- Adapter contract: `render()` required, `livePreview()` optional.
- Nothing in `.frameshell/cache` or `.frameshell/proxies` is precious: all of it can be regenerated.

---

## 3. Architecture

```
┌────────────────────────────── Electron app ──────────────────────────────┐
│  Renderer (React)                          Main process                  │
│  ├─ Explorer / History / Plugins           ├─ node-pty terminals         │
│  ├─ Preview player                         ├─ window + layout state      │
│  ├─ Editors (Monaco: md/json, transcript)  └─ frameshell-media:// proto  │
│  ├─ Timeline (canvas)                          (range requests, proxies) │
│  └─ xterm.js ◄──────── pty ───────────────────┘                         │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ JSON-RPC + events (unix socket / named pipe)
┌──────────────▼──────────────── frameshelld (Node) ───────────────────────┐
│  Project manager (multi-project)   Operation engine (validate → apply)   │
│  Schema (Zod)                      History journal + transactions        │
│  File watcher (chokidar)           Job queue (proxy, waveform, render,   │
│  Media service (ffprobe, proxies)             transcribe, export)        │
│  Clip render cache                 ffmpeg graph compiler                 │
│  Plugin host (adapters, providers, commands, presets, skills)            │
│  Binary manager (ffmpeg, whisper.cpp, models)                            │
└──────────────▲───────────────────────────────────────────────────────────┘
               │ same JSON-RPC
      ┌────────┴────────┬─────────────────┐
      │ frameshell CLI  │ frameshell mcp  │  (stdio MCP server)
      └────────▲────────┴────────▲────────┘
               └──── Agent ──────┘  (Claude Code, Codex, any MCP client)
```

### 3.1 Daemon `frameshelld`

- One per OS user. Holds any number of open projects.
- Transport: Unix domain socket (macOS/Linux), named pipe (Windows). JSON-RPC 2.0 plus server-pushed notifications (`timeline.changed`, `job.progress`, `history.appended`, `asset.added`).
- Handshake: client sends protocol version; incompatible → clear error with upgrade hint.
- Lifecycle: auto-started by CLI or app if absent; exits after an idle timeout with no clients and no running jobs.
- Owns every write to project files. Renders, transcriptions and exports continue if the window closes.

### 3.2 Electron app

- Main process: window, node-pty terminals (sessions die with the app in v0.1), custom `frameshell-media://` protocol serving proxies with HTTP range support.
- Each pty receives `FRAMESHELL_SOCKET`, `FRAMESHELL_PROJECT` and `FRAMESHELL_SESSION` env vars, so a CLI call from that terminal is attributed to that session.
- Renderer: React UI; subscribes to daemon events; sends operations, never writes files.

### 3.3 CLI `frameshell`

- Thin client of the daemon; starts it if needed.
- Human-readable output by default, `--json` for agents and scripts.
- Errors are actionable (what failed, valid range, suggested command).

### 3.4 Preview

- `media` clips: proxies decoded with **WebCodecs** (`VideoDecoder`) from the keyframe before each in-point, pre-roll discarded, frames drawn to a canvas on the **audio clock**. Decode and draw run in a Worker with `OffscreenCanvas`. Program audio comes from a PCM sidecar mixed in one `AudioWorklet` with its own sample counter and 2 ms edge fades; all audio tracks mix in the same worklet. Double-buffered `<video>` elements were measured and rejected (ADR 0001).
- Generated clips (`hyperframes`, later `remotion`): played from cached renders: `.frameshell/cache/clips/<hash>.webm` (VP9 with alpha) or `.mp4` (H.264) when opaque (ADR 0002). While a render is pending, show a placeholder with progress.
- Overlays: CSS/canvas compositing with the clip `transform` (position, scale, opacity).
- Subtitles: rendered in the DOM from the transcript, same style tokens as export.
- v0.2: `livePreview()` mounts the active clip's engine directly (iframe for HyperFrames, `@remotion/player` for Remotion), synced to the playhead.

### 3.5 Export pipeline

1. Resolve timeline (nested timelines flattened, subtitle words resolved).
2. Ensure every generated clip has a fresh cache entry (render missing ones via adapters).
3. **Video:** split the timeline into segments at clean boundaries, compile each to an ffmpeg `filter_complex` (`trim`, `setpts`, `scale`, `overlay`, `subtitles`/`ass`), encode segments in parallel, join with the concat demuxer. Every VP9 input with alpha is decoded with `-c:v libvpx-vp9` (the native `vp9` decoder silently drops alpha).
4. **Audio:** one continuous pass (not segmented, avoids clicks at segment joins): `atrim` + short `afade` at every cut, `atempo`, `amix`, two-pass `loudnorm` to the preset target (default −17 LUFS integrated).
5. Mux, apply preset (codec, bitrate, resolution, aspect ratio).
6. Optional: `frameshell transcribe --verify` compares the export against source transcripts and reports lost words.

The compiler is a pure function (timeline → plan → ffmpeg args) tested with golden files.

---

## 4. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) everywhere |
| Runtime | Node ≥ 22 (daemon, CLI, plugins) |
| Desktop shell | Electron + electron-vite |
| UI | React, xterm.js, Monaco, custom canvas timeline |
| Terminal | node-pty (ConPTY on Windows) |
| Schema | Zod as source; JSON Schema generated and published |
| File watching | chokidar |
| Media | ffmpeg / ffprobe (managed download, GPL build with x264 and libvpx) |
| Transcription | whisper.cpp pinned version (default provider, `large-v3-turbo-q5_0`, DTW token timestamps); cloud providers as plugins |
| First adapter | HyperFrames (`@frameshell/hyperframes`) |
| Tests | Vitest; golden files for compiler; short smoke renders in CI |
| Repo | pnpm workspaces monorepo |
| CI | GitHub Actions: macOS, Linux, Windows |
| Packaging | macOS signed + notarized DMG; Linux AppImage/.deb; Windows unsigned (beta) |
| Docs | TSDoc in code; `CHANGELOG.md` (Keep a Changelog + SemVer); repo `CLAUDE.md` as router |
| UI language | English, i18n-ready (Spanish as first translation) |

### Repository layout

```
frameshell/
├── apps/
│   └── desktop/              # Electron app (main + renderer)
├── packages/
│   ├── schema/               # Zod models, JSON Schema generation, migrations
│   ├── core/                 # frameshelld: ops, history, jobs, compiler, plugin host
│   ├── cli/                  # frameshell CLI
│   ├── protocol/             # JSON-RPC method + event types shared by clients
│   └── plugin-api/           # public types for plugin authors
├── plugins/
│   ├── hyperframes/          # @frameshell/hyperframes adapter + skill
│   └── whisper-cpp/          # @frameshell/whisper-cpp provider + skill
├── skills/
│   └── frameshell/SKILL.md   # agent skill for the core CLI
├── docs/
│   └── SPEC.md
├── LICENSE                   # Apache 2.0
└── CHANGELOG.md
```

---

## 5. Project data model

### 5.1 Project layout on disk

```
my-video/
├── frameshell.json            # project config
├── timelines/
│   ├── main.json              # exported sequence
│   └── intro.json             # nested sequence (used as a clip)
├── scripts/
│   └── script.md              # Markdown scripts
├── assets/                    # footage, images, audio, fonts, AI-generated media
├── compositions/
│   ├── hyperframes/intro/     # HTML compositions
│   └── remotion/              # TSX components (v0.2)
├── transcripts/
│   └── raw-01.words.json      # word-level transcript per asset
└── .frameshell/               # gitignored
    ├── cache/clips/           # rendered generated clips (regenerable)
    ├── proxies/               # CFR preview proxies (regenerable)
    ├── waveforms/, thumbs/    # regenerable
    ├── history/               # local operation journal (not shared; loss = loss of undo only)
    └── rejected/              # stale direct edits kept for recovery
```

### 5.2 `frameshell.json`

```json
{
  "$schema": "https://frameshell.dev/schema/v1/project.json",
  "schemaVersion": 1,
  "name": "Launch video",
  "fps": 30,
  "resolution": { "width": 2560, "height": 1440 },
  "sampleRate": 48000,
  "main": "timelines/main.json",
  "plugins": {
    "@frameshell/hyperframes": "0.1.0",
    "@frameshell/whisper-cpp": "0.1.0"
  },
  "transcription": { "provider": "whisper-cpp", "model": "large-v3-turbo-q5_0", "language": "es" },
  "binaries": { "ffmpeg": "managed" },
  "export": { "defaultPreset": "youtube-1440p", "loudness": -17 }
}
```

### 5.3 Timeline (`timelines/*.json`)

```json
{
  "$schema": "https://frameshell.dev/schema/v1/timeline.json",
  "schemaVersion": 1,
  "id": "main",
  "revision": 184,
  "tracks": [
    {
      "id": "v1", "kind": "video", "name": "Camera",
      "clips": [
        { "id": "c_0001", "type": "media", "asset": "assets/raw-01.mp4",
          "start": 0.000, "in": 3.200, "out": 15.733,
          "speed": 1.15, "audio": { "gain": 0, "muted": false } },
        { "id": "c_0002", "type": "media", "asset": "assets/raw-01.mp4",
          "start": 10.898, "in": 17.100, "out": 42.567, "speed": 1.15 }
      ]
    },
    {
      "id": "v2", "kind": "video", "name": "Overlays",
      "clips": [
        { "id": "c_0100", "type": "hyperframes",
          "source": "compositions/hyperframes/intro/index.html",
          "start": 0.000, "duration": 8.000,
          "props": { "title": "No vendas agentes de IA" },
          "transform": { "x": 0, "y": 0, "scale": 1, "opacity": 1 },
          "scriptRef": "scripts/script.md#intro" },
        { "id": "c_0101", "type": "timeline", "source": "timelines/intro.json",
          "start": 60.000 }
      ]
    },
    {
      "id": "a1", "kind": "audio", "name": "Music",
      "clips": [
        { "id": "c_0200", "type": "media", "asset": "assets/music.wav",
          "start": 0.000, "in": 0.000, "out": 30.000, "audio": { "gain": -18 } }
      ]
    },
    {
      "id": "s1", "kind": "subtitles", "name": "Subtitles",
      "follows": "v1",
      "style": { "preset": "big-keyword", "position": "bottom" }
    }
  ]
}
```

Rules:

- **Layering:** track order = stacking order; first video track is the bottom layer.
- **Timing:** `start` is timeline time; `in`/`out` are source time. `media` duration = `(out - in) / speed`. Generated clips carry `duration`. All times are seconds, snapped by the core to `1/fps`, stored with 3 decimals.
- **IDs:** stable, generated by core (`c_…`, `t_…`); agents reference clips by ID.
- **Subtitle tracks do not copy words.** A subtitle track `follows` a video/audio track: its words are the transcript words that fall inside each followed clip's `[in, out]`, mapped to timeline time. Cutting a clip automatically removes its words from subtitles. Word text corrections live in the transcript file.
- **Nested timelines:** `type: "timeline"` embeds another timeline file as a clip.
- **Clip types:** `media` and `timeline` are core types. Others (`hyperframes`, `remotion`, …) are registered by adapter plugins, each with its own `props` schema.
- Timeline duration is derived, never stored.

### 5.4 Transcript (`transcripts/*.words.json`)

```json
{
  "schemaVersion": 1,
  "asset": "assets/raw-01.mp4",
  "assetHash": "sha256:…",
  "provider": "whisper-cpp",
  "model": "large-v3-turbo-q5_0",
  "language": "es",
  "words": [
    { "id": "w_000001", "text": "Hola", "start": 0.520, "end": 0.810, "confidence": 0.97 },
    { "id": "w_000002", "text": "a",    "start": 0.810, "end": 0.880, "confidence": 0.95 }
  ],
  "edits": { "w_000002": { "text": "a todos" } }
}
```

- Times are source-asset seconds (same clock as the asset's `in`/`out`), measured on the CFR proxy.
- `start` is the DTW onset; `end` is derived from audio energy (last speech frame before the next onset), because DTW gives no word end (ADR 0003).
- `assetHash` invalidates the transcript if the asset changes.
- `edits` holds human corrections; re-transcribing keeps them where word IDs still match.

### 5.5 Script (`scripts/*.md`)

Plain Markdown. Optional conventions:

- YAML frontmatter: `title`, `target_duration`, `aspect`.
- Each `##` heading is a scene; its slug is the anchor used in `scriptRef` (`scripts/script.md#intro`).
- `frameshell script outline <file> --json` returns parsed scenes. The UI highlights the scene of the selected clip and flags scenes with no clips.

### 5.6 Schema evolution

Every file carries `schemaVersion`. `packages/schema` ships forward migrations; the daemon migrates on open (with a backup under `.frameshell/`).

---

## 6. Core behaviours

### 6.1 Operations

Every change, whether from the UI, the CLI or a direct file edit, becomes an **operation**: `{ op, args, inverse, author, tx, revisionBefore }`. The daemon validates, snaps times, applies, bumps `revision`, writes the file atomically (temp + rename), appends to history and emits `timeline.changed`.

### 6.2 History and transactions

- Journal: `.frameshell/history/<timeline>.jsonl`.
- `author`: `ui`, `cli:<session>` (terminal session), `file` (direct edit), `plugin:<name>`.
- CLI ops from the same terminal session are grouped automatically into a transaction until an idle gap; `frameshell tx begin "<label>"` / `frameshell tx commit` group explicitly.
- UI: History panel lists transactions ("agent: remove silences, 180 ops"). Actions: show diff on timeline, revert transaction, revert single op.
- Revert is itself a new operation (history is append-only).
- `frameshell history --since <tx> --json`: lets the agent see what the human changed since its last transaction.

### 6.3 Asset ingestion

Watcher detects new or changed files under `assets/`. The job queue then probes them (ffprobe), creates CFR proxies, a PCM audio sidecar, waveforms and thumbnails. Proxy recipe (ADR 0001): H.264, CFR, fixed GOP 15, **no B-frames** (decode order = display order), faststart, reduced resolution. The sidecar is s16le 48 kHz PCM (~165 MiB per 30 min mono); both are regenerable. Transcription is explicit (`frameshell transcribe`), never automatic, because of its cost.

### 6.4 Direct file edits and conflicts

The watcher sees a timeline file change that the daemon did not write:

- **`revision` equals current:** schema-validate, diff against in-memory state, record as ops with author `file`, bump revision. Invalid content is rejected with a precise error.
- **`revision` is stale:** reject. Restore the daemon's version, save the incoming file to `.frameshell/rejected/<timestamp>-<timeline>.json`, emit an event (shown in UI and returned by `frameshell doctor`/`status`).

### 6.5 Clip render cache

Cache key = hash(adapter name + adapter version + clip `props` + content hash of the adapter's declared input files + project fps/resolution). Changing a composition file triggers a background re-render of affected clips.

### 6.6 Project trust

On first open of a project that declares plugins, the UI and CLI ask for trust before installing or loading them. Untrusted projects open read-only for plugins (media, timeline and transcripts still work).

---

## 7. CLI surface (v0.1)

```
frameshell init [dir]                         # scaffold project
frameshell status [--json]                    # project, daemon, jobs, rejected edits
frameshell doctor [--install] [--json]        # binaries, encoders (x264, libvpx, VideoToolbox, NVENC, VAAPI), whisper accel; downloads only with --install

frameshell import <file…>                     # copy/link into assets/, queue proxies
frameshell track add|remove|list …
frameshell clip add|move|trim|split|remove|set …
frameshell cut <track> --from <s> --to <s>    # remove a timeline range (ripple)
frameshell timeline show [--json]             # compact dump for agents

frameshell transcribe <asset> [--provider p]  # writes transcripts/<asset>.words.json
frameshell transcribe --verify <export>       # lost-word report vs sources
frameshell script outline <file> [--json]

frameshell tx begin "<label>" | commit | abort
frameshell history [--since <tx>] [--json]
frameshell revert <tx|op>

frameshell render [--preset p] [--out file]   # export
frameshell frame --at <s> --out <png>         # composited frame, same path as MCP frame_capture
frameshell mcp                                # stdio MCP server (§7b)
frameshell plugin install|remove|list <spec>  # github:user/repo | npm name
frameshell <plugin> <command> …               # plugin-provided commands
```

All mutating commands accept `--timeline <id>` (default `main`) and print the resulting `revision`.

---

## 7b. MCP server (v0.1)

`frameshell mcp` starts a stdio MCP server that is one more daemon client (register it with e.g. `claude mcp add frameshell -- frameshell mcp`). It adds no logic of its own: tools map to daemon methods.

| Group | Tools / resources |
|---|---|
| **Project** | Every CLI operation of §7 as a typed tool (`clip_add`, `clip_trim`, `cut`, `track_add`, `transcribe`, `render`, `tx_begin`, `history`, `revert`, `plugin_install`…). Input schemas generated from the same Zod models as the protocol; errors as actionable tool errors. |
| **Read** | Resources for timeline, transcript, script outline, history and project status, in the compact form of `--json` CLI output. Resource change notifications on `timeline.changed` / `history.appended`. |
| **Observe** | `frame_capture(timeline, at)` returns the composited frame as an image; `frames_strip(timeline, from, to, count)` returns a contact sheet. Rendered by the daemon with the export compiler (single-frame plan), so it works with the app closed and matches export. |
| **UI state** | `ui_state()` returns playhead, selection (clips, words, time range), open editor tab and visible range. Available when the app is connected; otherwise returns `{ connected: false }`. |
| **Navigate** | `ui_seek`, `ui_play`, `ui_pause`, `ui_select`, `ui_open_file`, `ui_show_tx_diff`. Routed daemon → connected UI client. Navigation only: no pixel clicks, no drags. |

Design rules:

- Tool names, descriptions and schemas are written for models: one verb per tool, explicit units (seconds), enumerated values, examples in descriptions.
- Tool outputs stay compact (ids, revision, changed ranges); large data goes through resources.
- Every mutating tool reports the new `revision` and transaction id, so the model can revert its own work.
- The UI publishes its state to the daemon; the daemon is the only broker. MCP never talks to Electron directly.
- CLI parity: `frameshell frame --at <s> --out <png>` exists for non-MCP agents.

## 8. Plugin system

### 8.1 Manifest (`frameshell-plugin.json`)

```json
{
  "name": "@frameshell/hyperframes",
  "version": "0.1.0",
  "apiVersion": "1",
  "main": "dist/index.js",
  "contributes": {
    "clipTypes": ["hyperframes"],
    "transcriptionProviders": [],
    "commands": ["hyperframes new"],
    "exportPresets": [],
    "skills": ["skills/hyperframes/SKILL.md"]
  }
}
```

### 8.2 Extension points

| Point | v0.1 | Contract (sketch) |
|---|---|---|
| Clip adapter | ✅ | `type`, `propsSchema`, `inputs(clip)` → files affecting the cache key, `render(clip, ctx)` → `{ file, hasAlpha }`; `hasAlpha: true` ⇒ VP9 WebM with `alpha_mode=1` that plays in Chromium `<video>`; optional `livePreview` (v0.2) |
| Transcription provider | ✅ | `transcribe(file, opts)` → words in core format |
| CLI commands | ✅ | `register(name, handler)` with typed args |
| Agent skills | ✅ | Markdown shipped with the plugin; `frameshell plugin install` exposes it to the agent (e.g. linked into `.claude/skills/`) |
| Export presets | ✅ | Declarative codec, resolution, aspect and loudness settings |
| UI panels (webviews) | v0.3 | — |
| Effects / filters | v0.3 | ffmpeg filter fragments + preview equivalent |

### 8.3 Distribution

- Install: `frameshell plugin install github:user/repo` or an npm package name. Pinned per project in `frameshell.json`; global plugins allowed.
- Discovery: GitHub repos tagged `frameshell-plugin` get indexed automatically (herdr model). No review; trust and security guide in the docs.
- Plugins run in the daemon process with full Node access (like VS Code extensions). No sandbox in v0.1; project trust is the gate. Package lifecycle scripts (e.g. `prepare` for git plugins) run only after the project is trusted.
- Official plugins use only the public API; no private hooks.

---

## 9. Native binaries

- Managed by the daemon under the OS app-data directory, versioned (`ffmpeg/7.x/…`).
- Sources: pinned URLs + SHA-256 (sources and licences in `docs/binaries.md`). A mirror on Frameshell GitHub Releases is redistribution of GPL binaries: it ships only together with the matching source code (or a written offer), published in the same release.
- ffmpeg: GPL build (x264/x265, libvpx encoder and decoder) downloaded by the user at first run; not redistributed inside the installer. `doctor` checks libvpx.
- Headless Chrome for HTML engines (HyperFrames): managed like other binaries and passed via `PRODUCER_HEADLESS_SHELL_PATH`.
- whisper.cpp: pinned version, prebuilt per platform. macOS (Metal) and Linux builds are compiled reproducibly by Frameshell CI and published once on a Frameshell GitHub Release (MIT licence; bytes must match the pin); Windows uses upstream prebuilt assets. v0.1 ships CPU builds on Linux and Windows; GPU builds (CUDA/Vulkan) come from a user override (`binaries.whisper-cli`). DTW and VAD behaviour changes between commits, so the version is never floating. Default model `large-v3-turbo-q5_0` (574 MB) downloaded on first transcription.
- Override: `"binaries": { "ffmpeg": "/opt/homebrew/bin/ffmpeg" }` in the project, or in the global config.

---

## 10. UI

```
┌──────────┬─────────────────────────────────┬──────────────┐
│ Explorer │  Preview        │ Editor tabs   │ Terminal(s)  │
│ History  │                 │ script.md     │ [agent][zsh] │
│ Plugins  │                 │ transcript    │              │
│          │                 │ main.json     │              │
│          ├─────────────────────────────────┤              │
│          │ Timeline: V2 overlays / V1 / A1 / S1          │ │
└──────────┴─────────────────────────────────┴──────────────┘
```

- All panels resizable and collapsible; timeline maximize shortcut; layout saved per project.
- **Transcript view:** words synced to the playhead; words removed by cuts shown struck through; clicking a struck word restores it (an op that re-extends or re-inserts the clip range); selecting words selects the timeline range.
- **Timeline v0.1:** multiple video tracks (overlay transform: position, scale, opacity), audio tracks with gain and waveform, subtitle tracks. Move, trim, split, ripple delete, snapping, zoom. Generated clips show render state.
- **History panel:** transactions by author, diff highlight, revert.
- **Ask agent from selection** (decision 21): Cmd/Ctrl+L or context menu on any selection focuses the active agent terminal and types a reference into its prompt without sending. Region selection: drag a rectangle on the preview; the reference carries normalized coordinates and a frame capture saved under `.frameshell/context/` (regenerable, gitignored). Reference format, one line per selected item:
  ```
  [frameshell] subtitle "hola a todos" · 00:03:12.40–00:03:14.10 · clip c_0012 · words w_000123–w_000127
  [frameshell] region (0.62,0.08)–(0.94,0.22) @ 00:01:05.20 · frame .frameshell/context/f_0421.png
  [frameshell] asset assets/logo.png
  ```
  Times are timeline times; ids match the project files, so the agent resolves details with `frameshell` CLI or MCP tools. The same selection is exposed by `ui_state` (§7b).

---

## 11. MVP (v0.1)

### Acceptance scenario

> I record a video, open the folder in Frameshell and ask Claude Code in the integrated terminal: "remove silences and repeated takes, add an intro with subtitles". I watch the cuts appear on the timeline while the agent works. In the transcript view I restore two cuts I disagree with. I ask the agent to continue; it reads `frameshell history --since` and respects my changes. I export to 1440p for YouTube and the `--verify` report shows no lost words.

### In scope

| Area | Scope |
|---|---|
| Shell | Electron, layout §10, explorer + watcher, pty terminals with tabs, Monaco for md/json |
| Core | Daemon, schema + JSON Schema, operations, single writer, `revision`, history + transactions + revert, conflict handling |
| CLI | Surface in §7 |
| Media | Import, CFR proxies, waveforms, thumbnails, managed ffmpeg + whisper.cpp |
| Timeline | §10 feature set |
| Transcript | whisper.cpp provider, transcript view, strike/restore, subtitle tracks, `--verify` |
| Preview | Direct proxy playback + cached generated clips |
| Export | Segmented ffmpeg compiler, continuous audio pass, loudnorm, presets `youtube-1080p`, `youtube-1440p`, `vertical-1080x1920` |
| Plugins | API v1 for §8.2 v0.1 points, install from GitHub/npm, project trust; `@frameshell/hyperframes`, `@frameshell/whisper-cpp` |
| Agent | `skills/frameshell/SKILL.md` + plugin skills |
| MCP | `frameshell mcp` per §7b: project tools, resources, frame capture, UI state and navigation |
| Ask agent | Selection references into the agent terminal, including preview region selection (decision 21) |
| Platforms | macOS + Linux stable, Windows beta, CI on all three |

Estimate: 3–5 months for one developer. First cuts if needed: overlay transform (stack only) and the vertical preset.

---

## 12. Roadmap

| Version | Content |
|---|---|
| **v0.2** | `@frameshell/remotion` adapter; `livePreview()` for the active clip; opt-in proposal mode per transaction; cloud transcription providers (OpenAI, Deepgram, ElevenLabs Scribe) |
| **v0.3** | Transitions and keyframes; effects/LUT extension point; UI panel extension point (webviews); public plugin index website; OTIO / Premiere XML export |
| **v1.0** | Windows stable + signed; stable schema v1 and plugin API v1 guarantees; persistent terminal sessions (herdr-style) |
| **Later** | Remote/cloud daemon (render farm, team sync) as the monetization path; hosted agent; template/plugin marketplace |

---

## 13. Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| Gapless multi-clip preview (visible hiccups at hundreds of cuts) | Core UX of Case B | WebCodecs + audio-clocked worklet (ADR 0001, passes all thresholds on the 200-cut fixture); decode in a Worker so React stalls do not freeze video; preview renders stay a documented fallback |
| Word timestamp accuracy of whisper.cpp (cuts inside words) | Lost or clipped words | Mandatory snapping of every cut to the interior of an energy-detected pause (±500 ms window); DTW onsets required; word `end` derived from energy; never cut at raw engine times (ADR 0003) |
| Retake silently dropped from transcript (whisper can collapse a repeated phrase) | Repeated take kept or wrong take cut | `--verify` on every export; pause-based cut candidates that do not rely on text alone |
| VP9 alpha is 4:2:0 and lossy | Soft coloured text in overlays | Optional ProRes master render for export only (~+22 s per 8 s clip, ADR 0002) |
| ffmpeg graph size with hundreds of cuts | Slow or failing exports | Segmented video render + concat; continuous separate audio pass; golden tests |
| VFR sources drifting from transcript/cut times | A/V desync in long videos | CFR proxies at import; transcripts measured on proxies; export maps times on the same clock |
| Scope for a solo developer | MVP slips | Scenario-defined MVP; explicit cut list (§11); official plugins limited to two |
| Daemon lifecycle (stale sockets, version skew after update) | "App won't connect" | Version handshake, socket cleanup on start, `frameshell doctor` |
| Plugin security (projects declaring plugins) | Code execution from untrusted projects | Project trust prompt; plugins pinned; docs guidance; sandboxing evaluated post-v1 |
| HyperFrames maturity / API churn | Adapter breakage | Pin version per project; adapter isolated behind plugin API |
| Remotion licence (paid for companies > 3 people) | User confusion | Optional adapter, documented licence notice; never a core dependency |
| Binary download sources disappearing | First run broken | Mirror on GitHub Releases; checksums; system override |
| Windows ConPTY quirks with agent CLIs; path quoting in ffmpeg | Windows bugs | Beta label; CI on Windows from day one; args passed as arrays, never shell strings |
| Schema evolution breaking projects and agents | Data loss / agent confusion | `schemaVersion`, migrations with backup, published JSON Schema per version |
| Electron size and memory | Perception | Accepted trade-off; lazy-load Monaco and heavy panels |

---

## 14. Open items (non-blocking)

- Idle gap for automatic transaction grouping (start at ~10 s, tune with real agent sessions).
- Subtitle style presets and ASS generation details.
- Plugin index hosting (static site generated from GitHub topic search).
