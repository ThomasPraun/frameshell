---
title: Colour and film look
description: Correct exposure and white balance, apply a built-in look or your own LUT, and finish with grain, vignette and cinema bars.
section: guides
order: 10
---

## What to ask

- "Fix the colour of the interview: it is too blue and a bit dark."
- "Show me the clip in each built-in look side by side."
- "Give it a warm filmic look."
- "Use this LUT on all the camera clips."
- "Add a bit of grain and a soft vignette."
- "Cinema bars, 2.39."

Your AI measures the clip's levels first and suggests a correction with a reason for each number. It never applies it blind: it compares frames, then sets it.

## Corrections

Five numbers per clip: **exposure** (in stops of light), **temperature** (cooler to warmer), **tint** (greener to magenta), **contrast** and **saturation**. On top, a `.cube` **LUT** from the project with a mix from none to all. Footage shot in a LOG profile is detected, with a hint.

## Built-in looks

`warm`, `cool`, `filmic`, `punchy`, `faded` and `mono`. A look sets the five numbers in one step; adjust them after.

## Film finish

- **Grain**, the same at a given frame in every export.
- **Vignette**: darker corners.
- **Letterbox**: black bars for a cinema shape such as 2.39 or 1.85. One format (say 9:16) can have its own.

## In the app

Select a clip and use the **Colour** section of the inspector: the five sliders, the look list, the LUT and its mix, and **Reset**. The **Finish** section has grain and vignette, and the letterbox menu sits next to the format switcher over the preview. The preview shows the grade live; a computer without WebGL2 shows clips without it and says so, but the export still applies it.
