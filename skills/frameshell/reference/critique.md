# Critique loop

Look at what you built before the person does. A reel or a motion film is judged on the rendered file, by someone who did not build it, against a fixed rubric; then the worst problems are fixed and the loop runs again. Used by [reels.md](reels.md) and by any video you generate. Commands assume the session rule of [SKILL.md](../SKILL.md).

## 1. Make the evidence

Judge the **export**, never the project files or your memory of the code. Render a draft (`frameshell render --preset <preset> --out exports/draft.mp4 --json`), then build the sheets with the managed ffmpeg (`$FRAMESHELL_FFMPEG` in an app terminal) into a `review/` folder at the project root:

```sh
# whole film at 2 fps (pick fps and tile so every frame fits; several sheets for long films)
"$FRAMESHELL_FFMPEG" -i exports/draft.mp4 -vf "fps=2,scale=270:-1,tile=6x5" -frames:v 1 review/contact.png
# phone test: how it reads 360 px wide
"$FRAMESHELL_FFMPEG" -i exports/draft.mp4 -vf "fps=1,scale=360:-1,tile=5x3" -frames:v 1 review/phone.png
# loudness and true peak of the file people will hear
"$FRAMESHELL_FFMPEG" -i exports/draft.mp4 -af ebur128=peak=true -f null - 2>&1 | tail -12
```

- **Fast moments:** `frames_strip` (MCP) over the 0.5 s around each fast move, entrance and cut, with about 12 tiles: pops, overlaps and blank frames only show up in consecutive frames.
- **Critical stills:** `frameshell frame --at <s> --out <file.png>` at frame 0, every graphic's entrance, each zoom peak, and the end card.
- **Words:** `frameshell transcribe --verify exports/draft.mp4 --json` when speech was cut.
- **Delivery:** `"$FRAMESHELL_FFPROBE" -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,duration -of json exports/draft.mp4` matches the planned size, frame rate and length.

## 2. A fresh critic

The critic did not build the video. With subagents, start one and give it only the brief (or the person's request), the plan or shot list, the sheets, the stills and the numbers, never the code. Without subagents, do it yourself in the critic's voice: evidence first, no defending the work.

- **Describe before judging:** one sentence per contact-sheet frame, naming every object on it. An object that needs explaining is a problem in itself.
- **Measured beats seen:** vision judges layout and look well and fine motion and timing poorly. Timing, loudness and sync come from numbers (frame times, `ebur128`, word times); say which findings were measured and which only looked at ("sound measured, not heard": you cannot listen).
- **Unverified is not a pass:** a check you could not run is reported as not run.

## 3. Score or compare

**Score** a single version, 1–10 per criterion, each with evidence (timestamp, frame, number). 8 = ready for a demanding client.

| Criterion | Automatic cap |
|---|---|
| Hook: frame 0 already reads, the promise lands by ~1.5 s | Empty or near-blank frame 0 → max 6 |
| Readability at phone size (`phone.png`), the call to action the clearest text | CTA unreadable at 360 px → max 6; key text in the platform's UI zones → max 7 |
| Motion: weight, overlap, follow-through, nothing pops | A plain fade used as an entrance or exit → max 6; a visible pop or jump in a strip → max 7 |
| Pacing: something new every 2–4 s | A gap over 4 s, or a static run over 2 s outside the end card → max 7 |
| Brand and facts: real logos, UI and fonts, one accent; every claim sourced | Invented UI where real UI exists, a wrong font, a second accent, a claim with no source → max 6 |
| Sound: hits land with their picture, voice on top, −14 LUFS, true peak ≤ −1 dBTP | Hits off by over ~80 ms or loudness off target → max 6 |
| Composition in every format, the face free in talking-head video | A third of a 9:16 frame empty for over 1 s, or anything over the face → max 7 |
| Polish: no blank frames, no double-exposed text at swaps, clean seam | Any blank frame mid-film or double-exposed caption → max 7 |

A problem noted last round and still visible cannot score higher than last round.

**Compare** two or three versions when absolute scores feel arbitrary (choosing between variants, or checking that a round really improved): ask which is better per criterion, run it twice with the versions swapped, and count a version as better only when it wins both times. Each version must differ in something visible.

## 4. What to look for

Go through these one by one, on the sheets and strips:

- Frame 0 empty or black; the first word only readable after a few frames.
- A sound landing before its picture reads (visuals need a few frames to read: lead the motion, keep the sound on its beat).
- Text overlapping other text at a swap or a transition; a caption repeating what a graphic says.
- Everything fading in; everything moving at once (one hero move per moment); the same ease on every move; symmetric motion that looks mechanical.
- A shot that holds over one bar with nothing new; an end card that freezes; a loop seam that jumps.
- Text in the platform's UI zones; text under 28 px at 1080 wide; anything over the face or chin, also at the deepest zoom.
- Flat depth (cards like stickers); empty zones in vertical; type crossing busy UI while the camera moves.
- Banned looks: a centred title on a gradient, corner labels, frame borders, glow on UI, generic particles, crossfades between every shot, a whoosh on every cut, the same sound machine-gunned.
- Numbers or claims on screen the person or a source did not give.

Add every default you catch the video falling into to the project's banned list (the person's style notes), so the next round and the next video avoid it.

## 5. Notes, then fixes

Rank the problems by damage (P0: wrong or missing; P1: unreadable; P2: timing; P3: visual detail) and fix in that order. Write each fix as a scoped note:

```text
WHERE    12.4–13.1 s, the price card
PROBLEM  it enters 6 frames after the word "price" (measured from the transcript)
CHANGE   start the card 6 frames earlier; nothing else
KEEP     the zoom, the caption timing, every other graphic
```

Fix the three worst, each in its own transaction, then check each fix with a still or a strip of its range before re-rendering the whole film. Append the round to `review/log.md`: the scores table (or the comparison), the three problems with their timestamps, what changed, and whether last round's fixes landed.

## 6. Stop

- **Reels:** every score 8 or more.
- **Motion films** made from a brief: every score 8 or more after at least three rounds.

Never show the person a film the loop has not passed, unless they ask for an early look. When you deliver, give the scores, the contact sheet and anything you know is still imperfect.
