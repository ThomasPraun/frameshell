---
title: Voiceover
description: A narration generated from a script, one take per line, placed on the picture with captions that match. What it costs, and how to fix a word the voice says wrong.
section: guides
order: 13
---

Frameshell has no voice of its own. A voice plugin says the lines: the official one is **OpenAI voiceover**, which is paid and billed to your own OpenAI account.

## What to ask

- "Write a voiceover script for this video, 45 seconds."
- "Generate the voiceover with a calm female voice."
- "Place each line on its scene, and add captions."
- "Redo the second line, slower."

## The script

A voiceover script is a file in `scripts/`, one scene per heading and one spoken line per text line. Notes in brackets are never read. Two details make it sound right:

- **Names the voice gets wrong** are written twice: what shows in captions, and how to say it, like `{Frameshell|frame shell}`.
- **Numbers** are spelled out for the voice in Spanish and English, and stay as digits in captions.

A voice reads about 2.5 words a second, so your AI warns when a scene has more words than its time.

## Cost

Before generating anything paid, Frameshell shows an estimate and waits for you to confirm. Every finished take is kept in `assets/voiceover/`, so a line is never paid for twice; only lines you change are generated again.

## In the app

The voiceover window shows each line as it is said and checked. Each take is transcribed and compared with the script, so a skipped or misread word is listed. **Place voiceover…** puts the lines on their scenes or markers.
