---
status: accepted
---

# Pointer zoom of screen recordings: Shoot records the pointer's position, `clip zoom` pushes in where it rests

#797 (from Orkestra task 67, "zoom/foco a una parte del video") asks for the auto-zoom of screen-recording tools: a
tutorial recorded in Shoot zooms in where the action is. A zoom on part of the picture already works by hand (`clip
key` on `scale`, `x`, `y`; the inspector; `clip reframe` for faces), but the agent has to guess from frames where the
action is, and a Shoot screen recording kept no pointer or click positions. The issue left two questions to the
owner: build it at all, and record clicks (a global input hook, an extra permission) or the position only. On
2026-11-21 the owner asked for every pending proposal to be implemented; this ADR records the choices made so they can
be reviewed in the PR. **Accepted by the owner on 2026-11-21: position only, no clicks.**

## Decision

1. **Position only, no clicks.** Main polls Electron `screen.getCursorScreenPoint()` 20 times a second
   (`POINTER_SAMPLE_HZ`) while a session with a whole-screen source records. Clicks would need a global mouse hook
   (a native module per platform, and on macOS the Accessibility or Input Monitoring permission on top of Screen
   Recording); a rest of the pointer is a good stand-in for "here is the action", as Screen Studio-like tools also
   zoom on dwell. Clicks stay a later option: `follow` takes the literal `pointer` so `clicks` can join it.
2. **Whole screens only.** A window capture gets no track: the window can move under the pointer and its bounds are
   not known on the capture's clock. The display is the `display_id` of the `desktopCapturer` source the window's
   `getDisplayMedia` answered with, matched to `screen.getAllDisplays()` (the only display when the id is empty);
   no match, no track. The stand-in capture gets none.
3. **The pointer track file.** `PointerTrack` in `packages/schema/src/pointer.ts`: `{ version: 1, width, height,
   samples: [[t, x, y], ...] }`, `t` seconds on the screen file's own clock, `x`, `y` fractions of the captured
   display (outside 0 to 1 when the pointer is on another display). It lives next to the media as
   `.<name>.pointer.json` (`pointerFileOf`: `assets/shoot/<id>/.screen.pointer.json`); the leading dot keeps the
   asset watcher from ingesting it, and it travels with the folder. Any recorder can write one; `clip.zoom`'s
   `pointer` reads one from elsewhere.
4. **Clock.** The renderer passes its `performance.timeOrigin` with the recorders' starts (`shoot.started`); the
   screen file's time 0 is `timeOrigin + starts.screen` in wall-clock milliseconds, and main stamps each reading with
   its own `performance.timeOrigin + performance.now()`. Both are the same wall clock to about a millisecond, well
   under a 50 ms sample.
5. **Written at End.** Readings stay in main's memory and are written when the session ends (`savePointer`), also
   when the window goes away mid-recording. A crash of main loses the track, never the media; the zoom is optional.
6. **`clip.zoom` (CLI `clip zoom <clip> --follow pointer [--scale] [--pointer]`, MCP from the registry).** Pure
   planner `packages/core/src/zoom.ts`: a **rest** is the pointer staying within 0.05 of the picture's height of
   where the run began for 0.8 s or more (`ZOOM`), off-picture samples and gaps over 0.25 s break a run. Each rest
   becomes a zoom that eases in from 0.8 s before (0.5 s ramp ending 0.3 s before the rest), holds, and eases out
   from 0.4 s after; rests less than 1.2 s apart share one zoom that glides (0.5 s) between spots. The spot is
   brought to the frame's center as far as the picture's edge allows (the frame never shows past the picture), at
   `scale` (default 1.8, 1.1 to 4) times the clip's static scale; outside zooms the clip sits at its static
   placement. A zoom that would hold less than 0.4 s at a clip edge is dropped. Writes `scale`, `x` and `y` keys
   at the same times (ease in-out on every key that starts a move), replacing the clip's own keys of those three
   (as `clip.reframe` does, with a warning), in one transaction `Zoom <file name>`, one proposal in review mode.
   No rest: nothing written, a warning. Protocol 185.
7. **Media clips only.** A Shoot session becomes a multicam group, whose screen angle is never cut by a shot. To zoom,
   the agent places the screen file as a media clip (`clip add`); zooming a multicam `screen` shot is not built.

## Considered options

- **A global click hook (`uiohook-napi` or similar).** Gives exact click moments, but adds a native dependency per
  platform and a second macOS permission prompt to every Shoot; rejected for now (decision 1).
- **The sidecar under `.frameshell/`.** Machine-local and never versioned, so a moved or cloned project would lose it;
  rejected for a hidden file beside the media.
- **Writing the track as it records (append per second).** Survives a crash, but adds a second writer per session for an
  optional track; rejected (decision 5).
- **A highlight ring at each rest (item 3 of the issue).** Not built: it needs clicks to be honest; a later overlay.
