---
title: Install Frameshell
description: Download the desktop app for macOS, Windows or Linux, and what it downloads later on its own.
section: start
order: 1
---

Frameshell is a desktop app. It is free and open source, and it does not ship its own AI: you bring the AI app you already use.

## Download

Get the file for your computer from the [latest release](https://github.com/ThomasPraun/frameshell/releases/latest):

| Computer | File | Notes |
|---|---|---|
| Mac with Apple silicon or Intel | `.dmg` | Signed and notarized. Open it and drag Frameshell to Applications. |
| Windows x64 | `.exe` | Unsigned for now: the first time, SmartScreen warns. Click **More info**, then **Run anyway**. |
| Linux x64 | `.deb` or `.AppImage` | Beta: tested in CI, not yet by hand. |

Installed release builds check for updates on their own. **Help > Check for Updates…** checks now.

## What it downloads later

The installer is small on purpose. The tools Frameshell needs download the first time you use them, and it tells you the size before anything large:

- **ffmpeg**, for proxies, audio and export.
- **The transcription engine and its model** (about 600 MB), the first time you transcribe. You can skip it.
- **Headless Chrome**, the first time a generated clip (titles, animations) renders.

The **Plugins** view in the sidebar lists everything Frameshell has downloaded to this computer, with its size and a **Remove** button.

## Next

[Connect your AI](../connect-your-ai/), then make [your first video](../first-video/).
