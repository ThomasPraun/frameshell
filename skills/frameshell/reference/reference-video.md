# Reference video

"Make it like this video" works when you measure the reference instead of guessing. `analyze` reads a video the person gives you (a reel they like, a competitor, their own older film) and writes down its **grammar**: how it cuts, what colours it uses, how loud it is, what tempo it keeps. Take the grammar; never take the content (characters, designs, script, footage). Commands assume the session rule of [SKILL.md](../SKILL.md).

## 1. Measure it

```sh
frameshell analyze references/reel.mp4 --json
```

MCP: `analyze { file: "references/reel.mp4" }` returns the sheets as images and the numbers as JSON. The video can be anywhere on disk (a download folder is fine); it is only read. A 1-minute 1080p video takes about 25 seconds (a background `analyze` job; MCP `job_list`). It writes `.frameshell/analysis/<name>/` (`<name>`: the file name in lower case; `--name` picks another; a new run with the same name replaces the folder; it is regenerable and never touches project files):

- `contact*.png`: a frame every 0.5 s (2 per second), 30 to a sheet, with the first frame of each shot marked `cut` (`4.00 cut`). Look at these first: they show the pacing, the layouts and where text sits.
- `shots*.png` and `frames/shot-<n>.jpg`: the middle frame of every shot, labelled `#<shot> <start>`. One JPEG per shot (640 px) to open when a shot matters.
- `analysis.json`: everything below, plus the beat lists (`tempo.beats`, `tempo.downbeats`).

## 2. Read the numbers

- **Cutting** (`stats`): `shotCount`, `cutsPerMinute`, `averageLength`, `medianLength`, `shortest`, `longest` (seconds). The median says more than the average: one long hold skews the average. A reel at 25 or more cuts a minute is fast; a talking head under 8 is calm. `shots` lists each shot's `start`, `end`, `length` and `cutScore` (how violent the cut that opens it is, 0 to 1).
- **Palette** (`palette`, and one per shot): up to 5 colours as `#rrggbb` with their `share` of the pixels. Black bars and a blurred background count as colours, so look at the frames before calling a palette the look. A palette that repeats from shot to shot is a colour system; one that changes is a mood change.
- **Loudness** (`loudness`): integrated LUFS, loudness range in LU and true peak in dBTP. Compare with the project's `export.loudness` (default -17 LUFS) before copying a number: the reference may be mastered for a different platform.
- **Tempo** (`tempo`, null without a steady beat): `bpm`, `meter` and `confidence`. `low: true` means do not trust it: speech and ambient sound read as low, and calm music may read as double or half time (`alternatives` lists them). With music you want in your film, measure the track itself (`frameshell beats measure`), not the reference.
- **Times**: every time is a frame index ÷ fps rounded down to the millisecond (`startFrame`, `endFrame` give the frames). Use frames when you need to be exact.

## 3. What it does not find

A hard cut is found. A dissolve, a whip pan or a jump cut inside one continuous take is not (`--threshold 0.15` finds softer cuts and false ones; look at the frames it adds). Where large text sits, motion curves and eases, flashes and sound hits are not measured yet: read them from the sheets and say so.

## 4. Tell the person what you know and what you guess

Label every value you report:

- **MEASURED**: read by `analyze` (shot times, cuts per minute, palette, LUFS, BPM).
- **ESTIMATED**: seen by eye on the sheets (where text sits, what is 2D or 3D, the camera move and its direction, where the hook and the twist land). Vision estimates of positions are approximate: name the exact frames to check (`#7 at 12.30 s, frame 369`).
- **DECISION**: our creative choice for the new film.

End with about five decisions for an original episode ("cut every 1.4 s, median 1.2; two-colour palette of the brand; -14 LUFS for this platform"), each saying which measured number it comes from. Never copy characters, designs or script. The numbers feed the style file and the plan of the new film: write them there, with the reference's file name as their source.
