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
| **A: Scripted / motion video** | Explainers, tutorials, product demos, shorts. Built from a script, assets, voice-over, subtitles and code-based motion graphics (HyperFrames, Remotion). The spine may also be an audio recording and its transcript, from subtitles on a background to a full explainer (ADR 0015). | "Turn `scripts/launch.md` into a 60 s 9:16 promo." / "Make an explainer video for `podcast.mp3`." |
| **B: Transcript-driven footage editing** | Long recordings (talks, YouTube videos) cut by the agent from a word-level transcript: silences, repeated takes, intro, subtitles, loudness. | "Edit this video, add the intro, remove silences, prepare it for YouTube." |
| **C: Conversations with several people** | Podcasts, interviews, panels and recorded calls with one picture per person. A rule-based director cuts to whoever speaks, two-shots and wides; the agent reviews doubtful shots; the human corrects with number keys (ADR 0016). | "Build the multicam, interview style, and remove the silences." |
| **D: Images** | One picture made of layers: posters, thumbnails, social cards. The project's `kind` is `image`; its first frame is the picture and its video tracks are layers. The UI hides time, shows a Layers panel and exports PNG, JPEG or WebP (ADR 0017). | "Make a YouTube thumbnail from `photo.jpg` with this title." |

Case B follows the workflow published by Facundo Corengia ("El prompt para no editar más"): the agent edits and the human's only job is to watch it once and correct. Frameshell makes that review step visual and reversible.

Out of scope: a manual, Premiere-style NLE for multi-hour 4K footage (color grading, advanced keyframing); switching shots live during a call; AI avatars.

---

## 2. Decision log

