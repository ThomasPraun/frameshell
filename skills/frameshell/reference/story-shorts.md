# Story-led animated shorts from the person's voice

A true story told by one human voice, drawn as a 60-70 s vertical short: flat 2D characters in lit sets, one captioned narrator, no footage. This is the *explainer* level of [video-from-audio.md](video-from-audio.md) with a story discipline on top; the spine is the voice and its transcript, so read that page for the steps (import, transcribe, scene plan, `script outline`, one clip per scene) and this one for what to decide before and while building. Commands assume the session rule of [SKILL.md](../SKILL.md); one transaction per step the person might want to undo whole. A film made from a brief and no voice is [motion-films.md](motion-films.md); a take of the person on camera is [reels.md](reels.md).

| Gate | Done when |
|---|---|
| 1. Pitch | Five true stories written, **the person picked one** |
| 2. Script and sources | A script within budget, `sources.md` with a source for every claim, **the person checked the facts** |
| 3. Voice | The person's recording is imported, transcribed and cut |
| 4. Shot list and beats | One shot per idea with its reads, acting and beat table, **the person gave an explicit OK** |
| 5. Build | Every shot is a clip on its scene's span, checked in frames |
| 6. Captions, sound, finals | Captions on the voice, sound on the beats, critique rounds passed, the paperwork kept |

Gates 1, 2 and 4 stop and wait for the person. Never finalise a fact yourself.

## 1. Pitch before writing

Write five true stories into `scripts/pitch.md`, each one line, in a title pattern that makes a promise: "The [object] that [did something surprising]", "Why [thing] always [does X]". Per story: why both a 12-year-old and a 50-year-old would repeat it, and two sources they could open. Recommend one. **Stop** and wait for the pick; write nothing else first.

## 2. Script and `sources.md`

- **Budget:** about 2.5 spoken words per second: 150-170 words for 65 s of one narrator. Short spoken sentences; numbers written the way they are said.
- **Shape:** line 1 is the hook and makes a promise; the twist lands at about 60 % of the length; the last line pays off the hook. Count the words before showing it.
- **`sources.md`:** one row per factual claim (the claim, the source URL or book and page, the date you read it). No number, date, name or caption appears on screen that is not in it; an illustration that is not a fact is labelled `SCHEMATIC` in the shot list. Show the table and ask the person to check each row: they confirm the facts, you never do.
- Write the script as `scripts/<name>.md`, one `## ` scene per idea, so the recording can follow it.

## 3. The voice

The person records the narration themselves: it is the strongest signal that a human made the film, and it spares every question about cloned voices. Ask for a quiet room and one take of the whole script (or one per scene); they may misspeak, retakes are cut afterwards.

