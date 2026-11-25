---
title: How it works
description: You and your AI edit the same project. What a project is, who does what, and why nothing is ever lost.
section: concepts
order: 1
---

Frameshell is built on one idea: **you and your AI edit the same project at the same time**. The AI does the heavy work from your words; you watch every change live and fix what you do not like by hand. When you change something, the AI reads it and carries on from your version.

## Who does what

| You | Your AI |
|---|---|
| Say what you want, in your own words | Plans the edit and asks when something is unclear |
| Watch the preview and the timeline | Cuts, places clips, writes subtitles, makes titles and animations |
| Drag, trim, split, restore words | Reads your changes and continues from them |
| Decide on anything that costs money or downloads | Offers options, and asks before it installs, downloads or spends |

Frameshell does not ship its own AI and sends nothing to one. It gives your AI the tools it lacks: a timeline it can edit, a live preview, frames it can look at, and a fast export.

## A project is a folder

Every project is a normal folder on your computer. Nothing is hidden in a database:

| In the folder | What it is |
|---|---|
| `frameshell.json` | The project's settings: size, frame rate, formats such as 9:16 |
| `assets/` | Your recordings, music and pictures, untouched |
| `timelines/` | Each edit as a plain JSON file. `main.json` is the main one; a short or a cut-down is a second timeline from the same footage, with no copy of the video |
| `transcripts/` | Every spoken word with its time |
| `scripts/` | Scripts and plans, in Markdown |
| `exports/` | The finished videos |

Because it is plain files, you can back it up, put it in Git, or open a timeline in any text editor. A change made in a file shows in the app at once.

## Your footage is never touched

Cuts, trims and effects are instructions in the timeline, not changes to your files. Deleting a clip from the timeline never deletes the recording, and you can always bring a cut part back.

## Two kinds of projects

- **Video projects** have a timeline: footage, audio, subtitles, titles, generated clips.
- **Image projects** are a still picture made of layers: thumbnails, posters, covers. See [Thumbnails and images](../images/).

## Where the AI runs

Either in an AI app on your computer (Claude Desktop, the ChatGPT desktop app) connected to Frameshell, or as a coding agent inside Frameshell's own terminal. Both reach the same project with the same tools. See [Connect your AI](../connect-your-ai/).
