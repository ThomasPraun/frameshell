# Image projects

An image project makes one still picture instead of a video: a poster, a thumbnail, a social card. `frameshell.json` says `"kind": "image"`. The picture is the first frame of the main timeline; each video track is a **layer**, the first track at the bottom. Time plays no part: the app hides the playhead and the timeline and shows a Layers panel instead. Commands assume the session rule of [SKILL.md](../SKILL.md).

## Start

- From scratch: `frameshell init <dir> --kind image`, then set `resolution` in `frameshell.json` to the picture size (default 1920x1080).
- The app makes one from a dropped picture: the project takes its exact size, and each picture becomes a layer.

## Build the layers

- One element per video track, so the human can reorder and select it in the Layers panel: `frameshell track add video --name Logo`, then `frameshell clip add <track> assets/logo.png --x … --y … --scale …`.
- No `--duration` is needed: in an image project a still picture or a generated clip gets one frame. Keep every clip at `--start 0`; only frame 0 is exported.
- Text, shapes and layout: a HyperFrames or Remotion composition clip (`--type hyperframes --source compositions/card.html`), so each element stays editable as code and the human's Pick tool names it (`element h1.title "…"`).
- Reorder: `frameshell track set <track> --index n` (0 = bottom). Opacity and position: `frameshell clip set <clip> --opacity … --x … --y …`.
- Photos and generated pictures are assets: import them, never edit them in place.

## Thumbnail from a video frame

When the person wants a thumbnail or a still from their video, they may already have one: in the app, File > New Image from Frame (Cmd/Ctrl+Shift+S, or the preview's right-click menu) makes an image project beside the video's, named `<project> frame <mm-ss>`, with the frame as its background layer, and opens it in a new window. Work there. Without the app:

1. `frameshell frame --at <s> --out /tmp/frame.png` in the video project (a `[frameshell]` line's time, or one the person names).
2. `frameshell init "<dir beside it>" --kind image`, set `resolution` (YouTube thumbnail: 1280x720), then in it `frameshell import /tmp/frame.png`.
3. `frameshell track add video --name Frame`, `frameshell clip add <track> assets/frame.png` (a 16:9 frame fits a 1280x720 picture exactly; for another shape raise `--scale` until it covers).
4. Add the title and other elements as layers above it, look, export.

## Look and export

- Look: `frameshell frame --at 0 --out /tmp/look.png` (MCP `frame_capture { at: 0 }`).
- Export: `frameshell frame --at 0 --out exports/<name>.png` (or `.jpg`, `.webp`; `--quality 1-100` for JPEG and WebP, default 92). `render` makes a video: do not use it for an image project unless asked.
- A `[frameshell] point …` line from the human names the layer and, in a composition, the element they clicked (see [selection.md](selection.md)): edit that element's source.
