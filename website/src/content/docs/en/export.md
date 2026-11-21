---
title: Export and hand-off
description: Export for YouTube, Shorts, Reels and TikTok, drafts while you review, loops and GIFs, checking the result, and handing the timeline to Premiere or Resolve.
section: guides
order: 19
---

## Export

Ask your AI: "Export it for YouTube", "Export the vertical version", "Export every format". The file lands in the project's `exports/` folder.

| Preset | For |
|---|---|
| YouTube 1080p, 1440p | Horizontal video, H.264 + AAC |
| Vertical 1080x1920 | Shorts, Reels, TikTok |
| GIF | A loop with no sound, up to 1200 px |

**Draft or final.** While you review, ask for drafts: a fast encode at up to 30 fps. The final is slower and at full quality.

**Several formats** from one edit come out as one file each.

**The first frame** is the thumbnail on most platforms. When it is black, your AI is warned and can put a cover there: a frame with one big word.

## Loops and GIFs

Title loops, banners and GIFs for a README play again from the first frame. Ask for "a seamless loop" and your AI builds it so the last frame leads into the first, then checks the seam.

## Check before you share

Before showing you a video, your AI can review it: contact sheets of the whole film, how it looks on a phone, safe zones per platform, loudness, captions too short to read, long still stretches. It can also re-transcribe the export to make sure no word was lost at a cut. Ask "review the export before you show me".

## Hand off to another editor

- **File > Export Premiere XML…** for Premiere Pro (**File > Import** there).
- **File > Export OpenTimelineIO…** for DaVinci Resolve and other editors that read OTIO.

Cuts, clips, dissolves and clip volume carry over. What cannot (subtitles, generated clips, colour grades, transforms, audio effects) is listed when you export; generated clips keep their place as offline media.
