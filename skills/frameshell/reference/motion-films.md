# Motion films from a brief

A brief (a product, a page, an idea) and no footage: the whole film is generated clips cut to music. Work like a director with gates: each gate ends on something the person can see, and the next one starts only when it passes. Commands assume the session rule of [SKILL.md](../SKILL.md); one transaction per step the person might want to undo whole.

| Gate | Done when |
|---|---|
| 1. Intake | The answers are in `style.json` `brand`, nothing asked twice |
| 2. Storylines | Three written, one recommended, **the person picked one** |
| 3. Assumptions and costs | Listed, a free alternative beside every paid item, the person agreed |
| 4. Style guide | `style show` has the brand's colours, fonts, motion personality, platforms and `banned` |
| 5. Storyboard | Scenes in bars, the sum equals the length, **the person gave an explicit OK** (or about 10 minutes of silence, when they allowed it beforehand) |
| 6. Shots, board, animatic | Every shot placed and linked, one still per shot on a contact sheet, a draft render with pacing fixed, the hardest seconds checked first |
| 7. Cuts, sound, music | Cuts and transitions on the grid, sounds on their markers, the music's last hit on the end card |
| 8. Critique, finals | At least 3 [critique](critique.md) rounds with every score 8+, finals in every format |

Gates 2, 3 and 5 stop and wait for the person. Gate 5 alone may go on after about 10 minutes of silence, and only when the person said so beforehand ("go on if I don't answer"); a paid item at gate 3 always needs their yes.

## 1. Intake

One round, every question with options and your recommendation first. Read what the project already answers: a project made with "New video from an idea" has its formats set (`frameshell format list`) and the length and page in the first prompt.

- Product, page URL, audience, the one feeling the film leaves.
- Length and formats (16:9, 9:16, 1:1, 4:5).
- A reference film (optional): measure it now with `frameshell analyze references/<file>.mp4 --json` ([reference-video.md](reference-video.md)); take its grammar, never its content. Write the numbers you take into the storyboard as targets, each labelled MEASURED: shot length median and `rhythm.shotLengthCv` for the pacing, `look` (brightness, contrast, warmth) and `palette` for the grade, `rhythm.bursts` for where it accelerates, `events` (`appear` regions, `hit` offsets) for where graphics and sounds land, `tempo` as a hint only.
- Music: a track they supply, a free licensed track, a bed generated on this machine (`sound music`, gate 7), or a paid one (gate 3).
- Voice: none (the type carries the words), a voice on this machine, or a paid provider ([voiceover.md](voiceover.md)).
- Must show, must avoid.

Keep the answers in the style file, value by value: `frameshell style set brand.product "Acme"`, then `brand.url`, `brand.promise`, `brand.cta`, `brand.audience`, `brand.mustShow`, `brand.mustAvoid` (lists as JSON). A later session reads them with `style show` instead of asking.

Add every format the person named that `frameshell format list` lacks, in the first transaction: `frameshell format add 9x16` (also `1x1`, `4x5`). The finals and `review --format` of gate 8 need them.

## 2. Three storylines

Write three storylines into `scripts/storylines.md` and recommend one. Each is **one viewer doing one real task**, with one real piece of data travelling from the hook to the payoff. The three differ in the central idea, and each lives in a different world, uses a different device (a cursor in an app, a chat, a phone in a hand, a terminal) and takes a different form (a demo, a before/after, a countdown, a single unbroken move). Never default to a template's story or to the last film's look.

Per storyline: a title, the viewer and their task, the data that travels, the hook in one line, the five beats in one line each, what it costs to make. Before recommending, compare it with the project's last film (a previous `scripts/storylines.md` or the person's last export): at least 4 of 6 aspects (world, device, form, palette, motion, music) differ, or it is the last demo again.

**Stop.** Build nothing until the person picks one.

## 3. Assumptions and costs

List what you assume (audience, platform, length, every fact on screen) and every item that costs money, each with a free alternative beside it. Spend nothing without the person's yes.

