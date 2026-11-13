# Loops

A loop plays again from its first frame with no visible seam: title loops, banners, a motion clip on a page. Commands assume the session rule of [SKILL.md](../SKILL.md).

```sh
frameshell render --loop --out exports/title-loop.mp4
```

`--loop` (MCP: `render` with `loop: true`) renders the whole timeline, frame 0 to the last frame, and:

- fades the first and last 2 ms (96 samples at 48 kHz) of MP4 and MOV audio with a half sine, so the repeat does not click; a silent file is unchanged;
- warns in `warnings` when the output frame rate makes frames x output fps / fps not a whole number (the cycle is a fraction of a frame; render at the project's rate or change the length), and when frame 0 or the last frame is black (a fade from or to black, or no picture), because every pass then passes through black;
- once the file is written, compares frame 0 with the last frame. When they are the same picture while the file moves, the job's `warnings` (`job.list`, `--json`; the CLI prints them after `Rendered`) says the last frame repeats frame 0, so the picture holds for two frames at the seam. The timeline is never changed: you fix it.
- is refused with `--cover-frame` / `cover`: the cover replaces frame 0 and breaks the seam.

## Author for the seam

A loop is a first key identical to the last, with the frame range leaving the duplicate last frame out: the last frame must be the frame just before the first.

- Make the length N whole cycles of whatever moves, and drive every motion by phase = frame / N, so the frame after N-1 is frame 0.
- Equal position and equal speed at the seam, not only equal position: a move that ends at rest and restarts from rest reads as a pause. Ease with a curve that is symmetric around the seam, or use a constant speed.
- Noise, particles and wobble: sample them on a circle (angle = 2 pi x frame / N), not along a line, so they close on themselves.
- Frame 0 is a finished composition: it is also the thumbnail where platforms use the first frame.
- The warning "the last frame repeats frame 0": the last key sits on frame 0's state at frame N-1 instead of frame N. End the last key one frame earlier (`clip trim`, or the key's time), or trim one frame off the end of the timeline.
- Check the seam by looking at the last frames beside the first frames, not at a still: `frameshell review --sheets seam --file exports/title-loop.mp4` (MCP `review`).
- Sound: an MP4 loop is not sample-exact in most players (AAC priming), so the fades hide a click, not a gap. For a loop whose sound must meet, deliver MOV with a PCM preset or WebM with Opus (WebM gets no fade).

## GIF

```sh
frameshell render --preset gif --out exports/title.gif
```

`--preset gif` writes a GIF that plays forever. It is a loop export without `--loop`: the same refusal with `--cover-frame`, the same warnings, the same last-frame check after the file is written.

- No sound. The size is a box: each format is fitted inside 1200 x 1200 with its own aspect (16:9 is 1200 x 675, 9:16 is 675 x 1200) and never scaled up, so a 640 x 360 project stays 640 x 360. `--formats 16x9,9x16` gives one GIF each.
- At most 30 fps: 60 fps renders at 30, 24 and 25 keep their rate. At 24 fps the delays are 4,4,5,4,4,4 hundredths of a second, so 48 frames last exactly 2 s.
- At most 350 output frames: more is refused before anything renders, with the count and the length that fits (11.67 s at 30 fps, 14.58 s at 24). Shorten the timeline, or render an MP4 or WebM.
- A file over 15 MB is written, and the job's `warnings` gives its size: many places stop previewing a GIF that big. Smaller levers: a shorter timeline, fewer moving pixels (flat colours and still backgrounds compress; grain, gradients and photos do not), a smaller format.
- Colours: one palette of 256 over the whole file, ordered dither. Flat graphics and text come out well; photos and soft gradients band. For a photo or a long clip, deliver an MP4.
- `--quality` does not apply (a warning says so).
