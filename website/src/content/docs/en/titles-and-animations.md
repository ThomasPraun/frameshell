---
title: Titles and animations
description: Lower thirds, animated titles, cards, diagrams and 3D scenes as clips on the timeline, written as code by your AI and editable by pointing at them.
section: guides
order: 8
---

Titles and graphics in Frameshell are **generated clips**: small compositions your AI writes in HTML, React or Blender, rendered with transparency over your footage. They sit on the timeline like any clip.

## Engines

| Plugin | Good for |
|---|---|
| **HyperFrames** (HTML and CSS) | Titles, lower thirds, cards, captions, charts, a chalk drawing over the footage |
| **Remotion** (React) | UI demos and scenes built from your own app's components |
| **Blender** (3D) | A product or hero object in 3D; needs your own Blender |

Install them from the **Plugins** view. Your AI suggests one when you ask for something that needs it.

## What to ask

- "A lower third with my name and role when I first appear."
- "An animated title for the intro, in our brand colours."
- "A card with the three steps when I list them."
- "Make the title bigger and move it up."

## In the app

- A generated clip **plays live** in the preview while it renders, with a label that says so. The export always uses the finished render.
- Select it and the **inspector** shows its settings: position, size, opacity, glass (blurs what is under it), motion blur.
- Use the **Pick** tool in the preview (<kbd>I</kbd>) to click a part of a title. **Chat about this** then tells your AI exactly which element you mean: "make this word yellow".
- Its source file opens in an editor tab, if you want to change the code yourself.

## When a project comes from someone else

Plugins run with full access to your computer, so a project that declares plugins asks you to **Trust** them first. Until then its generated clips do not render.
