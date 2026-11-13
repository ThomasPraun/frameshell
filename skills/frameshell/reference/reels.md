# Short-form reels (talking head)

A person sends a take of themselves talking to camera and wants a reel, short or TikTok: tight cuts, captions with a keyword, a few graphics, gentle zooms, sound, loud enough for the platform. Work like an editor taking notes: **one pass at a time**, each one its own transaction the person can watch and revert. Commands assume the session rule of [SKILL.md](../SKILL.md). Cutting itself is in [transcript-editing.md](transcript-editing.md); this page adds what a reel needs on top.

## Intake

Ask once, in at most two rounds of up to four questions, each with options and your recommendation first. Never ask what the project already answers (`frameshell status`, `assets/`, `frameshell.json`, earlier transactions).

1. **Which take:** the newest video in `assets/`, or the file they name.
2. **Platform:** Instagram Reels, TikTok, YouTube Shorts, or all. It changes the safe zones and the length, little else.
3. **Style:** `frameshell style show` when the project has a `style.json` (colours, fonts, type sizes, motion, sound levels, platforms, banned list; see [project-model.md](project-model.md#style)); otherwise reference images they give, or your defaults below. Ask only for values it marks `not set`.
4. **Review:** *guided* (they watch after every pass) or *quick* (they only approve word fixes, caption keywords and the graphics plan). Both keep the three fixed stops: after the cut, after the graphics plan, before export.
5. **Graphics:** few (captions + 2–3 cards), balanced (captions + 4–6 cards and logos, recommended), many (also one full-screen scene).
6. **Music:** a file they give, one you make with your own tools, or none.

Write the answers into the first transaction's label or a `scripts/reel-brief.md`, so a later session resumes without asking again.

## The project

- **Vertical canvas.** A reel project is 1080×1920: set `resolution` in `frameshell.json` (see [project-model.md](project-model.md)) before placing clips, and export with `--preset vertical-1080x1920`.
- **Loudness.** Set `export.loudness` to `-14` in `frameshell.json`: the level Instagram, TikTok and Shorts normalize to. Export keeps true peak under −1 dBTP.
- **Horizontal footage.** A 16:9 take is fitted (letterboxed) into the vertical frame. Look at a frame first (`frameshell frame --at 1 --out <file.png>`): if the person lies on their side, the phone was held sideways and Frameshell cannot rotate a clip yet: tell them. If they stand upright, `frameshell clip reframe <clip> --json` fills the frame and follows their face (see [transitions.md](transitions.md)); `--anchor 0-1` fixes the position when no face is found. Do it before the zooms: it replaces the clip's `x`, `y` and `scale`.
- **More formats.** The same edit can also go out as 16:9, 4:5 or 1:1: `frameshell format add 4x5`, then `render --formats <ids>` with the ids `format list` prints. Check each format's frames: captions and cards placed for 9:16 may sit differently. Fix one format without touching the others: `frameshell clip set <clip> --format 4x5 --y 380` (or `--hidden` for a card that does not fit there), `frameshell track set <subtitles> --format 4x5 --position center`; `--reset` with `--format` undoes it there.
- **Voice.** A phone or laptop recording gets `frameshell clip set <clip> --voice` (high-pass, light denoise, gentle compression), before any music goes under it.

## Passes

1. **Words.** `frameshell transcribe assets/<take> --language <code> --json`. Show the person the transcript with the names, brands and numbers it contains, and ask which are misspelled; fix them in the transcript's `edits` (see [project-model.md](project-model.md#transcript)). Proofread before cutting: captions show these words.
2. **Cut.** `frameshell cleanup --retakes --dry-run --json` lists the long pauses and false starts with their words, reason and confidence (its defaults, pauses over 0.4 s with 0.1 s of air each side, are reel-tight). Show them as a table before applying in *quick* mode, then run it again without `--dry-run` and with `--skip <id>` for each rejected one: one transaction. In *guided* mode apply, then let them watch. Cut by hand what it does not cover, as in [transcript-editing.md](transcript-editing.md#choosing-cuts).
3. **Captions.** `frameshell track add subtitles --follows <video track> --preset big-keyword --position bottom --json`. The caption sits at chest height, never over the face: check with a frame where the face is lowest. Show the person the key words you would stress and wait for their OK: they are what a muted viewer reads.
4. **Graphics plan, then graphics.** First a table, no clips yet: what is said · time · what appears · why. One graphic per idea, triggered on its word (take the time from the transcript word, mapped to timeline time), roughly one every 3–5 s in a reel under a minute. Mark each trigger with `frameshell marker add --at <s> --label <idea>`: the person sees the plan on the timeline, and graphics, zooms and transitions land on `marker list` times. Real logos and screenshots the person gives you, never redrawn ones. Wait for the OK, then build each graphic with the `hyperframes` or `remotion` skill on a video track above the footage, one transaction per graphic.
5. **Zooms.** Keys on the footage clip (see [transitions.md](transitions.md#keyframes)), never a cut: `frameshell clip key <clip> --prop scale --at <s> --value <v> --ease in-out`. Push in toward an idea and back out, at most 5–10 % over the fill scale; start the hook slightly pushed in (about 1.08 times the fill scale) and settle in the first 1.5 s so frame 0 already moves. Every zoom needs a reason (a key phrase, a reveal). A topic change can take a `push` or `wipe` instead of a zoom ([transitions.md](transitions.md)); never a transition on every cut.
6. **Sound.** Frameshell makes no music or effects: make them with your own tools (or use the person's files), `frameshell import` them and place them on audio tracks. Effects sit 20–25 dB under the voice and land 20–40 ms before their visual: a hit on the hook, a whoosh on a scene change, a click on a check, one riser before the biggest moment. Music sits about 12 dB under the voice (`style.json` `sound` when set); then `frameshell duck <music track> --under <voice track>` dips it while someone speaks. Run `duck` again after any later cut.
7. **Export and verify.** Review rounds use `frameshell render --preset vertical-1080x1920 --quality draft --json`; the delivery is `--quality final`, then `frameshell transcribe --verify exports/<file>.mp4 --json` as in [transcript-editing.md](transcript-editing.md). Platforms show frame 0 as the thumbnail: when `render` warns it is black, add `--cover-frame --cover-text <word>`. Give them a cover image too: `frameshell cover --text <strongest word> --json`, which picks the frame where the word is spoken and checks it reads at thumbnail size.

## Layout rules (1080×1920)

- **Safe zones:** keep text and graphics out of the top ~220 px, the bottom ~380 px and the right ~140 px (the platform's buttons and caption); `style show` gives each platform's own zone when `style.json` names it. `frameshell review --platform <instagram|tiktok|shorts>` draws the zones over the frames and flags captions that cross them ([critique.md](critique.md)); check each graphic in a frame, not in its file.
- **Face first:** nothing covers the face or chin, also at the deepest zoom: cards start below the chin at the zoom they appear in.
- **One idea on screen:** when a graphic says what the caption says, the caption is noise; leave the caption and drop the graphic, or move the graphic to a moment the caption does not cover.
- **Text:** no caption on screen under 0.4 s; type at least 28 px at 1080 wide; one display face and one text face; one accent colour, on the key word only.

## A word behind the head

A big word between the background and the person, so they stand in front of it. It is the strongest graphic a reel can have and the easiest to get wrong: use it for the hook word or the one idea of the video, 1.5–4 s, two or three times in a reel at most.

1. **Pick the shot.** One person, upper body, not moving across the frame, no held object or mic arm near the body (the matte drops thin parts and flickers on held things). Skip two-person shots: they get one merged matte.
2. **Build it.** Make the word with the `big-word` template (props in the `hyperframes` skill) on its own video track above the footage, then `frameshell track set <word track> --behind <footage track>`. Run `frameshell matte <asset>` first: it takes about 1.5 minutes per minute of video, once per file, and `render` and `frame` wait for it otherwise (the app's preview shows the word in front until it is ready). The app shows the matte on the word track's header: a percentage while it is made, `!` when it failed (the track menu's "Stop going behind the person" or `--behind none` puts the word back on top).
3. **Cover.** The head should hide **30–55 %** of the word: under 15 % the word floats beside them, over 65 % they eat it. Measure on frames, not by eye on the file: `frameshell frame --at <s>` at the start, middle and end of the word's time on screen (the person moves). Fix with the template's `place` and `size`, or the clip's `transform`; at 80 % or more covered on any of the three frames, lay it out again.
4. **Never over the face.** Until the matte is ready the preview shows the word in front of the person, and a miss of the matte does the same at a frame. At every frame you checked, the face must be clear of the word; if one is not, move or shrink the word or drop it.
5. **Cutaways.** B-roll goes above the word's track or below the footage. A track between them covers the person, and the word then shows in front for as long as it is on screen.
6. **Keep it honest.** Do not blur or darken the background around the person to hide an edge; the real background stays.

## Notes from the person

- **A note is a rule for the whole video**, not one moment: "it covers my chin" means check every graphic at its deepest zoom; "the effects are loud" means lower all of them.
- **Redo only what they name:** "redo 0:04 to 0:07" changes that range and leaves the rest exactly as it was.
- Notes that apply to future reels (their colours, fonts, "never bounce text") go into `style.json` with `frameshell style set` (`rules`, `banned`, or the value itself) once they agree; `style show` reads it back at the next intake, and `style save <name>` keeps it for their next project.

## Before you hand it over

Run the [critique loop](critique.md) on a draft export until every score is 8 or more. Then check, and fix what fails:

- [ ] Nothing important in the safe zones; nothing over the face, at any zoom.
- [ ] No caption shorter than 0.4 s; every misspelled word fixed.
- [ ] Graphics follow their plan and the person's style; one idea at a time.
- [ ] `transcribe --verify` reports nothing `lost`.
- [ ] `cover` reports the word readable, and frame 0 is not black.
- [ ] Music ducked after the last cut; loudness at −14 LUFS.

Then ask them to watch it twice on their phone, with and without sound.
