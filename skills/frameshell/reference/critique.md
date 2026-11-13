# Critique loop

Look at what you built before the person does. A reel or a motion film is judged on the rendered file, by someone who did not build it, against a fixed rubric; then the worst problems are fixed and the loop runs again. Used by [reels.md](reels.md) and by any video you generate. Commands assume the session rule of [SKILL.md](../SKILL.md).

## 1. Make the evidence

Judge the **export**, never the project files or your memory of the code. Render a draft (`frameshell render --preset <preset> --quality draft --out exports/draft.mp4 --json`; a project with several formats: `--formats <id,id>` without `--preset`, and one set of sheets per file), then make the sheets of the file people will get with `review` (MCP `review`, which returns the images):

```sh
frameshell review --file exports/draft.mp4 --json
```

It writes `.frameshell/review/<n>/` (the last 10 runs are kept; project files are never touched) and prints each sheet's path, size and tile times; open the PNGs with your image tool. Every tile is labelled with its time in the file:

- `contact*.png`: a frame every 0.5 s (`--every` changes it), 30 to a sheet, several sheets for a long film. Review the timeline itself (no `--file`) and the sheet also marks clip starts and ends, cuts, markers, subtitle cues and the deepest zoom of a keyed clip (`1.50 cut`), which the file cannot tell.
- `phone*.png`: one frame per second at 360 px wide: how it reads on a phone.
- `motion-1.png`, `motion-2.png`: the two fastest moments (`peaks` in `--json` give their time and how much of the picture moved) as 12 consecutive frames: pops, overlaps and blank frames only show in consecutive frames.
- `seam.png`: the last 6 and the first 6 frames: does the loop jump.
- `safe-<platform>.png` (a vertical film, `--platform instagram|tiktok|shorts|youtube`): up to 36 frames with the platform's UI zones shaded red. A caption, a graphic or a face that reaches into a zone is marked `!subtitle`, `!graphic` or `!face` on its tile and listed in `safeZones[].flags` (`--json`) by subject, track, clip and zone with how many px it reaches in. A graphic is what a generated clip draws (titles included), measured on its alpha at up to 12 frames of the clip; a render with no alpha fills its frame, so a `warning` names the clip and it is not measured. A face comes from the cached `people scan` of the footage (`frameshell people scan` first: no scan, no flag); multicam shots are not placed. A graphic or a face in a zone is also a `safe-zone` craft warning. Look at the shaded bands yourself for anything else (text drawn into footage, a logo). A file has the zones but no flags. A vertical film whose `style.json` names platforms gets this sheet without `--platform`; `--sheets safe` alone uses those platforms too.

`--range 5,12` limits the sheets to those seconds; `--sheets phone,seam` writes only those; `--platform tiktok` adds the safe-zone sheet to the default ones. For a project with several formats review each format's file. Then the numbers that are not pictures. `review` writes them too, to `metrics.json` (`metrics` in `--json` and over MCP), unless `--sheets` leaves `metrics` out:

