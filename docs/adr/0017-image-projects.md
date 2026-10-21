---
status: accepted
---

# Image projects

Adds use case D to SPEC §1. A poster, a thumbnail or a social card is one picture made of layers: a photo, a logo, a title. The agent builds and edits it from the terminal and the human corrects it by pointing at it, as with video. Time plays no part (requested by the owner, 2026-10-21).

## Context (verified in the tree)

- Still images already import as media, show in the preview and export through the compiler. `clip.add` refused a still without `duration`.
- `frame` renders one composited frame as PNG with the export compiler. The managed ffmpeg also encodes JPEG (`mjpeg`) and WebP (`libwebp`).
- The Pick tool and `inspect.point` (ADR 0011) name the clip and the composition element under a point. That works the same on a still frame.
- A new project could only start from video or audio (ADR 0013, 0015). Every panel assumed a playhead and a timeline.

## Decision

1. **An explicit kind.** `frameshell.json` gains `"kind": "image"`; absent means `video`, so existing projects do not change. The kind is declared, not inferred from a one-frame timeline, so the UI never switches mode while someone edits, and the agent reads it from the file.
2. **Same data model.** An image project is the first frame of its main timeline. Each video track is a **layer**, the first track at the bottom. Nothing new in the timeline schema; export, preview, history, Pick and the MCP tools work unchanged.
3. **No length to give.** In an image project, `clip.add` gives a still image or a generated clip one frame when no `duration` is passed.
4. **Layer order is an operation.** `track.set` takes `index` to move a track in the stack: one journaled, undoable step, for both the agent and the Layers panel.
5. **Image export.** `frame` writes PNG, JPEG or WebP: `format`, else the extension of `out`, else PNG; `quality` 1-100 for JPEG and WebP (default 92). An image project exports with `frame --at 0`. PNG output keeps its exact ffmpeg args.
6. **Start from pictures.** The welcome screen, drops on it and Open with take images. Images alone make an image project the exact size of the first picture (`project.init` `kind` with `like`). Each picture becomes a layer at its own pixel size, centered, as one undo step. Pictures dropped on an open image project become layers on top.
7. **UI without time.** In an image project the Layers panel takes the timeline's place: layers topmost first; select, rename, move up or down, delete, Ask agent. The preview shows the picture's size instead of the timecode, keeps the Pick tool and has an **Export image** button. Playback controls and keys, the 9:16 view, and the clip inspector's sound controls go.
8. **An image from a video frame.** In a video project, File > New Image from Frame (Cmd/Ctrl+Shift+S, also in the preview's context menu) asks the picture size (YouTube thumbnail 1280x720, the video's size, square, vertical), makes an image project beside the video's (`<project> frame <mm-ss>`) with the frame at the playhead as its layer covering the picture, and opens it in a new window. No button: it is there when wanted and out of the way otherwise.

## Considered options

- **Infer the mode from a one-frame timeline without audio.** Rejected: no schema change, but the UI could flip mid-edit, and the agent cannot tell an image project from an empty video.
- **A separate layer model** (a `layers.json`). Rejected: it would duplicate placement, history, Pick, export and the MCP tools.
- **Hide the timeline but keep no layer list.** Rejected: layer order and selection need a place in the UI besides the preview.

## Consequences

- Schema: optional `kind` in `frameshell.json` (JSON Schema regenerated). Protocol v50: `project.init` `kind`, `track.set` `index`, `frame` `format` and `quality`, `frame` result `format`.
- CLI: `init --kind image`, `track set --index`, `frame --format --quality`. MCP `frame_capture` writes the asked format to `out` and still shows the model a PNG.
- The app registers PNG, JPEG, GIF and WebP for Open with, at Alternate rank (never the default viewer).
- Not covered: parts inside a photo (segmentation), direct drag-to-edit of composition elements, a dedicated image canvas size dialog.