| # | Topic | Decision | Rationale | Rejected |
|---|---|---|---|---|
| 1 | Use case | A (scripted/motion) + B (transcript-driven editing) + C (conversations, ADR 0016) on one model | The agent does the heavy lifting and the human reviews; both cases share "clips on tracks" | Classic manual NLE |
| 2 | App format | **Desktop app: Electron + React + TypeScript** | Real terminal (node-pty + xterm.js, same as VS Code); bundled Chromium + Node, both required by HTML/React video engines; proven IDE pattern | Tauri (per-OS webview codec issues, Node sidecar anyway, Rust), Flutter desktop (Remotion player would need a webview, weak terminal), VS Code extension (webviews lack H.264, panel-bound UI), plain local web app |
| 3 | Source of truth | **Declarative timeline JSON**; clips reference media or compositions of any engine through **adapters** | Human and agent edit the same structured data; moving a clip = changing a number; not tied to one engine | Remotion TSX as truth (timeline edits would require rewriting arbitrary code), OTIO native (verbose, poor fit for code compositions; export only) |
| 4 | Preview | **Hybrid**: `media` clips play directly from proxies; generated clips play from a per-clip render cache; live preview of the active clip later | Preview matches export; a new engine works with `render()` only | All-live multi-engine sync (hard, preview/export drift), render-only (too slow to feel live) |
| 5 | Final export | **ffmpeg as compositor**; core compiles timeline → ffmpeg graph, rendered in segments | Minutes, not hours, for 30-min cut videos; loudnorm/atempo native; engines only produce clips | Remotion as full compositor (frame-by-frame capture, licence leaks into core), MLT (painful cross-platform bundling, second model to sync) |
| 6 | Agent integration | **`frameshell` CLI** and **MCP server** as equal first-class paths, both clients of the daemon; direct file edits allowed (guarded by `revision`); bundled **agent skill** | Validated ops, low token cost, works with any agent or script (CLI) and with typed tools for MCP clients; each op is undoable | File-only (invalid JSON, token-heavy, races), MCP-only (excludes scripts) |
| 7 | On-disk format | **JSON + published JSON Schema**, split files (see §5) | Agents edit JSON reliably; small diffs; nested sequences; transcripts isolated | YAML (type gotchas; comments lost on rewrite anyway), single file (huge diffs) |
| 8 | Time unit | **Decimal seconds**, snapped by core to project frame grid, 3 decimals; **CFR proxies** for VFR sources | Native to humans, agents, whisper and ffmpeg; VFR (OBS, phones) handled at import | Integer frames (conversions everywhere, fps change rewrites all), rationals (hostile to agents) |
| 9 | AI | **Bring your own agent**: no built-in LLM. The UI injects context references from the user's selection into the agent terminal (decision 21) | Zero model cost; does not compete with agents that improve monthly | Built-in chat/agent |
| 10 | Media AI services | **Transcription is first-class** (`frameshell transcribe`, provider interface, whisper.cpp default, `--verify`). **Speech from text is a provider interface too** (`frameshell voiceover generate`, ADR 0034; no voice shipped). Video, image, music = assets produced by the agent | The data model needs word timestamps in one format; a voiceover needs a cache, trimming and a cost check every agent would otherwise reinvent; everything else changes too fast to own | Everything built in, nothing built in, TTS only through the agent (decision 10 before ADR 0034) |
| 11 | Licence | **Apache 2.0** + protected "Frameshell" trademark + DCO | Adoption and ecosystem over protection; patent grant; monetize via services | MIT (no patent grant), GPLv3/AGPLv3 + CLA (lower adoption) |
| 12 | Native binaries | **Downloaded on first use**: pinned versions + checksums (ffmpeg GPL build with x264, whisper.cpp, whisper models). Override with system binaries. `frameshell doctor` | Small installer; controlled versions; x264 quality; Frameshell does not redistribute GPL binaries | Bundled in installer (size, GPL obligations), system only (version chaos) |
| 13 | Plugins | **Node/TS packages** + `frameshell-plugin.json`; official adapters built on the same API; GitHub topic discovery; per-project pinning; project trust | herdr-style zero-friction ecosystem; API proven by first-party plugins; every plugin teaches the agent via its skill | Curated marketplace, UI extension points in MVP |
| 14 | Scripts | **Markdown with optional conventions** (`##` = scene, optional frontmatter); clips carry `scriptRef` | Free writing; traceability when useful; generation stays with the agent | Structured script format |
| 15 | Agent changes | **Applied immediately, grouped in transactions**; history with author; diff review; revert whole tx or single ops. Opt-in **review mode** per project, off by default (ADR 0019): changes not made in the app wait as one proposal per transaction, accepted or rejected whole | Keeps autonomy (agent works for an hour unattended) and adds review afterwards; `history --since` lets the agent resume from human edits; who wants to see changes first turns one switch | Plain undo, review as the default, a per-transaction opt-in chosen by the agent |
| 16 | Platforms | **macOS + Linux stable, Windows beta**; CI on all three from day one | Focus plus early detection of OS assumptions; signing cost only on macOS at v0.1 | macOS only, all three stable |
| 17 | Layout | **Terminal right (full height), preview + editor tabs center, timeline bottom, explorer/history/plugins left**. Any panel can be **detached** into its own window (sharing the project window's state) and docked back, or maximized in place (ADR 0012) | Agent, preview and timeline visible together; a second monitor holds the preview or the agent | Terminal tabbed with timeline, free docking |
| 18 | MVP | **End-to-end Case B scenario + one adapter (HyperFrames)** | Validates the core loop with a real workflow; HyperFrames is Apache 2.0, HTML, agent-friendly | Feature-list MVP, Remotion first |
| 19 | Core process | **`frameshelld` daemon** per user, JSON-RPC + events over local socket; UI and CLI are clients | Renders survive closing the window; single writer; agent works with app closed; MCP/cloud become more clients | Core inside Electron, dual cores with file locks |
| 20 | MCP scope | **Project + observe + navigate**: every core operation as a typed tool, frame capture as images, what is at a point of a frame (clip stack and composition element, ADR 0011), UI state (playhead, selection, open tab) and navigation (seek, play, select, open file, show transaction diff) | Model can see what it built and resolve "this" from the user's selection; UI actions are already core operations | Project-only (model edits blind), full UI automation (clicks/drags: fragile, adds no capability) |
| 21 | Chat about this from selection | **"Chat about this" action** (Cmd/Ctrl+L, context menu; "Hablar de esto" in the Spanish UI, ADR 0025; "Copy reference" under it puts the same text on the clipboard) writes a compact text reference of the current selection into the active agent terminal's prompt, unsent. Selectable: clips, words/subtitles, time ranges, assets, script scenes, a **rectangular region of the preview frame**, and **picked points**: the clip stack and the composition element under a pixel (ADR 0011) | Removes "which one?" round trips; plain text works with any agent CLI; ids let the agent fetch detail via CLI/MCP | Agent-pull only via `ui_state` (user must still explain), chat panel (decision 9) |
| 22 | Video from audio | **Part of case A**: new project from an audio file; a built-in subtitles-on-background video with no agent; for richer videos the agent writes a scene plan tied to transcript words before generating clips; audio is edited before visuals (ADR 0015) | Same tools as case A; the simple level is deterministic and must work without an agent | A separate use case, agent-made simple level, clips anchored to words, AI avatars |
| 23 | Multicam | **Multicam group + program track** of shot clips; a deterministic director (`frameshell direct`, `director.json`) proposes shots with a confidence, the agent reviews doubtful ones, the human corrects with number keys and a multicam viewer (ADR 0016) | One shot change is one clip edit; reproducible over hours of conversation; review stays cheap | One track per person with split clips, agent picks every shot, live switching |
| 24 | Transitions | **A property of the clip edge**: optional `dissolve` (on the incoming clip), `fadeIn`, `fadeOut`, centered on the cut, using handles; short handles shorten the dissolve or turn it into a dip through black, never fail; one schema function computes what plays; audio crossfades equal-power; multicam shots keep hard cuts (ADR 0018) | Clips stay butted, so the no-overlap invariant and every ripple operation stay as they are; an agent sets a dissolve with one time | Overlapping clips on a track, a transition list per track, failing on short handles, `xfade` |
| 25 | Keyframes | **Optional `keys` per property** (`x`, `y`, `scale`, `opacity`, `gain`) on the clip's own clock (the seconds `in` counts), ease `linear`/`in`/`out`/`in-out`, held outside; a keyed property ignores its static value; one evaluator in `composite.ts`, export expressions pinned by a parity test (ADR 0018) | Keys stay on their frames through trim, split and ripple cut; four eases are easy to hand-edit and to write as ffmpeg expressions | Keys in seconds from `start`, Bézier curves, a keyframe lane in v0.13 |
| 26 | Element adjustments | **Optional clip `elements`** (CSS selector → `x`, `y`, `scale`) applied as one host-made CSS sheet over the composition, live and in the render; source untouched; journaled `clip.set`; part of the render key (ADR 0021) | Works for script-made and animated elements and for both adapters; undo, history and review mode come free; the agent reads one flat field | Adapter patches the source, overrides inside `props`, rotation and text in v1 |
| 27 | People | **Optional `people.json`**: each person links transcript speakers (any transcript), multicam angles and face anchors. Frameshell **suggests** links (same voice across files from CAM++ voice prints, face on screen while a voice speaks, the person behind an angle); a person or an agent confirms each. Faces recognized locally (SFace on ONNX Runtime Web) by an on-demand scan; embeddings only in `.frameshell/people/`. `people ranges` gives timeline spans per person; subtitles may show speaker names (ADR 0020) | "When does Juan speak" and "when is Ana on screen" become one command; names and references in the project file, regenerable prints outside it; without the file nothing changes | People fields in transcripts or angles, automatic assignment above a threshold, prints or cluster ids in the project file |
| 28 | Photo segmentation | **Point at parts inside a photo** in image projects: a Pick click on a still image returns three masks (part to whole) from MobileSAM, run on the managed ONNX Runtime Web in a daemon worker and downloaded on first use; the first operation is a **cut-out** layer (`image.cutout`), and background removal is a cut-out plus hiding the photo (ADR 0022). | "The person on the left" becomes addressable with no new tool to install; one operation covers cut-out and background removal | A segmentation plugin (untrusted projects lose it), SAM 2.1 tiny (3.5× the download), matting models (cannot be pointed), masked blur in v1 (needs a schema effect) |
| 29 | Shoot scripts and takes | **A shoot script** (`scripts/*.md`, `shoot: true`) written by the agent beside the person's untouched original: `**Name:**` per line, `[LABEL: …]` cues, `[FREE: …]` for unscripted speech, `follow: words\|topics`, stale check by `source_hash`. Each **take** is compared word by word against it; **every deviation is marked, none blocks**; the person accepts or records again. The newest take per scene assembles the first cut as timeline transactions. Takes and decisions in `shoots/<slug>.json` (ADR 0023) | One deterministic comparison that works without an agent; the agent sees takes and deviations and adds judgment; the first cut exists when recording ends | A fixed `frameshell-script.md`, reading the original directly, flagging only big misses, an LLM in Frameshell |
| 30 | Shoot capture | **Record in the app**: camera, screen or window, microphone, system audio (`getDisplayMedia` + `audio: 'loopback'`); a **continuous shoot session** is one multicam group, takes are ranges in it (keys T/C); per-take transcription for deviations; a resident `whisper-server` (`small-q5_1`) drives a **teleprompter** whose focus line keeps the word being said centered (ADR 0024) | One app from script to finished video; one program track per session; live recognition never writes the project | One file set per take, external recorders only, browser speech recognition, the macOS system picker |
| 31 | Asset provenance | **Optional `credits.json`** at the project root: per outside asset the source URL, licence, author, title and content hash, written by `import --source-url --licence --author` or `credits set`. `credits` judges every placed asset and **fails when one is unverified** (no entry, no licence, a licence that needs credit without an author, changed content); the credit text for the video description is built from the ledger (ADR 0026) | An agent that forgets where a file came from cannot ship it unnoticed; CC BY credits stay correct because the line is derived, not typed | A field per asset in the timeline, `assets/CREDITS.json` (ingested as media), a stored pass/fail |
| 32 | Formats | **One edit, several formats**: `frameshell.json` `formats` (primary first, equal to `resolution`; built-in `16x9`, `1x1`, `4x5`, `9x16`, custom ids allowed). In a non-primary format untransformed footage covers the frame (crop around the centre; sources with alpha on upper tracks are fitted whole), generated clips render at its size, vertical captions are 1.3x; one pure `resolveFormat` feeds export, `frame` and the preview; the format owns the frame, a preset its codec; sparse per-format overrides later, never of timing or audio (ADR 0027) | Cuts, captions and audio stay one source of truth; the multicam `reframe` model (intent in data, layout per output) already works | A timeline per format nesting the edit (cannot re-block footage), forked timelines (drift), automatic layout only (no per-format handle) |
| 33 | Style guide | **Optional `style.json`** at the project root: brand, colours (hex), fonts (project files under `assets/fonts/` or bundled OFL faces), type sizes, a **motion personality** (playful, premium, corporate, energetic, calm) with field-by-field overrides, sound levels relative to the voice and voice-chain defaults, platforms by name, notes, rules and a banned list. Every value resolves with its source (file, personality, default). User styles are copied in, never inherited; safe zones are core data per platform, named not copied (ADR 0028) | Values are numbers agents and checks can read; a project renders the same on any machine; the loudness target stays `export.loudness` | Live inheritance from a user style, prose notes, a JSON + Markdown pair, safe zones per style |
| 34 | Markers and beats | **Timeline markers** (`markers`: id, `at`, label unique ignoring case, colour) that ripple with `cut` like clip starts and are deleted inside a cut range; a **beat grid measured per music asset** in a versioned `beats/<stem>.beats.json` with human corrections, mapped to the timeline through one chosen music clip (`tempo.clip`, nominal `bpm` fallback); energy snapping stays first, beats and markers are opt-in snap targets; names as times through one TimeRef contract (ADR 0029; slices 1, markers, and 2, the beat detector with `beats.measure` and `beats.show`, built; TimeRef for seconds and markers built with ADR 0037) | Moments get names the person and the agent share; a grid that belongs to the music follows it through moves, trims and speed changes, like words follow their clips | One grid in the timeline file, beats stored as markers, markers fixed on timeline seconds, a learned detector first |
| 35 | Shaped transitions | **A shape on the dissolve**: optional clip `shape` (`wipe`, `push`; iris, zoom, slats and grid later) qualifies the incoming clip's `dissolve`, chosen by cause; one pure `shapeAt` gives offsets and frame rectangles to export (`overlay` expressions, a `geq` alpha step) and preview (Canvas 2D clip paths); a shape with no handle holds the edge frame instead of dipping; `transition.set` warns on three of a kind in a row or more than a third hard cuts (ADR 0030) | Every ADR 0018 rule (edge ownership, handles, `edgeTransitions`, equal-power sound, patches) comes free; no WebGL, no new binary; a timeline without `shape` exports byte for byte as before | Recipes on keys only (2 of 6 kinds), ffmpeg `xfade` (no origin, second path to keep in parity), a WebGL shader catalogue with headless Chrome export |
| 36 | Effects on clips | **Typed, optional effect fields per kind**, one evaluator each (ADR 0031): `audio.effects` on media clips (`highpass`, `denoise`, `compressor`; `clip set --voice` writes the voice chain), baked once per asset and chain into `.frameshell/audio-fx/` and read by both preview and export; later a compositor `backdrop` blur under generated layers and a per-clip `grade` as one 3D table. Shots and angles take none in v1 | Parity by construction (same baked samples, same table); flat fields an agent writes by hand and timelines without them unchanged; clip render caches untouched | One ordered effect stack per clip with a registry, two-stage renders for glass, export-only filters, baking every effect into proxies |
| 37 | Subject matte | **Text and graphics behind the person**: a video track flagged `behind: <plateTrackId>` is turned on read into a synthetic subject layer (one pure rewrite in `composite.ts`, inside `flattenTimeline`) cut out by a **matte**, a grayscale video made once per asset content by MediaPipe's selfie segmenter (Apache-2.0) on the managed ONNX Runtime Web, smoothed over time and refined by a guided filter, cached in `.frameshell/cache/mattes/` (ADR 0032) | Plate edits never desync the subject; one rewrite feeds preview and export; the matte is regenerable derived media, never project data | A duplicate clip with a matte field, a baked VP9-alpha asset in `assets/`, MODNet (50× slower), u2net_human_seg (unlicensed weights), RVM (GPL-3.0) |
| 38 | Motion runtime | **Motion clips are HyperFrames compositions driven by a seek-only runtime** (ADR 0033): `packages/motion` (private, bundled into the plugin) binds a page to the HyperFrames clock (`window.__timelines`, `hf-seek` fallback) and writes only 2D `transform` and `opacity`, so render, live preview, Pick and element mode keep working. Spring math and presets have one source, `packages/schema` (`motion.ts`, also read by the style personalities of ADR 0028); no GSAP in Frameshell templates. Templates ship (`hyperframes new --template`, `hyperframes update` refreshing frozen runtime copies, typed props, `pick` per format, brand tokens read from `style.json` at scaffold); a core determinism verify and format/style injection are later slices. | One pure function of time per frame means preview, render and reseek agree; no third render pipeline; frozen per composition, so a plugin upgrade never re-renders old clips | Own adapter with its own capture, a `motion` clip type delegating to the producer, React hooks on the Remotion adapter, GSAP in templates (Prohibited Uses clause) |
| 39 | Voiceover | **Voiceover from text through our own `SpeechProvider` contract** (`contributes.speechProviders`, `registerSpeechProvider`); a **voiceover script** (`scripts/*.md`, `voiceover: true`) read with the shoot-script line rules, each line with a display form and a spoken form (respellings `{display\|spoken}`, numbers spelled out); one take per line in `assets/voiceover/<script slug>/<line id>.wav`, cached by a key stored inside the take, head and tail silence trimmed, imported together; a paid provider generates nothing until the person confirms the cost (`--yes`); first real provider a machine-level `command` in the global `config.json` only (`speech.command`, never `frameshell.json`); a provider with no cost estimate counts as paid unless it declares `free: true`; cloud keys from environment variables; Kokoro later behind a spike, no GPL G2P (ADR 0034) | Core owns what every voice needs (cache, trim, split, misread check, placement) and stays testable with a stand-in; voice churn stays in providers; nothing paid runs twice or unconfirmed | Agent-made narration only, Kokoro in core now (Spanish G2P is GPL), takes in `.frameshell/cache`, a hash index outside the takes |
| 40 | Blender clips | **An official `@frameshell/blender` adapter** renders a frame range of a `.blend` (clip `source`) with **the person's own Blender**, never downloaded or shipped, into the clip cache as VP9 alpha WebM (ADR 0035): drafts (EEVEE or Workbench) by default, finals only with `quality: "final"`; Blender 4.5 LTS and 5.x; scene fps must equal the project's; props are `scene`, `camera`, `quality` and no agent Python; the Blender version is in the render key | The timeline stays the source of truth: only the edited clip re-renders, history and review work as for any generated clip, and preview and export need nothing new; no GPL code ships | A managed Blender download (dmg extraction, version skew with the person's saves), a skill-only playbook with renders imported as media, a community plugin |
| 41 | Project config in history and review | **One config journal of keyed operations** (ADR 0036): `.frameshell/history/project.config.jsonl`, separate from the timeline journals, one line per change of a config document (`doc`, `patch` of keys such as `format:<id>` and later `style:<path>`, `tx`, hash chain); a pure `planConfigRevert` mirrors `planRevert`; config operations join the caller's transaction, show in every timeline's `history`, and `revert`/`tx abort` undo them. Review mode holds them as a `config` part of the transaction's one proposal (slice 2); old lines are read, never migrated | Same semantics as timelines for revert, rebase and stale; fine-grained keys, so an agent's added format never conflicts with the person's; one mechanism for formats and `style set` | Whole-document snapshots (any edit stales a proposal), config ops in a timeline journal, replaying stored undo calls |
| 42 | Fit music to the cut | **`music.fit`: one mutating method on existing clip fields** (`start`, `in`, `speed`, a 5 ms `fadeIn`, `fadeOut`, gain keys), `dryRun`/`skip` like `cleanup`, one transaction `Music fit: …` (one proposal in review mode): back-time the track so its final hit lands on `--end` (a marker or a second, through the shared **TimeRef** resolver), `--exact` varispeed through the clip `speed` within a hard ±1.7 %, a hit found on the energy envelope with a confidence (low never varispeeds), candidates as muted tracks matched by a cached per-asset EBU R128 measurement, drop and ending as gain keys marked `auto: "music"`, duck re-run when the clip carries duck keys; grid moves wait for the beat grid; built in slices, slice 1 (TimeRef, seconds and markers) done (ADR 0037) | A fit is arithmetic the agent should not redo per call, and one `revert` undoes it; no schema field before the drop slice, so older versions open the timelines; one resolver for every named time | An agent playbook with a read-only analyse method, a tape-resample flag in v1, a timeline "variant" concept for candidates, a second beat grid inside the ticket |

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
- Transport: Unix domain socket (macOS/Linux), named pipe (Windows). JSON-RPC 2.0 plus server-pushed notifications (`timeline.changed`, `job.progress`, `history.appended`, `asset.changed`).
- Handshake: client sends protocol version; incompatible → clear error with upgrade hint.
- Lifecycle: auto-started by CLI or app if absent; exits after an idle timeout with no clients and no running jobs.
- Owns every write to project files. Renders, transcriptions and exports continue if the window closes.

### 3.2 Electron app

- Main process: one window per project plus its detached panel windows (ADR 0012), node-pty terminals (a terminal lives until closed, also across moves between windows; sessions die with the project window), custom `frameshell-media://` protocol serving proxies with HTTP range support.
- Each pty receives `FRAMESHELL_SOCKET`, `FRAMESHELL_PROJECT` and `FRAMESHELL_SESSION` env vars, so a CLI call from that terminal is attributed to that session.
- Renderer: React UI; subscribes to daemon events; sends operations, never writes files.

### 3.3 CLI `frameshell`

- Thin client of the daemon; starts it if needed.
- Human-readable output by default, `--json` for agents and scripts.
- Errors are actionable (what failed, valid range, suggested command).

### 3.4 Preview

- `media` clips: proxies decoded with **WebCodecs** (`VideoDecoder`) from the keyframe before each in-point, pre-roll discarded, frames drawn to a canvas on the **audio clock**. Decode and draw run in a Worker with `OffscreenCanvas`. Program audio comes from a PCM sidecar mixed in one `AudioWorklet` with its own sample counter and 2 ms edge fades; all audio tracks mix in the same worklet. Double-buffered `<video>` elements were measured and rejected (ADR 0001).
- Generated clips (`hyperframes`, `remotion`): played from cached renders: `.frameshell/cache/clips/<hash>.webm` (VP9 with alpha) or `.mp4` (H.264) when opaque (ADR 0002). While a render is pending, show a slate with progress, or the clip's live page (next item).
- Overlays: CSS/canvas compositing with the clip `transform` (position, scale, opacity), or its `keys` evaluated at each frame (`placementAt` in `composite.ts`, ADR 0018).
- Transitions (ADR 0018): the incoming clip of a dissolve plays on a second decoder slot of its track during the overlap, primed from its handle by read-ahead; opacities come from the same transition weights as export. The audio plan gives each span a gain envelope (gain keys, fades, equal-power crossfades) applied per sample on top of the edge fades. A shaped dissolve on the bottom track (ADR 0030) leaves both pictures opaque: `spanShape` (from `shapeAt`) moves each one and cuts the incoming one to a frame rectangle with a Canvas 2D clip path; sound still crossfades, and frames before the source's start or past its end hold its edge frame (sound there is silence).
- Subtitles: rendered in the DOM from the transcript, same style tokens as export.
- A **9:16 frame** toggle shows a landscape project as the `vertical-1080x1920` preset exports it: the engine lays layers out at that canvas size as export does, so multicam shots show their reframed cuts. Placement handles, the pick tool and live pages work in the project frame and are off in it. The shot inspector sets the reframe point of each cut angle at the playhead (`multicam.reframe`).
- v0.2: `livePreview()`: while a generated clip's render is not ready, the preview plays its composition live in a sandboxed iframe (HyperFrames' runtime; the Remotion adapter's own bundle, driven through Remotion's frame globals), seeked to the playhead, when it is the topmost layer. The ready render always wins (ADR 0010).

### 3.5 Export pipeline

1. Resolve timeline (nested timelines flattened, subtitle words resolved).
2. Ensure every generated clip has a fresh cache entry (render missing ones via adapters).
3. **Video:** split the timeline into segments at clean boundaries, compile each to an ffmpeg `filter_complex` (`trim`, `setpts`, `scale`, `overlay`, `subtitles`/`ass`), encode segments in parallel, join with the concat demuxer. Every VP9 input with alpha is decoded with `-c:v libvpx-vp9` (the native `vp9` decoder silently drops alpha). A program track stacks like any video track: each shot becomes one overlay per angle (`crop` to the tile's aspect, `scale` to the tile, `overlay` at the tile), starting when the angle's recording does; a reframed angle whose cut moves during the shot gets a `crop` whose `x`/`y` are expressions of the group second (`exact=1`), the same formula as `cropAt` in `composite.ts`; its angles' sound joins the audio pass (step 4). Keys and transitions (ADR 0018) use the evaluator of `composite.ts` written as expressions of timeline time: `overlay` x/y and `scale` with `eval=frame`, alpha ramps (`fade=alpha=1` for linear spans, an alpha expression for eased keys). A dissolve's incoming piece is overlaid on the outgoing clip's extended tail on every track, bottom track included (no `xfade`); a segment boundary may fall inside it because every expression reads timeline time from the piece's start. A parity test pins the expressions to the evaluator. Shaped dissolves on the bottom track (ADR 0030) write `shapeAt` the same way: a push turns both pieces into layers whose `overlay` x/y add the offset (the base is black under them); a wipe adds a `geq` alpha step to the incoming piece only (about 34 ms per 1080p frame); frames past a handle hold the edge frame (`tpad` clone), and the sound of a head before the source's first sample is padded with silence (`adelay`).
4. **Audio:** one continuous pass (not segmented, avoids clicks at segment joins): `atrim` + short `afade` at every cut, `atempo`, `amix` (dissolves and fades: `afade` with the `qsin` curve over the effective length, the outgoing clip trimmed past its `out` into its handle; gain keys: `volume` with `eval=frame`, ADR 0018), rendered once to a lossless intermediate, then two-pass `loudnorm` reading that file (ADR 0005). Target: preset `loudness`, else project `export.loudness`, else −17 LUFS integrated. In the primary format, sources whose aspect ratio differs from the frame are letterboxed/pillarboxed. In any other format of the project (ADR 0027), a media clip with no transform and no picture keys covers the frame: the centre of its picture with the frame's aspect is cropped (`crop` in source pixels) and scaled to fill it; transformed clips keep their fit, and so do sources with an alpha plane on upper tracks (titles, lower thirds, PNG overlays: fitted whole, never cropped, until per-format overrides), multicam shots their own tile layout, generated clips are rendered at the format's size. Subtitles in a vertical non-primary format are 1.3x larger. `render --formats` runs one job per format, each file suffixed `-<format>`.
5. Mux, apply preset (codec, bitrate, loudness). The format owns the frame size: a preset of the format's aspect may scale it (when asked for, or in the primary format), a preset of another aspect asked for is refused (ADR 0027).
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
│   └── voiceover/<script>/    # one generated take per voiceover script line (ADR 0034)
├── compositions/
│   ├── hyperframes/intro/     # HTML compositions
│   └── remotion/              # Remotion project (ADR 0009); clips may also point at one outside the project
├── transcripts/
│   └── raw-01.words.json      # word-level transcript per asset
├── director.json              # optional: multicam director rules on top of a template (ADR 0016)
├── beats/<stem>.beats.json    # optional: beat grid of a music asset, with human corrections (ADR 0029; versioned, never swept)
├── people.json                # optional: who is who across transcripts, angles and faces (ADR 0020)
├── credits.json               # optional: source, licence and author of third-party assets (ADR 0026)
├── style.json                 # optional: style guide (colours, fonts, type, motion, sound, platforms, rules; ADR 0028)
├── shoots/<script>.json       # optional: takes, chosen takes, accepted deviations of a shoot script (ADR 0023)
└── .frameshell/               # gitignored
    ├── cache/clips/           # rendered generated clips (regenerable)
    ├── cache/mattes/          # subject mattes per asset content, model and fps (ADR 0032; regenerable)
    ├── proxies/               # CFR preview proxies (regenerable)
    ├── beats/                 # onset envelopes of the beat detector (ADR 0029; regenerable)
    ├── audio-fx/              # clip audio effects baked per asset and chain (ADR 0031; regenerable)
    ├── waveforms/, thumbs/    # regenerable
    ├── history/               # local operation journal + head snapshot per timeline (not shared; loss = loss of undo only)
    ├── review/<n>/            # `frameshell review` sheets, strips and `review.json`; the last 10 runs (regenerable)
    ├── rejected/              # refused direct edits kept for recovery
    ├── rejected.jsonl         # why each was refused (listed by `status`)
    ├── proposals/             # review mode (ADR 0019): open proposal, decided ones for 7 days, decisions.jsonl
    └── people/                # face scans, voice prints, clusters, thumbnails (ADR 0020; regenerable)
```

### 5.2 `frameshell.json`

```json
{
  "$schema": "https://frameshell.dev/schema/v1/project.json",
  "schemaVersion": 1,
  "name": "Launch video",
  "kind": "video",
  "fps": 30,
  "resolution": { "width": 2560, "height": 1440 },
  "formats": [
    { "id": "16x9-1440", "width": 2560, "height": 1440 },
    { "id": "9x16", "width": 1080, "height": 1920 }
  ],
  "sampleRate": 48000,
  "main": "timelines/main.json",
  "plugins": {
    "@frameshell/hyperframes": "0.1.0",
    "@frameshell/whisper-cpp": "0.1.0"
  },
  "transcription": { "provider": "whisper-cpp", "model": "large-v3-turbo-q5_0", "language": "es" },
  "binaries": { "ffmpeg": "managed" },
  "export": { "defaultPreset": "youtube-1440p", "loudness": -17 },
  "editing": { "snapWindow": 0.5 }
}
```

`kind` is `video` (the default when absent) or `image` (ADR 0017).

`formats` (optional, ADR 0027) lists the delivery formats of the one edit, primary first: the first equals `resolution`; ids are unique, lowercase letters, digits and `-` (not `png`, `jpg`, `jpeg`, `webp`); the built-in ids `16x9` (1920x1080), `1x1` (1080x1080), `4x5` (1080x1350) and `9x16` (1080x1920) keep their canvas; sizes after the first are even. Absent: one format, the resolution, named by its built-in id or `<width>x<height>`. Image projects take none. Edited with `frameshell format add|remove` (journaled in `.frameshell/history/project.config.jsonl`, undone by the call each change returns, not `revert`; while review mode is on only the person in the app may) or by hand. The schema is strict, so hosts older than ADR 0027 refuse a project that has it.

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
- **Track mute and hide:** optional `muted: true` on a video, audio or program track silences the whole track, whatever its clips', angles' or mics' own `audio`; optional `hidden: true` on a video or program track leaves its pictures out (the tracks below show through, the first shown video track is the bottom layer) while its sound plays and its clips still count for the timeline's length. Absent = false; `track.set` stores only `true`. Export, preview and the word checks share one reading: `withTrackMutes` folds a track's mute into its clips' (a program track's: its group's sounds') `muted`, `showsPicture` says whether a track paints (`composite.ts`); a nested timeline's hidden tracks stay hidden inside its host, and every track a hidden host's nested clips add is hidden.
- **Timing:** `start` is timeline time; `in`/`out` are source time. `media` duration = `(out - in) / speed`. Generated clips carry `duration`. All times are seconds, snapped by the core to `1/fps`, stored with 3 decimals.
- **IDs:** stable, generated by core (`c_` / `t_` + random hex); hand-written ids (e.g. `v1`) are accepted in files. Agents reference clips by ID.
- **Subtitle tracks do not copy words.** A subtitle track `follows` a video/audio track: its words are the transcript words that fall inside each followed clip's `[in, out]`, mapped to timeline time. Cutting a clip automatically removes its words from subtitles. Word text corrections live in the transcript file. `style.speakerNames: true` (default false, ADR 0020) starts the first cue of each turn with its speaker's transcript name ("Juan: …") and never lets a cue span two speakers. Captions can be chosen by hand (#460): the track's optional `phrases` hold transcript word ids per asset, cut into `chunks` (one cue each, whatever `maxWords`/`maxChars` say) with at most one `keyword` and an optional per-phrase `entry`; words no phrase holds keep the automatic grouping. A chunk lasts until the next cue starts, at most 0.35 s past its last word, never under 0.4 s. `style.entry` (`none`, `chars`, `words`, `line`), `style.keywordColor` and `style.keywordScale` tune the look; optional `gaps` (`{ from, to }` timeline seconds) hide every cue that overlaps one. Preview and ASS export share the rules in `@frameshell/schema/subtitles`.
- **Nested timelines:** `type: "timeline"` embeds another timeline file as a clip.
- **Clip types:** `media`, `timeline` and `shot` are core types. Others (`hyperframes`, `remotion`, …) are registered by adapter plugins, each with its own `props` schema.
- **Multicam (ADR 0016):** `groups` (optional) holds multicam groups; a `program` track shows one group with `shot` clips:

  ```json
  "groups": [
    { "id": "g_talk", "name": "Podcast", "angles": [
      { "id": "ana", "name": "Ana", "asset": "assets/ana.mp4", "offset": 0 },
      { "id": "ben", "name": "Ben", "asset": "assets/ben.mp4", "offset": 1.48,
        "crop": { "left": 0.1, "right": 0.1 }, "audio": { "gain": -2 } } ] } ],
  "tracks": [
    { "id": "p1", "kind": "program", "group": "g_talk", "clips": [
      { "id": "c_0300", "type": "shot", "start": 0, "in": 0, "out": 4.5,
        "shot": "solo", "angles": ["ana"] },
      { "id": "c_0301", "type": "shot", "start": 4.5, "in": 4.5, "out": 6,
        "shot": "two-up", "angles": ["ana", "ben"], "confidence": 0.6, "reason": "quick exchange" } ] } ]
  ```

  - An **angle**'s `offset` is the group-clock second at which its asset's time 0 plays (source time = group time − offset, never negative). `crop` cuts fractions of the picture off each side; `reframe` (keys `{ at, x, y }`: group second, then the point of the source picture as fractions of its width and height, sorted by `at`) is where a tile that cuts the picture centers it; `audio` sets the gain and mute of its own file's sound; `screen: true` marks a screen share, which the director shows by motion and never treats as a speaker.
  - **Mics (camera sets with separate recorders):** a group may hold `mics` (`id`, `name`, `asset`, `offset`, `audio`): sound files synced like angles, any start time, no picture needed. An angle's `mic` picks its sound: absent = its own file (every file written before mics); a mic id = that mic, and the angle's own file is then silent; `null` = no sound (a wide camera). Several angles may name one mic, which plays once. Gain and mute of an angle with a `mic` live on the mic (`audio` on such an angle is invalid). Mic ids are unique among the group's angle and mic ids and are never `camera` or `none`. The group's sounds (`groupSounds` in `composite.ts`) are the own-file sound of each angle without `mic`, then every mic; export, preview and `cut` snapping play exactly those, and a group ends with its longest camera, never a mic.
  - A **shot** plays group seconds `[in, out)` from `start`; length `out − in`, never past the group's end (latest `offset` + asset length). `shot` is the layout: `solo` (one angle), `two-up` (two), `grid` (two or more), `screen` (one angle whole), `pip` (a screen angle with a second angle as an inset); `angles` are ids of the track's group, in layout order (`pip`: the screen first, then the inset), each with a picture. A `pip` shot may carry `corner` (`top-left`, `top-right`, `bottom-left`, `bottom-right`; default `bottom-right`); no other layout may. `confidence` and `reason` are set by the director and absent on shots a person chose. Shots have no `audio`, `transform` or `speed`.
  - **Shots switch pictures only:** every sound of the group (`groupSounds`: own-file sound of each angle without `mic`, then each mic once) plays under every shot, at its gain. A gap on the program track is black and silent.
  - Invariants: a program track names a group in `groups`, one program track per group; shots never overlap; angle ids are unique in their group, group ids unique among the file's ids. Subtitle tracks follow video or audio tracks only.
  - Layout (`composite.ts`, shared by export and preview): tiles cover the frame without gaps; each angle's cropped picture fills its tile, cut to the tile's aspect, centered, or centered on the angle's `reframe` point at that group second: the point moves in a straight line between keys and holds before the first and after the last, the cut's edges round to whole pixels and stay inside the angle's crop. This is how a 9:16 export (`vertical-1080x1920`) of 16:9 cameras keeps a face in a solo and in each stacked tile of a two-up; at the pictures' own aspect nothing is cut, so keys change nothing. `two-up` is side by side, stacked when the frame is taller than wide; `grid` picks the columns whose tiles are closest to the pictures' aspect, the last row centered. `screen` and the first angle of a `pip` shot are never cut: the whole cropped picture, centered, black bars where the aspects differ. A `pip` inset is 25% of the frame width (at most 40% of its height) in the aspect of its picture, 2% of the width from the edges, painted over the screen. A nested timeline's program track becomes a program track above its host video track (a renamed copy of its group carries the host's gain), or its angles' sound on an audio host. Export refuses (`ExportUnsupported`) a program track nested under a video host clip with a transform or picture keys: shots fill the frame and are not placed under one.
  - **Creating a group (`frameshell multicam create`):** cameras (video files) and optionally separate mic files (`--mic-file`) are all synced by audio against each other (`planSync` in `multicam/sync.ts`). The first file with sound is the reference; the cross-correlation of the files' audio energy envelopes (`media/energy.ts`, the cache cut snapping uses; first 10 minutes of each file, 10 ms steps refined below one step) is computed between placed and unplaced files, and the pair with the highest confidence places the next file, so a faint camera lands through the mic that hears the same room. Then all shift so the earliest starts at 0. Every file reports a confidence from 0 to 1 and the file it was matched `against`; below 0.5 against every file it is not shifted, starts with the reference, and a warning says so. `--sound` maps each camera to a mic number, `none` or `camera` (default: camera n takes mic n while there are mics). One operation (`multicam.create`) adds the group, a program track on top and one `grid` shot over the cameras' whole length. `multicam offset` sets one angle's offset by hand, `multicam mic` a mic's offset, name and level.
  - **Gallery recordings (`frameshell multicam gallery`):** one Zoom, Meet or Teams recording in gallery view becomes a group whose angles are all that file at offset 0, one per tile, each with the `crop` that keeps its tile, named in reading order (rows top to bottom, each left to right); the file's sound plays once through one group mic (`call`) that every angle takes, so its speaking turns come from the transcript's speakers (§5.4) once `transcribe --speakers` ran. Tiles are found on frames sampled across the whole file (one every second, sparser past 600 samples; at most 960 px wide, gray, managed ffmpeg): per frame, the gutter level is the brightness most flat full-length rows and columns share (up to three candidates; the one whose cut gives the most tiles wins), then a recursive XY cut trims gutter lines off the border, splits at interior gutter rows, else columns, and drops pieces under 6% of the frame. Frames with the same tiles (edges within 2% of the frame) form a layout; a layout seen in fewer than 3 samples is no grid, runs under 3 samples join the run before. A layout's tiles are its frames' median edges; a tile's confidence is the share of the layout's frames that found it times the ratio of its area to the median tile's. The angles follow the layout held longest, or the one at `--at`; every layout change is reported with its time. One operation (`multicam.gallery`) carries the crops.
  - **Speaking turns (`frameshell multicam turns`):** per angle, the 10 ms energy envelope (same cache) is cut into 50 ms frames on the group clock (the angle's `offset` applied). An angle speaks in a frame when its level is 6 dB above its own quiet threshold and within 12 dB of the loudest angle at that time (so a voice bleeding into other mics is not their turn; people talking at once overlap); a running turn holds 6 dB lower. Pauses under 0.5 s are bridged, turns under 0.3 s dropped. Each angle's sound source counts: its own file, or its mic with the mic's offset (`mic: null` has no turns). Angles that share one file, angles that share a mic whose transcript has speakers (without them they speak together: two cameras of one person), and angles naming a `speaker` take their turns from that speaker's words in the source's transcript instead (§5.4; unnamed ones take the free speakers in order, with a warning); screen angles never do. Each angle's `audio.gain` (the mic's, for an angle with a mic) is added to its levels before the comparison, so mics of very different volume are levelled with it; a pause is not bridged while another angle speaks in it. While the group has an angle that is not a screen, screen angles are not heard (their sound, often the mixed call, would mask the people's turns). Read-only method `multicam.turns`; the director consumes the same function. **Painted turns** (`group.painted`, operation `multicam.paint`, CLI `multicam paint`): stretches of the group clock a person marked as spoken or silent for one angle replace that angle's measured turns inside their range, whatever the source (energy or words), so `multicam.turns` and `direct` obey them (ADR 0016 decision 3). They live in the group, are journaled and undone like any operation, and survive re-measuring and re-directing.
  - **Directing (`frameshell direct`):** `director.json` (JSON Schema `director.json`) names a `template` (`interview` default, `podcast-calm`, `panel-dynamic`) and the rules that differ: `minShot`, `maxShot` with a `cutaway` (`listener` of highest weight, or `wide`, for `length` s), `cutLead` (the voice leads the cut), `twoShot` (`exchange`: three or more alternating turns of two people each shorter than it; `overlap`: two people at once at least that long), `wide` (`silence`, `laughter` = `together` or more people at once, capped at the group's pictured angles), `weights` per angle id (0: never alone or in a two-up), `screen` (`motion`: a screen angle that changes for at least this long is shown; `hold`: pauses in its motion shorter than this stay inside the stretch; `threshold`: mean brightness change between samples, 0 to 255, that counts as motion; `pip`: false never shows an inset; `corner`). Null switches a time rule off. Order: laughter, who speaks, overlaps and silences (shorter ones keep the shot that was on), quick exchanges, cut lead, minimum length (shortest first, into the shot before), cutaways, screens in motion, frame grid. **Screens:** angles with `screen: true` never speak and never appear in solos, two-ups or wides. Their motion is the frame difference of the angle's picture (first video stream, scaled to 64×36 gray, 4 samples a second), measured by `multicam.direct` and passed in the operation args like the turns; while a screen moves, the shot is `pip` (screen, then the person who speaks most in that stretch, in `screen.corner`) when the shot there was a solo, two-up or exchange, else `screen`; the first moving screen in group order wins. A group with no angle but screens treats them as people. One operation (`multicam.direct`) whose args carry the measured turns and resolved rules, so it is reproducible: each shot of the program track overlapping the range (timeline seconds) gives its group time to the director (back-to-back shots that play on in the group as one stretch; parts outside the range stay; gaps stay; an empty track is filled over the whole group), and the directed shots carry `confidence` and `reason`; the result lists those below 0.5. Shots a person chose are kept unless `replaceHuman`: a `shot.set` by author `ui`, and pieces cut out of it since (their group time inside its own), while they carry no `confidence`; a `shot.set` by any other author hands the shot back to the director.
  - Operations treat shots as clips: `cut` ripples the program track like any other (energy snapping listens to the angles' sound), `clip trim`/`split`/`move`/`remove` work on the group clock, `clip set` takes only `scriptRef`. `shot.set` changes a shot's layout and angles (only a layout: angles kept, cut or filled from the group in group order; only angles: the layout follows the count when it does not fit) and removes `confidence` and `reason`: the shot is now a person's. `multicam.angle` changes an angle's name, crop, own-file sound, `mic` and `screen` mark, `multicam.reframe` sets, replaces (same frame) or removes one `reframe` key, at a group second (`at`) or a timeline second (`time`, through the shot playing then), clears them, or replaces them all (`keys`; `multicam.faces` proposes them from the largest face in 2 frames per second, one operation per angle in one transaction, skipping angles with keys unless `replace`); per angle in the group, not per shot, so ripple cuts and `direct` keep them on the same picture; `multicam.offset` its sync, `multicam.mic` a mic's name, offset and sound; anything else in a group changes through `timeline.patch` (direct edits).
- **Transitions (ADR 0018):** optional clip fields, seconds: `dissolve` on the incoming clip mixes from the clip that ends where it starts on its track; `fadeIn` and `fadeOut` fade from and to nothing (black under the bottom track, transparent on upper ones, silence for sound). On an audio track, and for the sound of a clip on a video track, a dissolve is an equal-power crossfade. A dissolve is centered on the cut: the outgoing clip plays on past its `out` and the incoming clip starts before its `in` by half its length each (the **handles**: media source outside `[in, out]` divided by `speed`; unlimited for stills; the held first or last rendered frame for adapter clips; nested-timeline seconds outside the window). The file keeps the requested length; `edgeTransitions` (`packages/schema/src/transitions.ts`) computes what plays, and export, preview and engine warnings use only it: each half is cut to the handle both clips have and to half of each clip, in whole frames; no handle on either side plays a dip through black (fade out, fade in) over the clips' own frames; a `dissolve` with no clip ending at its start plays as a fade in of that length (kept, so butting the clips again restores it); any edge takes at most half its clip. Timeline length never changes. Program-track shots take none. **Shapes (ADR 0030):** optional `shape: { kind, direction? }` beside `dissolve` (required with it; the schema rejects `shape` without `dissolve` and on audio tracks) moves the pictures instead of mixing them: `wipe` (a straight edge uncovers the incoming clip) or `push` (the incoming clip slides in, pushing the outgoing one out); `direction` `left` (default: the incoming picture enters from the right edge), `right`, `up` or `down`. Progress eases in and out (f²(3−2f)). `shapeAt` in `transitions.ts` is the one geometry for export and preview. A shaped dissolve is cut to half of each clip but not to the handles: past a handle the outgoing clip's last frame or the incoming clip's first frame holds. Shapes play on the bottom video track only for now; elsewhere a shaped dissolve mixes.
  ```json
  { "id": "c_0002", "type": "media", "asset": "assets/raw-01.mp4", "start": 10.898, "in": 17.1, "out": 42.567,
    "dissolve": 0.5, "fadeOut": 1,
    "keys": { "scale": [{ "at": 17.1, "value": 1 }, { "at": 22, "value": 1.2, "ease": "in-out" }] } }
  ```
- **Keys (ADR 0018):** optional `keys` holds one list per property (`x`, `y`, `scale`, `opacity` on video tracks; `gain` in dB on both), each sorted by `at`: `{ at, value, ease? }`. `at` is on the clip's own clock, the seconds its `in` counts (source seconds for media, composition seconds for adapters, nested seconds for timeline clips), so keys keep their frames through trim, split, ripple cut and speed changes. Between two keys the value follows the first key's `ease`: `linear` (default), `in` (f²), `out` (f(2−f)), `in-out` (f²(3−2f)), f the fraction of the way; before the first key and after the last it holds. A keyed property ignores its static `transform` field or `audio.gain`; `muted` still wins. `placementAt` and `gainAt` in `composite.ts` evaluate them for export and preview; a nested clip's keys compose with its clips' at each time.
- **Audio effects (ADR 0031):** media clips may carry `audio.effects`, a list of 1 to 8 effects applied in order before gain, keys and fades: `highpass { frequency }` (Hz), `denoise { floor, reduction }` (dB, `afftdn`), `compressor { threshold, ratio, attack, release, makeup }` (dB, ratio, ms, ms, dB). Omitted numbers take the voice chain's (85 Hz; −30 dB, 8 dB; −20 dB, 2.5:1, 8 ms, 140 ms, +2 dB), which `clip set --voice` writes as explicit entries. The asset's sound is baked once per content and chain (`normalizeAudioEffects` in `packages/schema/src/effects.ts`) into `.frameshell/audio-fx/`, mono s16 on the sidecar's clock; export mixes the bake and the preview plays it as the clip's sidecar (dry until it is ready). `clip.set { audioEffects }` replaces the list, `null` clears it; shots are skipped with a warning. Energy snapping and transcription read the dry sound.
  ```json
  { "id": "c_0001", "type": "media", "asset": "assets/raw-01.mp4", "start": 0, "in": 3.2, "out": 15.733,
    "audio": { "gain": 0, "effects": [{ "kind": "highpass", "frequency": 85 }, { "kind": "denoise" }, { "kind": "compressor", "ratio": 2.5 }] } }
  ```
- **Element adjustments (ADR 0021):** adapter clips may carry `elements`: CSS selector (as Pick names it) → `{ x?, y?, scale? }`, a move in the composition's CSS pixels and a uniform scale about the element's centre. Core turns them into one CSS sheet (`elementStyles`, separate `translate`/`scale` properties with `!important`, so they add to animated `transform`). Adapters declaring `elementStyles: true` place it last in the render page; the app's live bridge places it in live pages. The source file is never changed. `clip.set` merges `elements` per selector (`null` removes one, `elements: null` all) and fails for adapters without the flag. A selector that matches nothing moves nothing and is reported; one matching several elements moves all of them.
- **Transition and key operations (ADR 0018):** `transition.set { at, kind?, duration?, tracks? }` (`kind` `dissolve` default or `fade`, `duration` default 0.5 s) acts on the clip edge at timeline second `at` on every video and audio track that has one there, unless `tracks` limits it: where two clips butt, `dissolve` sets the incoming clip's `dissolve` and `fade` sets half the length as the outgoing `fadeOut` and the incoming `fadeIn` (a dip); on a lone edge both kinds set `fadeIn` or `fadeOut`. Program tracks are skipped with a warning. `transition.remove { at, tracks? }` clears them. `clip.key { clip, prop, time, value?, ease?, remove?, clear? }` adds or replaces the key at the frame of timeline second `time` (value default: what plays there), removes it, or clears the property's keys. `clip.split` gives the left part `dissolve`/`fadeIn`, the right part `fadeOut`, the new cut none; both parts keep every key. Results carry a `warnings` entry when a transition plays shorter than stored, as a dip or as a fade in; nothing fails for lack of handles. `transition.set` also takes `kind` `wipe` or `push` with `direction` (ADR 0030): on the bottom video track (the first shown picture track, as export and preview stack them; none when a program track is first) it sets `dissolve` plus `shape`, on audio tracks a crossfade; any other video track named in `tracks` is refused, and skipped with a warning otherwise; an edge of a nested clip is refused; a lone edge fades, with a warning. `dissolve`, `fade`, `transition.remove`, split and cut clear `shape` with the `dissolve`. Every `transition.set` result warns when the bottom track's scene cuts (not jump cuts between clips of one asset) have three transitions of one kind in a row, or more than a third hard cuts.
- **Markers (ADR 0029):** optional `markers`, sorted by `at`: `{ "id": "m_1a2b3c", "at": 12.5, "label": "hook", "color": "red" }`. `at` is timeline seconds on the frame grid; ids are unique among the file's ids; labels are unique per timeline ignoring case, 1 to 80 characters with no space at either end, and never shaped like a marker id (`m_` plus hex): a reference is the id when it matches one, else the label; `color` is `red`, `orange`, `yellow`, `green`, `blue` or `purple` (absent: the app's accent). Operations `marker.add { at, label, color? }`, `marker.set { marker, at?, label?, color? }` (`color: null` clears it) and `marker.remove { marker }` name a marker by id or label; `marker.list` reads them, and `timeline.show` lists them. A `cut` of every video, audio and program track moves markers after the range left with the material and deletes those strictly inside it (a `warnings` entry names them); a marker on the range's first frame stays. `ripple` inserts move markers like clip starts, and a ripple `clip.trim` treats the material it removes like a `cut` (markers strictly inside are deleted with a warning, one on the first removed frame stays, later ones shift), in both cases only when they ripple every clip track. A cut or ripple of only some tracks leaves markers where they are. A direct edit of the file that duplicates an id or label, uses an id-shaped label or puts a marker off the frame grid is rejected like any invalid edit (`.frameshell/rejected/`); a journaled edit is written back sorted by `at`. Markers of a nested timeline stay inside it. They paint and play nothing: export and preview never read them. The app shows them on a lane under the ruler, and a dragged clip's edges snap to them. **Time references (ADR 0029 decision 7, ADR 0037):** the timeline-time arguments `transition.set`/`transition.remove` `at`, `clip.key` `time`, `clip.split` `at`, `cut` `from`/`to`, `clip.move` `start`, `clip.trim` `start`/`end`, `clip.add` `start` and `marker.add`/`marker.set` `at` take seconds or a marker id or label with an optional `+s`/`-s` offset (`hook`, `hook+0.5`, `outro-1`; the whole text is tried as a name first, so a label such as `end-card` is not an offset). The daemon resolves them against the timeline the operation applies to, in the operation's turn (so a marker added earlier in the transaction counts, and in review mode the proposal's timeline is used), before the engine runs, and the journal records seconds. An unknown name or a result before 0 fails `InvalidOperation` listing the markers. `beat:`, `bar:` and `word:` are reserved for later slices and refused until then. `TIME_REF_FIELDS` in `packages/protocol/src/timeline.ts` is the one list of these arguments.
- **Ducking (#456):** `track.duck { track, curve }` (method `track.duck { track, under, depth?, attackMs?, releaseMs?, threshold?, gap? }`, CLI `duck`) writes `gain` keys on every clip of an audio track from a dip curve the method measures from the energy envelope (`media/energy.ts`) of the `under` tracks' sound: speech above `threshold` dBFS (default -38), merged across `gap` seconds (0.6), dip `depth` dB (7) complete as the voice starts (`attackMs` 40) and gone `releaseMs` (450) after it ends. Keys are the clip's level (`audio.gain`, or its keys not marked `auto`) minus the dip, plus keys at the clip's start and end; each carries `auto: "duck"` so a re-run replaces them and leaves hand-set keys (`clip.key` clears the mark, so an edited duck key is a level the next run dips). A hand key where the dip is on is dipped too: it comes back as a duck key at the same `at` with its level in `base`, which the next run restores. The speech is measured on the timeline the operation applies to (`prepare`), at source level (clip and track gain are not counted); an undecodable file is a warning, a missing ffmpeg fails the method. Export and preview play them as any gain key; `packages/core/src/media/duck.ts` is the pure part.
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
  "edits": { "w_000002": { "text": "a todos" } },
  "speakers": [{ "id": "s1", "name": "Ana" }]
}
```

- Times are source-asset seconds (same clock as the asset's `in`/`out`), measured on the CFR proxy.
- `start` is the DTW onset; `end` is derived from audio energy (last speech frame before the next onset), because DTW gives no word end (ADR 0003).
- `assetHash` invalidates the transcript if the asset changes.
- `edits` holds human corrections (`text`, `speaker`, or both); re-transcribing keeps them where word IDs still match.
- `speakers` and each word's optional `speaker` (ADR 0016): who says it, from local speaker diarization (`frameshell transcribe --speakers`), run on demand after transcription. A speaker id stays with its person across runs (the voice sharing most words with the last run keeps its id and `name`); a speaker correction in `edits` always wins. Re-transcribing gives each new word the speaker of the old words it overlaps. Every `speaker` names an entry of `speakers`.

### 5.5 Script (`scripts/*.md`)

Plain Markdown. Optional conventions:

- YAML frontmatter: `title`, `target_duration`, `aspect`.
- Each `##` heading is a scene; its slug is the anchor used in `scriptRef` (`scripts/script.md#intro`). A `scriptRef` without `#anchor` refers to the whole script.
- A scene may name the transcript words it covers with an HTML comment right under its heading, `<!-- words: talk.words.json w_000010..w_000042 -->` (ADR 0015). Optional; a single id names one word. Word ids repeat across transcripts, so the comment names the transcript file (under `transcripts/`); the bare form `<!-- words: w_000010..w_000042 -->` works only while exactly one transcript holds both ids, otherwise it warns and places nothing. The range runs in transcript order and stays inside one transcript.
- **Shoot scripts** (ADR 0023): frontmatter `shoot: true` adds lines (one per non-blank text line), speakers (`**Name:**` at a line start, held until the next), cues (`[LABEL: text]`, never spoken; `[FREE: …]` = unscripted speech checked for presence), `follow: words|topics`, `source` + `source_hash` of the person's original (stale when it changes), and the scene's expected length from a heading timing `(0:05–0:40)`, which is left out of the scene's title and anchor. `frameshell script check <file>` validates them.
- **Voiceover scripts** (ADR 0034): frontmatter `voiceover: true` reads the script with the shoot-script line rules (one line per non-blank text line, `**Name:**`, cues never read) and adds `language`, `provider`, `voice`. Each line has an id `<scene slug>-<n>`, a display form (as written) and a spoken form: respellings `{display|spoken}` resolved to their spoken side, numbers with digits spelled out in `language` (`es`, `en`). A scene longer than its heading timing at 2.5 words/s warns. `frameshell voiceover generate <file>` says the lines.
- `frameshell script outline <file> --json` returns parsed scenes; a scene with a words comment also gets its `span`: first to last placed word on each timeline. The UI highlights the scene of the selected clip and flags scenes with no clips; the timeline shows a band under the ruler with one span per scene that has a placed word range (hollow while no clip of that timeline has its `scriptRef`), and a click on a span selects its time range and clips.

### 5.6 Schema evolution

Every file carries `schemaVersion`. `packages/schema` ships forward migrations; the daemon migrates on open (with a backup under `.frameshell/`).

### 5.7 People (`people.json`)

Optional (ADR 0020). Without it, nothing changes.

```json
{
  "schemaVersion": 1,
  "people": [
    { "id": "p_3fa2c1", "name": "Juan",
      "speakers": [{ "transcript": "transcripts/ep1.words.json", "speaker": "s1" }],
      "angles": [{ "timeline": "main", "group": "g_talk", "angle": "juan" }],
      "faces": [{ "asset": "assets/ep1.mp4", "at": 12.5, "x": 0.41, "y": 0.33 }] }
  ],
  "dismissed": ["sg_9c04e1d2"]
}
```

- `id`: `p_` + 6 hex, core-generated, stable (hand-written ids accepted); `name` unique, case-insensitive; commands take either.
- Links: `speakers` (a transcript and a speaker id; no `speaker` = every word of the transcript), `angles` (timeline, group, angle id), `faces` (**face anchors**: asset, source second, point of the face as fractions of the picture). Optional `by` on a link names the author that confirmed it. A transcript speaker, angle or anchor belongs to at most one person. A link whose target is gone is reported `missing` and ignored, never removed.
- `dismissed`: suggestion ids answered "no".
- Names only, no embeddings: voice prints (CAM++ on the transcription WAV, per speaker), face scans (2 samples a second, YuNet then SFace, per asset) and face clusters live in `.frameshell/people/`, keyed by asset hash and model ids, and are regenerated on demand. A face is a person's when it is closest to that person's anchors.
- Linking a transcript speaker, or renaming its person, writes the person's name into the transcript's `speakers` entry, so subtitles and export need no knowledge of people. Angle names are not rewritten.
- Only the daemon writes it (atomically); a hand edit is read on the next call; an invalid file fails people methods with `InvalidProjectFile` and nothing else. Not journaled, not held by review mode (ADR 0019): an agent's confirmation applies and shows as confirmed by agent. Cmd/Ctrl+Z in the People panel undoes the last people change (one step).
- **Suggestions** (`people suggest`): `speaker` (an unlinked speaker close to a person's voice print), `face-speaker` (the face on screen for most of a speaker's time in one asset), `angle` (person named like a multicam angle, with its voice and face), `face` (an unnamed cluster on screen at least 10 s). Each has a stable `sg_` id, a score and a reason; `people confirm` links, `--reject` dismisses. Nothing is linked without a confirmation by a person or an agent.
- **Ranges** (`people ranges`): merged timeline spans where a person speaks (their linked speakers' words placed by clips, their angles' turns placed by shots) or is on screen (shots showing their angles, face samples placed by clips showing the asset; occlusion by upper tracks not subtracted).

### 5.8 Style (`style.json`)

Optional (ADR 0028). Without it, nothing changes. Nothing renders from it yet: agents read it.

```json
{
  "schemaVersion": 1,
  "brand": { "product": "Acme", "hook": "Stop editing by hand.", "cta": "?" },
  "colors": { "bg": "#0b0b0f", "ink": "#f5f5f0", "accent": "#ff5a1f" },
  "fonts": { "display": { "family": "Archivo Black" }, "ui": { "family": "Inter", "file": "assets/fonts/Inter.ttf", "weight": 500 } },
  "type": { "minReadable": 30 },
  "motion": { "personality": "premium", "duration": { "quick": 0.3 } },
  "sound": { "musicUnderVoice": 14, "duck": { "depth": 9 } },
  "platforms": ["instagram-reels"],
  "rules": ["sentence case"],
  "banned": ["emoji in captions"]
}
```

- Sections: `brand` (strings; `?` = ask the person), `colors` (`bg`, `ink`, `ink2`, `accent`, `card`, `keyword`, `highlight`, hex), `fonts` (`display`, `ui`, `captions`, `keyword`: family, optional file under `assets/fonts/`, weight, tracking in em), `type` (px on a frame whose short side is 1080), `motion` (seconds), `sound` (dB under the voice, ducking, voice chain), `platforms`, `notes`, `rules`, `banned`; optional `from` (user style id and SHA-256 when copied). Unknown keys are refused.
- Resolution (`resolveStyle`, `packages/schema`): Frameshell's defaults, the motion values of the named personality (default `corporate`), then the file; objects merge field by field, lists, colours and fonts replace. Every resolved value carries its source: `file`, `personality` or `default`.
- The integrated loudness target is `export.loudness` (§5.2), never the style; an effect set on a clip overrides the style's voice-chain default.
- Safe zones are not in the style: `packages/schema/src/safe-zones.ts` holds one per platform (pixels of a reference frame the platform's app covers, `measured` or from guides); styles, formats and review name the platform.
- `style.show` resolves it; `file.write` refuses an invalid file. A journaled `style.set`, user styles in `configDir/styles/` (copied in with `from`) and captions, fonts and generated clips taking the style come later (ADR 0028).

### 5.9 Beat grid (`beats/*.beats.json`)

Optional (ADR 0029). One file per music asset, named like transcripts (`beats/<path under assets/ minus extension>.beats.json`, the extension kept when a same-name sibling owns the first name). Written by `beats.measure`, or by a generator that knows its beats with `"detector": "exact"`; versioned with the project. Without it, nothing changes: nothing on a timeline reads a grid yet.

```json
{
  "schemaVersion": 1,
  "asset": "assets/music/theme.mp3",
  "assetHash": "sha256:…",
  "detector": "onset-flux@1",
  "sampleRate": 48000,
  "bpm": 120,
  "meter": 4,
  "downbeat": 2,
  "confidence": 0.93,
  "residualMs": 4.2,
  "edits": { "tempo": "half", "downbeat": 1, "offset": 0.012 },
  "beats": [0.2, 0.7, 1.2],
  "onsets": [0.2, 0.46, 0.7]
}
```

- Times are source-asset seconds (the clock `in` and `out` count). `beats` is strictly increasing, from the first matched hit to the last, each beat snapped to a measured hit within 8 ms (else on the fitted straight grid, each computed from its index and rounded once). `onsets` are the strong hits (peaks above 0.12 of the strongest), where a sound effect lands within 40 ms.
- `bpm`, `meter`, `downbeat` (index among `beats` of the first beat that starts a bar), `confidence` (0..1) and `residualMs` (largest gap between the grid and a hit it matched) describe the measured grid; `edits` are the human's: `tempo` `double` (a beat halfway between each pair) or `half` (every other beat), `downbeat` (index among the effective beats), `offset` (seconds). `effectiveBeatGrid` (`packages/schema`) applies them in that order; nothing else re-implements them.
- Confidence under 0.5 is LOW (calm music gets a double-time grid; a downbeat can be half a bar off): `alternatives` lists the other tempi, best supported first, and snapping to beats (ADR 0029 slice 3) never uses a LOW grid unless an `edit` vouches for it. A grid from the 16 kHz fallback decode (no finished ingest) is capped at 0.45; `sampleRate` says which audio was analysed.
- A beat grid without music yet (a nominal `bpm` and `offset`) is `nominalBeatFrame`: the frame of beat i is `round(fps · 60 · i / bpm + offset · fps)`, never an added rounded step (that drifts 2 frames in 32 beats at 128 BPM and 30 fps).
- `file.write` refuses an invalid file; a hand edit of `edits` takes effect on the next `beats.show`. `.frameshell/beats/` holds only the onset envelope (`<hash>-b1-<rate>.f32`), swept by `gc` once no asset has that content; `gc` never touches `beats/`.

---

## 6. Core behaviours

### 6.1 Operations

Every change, whether from the UI, the CLI or a direct file edit, becomes an **operation**: `{ op, args, inverse, author, tx, revisionBefore }`. The daemon validates, snaps times, applies, bumps `revision`, writes the file atomically (temp + rename), appends to history and emits `timeline.changed`.

### 6.2 History and transactions

- Journal: `.frameshell/history/<timeline>.jsonl`, plus `<timeline>.head.json`, the timeline as the last entry wrote it. When a project opens, a timeline file that differs from it (edited while no daemon ran) is journaled as one `file` operation on top of it, so `revert` has no gap; content breaking a timeline rule is rejected as in §6.4. Without a matching snapshot the change stays a gap `revert` refuses to cross.
- `author`: `ui`, `cli:<session>` (terminal session), `agent:<label>:<session>` (an agent CLI ran it in that session), `file` (direct edit), `plugin:<name>`. The app detects an agent CLI (Claude Code, Codex, Gemini CLI, …) by the name of its terminal's foreground process and tags the session in the daemon (`session.tag`); Outside app terminals the agent names itself (ADR 0025 decision 6): the MCP server from the client name in `initialize` (`claude-code` → `claude`), the CLI from the agent among its parent processes, both with the labels app terminals detect (`agentCommands`, `@frameshell/protocol`). `FRAMESHELL_AGENT=<label>` overrides all of it for the CLI and MCP server (empty = not an agent). An agent's operations group with its session's, so `tx commit` from the same shell works after it quits. A save through `file.write` is the caller's (the desktop editor's is `ui`); only edits the watcher finds on disk are `file`.
- CLI ops from the same terminal session are grouped automatically into a transaction until an idle gap; `frameshell tx begin "<label>"` / `frameshell tx commit` group explicitly. Outside an app terminal the CLI generates a session id when `FRAMESHELL_SESSION` is unset: `sh-<pid>-<hash>` from its parent shell's pid and start time, stable for every call from that shell. Open transactions persist on disk (survive daemon restarts) and `status` lists them with label, session and age, so one left by a closed shell can be ended with `FRAMESHELL_SESSION=<session> frameshell tx commit|abort`; `tx abort` is all-or-nothing across timelines. `tx.begin` may set `autoCommitAfter` (seconds without an operation of its author, kept across restarts): the daemon then commits it itself, so a client crashing mid-transaction never leaves one open.
- Each UI edit command is one labelled `ui` transaction (`Move clip`, `Split 3 clips`, `Ripple trim clip`), so one undo step and a readable `history --since`; a gesture burst (a held or repeated nudge key, same clips, under 1.5 s apart) shares one (`Nudge clip`). The app begins it with `autoCommitAfter`, closes a burst before any other edit, undo, revert or save, and commits any `ui` transaction still open before its first edit or undo after a start or a lost commit.
- Mutating daemon methods accept an idempotency key (`params.idempotencyKey`); the daemon remembers recent keys per author and answers a replay with the first result, so a client retrying after a lost reply never applies a change twice.
- UI: History panel lists transactions ("agent: remove silences, 180 ops"). Actions: show diff on timeline, revert transaction, revert single op.
- Revert is itself a new operation (history is append-only).
- **Project config (ADR 0036):** changes of `formats` in `frameshell.json` (`format add|remove`) are journaled in `.frameshell/history/project.config.jsonl`, one keyed operation per line (`doc`, `patch` of `format:<id>` keys, `tx`, `txLabel`, hash chain of the document), in the caller's transaction. `history` lists them in every timeline's history (`doc` set, keys as `touched`); `revert <tx|op>` and `tx abort` undo them with the same conflict and hand-edit rules as timelines. While review mode is on only `ui` changes or reverts config until config proposals land (ADR 0036 slice 2).
- `frameshell history --since <tx> --json`: lets the agent see what the human changed since its last transaction.
- **Review mode (ADR 0019):** a per-project switch in the app, off by default, stored per user in `<configDir>/review.json` (never in project files; only `ui` sets it, through internal `review.set`). While on, a timeline change by any author but `ui` becomes a **proposal**: the transaction it joins, applied to a proposal timeline (current file plus its patches) instead of the file, kept in `.frameshell/proposals/<tx>.json` across restarts. It is building while the transaction is open and ready when it closes (commit, auto-commit, idle gap, or at once for authors without grouping). Its author's reads (`timeline.show`, `track.list`, `frame`, `inspect.point`) default to `view: "proposal"`, everyone else's to `current`; `render` exports the current timeline. One proposal at a time: other non-`ui` changes, a new `tx begin`, and its author's changes once ready fail with `ProposalPending`; `proposal.wait` blocks until `accepted`, `rejected` or `stale` (or `pending` after its timeout). A `ui` edit that touches none of the proposal's groups, tracks, clips or track order rebases it; one that does, or a replay breaking a timeline rule, makes it **stale**: closed unapplied, with the ids touched by both. Only `ui` accepts or rejects (internal `proposal.accept`/`proposal.reject`). Accept journals the operations as their author made them, each marked `proposal: <tx>`, all timelines or none; reject journals nothing. Outcomes go to `.frameshell/proposals/decisions.jsonl`, read by `status`, `proposal.status` and `history` (`proposals`). Event `proposal.changed` reports each step.

### 6.3 Asset ingestion

Watcher detects new or changed files under `assets/`. The job queue then probes them (ffprobe), creates CFR proxies, a PCM audio sidecar, waveforms and thumbnails. Proxy recipe (ADR 0001): H.264, CFR, fixed GOP 15, **no B-frames** (decode order = display order), faststart, reduced resolution. A source with alpha (VP9/VP8 `alpha_mode=1`, or an alpha pixel format such as ProRes 4444 or QuickTime Animation) gets a VP9 WebM proxy with its alpha plane instead (#90, ADR 0001 addendum), on the same frame grid and GOP, which the preview decodes like a clip render (ADR 0002). The sidecar is s16le 48 kHz PCM (~165 MiB per 30 min mono); both are regenerable. Transcription is explicit (`frameshell transcribe`), never automatic, because of its cost.

`.svg` and font files (`.ttf`, `.otf`, `.woff`, `.woff2`) in `assets/` are not media: ingest only hashes them (no probe, no derived media, no ffmpeg), `asset.list` reports them with `kind` `svg` or `font` and `state` `ready` once hashed, and `clip.add` refuses them as media clips (`InvalidOperation`, reason `not media`). Kind is decided by extension, case-insensitively.

### 6.4 Direct file edits and conflicts

The watcher sees a timeline file change that the daemon did not write:

- **`revision` equals current:** schema-validate, diff against in-memory state, record as ops with author `file`, bump revision. Invalid content is rejected with a precise error.
- **`revision` is stale:** reject. Restore the daemon's version, save the incoming file to `.frameshell/rejected/<timestamp>-<timeline>.json`, emit an event (shown in UI and returned by `frameshell doctor`/`status`). `status` reads rejections back from disk, so they survive restarts, until the kept file is deleted.
- **Review mode on (ADR 0019):** a valid edit with the current `revision` becomes a ready proposal (`Edit timelines/<id>.json`, author `file`) instead of being journaled: the daemon's version goes back on disk and the edited text is kept in the proposal. While another proposal is open the edit is rejected with reason `proposal-pending`. The offline catch-up on open follows the same rule; `file.write` by `ui` stays immediate.

### 6.5 Clip render cache

Cache key = hash(adapter name + adapter version + clip `props` + clip `elements` when present (ADR 0021; absent leaves existing keys unchanged) + content hash of the adapter's declared input files + fps and the frame size rendered). Changing a composition file triggers a background re-render of affected clips. Background renders are at the project resolution (the primary format) only; a render for another format of the project (ADR 0027) is made at that format's size on export or `frame` in it, under its own key, and `gc` keeps the renders of every declared format. Placement never re-renders; the `blender` adapter is the exception, because a Blender render covers only the part the clip plays: its declared inputs include the length rendered, so changing a clip's `in` or `duration` re-renders it (ADR 0035).

### 6.6 Project trust

On first open of a project that declares plugins, the UI and CLI ask for trust before installing or loading them. Untrusted projects open read-only for plugins (media, timeline and transcripts still work).

---

## 7. CLI surface (v0.1)

```
frameshell init [dir] [--no-skill]            # scaffold project + agent skill in .claude/skills/frameshell/
frameshell status [--json]                    # project, daemon, jobs, rejected edits, open transactions
frameshell doctor [--install] [--json]        # binaries, encoders (x264, libvpx, VideoToolbox, NVENC, VAAPI), whisper accel, the frameshell on PATH; downloads only with --install

frameshell import <file…>                     # copy/link into assets/, queue proxies
frameshell track add|remove|list …
frameshell clip add|move|trim|split|remove|set …
frameshell multicam create <asset>… [--name <angle>…] [--mic-file f… --sound s…]   # group + program track + grid shot, files synced by audio (ADR 0016)
frameshell multicam gallery <asset> [--name <tile>…] [--at s]   # group from a gallery-view call recording: one cropped angle per tile
frameshell multicam offset <group> <angle> <seconds>     # fix one angle's sync by hand
frameshell multicam angle <group> <angle> [--name n] [--crop-left f …] [--gain dB] [--mic id|camera|none] [--screen]   # rename, crop, sound, screen
frameshell multicam mic <group> <mic> [--name n] [--offset s] [--gain dB] [--muted]   # a separate mic: sync and level
frameshell multicam paint <group> [<angle>] --from s --to s (--speaking [--alone] | --silent | --measured)   # correct who speaks by hand (group seconds)
frameshell multicam reframe <group> <angle> (--time s | --at s) [--x f] [--y f] [--remove] | --clear   # where cut tiles center the angle (9:16)
frameshell multicam faces <group> [<angle>…] [--replace]   # propose reframe keys from faces, one transaction
frameshell clip reframe <clip> [--format 9x16] [--person p | --anchor 0-1]   # frame one clip for another aspect around a face, x/y keys, one transaction
frameshell shot set <shot> [--layout solo|two-up|grid|screen|pip] [--angles a,b] [--corner c]   # change a shot
frameshell multicam turns <group>                        # who speaks when, from each angle's mic (ADR 0016)
frameshell direct <group> [--template id] [--rules file] [--from s --to s] [--replace-human]   # shots from turns by director.json rules
frameshell transition set --at <s> [--kind dissolve|fade|wipe|push] [--direction left|right|up|down] [--duration <s>] [--track <id>…]   # dissolve (default, 0.5 s), fade, or a wipe or push on the bottom video track at a clip edge; default: all video and audio tracks (ADR 0018, ADR 0030)
frameshell transition remove --at <s> [--track <id>…]
frameshell marker add --at <s> --label <l> [--color c]   # named point on the timeline clock; ripples with cut (ADR 0029)
frameshell marker set <marker> [--at s] [--label l] [--color c | --clear-color] | remove <marker> | list   # <marker>: id or label
#   --at/--from/--to/--start/--end of cut, clip add|move|trim|split|key, transition, marker take a second or a marker id/label, optionally +s/-s: --at hook+0.5
frameshell beats measure <asset> [--bpm n] [--reset-edits] | show <asset>   # beat grid of a music asset into beats/<stem>.beats.json (ADR 0029); LOW confidence is flagged
frameshell clip key <clip> --prop x|y|scale|opacity|gain --time <s> [--value v] [--ease linear|in|out|in-out] [--remove] | --clear   # keyframe at a timeline second
frameshell cut [--track <id>…] --from <s> --to <s> [--no-snap] [--snap-window <s>]  # ripple cut; default: all video and audio tracks; edges snap to pauses (ADR 0003), window >= 0.5 s, default from editing.snapWindow
frameshell timeline show [--json]             # compact dump for agents

frameshell transcribe <asset> [--provider p]  # writes transcripts/<asset>.words.json
frameshell people list [--json]               # people, their links, missing links (ADR 0020)
frameshell people add <name> | rename <person> <name> | remove <person>
frameshell people link|unlink <person> (--speaker <transcript>[:<speaker>] | --angle [<timeline>:]<group>:<angle> | --face <asset>@<s>[:x,y])
frameshell people scan [<asset>…]             # background job: faces of video assets (YuNet + SFace), cached in .frameshell/people/
frameshell people suggest [--json]            # speaker, face-speaker, angle and face suggestions with ids
frameshell people confirm <suggestion>… [--reject] [--person <person>]
frameshell people ranges <person> [--on-screen] [--json]   # timeline spans where the person speaks (default) or is on screen
frameshell matte <asset>                      # background job: subject matte of a video (ADR 0032), cached in .frameshell/cache/mattes/; prints its path
frameshell transcribe --verify <export>       # lost-word report vs sources
frameshell script outline <file> [--json]
frameshell style show [--json]                # style.json resolved: each value and its source, safe zones of its platforms (ADR 0028)
frameshell voiceover generate <script> [--lines id,id] [--provider p] [--voice v] [--yes]   # one take per line into assets/voiceover/, cached, trimmed, imported; paid providers need --yes (ADR 0034)

frameshell tx begin "<label>" | commit | abort
frameshell proposal status [--json]           # review mode on/off, the open proposal, last decisions (ADR 0019)
frameshell proposal wait [--timeout s] [--json]   # block until the open proposal is accepted, rejected or stale
frameshell history [--since <tx>] [--json]
frameshell revert <tx|op>

frameshell render [--preset p] [--formats id,id] [--out file]   # export; one file per format with --formats (ADR 0027)
frameshell frame --at <s> --out <png> [--format <id>]   # composited frame, same path as MCP frame_capture; --format lays it out in a format
frameshell review [--file <video>] [--range a,b] [--sheets contact,phone,motion,seam] [--every s]   # contact sheet, phone sheet, fast-motion strips, loop seam into .frameshell/review/<n>/ (#457)
frameshell format list | add <id> [--size WxH] [--index n] | remove <id>   # delivery formats of the project (ADR 0027)
frameshell inspect --at <s> --point x,y [--segment]   # clip stack and element under a point; --segment adds the photo's masks (ADR 0011, 0022)
frameshell image cutout <clip> --mask <png>   # new layer with only the masked part of a photo, exactly over it (ADR 0022)
frameshell mcp                                # stdio MCP server (§7b)
frameshell plugin install|remove|list <spec>  # github:user/repo | npm name | local tarball (ADR 0008)
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
| **Observe** | `frame_capture(timeline, at)` returns the composited frame as an image; `frames_strip(timeline, from, to, count)` returns a contact sheet; `review(timeline | file, from?, to?, sheets?, every?)` returns the sheets of a whole film (#457): a **contact sheet** (6 tiles wide, 10 in a vertical format, 30 a sheet; frames at clip starts and ends, cuts, markers, subtitle cues, the deepest zoom of a keyed clip, and one every 0.5 s, each labelled with its time and why), a **phone sheet** (1 fps, 360 px tiles), **motion strips** (the two fastest moments by mean grey difference of sampled frames at 320 px, consecutive only on a short film or a file at its own rate; 12 consecutive frames each at 640 px) and a **loop seam** sheet (last 6 and first 6 frames), written to `.frameshell/review/<n>/` with a `review.json` manifest (sheets, tile times and tags, peaks); the last 10 runs are kept and no project file is touched. A timeline is captured frame by frame with the `frame` path (its motion sampled at most 90 times); a file is decoded by the managed ffmpeg. Rendered by the daemon with the export compiler (single-frame plan), so it works with the app closed and matches export. `inspect_point(timeline, at, x, y)` returns the clip stack under that point and, for generated clips in trusted projects, the composition element there (ADR 0011); with `segment`, on a photo in an image project, three masks of the part under the point (ADR 0022). |
| **UI state** | `ui_state()` returns playhead, selection (clips, words, time range, preview region, picked points), open editor tab and visible range. Available when the app is connected; otherwise returns `{ connected: false }`. |
| **Navigate** | `ui_seek`, `ui_play`, `ui_pause`, `ui_select` (also picked points, so the model can show what it understood), `ui_open_file`, `ui_show_tx_diff`. Routed daemon → connected UI client. Navigation only: no pixel clicks, no drags. |

Design rules:

- Tool names, descriptions and schemas are written for models: one verb per tool, explicit units (seconds), enumerated values, examples in descriptions.
- Tool outputs stay compact (ids, revision, changed ranges); large data goes through resources.
- Every mutating tool reports the new `revision` and transaction id, so the model can revert its own work.
- The UI publishes its state to the daemon; the daemon is the only broker. MCP never talks to Electron directly.
- Default project of a call without `cwd`: the project enclosing the server's directory; when that is in no project (one global server, e.g. Claude Desktop), the project of the app window focused last, named in the result. No window: the call fails asking to open a project or pass `cwd` (ADR 0014).
- CLI parity: `frameshell frame --at <s> --out <png>` and `frameshell inspect --at <s> --point x,y` exist for non-MCP agents.
- People (ADR 0020): every `people.*` method is a tool (`people_suggest`, `people_confirm`, `people_ranges`, …); a person picked in the People panel shows in `ui_state`.
- Style (ADR 0028): `style_show` reads the resolved style guide; agents write `style.json` with `file_write` until a style write tool exists.
- Review mode (ADR 0019): `proposal_status` and `proposal_wait` are tools; accepting, rejecting and turning review on or off are internal methods only the app calls, never tools.

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
    "speechProviders": [],
    "commands": ["hyperframes new"],
    "exportPresets": [],
    "skills": ["skills/hyperframes/SKILL.md"]
  }
}
```

### 8.2 Extension points

| Point | v0.1 | Contract (sketch) |
|---|---|---|
| Clip adapter | ✅ | `type`, `propsSchema`, `inputs(clip, ctx?)` (`ctx`: project dir, `ensureBinary`, additive: ADR 0035) → files affecting the cache key, `render(clip, ctx)` → `{ file, hasAlpha }`; `hasAlpha: true` ⇒ VP9 WebM with `alpha_mode=1` that plays in Chromium `<video>`; `api.refreshRenders()` re-checks keys after changes the host cannot see (code outside the project, ADR 0009); optional `livePreview(clip, ctx)` → `{ root, entry, head }`, a page the preview drives while no render is ready (v0.2, ADR 0010) |
| Transcription provider | ✅ | `transcribe(file, opts)` → words in core format |
| Speech provider | ✅ (ADR 0034) | `voices()`, optional `estimate(text, voice, opts)` → `{ cost, currency }` (no estimate and no `free: true` = paid, cost unknown), `synthesize(text, voice, opts, ctx)` → `{ file }` (mono 16-bit PCM WAV); the host spells numbers, caches, trims, writes and imports the take |
| CLI commands | ✅ | `register(name, handler)` with typed args |
| Agent skills | ✅ | Markdown shipped with the plugin; `frameshell plugin install` exposes it to the agent (e.g. linked into `.claude/skills/`) |
| Export presets | ✅ | Declarative codec, resolution, aspect and loudness settings |
| UI panels (webviews) | v0.3 | — |
| Effects / filters | v0.3 | ffmpeg filter fragments + preview equivalent |

Live pages (`livePreview`, ADR 0010). The daemon method `clip.live` asks the adapter for the page. The desktop app serves it from `frameshell-live://` into a frame sandboxed with `allow-scripts` only, over the program canvas. Rules for adapter authors:

- **Files:** `root` and `entry` are project-relative, and the page loads nothing from the project outside `root`. The network stays reachable.
- **`head`:** JavaScript text, not HTML. The app inserts it in a `<script>` at the start of the entry's `<head>` on every load. It must not contain `</script`, and it must define `window.frameshellLive = { ready, seek(seconds) }`.
- **`describe(element)`** (optional, ADR 0011): facts about a DOM element the Pick tool picked, as a JSON-safe object: `source` (project-relative file it comes from) and `components` (names of the components rendering it, outermost first). The app adds them to what it reports to the agent.
- **`seek`:** shows composition time `seconds`, as file time `seconds` of a render. The app sends only the latest seek while one runs.
- **Opaque origin:** no `localStorage`, `sessionStorage` or cookies (reading them throws), and no access to the app.
- **Sound:** keep the page muted; renders carry no audio.
- **What the app shows:** the page only while the clip's render is queued or rendering and the clip is the topmost picture. A new render key reloads it.
- **Element adjustments** (optional, ADR 0021): an adapter declaring `elementStyles: true` places `ctx.elementCss` (CSS the host made from the clip's `elements`) after the page's own styles in its render. The app's bridge does the same in live pages, so `head` needs nothing for it.

### 8.3 Distribution

- Install: `frameshell plugin install github:user/repo`, an npm package name, or a local tarball from `npm pack` (ADR 0008: copied into the project's `vendor/`, pinned project-relative with its sha256). Pinned per project in `frameshell.json`; global plugins allowed.
- Discovery: GitHub repos tagged `frameshell-plugin` get indexed automatically (herdr model). No review; trust and security guide in the docs.
- Plugins run in the daemon process with full Node access (like VS Code extensions). No sandbox in v0.1; project trust is the gate. Package lifecycle scripts (e.g. `prepare` for git plugins) run only after the project is trusted.
- Official plugins use only the public API; no private hooks.

---

## 9. Native binaries

- Managed by the daemon under the OS app-data directory, versioned (`ffmpeg/7.x/…`).
- Sources: pinned URLs + SHA-256 (sources and licences in `docs/binaries.md`). A mirror on Frameshell GitHub Releases is redistribution of GPL binaries: it ships only together with the matching source code (or a written offer), published in the same release.
- ffmpeg: GPL build (x264/x265, libvpx encoder and decoder) downloaded by the user at first run; not redistributed inside the installer. `doctor` checks libvpx.
- Headless Chrome for HTML engines (HyperFrames): managed like other binaries and passed via `PRODUCER_HEADLESS_SHELL_PATH`.
- Speaker diarization (ADR 0016): sherpa-onnx's offline diarization (Apache-2.0), upstream prebuilt CPU builds per platform, with a pyannote segmentation model (MIT) and a 3D-Speaker embedding model (Apache-2.0), about 60 MB together, downloaded from the builders on first use; not mirrored. The tool finds the speech segments; their voices come from the embedding model on the ONNX Runtime Web pin below (its native runtime gives wrong embeddings, `docs/research/diarization-embeddings.md`).
- Face detection for reframe keys (ADR 0016, `multicam.faces`): ONNX Runtime Web (MIT), the WebAssembly build from Microsoft's npm tarball, one pin for every platform, imported by a daemon worker thread (no native code), with OpenCV zoo's YuNet model (MIT), about 33 MB, downloaded from the builders on first use; not mirrored.
- Face recognition for people (ADR 0020, `people scan`): OpenCV zoo's SFace model (Apache-2.0, 38.7 MB, pinned at the YuNet commit), run by the same ONNX Runtime Web pin; voice prints reuse the diarization's CAM++ model. Downloaded on first scan; not mirrored.
- Photo segmentation (ADR 0022, Pick in image projects, `image.cutout`): MobileSAM's encoder and decoder (Apache-2.0, ONNX export pinned by revision on Hugging Face), about 45 MB, run on the same ONNX Runtime Web pin by a daemon worker; downloaded on first use, not mirrored.
- Video subject matte (ADR 0032, `matte.prepare`): MediaPipe's selfie segmenter, general 256×256 model (Apache-2.0 per Google's model card; ONNX conversion pinned by revision on Hugging Face), 0.46 MB, run on the same ONNX Runtime Web pin by a daemon worker; downloaded on first use, not mirrored.
- whisper.cpp: pinned version, prebuilt per platform. macOS (Metal) and Linux builds are compiled reproducibly by Frameshell CI and published once on a Frameshell GitHub Release (MIT licence; bytes must match the pin); Windows uses upstream prebuilt assets. v0.1 ships CPU builds on Linux and Windows; GPU builds (CUDA/Vulkan) come from a user override (`binaries.whisper-cli`). DTW and VAD behaviour changes between commits, so the version is never floating. Default model `large-v3-turbo-q5_0` (574 MB) downloaded on first transcription.
- Blender (ADR 0035): the person's own install, never managed, downloaded or mirrored. Found through `binaries.blender`; `doctor` reports its version, and a version outside 4.5 LTS and 5.x as a problem.
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

- All panels resizable and collapsible; any panel maximizes in place (Cmd/Ctrl+Shift+Enter) or detaches into its own window and docks back; `F` shows the preview full screen (ADR 0012). Panel sizes saved per project; detached windows' placement saved globally, per display set.
- **Transcript view:** words synced to the playhead; words removed by cuts shown struck through; clicking a struck word restores it (an op that re-extends or re-inserts the clip range); selecting words selects the timeline range; clicking a word seeks the playhead to it, also while playing (selecting a script heading or History row never moves a playing playhead).
- **Correcting who speaks (ADR 0016 decision 3):** in the transcript view, any selection of words (dragged here, or picked from the timeline or a subtitle cue) is said by a speaker chosen from the toolbar picker or the context menu, a new speaker included; a speaker is renamed from its label. Both are saved as transcript `edits`/`speakers` through `file.write`. On a program track, a toggle on its header opens one turn lane per angle under the shots: it shows the angle's turns (measured and painted, painted ones marked); dragging paints the angle as speaking and everyone else silent there, Shift adds the angle without silencing others, Alt marks it silent, and the context menu takes a stretch back to measured. Each stroke is a `multicam.paint` by `ui` (one per shot it crosses, one transaction). The angle panel of the shot inspector picks an angle's transcript speaker (`multicam.angle` `speaker`).
- **Timeline v0.1:** multiple video tracks (overlay transform: position, scale, opacity), audio tracks with gain and waveform, subtitle tracks. Move, trim, split, ripple delete, snapping, zoom. Generated clips show render state. Ripple trim (R toggles it, Shift when pressing an edge inverts it). Multi-select (Shift/Cmd/Ctrl+click, Cmd/Ctrl+A) moves the selected clips together. Undo and redo in the Edit menu, and their keys anywhere outside text fields.
- **Transitions and keys (v0.13, ADR 0018):** an edge with a transition is marked across the cut at its effective length; right-click on an edge adds a dissolve or a fade or removes it; selecting the mark shows kind and duration in the inspector. Keys show as diamonds on the clip; the clip inspector has an "add keyframe at playhead" button per property (position, scale, opacity, gain), the key's ease, and remove. Hidden in image projects. Dragging keys and a keyframe lane come later. A shaped dissolve (ADR 0030) shows as a dissolve; changing its length keeps its shape; choosing a shape in the app comes later.
- **Element adjustments (v0.16, ADR 0021):** in the paused preview of a trusted project, double-click a generated clip to enter its elements: the element under the cursor gets handles (body moves, corners scale uniformly), an inline element steps up to its block ancestor, Escape returns to the clip; a normal drag still moves the whole clip. While dragging, a topmost clip shows its live page with the sheet swapped live (the engine skips its render layer); a covered clip moves only an outline. Each drag is one `clip.set` by `ui`, one undo step; the clip then re-renders in the background. The inspector lists the clip's adjustments with a reset each, marks fragile selectors (no `id`, `:nth-child`) "may not follow code edits" with an Chat about this shortcut to add an `id`, and marks adjustments that match nothing. Image and video projects alike.
- **History panel:** transactions by author, diff highlight, revert.
- **People (v0.15, ADR 0020):** a People sidebar view, detachable, next to Angles. Suggestions on top (listen to the voice, see the face, Yes / No, a name for a new person), then each person: colour, linked speakers, angles and faces (agent-confirmed ones marked), seconds speaking and on screen. Clicking a person selects their words in the transcript view and their spans on the timeline (Speaks / On screen toggle); Chat about this quotes `[frameshell] person p_3fa2c1 "Juan" · speaks · 14 spans, 03:20 total`. The transcript view's speaker label menu has "Link to person"; the subtitle inspector has "Show speaker names". "Scan faces" starts `people scan`.
- **Review mode (ADR 0019):** "Review agent changes before applying", per project (project menu and History panel header), off by default. While a proposal is open, every window of the project, detached panels included, shows a bar above preview and timeline: label, author, operation count, a **Before / After** toggle (window state shared with its detached panels, so preview and timeline show the same side; After when a proposal becomes ready), **Accept** (when ready) and **Reject**. After plays and shows the proposal timeline with the History diff marks on what changes. A stale proposal shows "Out of date" until dismissed.
- **Chat about this from selection** (decision 21): Cmd/Ctrl+L or context menu on any selection focuses the active agent terminal and types a reference into its prompt without sending. Pick tool (`I`, ADR 0011): hover outlines the element under the cursor, ↑/↓ moves to its parent or child, click picks a point, Shift+click adds points (each keeps its time), drag selects a region. A point names the clip stack under it (topmost painting layer first) and the composition element there; a region names the clips it touches. In an image project a click on a photo also names the part under it (ADR 0022): photos are prepared when Pick turns on, the chosen mask is outlined, ↑/↓ steps to a larger or smaller mask, and the context menu offers "Cut out as layer". Details (full stack, element facts) and the frame capture go under `.frameshell/context/` (regenerable, gitignored, swept by `gc` after 7 days). The reference is typed at once; while a render is pending the frame is `frame pending`. Reference format, one line per selected item:
  ```
  [frameshell] subtitle "hola a todos" · 00:03:12.40–00:03:14.10 · clip c_0012 · words w_000123–w_000127
  [frameshell] region (0.62,0.08)–(0.94,0.22) @ 00:01:05.20 · clips c_0100, c_0002 · details .frameshell/context/e_0421_1.json · frame .frameshell/context/f_0421.png
  [frameshell] point (0.71,0.14) @ 00:01:05.20 · clip c_0100 hyperframes overlays/intro.html · element #scene-2 > .card > h1 "Nuevo lanzamiento" · under c_0002 media · details .frameshell/context/e_0421_2.json · frame .frameshell/context/f_0421.png
  [frameshell] point (0.21,0.48) @ 00:00:00.00 · clip c_0003 media assets/team.jpg · segment .frameshell/context/m_0_1210_1530_3.png bbox 880,610 920x2414 px (18 %) · details .frameshell/context/e_0_1.json · frame .frameshell/context/f_0.png
  [frameshell] asset assets/logo.png
  [frameshell] file scripts/launch.md
  [frameshell] clip c_0012 · media assets/raw-01.mp4 · 00:00:12.40–00:00:31.00 · track t_1a2b3c
  [frameshell] scene scripts/launch.md#intro "Intro" · 00:00:00.20–00:00:12.50 · clips c_0100, c_0101
  [frameshell] transaction tx_0042
  [frameshell] operation op_0310
  [frameshell] track v1 · video "Camera"
  [frameshell] range 00:01:00.00–00:01:12.50
  ```
  One line per item when the terminal program enables bracketed paste; otherwise items share one line (nothing is ever submitted). Control characters are stripped.
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
| Chat about this | Selection references into the agent terminal, including preview region selection (decision 21) |
| Platforms | macOS + Linux stable, Windows beta, CI on all three |

Estimate: 3–5 months for one developer. First cuts if needed: overlay transform (stack only) and the vertical preset.

---

## 12. Roadmap

| Version | Content |
|---|---|
| **v0.2** | `@frameshell/remotion` adapter; `livePreview()` for the active clip; cloud transcription providers (OpenAI, Deepgram, ElevenLabs Scribe) |
| **v0.3** | Effects/LUT extension point; UI panel extension point (webviews); public plugin index website; OTIO / Premiere XML export |
| **v0.9** | Video from audio (ADR 0015): new project from an audio file, built-in subtitles-on-background video, scene plan tied to transcript words |
| **v0.10** | Multicam (ADR 0016): one file per person, audio sync, multicam group and program track, `solo`/`two-up`/`grid` shots, `frameshell direct` with `director.json`, number-key switching and multicam viewer |
| **v0.11** | Multicam sources and shots: speaker diarization and `speaker` on words, gallery-view call recordings, camera sets with separate mics, `screen` and picture-in-picture shots with director rules for screen motion, 9:16 reframing |
| **v0.13** | Transitions and keyframes (ADR 0018): dissolves, fades from and to black, audio crossfades and fades, keys for position, scale, opacity and gain; shaped transitions in ADR 0030 |
| **v0.14** | Review mode (ADR 0019): per-project switch, agent transactions as proposals with before/after view, accept or reject, rebase or stale on human edits, `proposal wait` |
| **v0.15** | People (ADR 0020): `people.json`, voice suggestions across files, face recognition scan and clusters, voice↔face by co-occurrence, people from multicam angles, ranges per person, speaker names in subtitles, People panel |
| **v0.16** | Drag to edit composition elements (ADR 0021): double-click a generated clip, move or scale an element inside it, saved as clip `elements` (CSS selector → move, scale) applied over the source in live preview and render; HyperFrames first, then Remotion |
| **v0.17** | Photo segmentation (ADR 0022): Pick names parts inside a photo in image projects (MobileSAM masks), cut-out layer, background removal as cut-out plus hiding the photo. |
| **Next** | Shaped transitions chosen by cause (ADR 0030): wipe and push on the bottom track first; then iris with an `origin` and dip cut; then upper tracks, nested clips and the inspector; then zoom, slats and pixel grid |
| **Next** | Voiceover from text (ADR 0034): speech provider contract, voiceover scripts, cached and trimmed takes, cost confirmation; then a machine-level `command` provider, silence split and misread check, placement on markers and app UI, cloud plugins, a Kokoro spike |
| **v0.18+** | Blender clips (ADR 0035): `@frameshell/blender` renders a `.blend` range with the person's own Blender to VP9 alpha; finals, export warning for drafts, skill playbook and look sheet, fps remap and libraries outside the project follow in later slices of #482 |
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
| Scope for a solo developer | MVP slips | Scenario-defined MVP; explicit cut list (§11); official plugins limited to the ones that ship today (`whisper-cpp`, `hyperframes`, `remotion`), Blender (ADR 0035) and `packages/motion` (ADR 0033): any other goes to a community plugin |
| Daemon lifecycle (stale sockets, version skew after update) | "App won't connect" | Version handshake, socket cleanup on start, `frameshell doctor` |
| Plugin security (projects declaring plugins) | Code execution from untrusted projects | Project trust prompt; plugins pinned; docs guidance; sandboxing evaluated post-v1 |
| HyperFrames maturity / API churn | Adapter breakage | Pin version per project; adapter isolated behind plugin API |
| Remotion licence (paid for companies > 3 people) | User confusion | Optional adapter, documented licence notice; never a core dependency |
| Blender API churn between 4.x and 5.x; long final renders hold the single clip queue (ADR 0035) | Broken scripts; other renders and exports wait | Supported range 4.5 LTS and 5.x checked at start, version in the render key, opt-in real test; one clip queue in v1, a second queue or priorities get their own ticket |
| Binary download sources disappearing | First run broken | Mirror on GitHub Releases; checksums; system override |
| Windows ConPTY quirks with agent CLIs; path quoting in ffmpeg | Windows bugs | Beta label; CI on Windows from day one; args passed as arrays, never shell strings |
| Schema evolution breaking projects and agents | Data loss / agent confusion | `schemaVersion`, migrations with backup, published JSON Schema per version |
| Electron size and memory | Perception | Accepted trade-off; lazy-load Monaco and heavy panels |

---

## 14. Open items (non-blocking)

- Idle gap for automatic transaction grouping (start at ~10 s, tune with real agent sessions).
- Plugin index hosting (static site generated from GitHub topic search).
