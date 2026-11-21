---
title: Plugins
description: Optional extras for transcription, animated titles, React scenes, 3D and cloud voices. What each needs, costs and downloads.
section: reference
order: 1
---

Frameshell works without plugins. Plugins add new kinds of clips or new services, per project. Open the **Plugins** view in the sidebar to see each one with what it needs, what it costs and what it downloads on first use, then **Install** or **Remove** it with one click. Your AI can suggest one, but nothing is installed without your yes.

## Official plugins

| Plugin | What it adds | Cost |
|---|---|---|
| **whisper.cpp transcription** | Turns speech into words with times, on your computer. Needed for subtitles, cutting pauses and editing by words. Downloads the engine and a model (about 600 MB) the first time | Free, works offline |
| **OpenAI transcription** | The same, with OpenAI's cloud service instead | Paid, billed to your own OpenAI account; asks before each upload |
| **OpenAI voiceover** | Narration generated from text with OpenAI's voices | Paid, billed to your own OpenAI account; shows the estimate first |
| **HyperFrames** | Animated titles, lower thirds, overlays and graphics written in HTML, with transparency | Free |
| **Remotion** | Animated scenes and overlays built with React, including components from your own app | Free; [Remotion's licence](https://www.remotion.dev/license) applies to companies |
| **Blender** | 3D scenes from `.blend` files, with transparency | Free; needs your own Blender (4.5 LTS or 5.x) |

The first install of a plugin downloads it with npm and can take a minute or two.

## Trust

Plugins run with full access to your computer. When you open a project someone else made that declares plugins, the Plugins view shows a banner: **Trust** turns them on, **Don't trust** keeps them off. Only trust a project whose source you trust. Plugins you install yourself are trusted.

## Downloads on this computer

The same view lists what Frameshell has downloaded (ffmpeg, the transcription engine and models, headless Chrome) with its size and a **Remove** button. Anything removed downloads again when it is next needed.

## From a terminal

```sh
frameshell plugin catalog                          # what exists, needs and costs
frameshell plugin install @frameshell/whisper-cpp  # install in this project
frameshell plugin list                             # installed, with what each adds
frameshell doctor                                  # downloads on this computer
```