| Item | Paid | Free alternative |
|---|---|---|
| Voice | A paid speech provider: `voiceover generate` refuses with `ConfirmationRequired` and the cost; `--yes` only after they confirm | The `command` provider running a local voice the person installs ([voiceover.md](voiceover.md#the-command-provider)), or no voice and kinetic type |
| Music | A track from a paid library or a music generator | `sound music`: a bed made offline, its beat grid exact ([sound.md](sound.md#music-bed)); or a CC0 track, or the person's own ([credits.md](credits.md)) |
| Fonts | A commercial licence | An open-licence font (OFL), copied into `assets/fonts/` |
| Pictures | Stock, image or video generators | The product's real UI and logo, and the motion templates (`device-frame`, `app-window`, `scene-background`) |
| Sound effects | Sample packs | `sound sfx`: made offline, the person's own ([sound.md](sound.md)) |
| 3D | A render service | The `blender` skill with the person's own Blender, when the plugin is installed |

**Facts:** only figures from the brief or a source the person gave, with their scope ("in our beta, 40 teams"). Illustrative numbers and UI get labelled `SCHEMATIC` in the storyboard; an unvalidated claim says so.

## 4. Brand and style guide

- **Real brand, never redrawn.** Logo, screenshots and colours come from the person or their page. Save what you fetch under a new name in `assets/` (the first-bytes check of [credits.md](credits.md)) and record it: `frameshell credits set assets/logo.svg --licence own --source-url <page>`. A font file goes into `assets/fonts/` with its own licence: `frameshell credits set assets/fonts/Inter.ttf --licence OFL-1.1 --source-url <url>`.
- **Style values.** `frameshell style apply premium` (or `playful`, `corporate`, `energetic`, `calm`: the motion personality the storyline asks for), then `style set` for `colors.bg`, `colors.ink`, `colors.accent`, `fonts.display`, `fonts.ui`, and `platforms` for vertical delivery ([project-model.md](project-model.md#style)). One display face, one UI face, one accent colour.
- **Banned looks** go into the file before the first shot, so every round checks against them. `style set banned` replaces the whole list: read `frameshell style show` first and pass what is already there (the person's rejections from earlier rounds) together with the new entries: `frameshell style set banned '["centred title on a gradient","everything fading in","corner labels","frame borders","glow on UI","generic particle bursts","crossfades between shots","spins, glitches, light leaks","bounce on UI or type"]'`, plus the person's own.
- **Loudness:** set `export.loudness` to `-14` in `frameshell.json` for social platforms.

## 5. Beat grid and storyboard

**Time budget first.** Length in bars = seconds × BPM ÷ (60 × beats per bar): 30 s at 120 BPM is 15 bars. State the lead's share (the proof: the product at work) before writing scenes: aim at 35-40 % of the runtime. When proportions are off, add runtime elsewhere; keep the favourite scene.

Default structure when the brief gives none, with beat shares for a launch (they add up to 100 %):

| Part | Share | Holds |
|---|---|---|
| Hook | 8 % | The pain in one image; the densest 2 s, never black or a logo alone |
| Problem | 12 % | What people do today |
| Reveal | 8 % | The product appears, the key feature in real UI |
| Proof | 36 % | The lead: the product at work, the data travelling |
| Payoff | 20 % | The result |
| Claim | 8 % | The claim in one line |
| End card | 8 %, 2 s at most | Logo and CTA, never static |

Turn shares into seconds (share × length), cap the end card at 2 s and give what it loses to the proof, then round each scene start to a bar (a beat for scenes shorter than a bar) and give the rounding remainder to the proof too, so the scenes add up to the length exactly. 30 s: the end card 2 s, the proof 11.2 s (37 %).

**The grid.** Before music exists, block in bars on a nominal grid: `frameshell tempo set --bpm 120 --meter 4`. With a generated bed: `frameshell sound music <preset> --bpm 120 --bars 15 --no-place` (gate 7) gives the grid exact from the start, and the timeline follows it when it has no tempo. With a supplied track: import it (with its credit), `frameshell beats measure assets/music.wav`, read `frameshell beats show assets/music.wav` (a `LOW` grid: offer the alternatives and wait, see [project-model.md](project-model.md#beat-grid)), put it on an audio track at 0, then `frameshell tempo set --clip <music clip>`. A film led by a voice is clocked by the voice instead: generate it first, place its phrases, and each scene lasts its narration plus the silences before, between and after ([voiceover.md](voiceover.md)).

**The storyboard** is `scripts/<film>.md`, one `## ` scene per shot, its bars and seconds in the heading. It is the source of truth: never reorder, add or drop a scene without the person's OK. Per shot:

```markdown
## Proof (bars 4-9, 0:06-0:18)
- Notices: the total jumps from 0 to 1,240 as the row lands (read 1, 6.0-7.5 s), then the "Paid" badge (read 2, 7.5-9.0 s)
- Mechanism: the invoice from the hook is dragged onto the ledger; claim "it files itself", proof the row it fills
- Action -> end state: cursor drags invoice to ledger -> row filled, badge on
- Hero move: the drop (one per shot); camera: slow push 1.00 -> 1.05
- Text on screen, exact: "Filed." / "1,240.00"
- In: hard cut on bar 4; out: the ledger row is carried into the payoff
- Exposure: ones for the drag (every frame moves), a hold of half a bar on the badge
- Sound: thump on the drop, tick on the count; VO: none
- 9:16: ledger stacked under the invoice, text over 28 px
```

Then:

- Restate the scenes as a list of frame ranges and check that they add up to the length exactly.
- Mark each scene start on the timeline: `frameshell marker add --at bar:4 --label proof` (`bar:N` counts bars from 1). The person sees the plan under the ruler, and later commands land on the labels (`--start proof`, `--at proof+0.5`).
- `frameshell script outline scripts/<film>.md` lists the scenes; fix its warnings.

**Reads.** Per shot, in order, what the viewer must understand, each with a start and an end, no overlaps, each long enough (anything important about 1.5 s). One read at a time; fast actions, slow meanings; reveal each element when the voice or the type names it. A cut must add information.

**Stop** and show the storyboard as a table. Build after the person's explicit OK. Never animate without a storyboard: when the person asks to skip it, offer to draft one from the brief and show that.

## 6. Shots, board, animatic

1. **Shots.** Each shot is a composition of the `hyperframes` plugin (`frameshell plugin list` says whether it is installed; install it and pass `--trust` only after the person agrees). Scaffold it from a template of the catalog in the `hyperframes` skill, `frameshell hyperframes new proof --template counter` (it prints the props and what it took from `style.json`), or write one by hand under that skill's rules.
   **Layout:** the shots go on the bottom video track, butted end to end, so push and wipe between them move the whole picture ([transitions.md](transitions.md#shaped-transitions-pick-by-cause)), each painting the full frame: a template that paints its own background (`app-window`, `device-frame`, `end-card`), one with `bg` and `backdrop` raised toward 1, or a hand-written composition with the backdrop inside it. Never a `scene-background` under the shots with transparent shots over it: a push or wipe there moves only the shots, over a background that stays still, which reads as cards sliding, not as a new shot. Transparent pieces (`kinetic-headline`, `lower-third`, `big-word`) go on a track above, inside their shot's range; they cut hard at the shot's edge, so end them before it or let them leave on their own move. A `glass-card` goes there too, only when `style.json` `glass.cards` is true or the person asked: add it, then `frameshell clip set <clip> --glass` (without it the card is a pale pane; the backdrop is not drawn on the bottom track). A film that wants one continuous background under every shot keeps it on the bottom track and moves between shots with hard cuts and carry inside the compositions instead of push or wipe.
   Place each shot on its scene and link it: `frameshell clip add <bottom track> --type hyperframes --source compositions/hyperframes/proof/index.html --start proof --duration 12 --props '{"to":1240}'`, then `frameshell clip set <clip> --script-ref scripts/film.md#<slug>` with the scene's slug from `script outline`. One transaction per shot.
2. **Board.** One still per shot, posed in the real composition: `frameshell review --sheets contact` lays the timeline out with its markers and cuts; add `frameshell frame --at <s> --out boards/<shot>.png` at each hero move. Show it with the reads written under each still.
3. **Animatic.** `frameshell render --quality draft --out exports/animatic.mp4` with the grid's placeholder or the unfitted music. There is no 540p export: the draft renders at the project size, and its 30 fps cap and fast encode keep it quick. Fix pacing here, before any polish.
4. **Hardest seconds first.** Build the hardest 2-4 s completely and look at them in consecutive frames (`frameshell review --range 6,10 --sheets motion`) before building the rest.
5. **Check each shot paints the same every time.** `frameshell clip verify <clip>` loads the shot cold and after a reseek and compares them; `ok: false` names the time, pixel and element (a CSS transition, a timer, unseeded random). Fix it in the composition now: a shot that fails here renders differently from the preview. It takes up to a minute per clip.

**The shot brief.** Before building a shot (yourself or through a subagent), write its directed brief of about 450 words: GOAL (the one feeling), OUTPUT (format, size, file), TIME (frame range, bars), LOOK (3-5 lines plus the banned looks), MOTION (the personality, springs, the measured defaults below), SHOTS (frame range, one hero move, the handoff; hard cut by default), BANNED, QA (what you check and how); for 3D also MODEL and CAMERA. A directed brief beats a one-liner, and identical briefs make films that rhyme: write each from its storyline.

Up to about six short scenes, one agent is faster. More: write an animation guide first (springs per role, durations, the style values), give each subagent 2-3 scenes and launch them all at once (a second wave nearly doubles the time); shared helpers are read-only. Paste the style guide verbatim at the top of every composition: a paraphrase drifts.

## 7. Cuts, sound and music

- **Cuts on bars.** Hard cuts on bar lines, inner events on beats or half-beats: `--start bar:4`, `--at beat:17.5`, or `--snap-to bar` on a time you have. Visual hits lead slightly so they read on the beat.
- **Transitions by cause** ([transitions.md](transitions.md#shaped-transitions-pick-by-cause)): `frameshell transition set --at proof --kind push --direction left`; never a crossfade between shots. When something just lit up and the next shot is about it, `--kind iris --origin x0,y0,x1,y1` opens from that element (`frameshell inspect --at <s> --point x,y` gives its box); a hard cut that needs weight is `--kind dip-cut`. The shots sit on the bottom video track (gate 6), so a shape there moves the whole frame; on an upper track it moves only that track's pieces over what is below.
- **Carry between shots.** At each boundary a survivor carries across (moves at least 2 % of the frame diagonal or scales at least 10 %), or one large element stays unchanged (anchored). Score = (carried + anchored ÷ 2) ÷ boundaries: under 0.5 fails, under 0.7 needs work. Judge it on the contact sheet, shot by shot.
- **Sound effects** on markers, cuts or typing: `frameshell sound place thump --at proof+1.2 --seed 7`, `frameshell sound place tick --typing --from hook --to hook+1.5` ([sound.md](sound.md)). One seed per film; about 85 % of cuts get no sound.
- **Music.** Two sources, both through the same fit.
  - *Generated:* `frameshell sound music synthwave --bars 15 --sections intro:2,full:6,build:2,drop@reveal,outro:2 --accents logo` makes the bed offline and places it on the `Music` track at -14 LUFS with its exact beat grid ([sound.md](sound.md#music-bed)). Put the `drop` on the hero reveal (30 to 60 % in) and `--accents` on the logo. Its own `--at`, `@time` and `--accents` take seconds or markers, not `bar:N`: mark the bars first (below). Its final hit is exact, so the fit is reliable. Say it is synthesized and offer a licensed track for premium work.
  - *Supplied or free:* put two to seven candidate tracks under the picture at one loudness: `frameshell music candidates assets/music/a.wav assets/music/b.wav --end end-card --dry-run`, then without `--dry-run`. The person listens, then `track set <track> --unmuted` on the winner and `track remove <track> --force` on the rest ([music.md](music.md#candidates-several-tracks-at-one-loudness)). One track: import it and put it on an audio track.
- **Music on the end card.** `music fit` takes the grid directly: `frameshell music fit <music clip> --end bar:15 --dry-run`, then without `--dry-run` (`--from bar:N` where the music may start; a marker label works too). The bar is read on the clip as it is before the fit. Mark `end-card` as well (`frameshell marker add --at bar:15 --label end-card`) so later commands and a re-fit follow the label. `sound place --at` still takes seconds and markers only, so put a marker on a bar before placing a sound on it. The grid follows the moved clip: read `frameshell tempo show`, re-snap markers that drifted (`frameshell marker set <marker> --at <s> --snap-to bar`) and move their clips (`frameshell clip move <clip> --start <marker>`).
- **Level and duck.** `frameshell duck <music track> --under <voice track> --level 12` sets the music 12 dB under the voice by loudness and dips it while someone speaks; run it after the fit, and again after the voice changes. A film with no voice needs neither.

## 8. Formats, critique and finals

- **Every format is re-blocked, never letterboxed.** Templates lay out per format; a hand-written composition picks its layout with `M.pick` (the `hyperframes` skill). Look at each: `frameshell review --format 9x16` and, for vertical delivery, `frameshell review --platform instagram` (safe zones, [critique.md](critique.md)).
- **Critique loop:** at least three rounds of [critique.md](critique.md) on a draft render until every score is 8 or more. Each round reads the numbers `review` writes (`metrics.json`: `picture.longestStatic`, `largestGap`, `blank`, `firstFrameEmpty`; for a rendered file the `loudness` and `phoneBand`; the `craft` warnings) beside the sheets, and fixes or explains every warning. Review the draft file with `--file` so the loudness is measured. With a reference film, set its `analyze` rhythm beside ours and say how far apart they are: targets, not pass or fail. Never show the film before that unless the person asks for an early look.
- **Before the finals:** run `frameshell clip verify <clip>` on every generated clip you changed since gate 6; a clip that fails renders differently from what the person approved.
- **Finals:** `frameshell render --quality final --formats 16x9,9x16`, `frameshell credits`, then deliver with each file a contact sheet (`frameshell review --file exports/<file>.mp4`), a loop check (`frameshell review --file exports/<file>.mp4 --sheets seam`: would it hold played twice back to back) and a poster frame (`frameshell cover --text <word> --out exports/poster.png`). A film delivered as a loop (a banner, a title loop) renders with `frameshell render --loop --out exports/<file>.mp4` and its warnings are read ([loops.md](loops.md)); it takes no cover frame. Variants of the finished film (languages, product rows, sizes) are `frameshell batch <file.batch.json> --dry-run`, then without it: one patched copy of the timeline per row, never a second storyboard ([cli.md](cli.md)). Report the scores, the free and paid items used, and anything still imperfect.

## Motion and layout rules

- **Hook readable by 2 s;** frame 0 already a composition, never empty.
- **Something new every 2-4 s;** no hold longer than a bar; a held shot keeps a micro push (scale 1.00 to 1.03-1.08); nothing ever fully stops: start the next move before the last settles, offset related keys by a couple of frames.
- **Springs** for anything that enters, exits or retargets; enters about 0.5 s with slight overshoot, exits faster than enters. An entrance or exit is a move, with opacity only riding along. Swaps are sequential: the outgoing element is gone before the incoming one lands.
- **Measured defaults at 30 fps:** a move takes about 10 frames (translate 12, opacity 6, blur 7, exits 13-14); words land 2-4 frames apart in a hook, 4-6 in a headline, 8-12 when a voice leads; count-ups about 1 s. At most a quarter of the beats are weighted "this is the point".
- **A cursor is a hand:** it travels on arcs, hesitates before its target, and every click gets a small press that causes the next beat.
- **Text:** at least 28 px at 1080p and readable on the `phone` sheet at 360 px wide; real UI and logos.

## Director notes

- **Effort**, where your harness sets it: medium for fixes and re-renders, high for a new film, max when the first 3 s must carry a launch.
- A note from the person is a rule for the whole film. Change the smallest thing that answers it, in its own transaction, and keep the rest exactly as it was.
- Ask for notes in camera words ("slow every zoom to 0.7x", "hard cut here", "push in on the button"); a vague note leads to random changes, so turn it into one before acting.
- To choose between directions, build two or three variants of the storyboard or of one shot and let the person pick, as in the comparison of [critique.md](critique.md#3-score-or-compare).
