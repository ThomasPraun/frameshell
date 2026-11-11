# Short-form reels (talking head)

A person sends a take of themselves talking to camera and wants a reel, short or TikTok: tight cuts, captions with a keyword, a few graphics, gentle zooms, sound, loud enough for the platform. Work like an editor taking notes: **one pass at a time**, each one its own transaction the person can watch and revert. Commands assume the session rule of [SKILL.md](../SKILL.md). Cutting itself is in [transcript-editing.md](transcript-editing.md); this page adds what a reel needs on top.

## Intake

Ask once, in at most two rounds of up to four questions, each with options and your recommendation first. Never ask what the project already answers (`frameshell status`, `assets/`, `frameshell.json`, earlier transactions).

1. **Which take:** the newest video in `assets/`, or the file they name.
2. **Platform:** Instagram Reels, TikTok, YouTube Shorts, or all. It changes the safe zones and the length, little else.
3. **Style:** their style notes if the project has them (a `scripts/style.md` or what they said before), reference images they give, or your defaults below.
4. **Review:** *guided* (they watch after every pass) or *quick* (they only approve word fixes, caption keywords and the graphics plan). Both keep the three fixed stops: after the cut, after the graphics plan, before export.
5. **Graphics:** few (captions + 2–3 cards), balanced (captions + 4–6 cards and logos, recommended), many (also one full-screen scene).
6. **Music:** a file they give, one you make with your own tools, or none.

Write the answers into the first transaction's label or a `scripts/reel-brief.md`, so a later session resumes without asking again.

## The project

- **Vertical canvas.** A reel project is 1080×1920: set `resolution` in `frameshell.json` (see [project-model.md](project-model.md)) before placing clips, and export with `--preset vertical-1080x1920`.
- **Loudness.** Set `export.loudness` to `-14` in `frameshell.json`: the level Instagram, TikTok and Shorts normalize to. Export keeps true peak under −1 dBTP.
- **Horizontal footage.** A 16:9 take is fitted (letterboxed) into the vertical frame. Look at a frame first (`frameshell frame --at 1 --out <file.png>`): if the person lies on their side, the phone was held sideways and Frameshell cannot rotate a clip yet: tell them. If they stand upright, fill the frame with `frameshell clip set <clip> --scale <s> --x <px>`: `s` = (1920 × source width) / (1080 × source height), 3.16 for 16:9; `x` moves the picture sideways in project pixels, so centre the face and keep the edges covered (|x| at most half of the scaled width minus 1080).

## Passes

1. **Words.** `frameshell transcribe assets/<take> --language <code> --json`. Show the person the transcript with the names, brands and numbers it contains, and ask which are misspelled; fix them in the transcript's `edits` (see [project-model.md](project-model.md#transcript)). Proofread before cutting: captions show these words.
2. **Cut.** Long pauses and retakes as in [transcript-editing.md](transcript-editing.md#choosing-cuts), in one transaction. Reels are tighter than talks: cut pauses over about 0.4 s and leave about 0.1 s of air each side. Show the list of cuts (time, words around it, why) before applying it in *quick* mode; in *guided* mode apply, then let them watch.
3. **Captions.** `frameshell track add subtitles --follows <video track> --preset big-keyword --position bottom --json`. The caption sits at chest height, never over the face: check with a frame where the face is lowest. Show the person the key words you would stress and wait for their OK: they are what a muted viewer reads.
4. **Graphics plan, then graphics.** First a table, no clips yet: what is said · time · what appears · why. One graphic per idea, triggered on its word (take the time from the transcript word, mapped to timeline time), roughly one every 3–5 s in a reel under a minute. Real logos and screenshots the person gives you, never redrawn ones. Wait for the OK, then build each graphic with the `hyperframes` or `remotion` skill on a video track above the footage, one transaction per graphic.
5. **Zooms.** Keys on the footage clip (see [transitions.md](transitions.md#keyframes)), never a cut: `frameshell clip key <clip> --prop scale --at <s> --value <v> --ease in-out`. Push in toward an idea and back out, at most 5–10 % over the fill scale; start the hook slightly pushed in (about 1.08 times the fill scale) and settle in the first 1.5 s so frame 0 already moves. Every zoom needs a reason (a key phrase, a reveal).
6. **Sound.** Frameshell makes no music or effects: make them with your own tools (or use the person's files), `frameshell import` them and place them on audio tracks. Effects sit 20–25 dB under the voice and land 20–40 ms before their visual: a hit on the hook, a whoosh on a scene change, a click on a check, one riser before the biggest moment. Music sits about 12 dB under the voice; dip it a further 6–7 dB while someone speaks with `clip key <music clip> --prop gain` keys at each phrase start and end.
7. **Export and verify.** `frameshell render --preset vertical-1080x1920 --json`, then `frameshell transcribe --verify exports/<file>.mp4 --json` as in [transcript-editing.md](transcript-editing.md). Give them a cover too: `frameshell frame --at <s> --out exports/cover.png` at the frame with the strongest word.

## Layout rules (1080×1920)

- **Safe zones:** keep text and graphics out of the top ~220 px, the bottom ~380 px and the right ~140 px (the platform's buttons and caption). Check each graphic in a frame, not in its file.
- **Face first:** nothing covers the face or chin, also at the deepest zoom: cards start below the chin at the zoom they appear in.
- **One idea on screen:** when a graphic says what the caption says, the caption is noise; leave the caption and drop the graphic, or move the graphic to a moment the caption does not cover.
- **Text:** no caption on screen under 0.4 s; type at least 28 px at 1080 wide; one display face and one text face; one accent colour, on the key word only.

## Notes from the person

- **A note is a rule for the whole video**, not one moment: "it covers my chin" means check every graphic at its deepest zoom; "the effects are loud" means lower all of them.
- **Redo only what they name:** "redo 0:04 to 0:07" changes that range and leaves the rest exactly as it was.
- Notes that apply to future reels (their colours, fonts, "never bounce text") go into `scripts/style.md` once they agree; read it at the next intake.

## Before you hand it over

Run the [critique loop](critique.md) on a draft export until every score is 8 or more. Then check, and fix what fails:

- [ ] Nothing important in the safe zones; nothing over the face, at any zoom.
- [ ] No caption shorter than 0.4 s; every misspelled word fixed.
- [ ] Graphics follow their plan and the person's style; one idea at a time.
- [ ] `transcribe --verify` reports nothing `lost`.
- [ ] The cover shows one big word readable as a thumbnail.

Then ask them to watch it twice on their phone, with and without sound.