- `picture`: `longestStatic` (nothing changes), `largestGap` between visual events, `blank` stretches, `firstFrameEmpty` (frame 0 is the thumbnail). Measured on grey frames, a file at up to 15 samples a second and a timeline at most 90 over the range, so a flash shorter than the `spacing` can be missed.
- `subtitles.shortCues` (timeline): cues on screen for less than their words take to read (0.4 s for one or two words, else 0.75 x (0.5 + 0.3 s per word)).
- `loudness` (a `--file` only, after the AAC encode, which moves the peak): `integrated` LUFS, `range` LU, `truePeak` dBTP and `phoneBand`, the 200 Hz to 6 kHz band a phone plays. A timeline has no loudness: render a draft and review the file.
- `sync`: each sound against the picture event it belongs to. For a timeline, the generated sounds `sound place` put on it (the take's anchor, exact to the frame); for a `--file`, the hits found in its sound (a 12 dB rise in the 10 ms envelope). Whooshes, risers and ticks are left out (`excluded`): they do not land on an event by design. `offsets` gives, per sound, the nearest visual event within 0.12 s and `offset` = sound minus picture in seconds: a sound over 45 ms before its picture reads `early`, over 75 ms after it `late`, `none` with no event near. The limits widen by half the picture `spacing`, so a file sampled at 15 a second cannot tell less than 33 ms. `near` is the share of sounds with an event within 0.1 s and `chance` the same share when the same sounds are moved by fixed offsets of 0.3 to 1.1 s: what random placement scores. A hit on every cut proves nothing, so read `near` against `chance`, then `silentCuts` (cuts of the timeline with no sound) and the sounds with verdict `none`; place sounds where something physical happens, never to fill a cut. Round placement so a sound is never before its picture.
- `seam`: `jump`, the mean grey difference (0 to 255 at 160 px) between the last frame and the first, with `verdict`: `duplicate` (under 0.5 while the picture moves, so the loop holds two frames), `continuous` (under 10) or `cut` (10 or more; a hard cut reads 40 to 80). It is the measure `render --loop` checks the file with ([loops.md](loops.md)). `--loop` (MCP `loop: true`) says the film repeats: a `duplicate` or a `cut` is then a `loop-seam` craft warning.
- `delivery` (`--file` with `--preset <preset the file was made with>`; `--timeline` and `--format` name the plan): the file read back with ffprobe against the export plan of the timeline with that preset: `width`, `height`, `fps`, `duration` (within 2 frames), video `codec`, `audio` and, for a file with sound, `loudness` against the preset's target (within 1.5 LU). Every check has `expected`, `actual` and `ok`; any `ok: false` is a `delivery` craft warning. Run it on every file you deliver.
- `craft`: each warning names its check (`static` over 3 s, `frame-0`, `blank`, `reading`, `peak` above -1 dBTP, `phone-band` 6 LU under the mix, `silent` over 15 s, `sync`, `loop-seam`, `delivery`, `safe-zone`). They are warnings, not failures: fix them or say why the film wants them.

- **A moment `review` did not pick:** `frameshell review --range <a,b> --sheets motion`, or `frames_strip` (MCP) over the 0.5 s around an entrance or a cut with about 12 tiles.
- **Critical stills:** `frameshell frame --at <s> --out <file.png>` at frame 0, every graphic's entrance, each zoom peak, and the end card.
- **Words:** `frameshell transcribe --verify exports/draft.mp4 --json` when speech was cut.
- **Thumbnail:** a `warning:` from `render` that frame 0 is black is a hook problem; `frameshell cover --text <word> --json` reports whether the cover word reads at 180 px.
- **Delivery:** `frameshell review --file exports/draft.mp4 --preset <preset> --sheets metrics --json` and read `metrics.delivery`: size, frame rate, length, codecs and loudness against the export plan.

## 2. A fresh critic

The critic did not build the video. With subagents, start one and give it only the brief (or the person's request), the plan or shot list, the sheets, the stills and the numbers, never the code. Without subagents, do it yourself in the critic's voice: evidence first, no defending the work.

- **Describe before judging:** one sentence per contact-sheet frame, naming every object on it. An object that needs explaining is a problem in itself.
- **Measured beats seen:** vision judges layout and look well and fine motion and timing poorly. Timing, loudness and sync come from numbers (frame times, `review` metrics, word times); say which findings were measured and which only looked at ("sound measured, not heard": you cannot listen).
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

Add every default you catch the video falling into to `banned` in the project's `style.json` with `frameshell style set banned '[…]'` (the whole list; with the person's agreement), so the next round and the next video avoid it. Judge brand, type sizes, motion and sound levels against `frameshell style show`, not your taste.

## 5. Notes, then fixes

Rank the problems by damage (P0: wrong or missing; P1: unreadable; P2: timing; P3: visual detail) and fix in that order. Write each fix as a scoped note:

```text
WHERE    12.4–13.1 s, the price card
PROBLEM  it enters 6 frames after the word "price" (measured from the transcript)
CHANGE   start the card 6 frames earlier; nothing else
KEEP     the zoom, the caption timing, every other graphic
```

Fix the three worst, each in its own transaction, then check each fix with a still or a strip of its range before re-rendering the whole film. Re-render drafts with `--quality draft`; only the delivery is `--quality final`. Append the round to `review/log.md`: the scores table (or the comparison), the three problems with their timestamps, what changed, and whether last round's fixes landed.

## 6. Stop

- **Reels:** every score 8 or more.
- **Motion films** made from a brief: every score 8 or more after at least three rounds.

Never show the person a film the loop has not passed, unless they ask for an early look. When you deliver, give the scores, the contact sheet and anything you know is still imperfect.
