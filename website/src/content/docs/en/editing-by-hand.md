---
title: Editing by hand
description: The timeline, the transcript view, the inspector and the preview, with every gesture and shortcut.
section: concepts
order: 2
---

The AI does the first pass; you correct it. Everything you do by hand is saved at once and lands in [History](../history-and-review/), so the AI sees it and you can undo it.

## The timeline

Clips sit on tracks: video, audio, subtitles. A cut removes the range and closes the gap.

| Do | How |
|---|---|
| Select a clip | Click. <kbd>Shift</kbd> or <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+click adds or removes one; <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>A</kbd> selects all |
| Move | Drag the selected clips |
| Trim | Drag an edge. Hold <kbd>Shift</kbd> when you press it (or press <kbd>R</kbd>) to ripple trim: later clips follow |
| Split | <kbd>S</kbd> splits at the playhead |
| Trim to the playhead | <kbd>[</kbd> and <kbd>]</kbd> |
| Nudge one frame | <kbd>,</kbd> and <kbd>.</kbd> |
| Delete | <kbd>Delete</kbd> leaves a gap; <kbd>Shift</kbd>+<kbd>Delete</kbd> closes it |
| Select a time range | Drag over empty space |
| Move the playhead | Click the ruler, or use the arrow keys |
| Snapping on or off | <kbd>N</kbd> |
| Zoom | <kbd>+</kbd> and <kbd>-</kbd>; <kbd>0</kbd> fits the whole timeline |
| Undo / redo | <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd>; <kbd>Ctrl</kbd>+<kbd>Y</kbd> or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> |

To put media on the timeline without the AI, drag a video or sound from **Files** (the Explorer in the sidebar) onto a track, or right-click it in `assets/` and choose **Add to timeline**. Right-click a clip, a track header or the ruler for more: markers, track options, "Put behind the person".

## The transcript view

Click **Transcript** in the editor tabs (or open a file in `transcripts/`). It lists every word on the timeline, in order.

- A word that was cut is **struck through**. Click it to bring it back; **↺** restores a whole cut passage.
- Click or drag over words to select them; the playhead jumps there.
- Double-click a word (or press <kbd>F2</kbd>) to fix a word the transcription got wrong.
- To cut words, select them and use **Chat about this** ("cut these"), or cut the same range on the timeline.

## The inspector

Select a clip and the inspector shows what you can change: position and size, opacity, volume and mute, voice clean-up, colour, film finish (grain, vignette, letterbox), transitions and animated values. Subtitles have their own inspector for the style. In the preview you can drag a selected layer's handles to move or scale it.

## Chat about this

Select anything (clips, words, a time range, a file, a point in the preview) and press <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>L</kbd>, or right-click and choose **Chat about this**. Your AI gets an exact reference, so "make this louder" or "cut this part" means what you selected.

## Panels in their own window

Most panels (timeline, transcript, History, People, Angles) can open in their own window, for a second screen. Dock them back from the same button.
