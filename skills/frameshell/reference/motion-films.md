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
- A reference film (optional): measured with `analyze` ([reference-video.md](reference-video.md)); take its grammar (rhythm, transitions, shot lengths), never its content.
- Music: a track they supply, a free licensed track, or a paid one (gate 3).
- Voice: none (the type carries the words), a voice on this machine, or a paid provider ([voiceover.md](voiceover.md)).
- Must show, must avoid.

Keep the answers in the style file, value by value: `frameshell style set brand.product "Acme"`, then `brand.url`, `brand.promise`, `brand.cta`, `brand.audience`, `brand.mustShow`, `brand.mustAvoid` (lists as JSON). A later session reads them with `style show` instead of asking.

## 2. Three storylines

Write three storylines into `scripts/storylines.md` and recommend one. Each is **one viewer doing one real task**, with one real piece of data travelling from the hook to the payoff. The three differ in the central idea, and each lives in a different world, uses a different device (a cursor in an app, a chat, a phone in a hand, a terminal) and takes a different form (a demo, a before/after, a countdown, a single unbroken move). Never default to a template's story or to the last film's look.

Per storyline: a title, the viewer and their task, the data that travels, the hook in one line, the five beats in one line each, what it costs to make. Before recommending, compare it with the project's last film (a previous `scripts/storylines.md` or the person's last export): at least 4 of 6 aspects (world, device, form, palette, motion, music) differ, or it is the last demo again.

**Stop.** Build nothing until the person picks one.

## 3. Assumptions and costs

List what you assume (audience, platform, length, every fact on screen) and every item that costs money, each with a free alternative beside it. Spend nothing without the person's yes.

