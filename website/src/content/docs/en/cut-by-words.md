---
title: Cut pauses and retakes
description: Edit a long recording by what is said. Remove dead air and false starts, cut whole passages by their words, and check that no word was lost.
section: guides
order: 1
---

For talks, tutorials, vlogs and interviews: anything with speech. The edit starts from the transcript, so every cut lands in a pause and never clips a word.

## Before you start

The recording needs a transcript. Tick **Transcribe what is said** when you create the project, or ask your AI to transcribe it. It runs on your computer with the free whisper.cpp plugin; the first time it downloads about 600 MB and asks first.

## What to ask

- "Remove the long pauses and the false starts."
- "Show me the cuts you would make before you make them."
- "Cut everything before 'welcome to the channel'."
- "Remove the part where I talk about pricing."
- "Leave the pause after the joke."

Your AI finds pauses and retakes on its own: a pause is a quiet gap between words, a retake is a phrase said again, where the last attempt is kept. It can list them first as a table with a confidence for each, so you decide which to keep.

## What you see

- On the **timeline**, the clip splits at each cut and the rest moves earlier.
- In the **transcript view**, every removed word is **struck through**. Click a word to bring it back, or **↺** for a whole passage.
- In **History**, the whole clean-up is one step you can revert.

## Check before you publish

Ask "verify the export". Your AI transcribes the exported video again and compares it with what you kept, and it fixes any word that got clipped at a cut. Words it is not sure about, it asks you to check by ear.

## Tips

- Cut the sound first, then add titles and graphics: a late cut can move a generated clip off its words.
- Fix misspelled names in the transcript before adding subtitles: double-click a word in the transcript view.
- For your own language, you can register a Whisper model trained for it: ask your AI how.