1. `frameshell import assets/<voice>.wav --wait`, then `frameshell transcribe assets/<voice>.wav --language <code>`; fix names and numbers in the transcript ([transcript-editing.md](transcript-editing.md)).
2. Cut it: `frameshell cleanup --retakes --dry-run --json`, show the table, apply what they accept, then cut by hand what it misses ([transcript-editing.md](transcript-editing.md#choosing-cuts)). Do this before any visual: visuals do not follow a later cut.
3. Check the length against the budget now. A narration far over 70 s is cut in the script, not sped up.
4. Put the words comment of [video-from-audio.md](video-from-audio.md) under each scene and run `frameshell script outline scripts/<name>.md`; fix its warnings.

A voice made from text ([voiceover.md](voiceover.md)) is a different decision, with its costs, that the person makes; never offer it as the default.

## 4. Shot list = contract

`scripts/<name>.md` keeps one `## ` scene per idea; under it, one entry per shot. A shot is **1.5-3 s** (a new one about every 2 s). Per shot:

```markdown
## The clerk drops the key
<!-- words: story.words.json w_000140..w_000151 -->
- Reads: the key is heavy (read 1, 12.0-12.8 s), it falls (read 2, 12.8-13.2 s), nobody looks up (read 3, 13.2-14.0 s)
- Set: the hotel lobby (set 2); camera: slow push-in 1.00 -> 1.06, to keep the eye on the key's hand
- Character: the clerk, eyes down, then wide
- Hero prop: the brass key (3D); sound: a metal clink on the hit frame
- Acting: thinks "not again" -> eyes drop 4 frames before the hand opens -> the key falls on "dropped" -> hold 10 frames
```

- **Reads.** What the viewer must understand, in order, each with a start and an end (24 frames = 1 s). One read at a time, cause then reaction. A payoff packed into 1.3 s was missed; over about 4 s it read. A shot's length comes from its reads, never from padding, and the last read needs a hold before the cut. When a gag needs more read time than its line gives, carry it into the next line instead of slowing the voice.
- **Camera with a reason:** a slow push-in or dolly toward what matters. Never random drift, never a constant orbit.
- **Sets:** 3-5 for a 65 s episode, not 30. Reuse them with new framing and the same light.
- **Beats in frames.** A table of global frame numbers at the project's fps (`frameshell status`): push-in start, the action, the hit sound, the cut, the caption readable, the hold's end. A note then reads "move the hit to 1260". Physics check: a fall of about 30 cm takes about 0.25 s (7-8 frames at 30 fps); slower looks floaty. Put the key frames on the timeline as markers in seconds (frame / fps): `frameshell marker add --at 42.0 --label hit-key`.
- **Acting line first,** before anything is animated: the thought, the anticipation (the eyes move about 4 frames before anything else), the action on a word, a hold of about 10 frames so it reads. No idle bounce, every move starts with a look, mouths change only on stressed words.

Show the whole list as a table (shot, words, set, camera and why, reads, hero prop) and **stop** for the OK. A change after the OK goes into the list first, then into the clip.

## 5. Build

- **Look.** Flat characters (flat colour, one thick outline, no realistic shading) with a contact shadow so they sit on the floor. Sets with one motivated key light, warm practicals, depth of field and worn materials. The story's hero prop is always 3D, never drawn.
- **Where each piece comes from.** Characters and flat sets are `hyperframes` compositions (`frameshell hyperframes new <name>`, with the `hyperframes` skill; paste `frameshell style show` into each). The hero prop in 3D: the `product-shot` template (`frameshell hyperframes new key --template product-shot`: three.js, renders on any machine, a GLB or the built-in box in studio light). A whole lit 3D set: a `blender` clip from the person's own `.blend` when `frameshell doctor` lists Blender (the `blender` skill). Judge 3D by frames, not by the file: drafts are not the finished look.
- **Layout.** One video track per layer (sets, characters, hero prop), each clip on its scene's `span` and linked: `frameshell clip set <clip> --script-ref scripts/<name>.md#<slug>`. The first 2 s already hold a composition, never black.
- **Check each shot.** `frameshell frame --at <s> --out boards/<shot>.png` at the hero move, `frameshell review --range 12,14 --sheets motion` for the fastest part, `frameshell clip verify <clip>` for generated clips (a shot that fails renders differently from the preview). Hardest shot first.
- **Facts on screen** come from `sources.md` only. Real logos and photos come from the person, with their credit ([credits.md](credits.md)); to take their brand from a site use `frameshell brand capture <url>`, never redraw it.

## 6. Captions, sound, finals

- **Captions:** 1-2 words a cue, cut on each word's start, bold white with a dark outline, centre-low inside the safe area, a pop only on a stressed word. `frameshell track add subtitles --follows <voice track> --preset big-keyword --position bottom`, then chunk by hand with `frameshell captions set <track> --file scripts/captions.txt` (one phrase per line, `|` between cues, the stressed word between asterisks). `frameshell review --platform shorts` draws the safe zones ([critique.md](critique.md)).
- **Sound only where something physical happens:** `frameshell sound place thump --at <marker>` ([sound.md](sound.md)), 20-40 ms before the visual hit. Music, when used, sits about 12 dB under the voice: `frameshell duck <music track> --under <voice track> --level 12`.
- **Finals:** `frameshell render --preset vertical-1080x1920 --quality draft` for rounds, at least three [critique](critique.md) rounds, then `--quality final` with `export.loudness` at `-14`, `frameshell transcribe --verify exports/<file>.mp4` (nothing `lost`) and `frameshell cover --text <word>`. Time each gate on the first episode and write the numbers into `review/log.md`.
- **Keep the paperwork with the video:** `scripts/pitch.md`, the script, `sources.md`, the shot list with its beat table, the markers, the credits and the approved export live in the project, so the next episode starts from them.

## Platform rules

- Take a channel's **grammar** (pacing, caption style, the hook-twist-payoff shape), never its characters, designs or scripts.
- YouTube's monetisation rules target mass-produced, repetitive content: an original story, the person's own voice and new sets each episode are the answer. Never batch episodes ([batch.md](batch.md) is for variants of one film).
- Anything that could pass for real footage or a real recording is labelled as animated or reconstructed, in the film or its description.

## Music and lyric films

A film built on a song instead of a narration: ask for the song and its timings **before** storyboarding (guessing from feel made a draft twice too slow), take the grid from it (`frameshell beats measure assets/<song>.wav`, [project-model.md](project-model.md#beat-grid)), and make chapters out of its sections, each with its own setting and a small palette. One motif escalates from chapter to chapter, and the ending rhymes with the opening. Everything else here (reads, beats, captions, finals) holds.