| Item | Paid | Free alternative |
|---|---|---|
| Voice | A paid speech provider: `voiceover generate` refuses with `ConfirmationRequired` and the cost; `--yes` only after they confirm | The `command` provider running a local voice the person installs ([voiceover.md](voiceover.md#the-command-provider)), or no voice and kinetic type |
| Music | A track from a paid library or a music generator | A CC0 track, or the person's own ([credits.md](credits.md)) |
| Fonts | A commercial licence | An open-licence font (OFL), copied into `assets/fonts/` |
| Pictures | Stock, image or video generators | The product's real UI and logo, and the motion templates (`device-frame`, `app-window`, `scene-background`) |
| Sound effects | Sample packs | `sound sfx`: made offline, the person's own ([sound.md](sound.md)) |
| 3D | A render service | The `blender` skill with the person's own Blender, when the plugin is installed |

**Facts:** only figures from the brief or a source the person gave, with their scope ("in our beta, 40 teams"). Illustrative numbers and UI get labelled `SCHEMATIC` in the storyboard; an unvalidated claim says so.

## 4. Brand and style guide

- **Real brand, never redrawn.** Logo, screenshots and colours come from the person or their page. Save what you fetch under a new name in `assets/` (the first-bytes check of [credits.md](credits.md)) and record it: `frameshell credits set assets/logo.svg --licence own --source-url <page>`. A font file goes into `assets/fonts/` with its own licence: `frameshell credits set assets/fonts/Inter.ttf --licence OFL-1.1 --source-url <url>`.
- **Style values.** `frameshell style apply premium` (or `playful`, `corporate`, `energetic`, `calm`: the motion personality the storyline asks for), then `style set` for `colors.bg`, `colors.ink`, `colors.accent`, `fonts.display`, `fonts.ui`, and `platforms` for vertical delivery ([project-model.md](project-model.md#style)). One display face, one UI face, one accent colour.
- **Banned looks** go into the file before the first shot, so every round checks against them: `frameshell style set banned '["centred title on a gradient","everything fading in","corner labels","frame borders","glow on UI","generic particle bursts","crossfades between shots","spins, glitches, light leaks","bounce on UI or type"]'`, plus the person's own.
- **Loudness:** set `export.loudness` to `-14` in `frameshell.json` for social platforms.

## 5. Beat grid and storyboard

**Time budget first.** Length in bars = seconds × BPM ÷ (60 × beats per bar): 30 s at 120 BPM is 15 bars. State the lead's share (the product at work) before writing scenes: aim at 35-40 % of the runtime. When proportions are off, add runtime elsewhere; keep the favourite scene.

Default structure when the brief gives none, with beat shares for a launch:

| Part | Share | Holds |
|---|---|---|
| Hook | 8 % | The pain in one image; the densest 2 s, never black or a logo alone |
| Problem | 12 % | What people do today |
| Product | 8 % reveal + 40 % proof | The key feature in real UI, the data travelling |
| Payoff | 20 % | The result |
| Logo + CTA | 8 % claim + 8 % end card | The claim, then the end card (2 s at most, never static) |

**The grid.** Before music exists, block in bars on a nominal grid: `frameshell tempo set --bpm 120 --meter 4`. With the track: import it (with its credit), `frameshell beats measure assets/music.wav`, read `frameshell beats show assets/music.wav` (a `LOW` grid: offer the alternatives and wait, see [project-model.md](project-model.md#beat-grid)), put it on an audio track at 0, then `frameshell tempo set --clip <music clip>`. A film led by a voice is clocked by the voice instead: generate it first, place its phrases, and each scene lasts its narration plus the silences before, between and after ([voiceover.md](voiceover.md)).

**The storyboard** is `scripts/<film>.md`, one `## ` scene per shot, its bars and seconds in the heading. It is the source of truth: never reorder, add or drop a scene without the person's OK. Per shot:

```markdown
## Proof (bars 4-9, 0:06-0:18)
- Notices: the total jumps from 0 to 1,240 as the row lands (read 1, 6.0-7.5 s), then the "Paid" badge (read 2, 7.5-9.0 s)
- Mechanism: the invoice from the hook is dragged onto the ledger; claim "it files itself", proof the row it fills
- Action -> end state: cursor drags invoice to ledger -> row filled, badge on
- Hero move: the drop (one per shot); camera: slow push 1.00 -> 1.05
- Text on screen, exact: "Filed." / "1,240.00"
- In: hard cut on bar 4; out: the ledger row is carried into the payoff
- Sound: thump on the drop, tick on the count; VO: none
- 9:16: ledger stacked under the invoice, text over 28 px
```

Then:

- Restate the scenes as a list of frame ranges and check that they add up to the length exactly.
- Mark each scene start on the timeline: `frameshell marker add --at bar:4 --label proof` (`bar:N` counts bars from 1). The person sees the plan under the ruler, and later commands land on the labels (`--start proof`, `--at proof+0.5`).
- `frameshell script outline scripts/<film>.md` lists the scenes; fix its warnings.

**Reads.** Per shot, in order, what the viewer must understand, each with a start and an end, no overlaps, each long enough (anything important about 1.5 s). One read at a time; fast actions, slow meanings; reveal each element when the voice or the type names it. A cut must add information.

**Stop** and show the storyboard as a table. Build after the person's explicit OK.

## 6. Shots, board, animatic

1. **Shots.** Pick a template from the catalog in the `hyperframes` skill (`frameshell plugin list` shows it; install the plugin and pass `--trust` only after the person agrees) or write a motion composition by hand under that skill's rules. A `scene-background` on the bottom video track, shots on the tracks above. Place each on its scene and link it: `frameshell clip add <track> --type hyperframes --source compositions/hyperframes/proof/index.html --start proof --duration 12 --props '{"to":1240}'`, then `frameshell clip set <clip> --script-ref scripts/film.md#<slug>` with the scene's slug from `script outline`. One transaction per shot.
2. **Board.** One still per shot, posed in the real composition: `frameshell review --sheets contact` lays the timeline out with its markers and cuts; add `frameshell frame --at <s> --out boards/<shot>.png` at each hero move. Show it with the reads written under each still.
3. **Animatic.** `frameshell render --quality draft --out exports/animatic.mp4` with the grid's placeholder or the unfitted music. Fix pacing here, before any polish.
4. **Hardest seconds first.** Build the hardest 2-4 s completely and look at them in consecutive frames (`frameshell review --range 6,10 --sheets motion`) before building the rest.

More than about six scenes: write an animation guide first (springs per role, durations, the style values), give each subagent 2-3 scenes and launch them all at once; shared helpers are read-only. Paste the style guide verbatim at the top of every composition: a paraphrase drifts.

## 7. Cuts, sound and music

- **Cuts on bars.** Hard cuts on bar lines, inner events on beats or half-beats: `--start bar:4`, `--at beat:17.5`, or `--snap-to bar` on a time you have. Visual hits lead slightly so they read on the beat.
- **Transitions by cause** ([transitions.md](transitions.md#shaped-transitions-pick-by-cause)): `frameshell transition set --at proof --kind push --direction left`; never a crossfade between shots.
- **Carry between shots.** At each boundary a survivor carries across (moves at least 2 % of the frame diagonal or scales at least 10 %), or one large element stays unchanged (anchored). Score = (carried + anchored ÷ 2) ÷ boundaries: under 0.5 fails, under 0.7 needs work. Judge it on the contact sheet, shot by shot.
- **Sound effects** on markers, cuts or typing: `frameshell sound place thump --at proof+1.2 --seed 7`, `frameshell sound place tick --typing --from hook --to hook+1.5` ([sound.md](sound.md)). One seed per film; about 85 % of cuts get no sound.
- **Music on the end card.** `--end` of `music fit` and `--at` of `sound place` take seconds or a marker, not `bar:N`: mark the bar first. `frameshell marker add --at bar:15 --label end-card`, then `frameshell music fit <music clip> --end end-card --dry-run`, then without `--dry-run` ([music.md](music.md)). The grid follows the moved clip: read `frameshell tempo show`, re-snap markers that drifted (`frameshell marker set <marker> --at <s> --snap-to bar`) and move their clips (`frameshell clip move <clip> --start <marker>`).

## 8. Formats, critique and finals

- **Every format is re-blocked, never letterboxed.** Templates lay out per format; a hand-written composition picks its layout with `M.pick` (the `hyperframes` skill). Look at each: `frameshell review --format 9x16` and, for vertical delivery, `frameshell review --platform instagram` (safe zones, [critique.md](critique.md)).
- **Critique loop:** at least three rounds of [critique.md](critique.md) on a draft render until every score is 8 or more. Never show the film before that unless the person asks for an early look.
- **Finals:** `frameshell render --quality final --formats 16x9,9x16`, `frameshell credits`, then deliver with each file a contact sheet (`frameshell review --file exports/<file>.mp4`), a loop check (`frameshell review --file exports/<file>.mp4 --sheets seam`: would it hold played twice back to back) and a poster frame (`frameshell cover --text <word> --out exports/poster.png`). Report the scores, the free and paid items used, and anything still imperfect.

## Motion and layout rules

- **Hook readable by 2 s;** frame 0 already a composition, never empty.
- **Something new every 2-4 s;** no hold longer than a bar; a held shot keeps a micro push (scale 1.00 to 1.03-1.08); nothing ever fully stops: start the next move before the last settles, offset related keys by a couple of frames.
- **Springs** for anything that enters, exits or retargets; enters about 0.5 s with slight overshoot, exits faster than enters. An entrance or exit is a move, with opacity only riding along. Swaps are sequential: the outgoing element is gone before the incoming one lands.
- **Measured defaults at 30 fps:** a move takes about 10 frames (translate 12, opacity 6, blur 7, exits 13-14); words land 2-4 frames apart in a hook, 4-6 in a headline, 8-12 when a voice leads; count-ups about 1 s. At most a quarter of the beats are weighted "this is the point".
- **A cursor is a hand:** it travels on arcs, hesitates before its target, and every click gets a small press that causes the next beat.
- **Text:** at least 28 px at 1080p and readable on the `phone` sheet at 360 px wide; real UI and logos.

## Director notes

- A note from the person is a rule for the whole film. Change the smallest thing that answers it, in its own transaction, and keep the rest exactly as it was.
- Ask for notes in camera words ("slow every zoom to 0.7x", "hard cut here", "push in on the button"); a vague note leads to random changes, so turn it into one before acting.
- To choose between directions, build two or three variants of the storyboard or of one shot and let the person pick, as in the comparison of [critique.md](critique.md#3-score-or-compare).
