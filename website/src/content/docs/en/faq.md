---
title: Frequently asked questions
description: Cost, privacy, which AI to use, working offline, other editors, and what Frameshell is not.
section: help
order: 1
---

## What is Frameshell?

A desktop video editor where an AI does the editing from your words and you watch and correct it on a real timeline. Think of it as an IDE, like VS Code or Cursor, whose build output is a video.

## Is it free?

Yes. Frameshell is open source under the Apache 2.0 licence and costs nothing. What you may pay for is outside it: your AI app's plan, and optional cloud plugins such as OpenAI voiceover, billed to your own account. Frameshell always tells you a cost before it spends anything.

## Which AI do I need?

One you already use. The easiest are **Claude Desktop** and the **ChatGPT desktop app**, connected in one click. Developers can use **Claude Code**, **Codex**, **Gemini CLI**, **OpenCode** or any MCP client. See [Connect your AI](../connect-your-ai/).

## Does Frameshell include an AI?

No. It sends nothing to an AI on its own. Your AI app reads the project through Frameshell's tools, the same way you see it in the app.

## Can I use it without an AI?

Yes, as a plain editor: drag media onto the timeline, cut, trim, add transitions, colour and subtitles, and export. But the point is to let the AI do the slow parts.

## Where are my files? Is my footage uploaded?

Your project is a normal folder on your computer, and your footage stays there. Transcription runs on your computer by default. Only an optional cloud plugin (OpenAI transcription, OpenAI voiceover) sends anything out, and it asks before each upload. Your AI app sees what it reads through Frameshell: frames, the transcript, the timeline.

## Does it change my original recordings?

Never. Cuts and effects are instructions in the timeline. See [How it works](../how-it-works/).

## Does it work offline?

Frameshell does, once its tools are downloaded: editing, preview, local transcription and export need no internet. Your AI app needs its own connection.

## Which languages does transcription understand?

whisper.cpp understands many languages, Spanish and English among them. You can also register your own Whisper model, for example one fine-tuned for your language.

## Which computers does it run on?

macOS (Apple silicon and Intel), Windows x64 and Linux x64 (beta). Transcription and 3D are faster on a recent machine; on a slow one, ask for draft exports while you iterate.

## Can I finish in Premiere, DaVinci Resolve or Final Cut?

Yes. **File > Export Premiere XML…** opens in Premiere Pro; **File > Export OpenTimelineIO…** opens in Resolve and other editors that read OTIO. Effects Frameshell cannot carry over are listed when you export. See [Export](../export/).

## What formats can I export?

MP4 (H.264 + AAC) for YouTube 1080p or 1440p, vertical 1080x1920 for Shorts, Reels and TikTok, a looping GIF, and PNG, JPEG or WebP for images. One edit can export to several formats at once, such as 16:9 and 9:16.

## Can the AI break my project?

Every change is a step in **History** that you can revert, and review mode lets you approve each change before it applies. See [History, undo and review](../history-and-review/).

## Can I edit the project files myself?

Yes. Timelines, scripts and settings are plain text files. Edit them in any editor or in Frameshell's own editor tabs; the app shows the change at once and History records it.

## Is it ready for production work?

It is alpha. It works, it is used every day, and it has rough edges. Keep your originals backed up, and [tell us](https://github.com/ThomasPraun/frameshell/issues) when something breaks.

## How do I report a bug or ask for a feature?

**Help > Report a Problem…** opens a bug report on GitHub. Paste the details from **Help > Copy Diagnostics** into it: they describe your setup and hold no file contents and no secrets.
