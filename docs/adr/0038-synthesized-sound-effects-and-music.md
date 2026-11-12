---
status: accepted
---

# Synthesized sound effects and music: a seeded synth in core, marked takes in assets/sound/, placement by anchor on time references

#463 (epic #451) asks for offline, seeded sound effects (click, tick, pop, whoosh, riser, thump, impact, shutter) and music (tempo, chords, sections, genre presets), written as WAV files under new names, placed on markers or events, the same file for the same seed, with loudness in range per kind. The ticket text proposed an official plugin `@frameshell/sound`. The owner decided on 2026-11-11: option A, every recommendation of the proposed decision accepted (the eight points below). It ships in slices; **slices 1 (the sound effects, `sound.sfx`) and 2 (`sound.place`) are built so far.**

## Context (verified)

- No sound or music code existed. Core had no synth; the schema had no tempo and no beats file schema (ADR 0029 slice 2 defines it).
- A plugin command (`CommandContext`) has no daemon handle: it cannot import an asset, read a marker or add a clip, and plugins load only in trusted projects. SPEC §13 limits official plugins to a short list.
- Voiceover (ADR 0034) has the shape: WAV takes in `assets/voiceover/<slug>/`, each holding a RIFF chunk with its own cache key, a file without the chunk never overwritten, one `asset.import` for the new ones.
- `pcmWavBytes` wrote mono 16-bit only. `STYLE_DEFAULTS.sound` holds the relative levels (`musicUnderVoice` 12 dB, `sfxUnderVoice` 20 dB); ADR 0028 keeps the integrated target in `export.loudness`.
- Credits (ADR 0026): licence `own` needs no credit, but `credits.check` fails a placed asset with no entry once a ledger exists. Cross rule 6 of #451 says generated sounds record credits through that path.
- #478: take nothing from HyperFrames `media-use` (HeyGen account and network); build in core, reference tools are references only.

## Decision

1. **In core, not a plugin.** The synth lives in `packages/core/src/sound/`, exposed through daemon methods; the CLI group `sound` is built-in and reserved (`BUILTIN_COMMANDS`, cross rule 5), so plugins may not shadow it. It writes marked WAV takes into `assets/sound/` and imports them, like voiceover. No SPEC §13 amendment, and it works in untrusted projects. The same parameters and seed always give the same file (a PCM hash test per kind and variant; own transcendental functions if V8's ever differ across platforms).
2. **Kinds in v1:** `click`, `tick`, `pop`, `whoosh`, `riser`, `thump`, `impact`, `shutter`, three variants each, a family seed and seeded jitter (pitch 0.9 to 1.3, level within 1.5 dB). Glitch, braaam, swell, bell and notify come later.
3. **Placement by a role table.** Every take records `peakAt` in its RIFF chunk. Placement puts it on the cue (a TimeRef: marker or seconds) plus an offset from `SOUND_ROLE_OFFSETS` in `packages/schema` (click -11 ms, tap -60, knock -40, pop +30, whoosh peak +37, swell peak +42; a riser ends 75 ms before the hit), overridable with `--offset`.
4. **Credits.** An entry `licence: own`, author "Frameshell sound synth", only when the project already has a `credits.json` ledger.
5. **Caps warn, never refuse:** more than 2 sounds on one frame, gaps below the per-kind minimum (tick 66 ms, key 87, pop 114), the same take twice in a row; the same rules are lint rules for #457.
6. **Music writes an exact beats file** (`detector: "exact"`, confidence 1, downbeat phase), using the one beats file schema (cross rule 3 on #451).
7. **CC0 set:** not now; later an optional on-demand download (licence files read before pinning), never committed, recorded in the credits ledger.
8. **The 4x-oversampled true-peak limiter for export** is its own ticket.

Gain: clip `gain` relative to the voice from `style.sound.sfxUnderVoice` and `musicUnderVoice`, with role tiers 0, -4 and -8 dB; takes are normalised on write (sound effects to a fixed peak; music to -14 LUFS with peak at most -1 dBFS). Format: 48 kHz WAV, 16-bit mono sound effects (the whoosh is stereo), 24-bit stereo music; `pcmWavBytes` is generalised, not copied.

## Slices

1. **Sound effects:** `SFX_KINDS` and the role table in `packages/schema/src/sound.ts`, the synth, `sound.sfx`, CLI `frameshell sound sfx`, MCP `sound_sfx`, protocol bump. Built, see below.
2. **Placement:** `sound.place` on TimeRef cues (the shared resolver of ADR 0037), on the cuts of a track and on typing runs, with gain from the style and the warnings of decision 5; CLI `sound place`, MCP `sound_place`, skill reference of the placement grammar. Built, see below.
3. Music: a seeded 16-step sequencer (synthwave, lo-fi, minimal), sections, sidechain, `sound.music`, the exact beats file.
4. Credits integration for music takes and the remaining docs.
5. Later: the CC0 set, more kinds, an audition page.

## Slice 1 as built

- **Method.** `sound.sfx { kind, variant = 1, seed = 0, pitch?, length? }`, mutating. It writes `assets/sound/<kind>-<first 8 hex of the key>.wav` and imports it with one `asset.import`; the result carries the file, `state` (`generated` or `cached`), `duration`, `channels`, `peakAt`, `peakDb`, `rmsDb`, the pitch used, the `imported` job and `credited`. One run per project at a time. Review mode is not involved: assets are not journaled (ADR 0019); the timeline change of slice 2 will be a proposal.
- **The take key** is the SHA-256 of the key version, kind, variant, seed and the caller's `pitch` and `length` when given. It is stored with the kind, variant, seed, the pitch and level jitter actually used and `peakAt` in the RIFF chunk `fssd` between `fmt ` and `data`. A file already at that name whose mark holds the key is `cached` and not written again; a file with no mark, or another key, is refused with `InvalidOperation` and never overwritten. Bumping `SFX_KEY_VERSION` makes new names, so old takes stay.
- **Synth.** Pure TypeScript at 48 kHz: a seeded Mulberry32 generator (seeded from a hash of the parameters), biquad filters with clamped coefficients, additive tones, saturation with `tanh`. Recipes use the numbers of the ticket's comments (click 1 ms high-passed burst plus a 2.3 kHz blip and a 520 Hz body, or two pings that fall to half pitch in 35 ms; pop glide 820 to 1720 Hz; thump sine 95 to 42 Hz saturated under a low-passed noise sweep; whoosh band-passed noise sweeping 160 to 350 up to 3400 to 6850 Hz with its peak at 45 % of its length, panned left to right; riser noise sweep plus a rising saw with exponential gain growth, cut at its peak; impact a deep falling sub, a crack and a dark tail; shutter two band-passed clacks 30 to 40 ms apart). It runs inline: the longest take (a riser of 6 s) takes tens of milliseconds, so no worker thread yet; the music slice will need one (`worker-task.ts`).
- **Anchor.** `peakAt` is where the take meets the picture: the transient of a hit, the peak of a whoosh (45 % of its length), the end of a riser. Build sounds have a lead, so their peak, not their start, falls on the cue.
- **Level.** The peak is normalised to -3 dBFS and then shifted by the seeded jitter (±1.5 dB), so it is always below -1 dBFS. Normalising to loudness is for music (slice 3).
- **Credits.** After the write, when `credits.json` exists the take gets an entry (licence `own`, author "Frameshell sound synth") unless it has one; a take made before the ledger existed is recorded the next time it is asked for. No ledger: nothing is written.
- **Shared code.** `wavBytes` in `transcripts/window.ts` writes any channel count at 16 or 24 bits; `pcmWavBytes` calls it with the same bytes as before, so voiceover and transcription windows are unchanged. The rule that a file without our chunk is never overwritten is the voiceover rule, copied in shape because the two marks differ.
- **Registry type size.** `TimelinePatchSchema` is typed by name (`z.ZodType<TimelinePatch>`): it is the inverse of every operation result, so its structure was written out in dozens of methods and the `methods` registry hit TS7056 with one more entry.
- Protocol 92.

## Slice 2 as built

- **Method.** `sound.place { timeline = main, cues?, cuts?, typing?, track? }`, mutating; at least one of `cues`, `cuts`, `typing`. It makes every take like `sound.sfx` (the same code, cached when current, serialised with other sound work of the project), then writes **one transaction** `Sound: 2 whoosh, 3 click` made of at most one `track.add` per audio track it needs and a `clip.add` per sound. In review mode that is one proposal (ADR 0019); `revert` undoes it whole, the new track included. Planning (`planSounds`) is separate from the writes (`runPlan`) and touches no timeline file; the daemon opens the transaction only when there is a sound to write.
- **Where.** A *cue* is `{ at, kind, … }` with `at` a TimeRef resolved by the shared resolver of ADR 0037 against the timeline as the caller sees it (this code parses nothing; `beat:` and `bar:` work the day that resolver builds them). `cuts` is the start of every clip after the first of a video, audio or program track, or the numbered ones in `which`. `typing` is a run of keys between `from` and `to`: `tick` (default) or `click`, 8 keys a second by default, at most 10, each interval jittered by ±10 % from a seed (so the cues of two keys are at least 90 ms apart, above the 87 ms of the key gap; whole frames can bring the placed keys closer, which `soundWarnings` checks on the anchors), the takes rotating through 3 variants and 2 seeds so one never repeats the one before it. At most 200 sounds per call; the whole call is refused before any file is written when a time, track or cut number is wrong.
- **Offset.** A sound lands at `cue + offset - anchor`, the offset from `SOUND_ROLE_OFFSETS` by `role`, or `offset` (ms) when given. A kind has a default role: `click` and `shutter` click, `tick` tap, `pop` and `thump` pop, `whoosh` whoosh, `impact` knock; a riser has none and ends 75 ms before the cue. The result reports the offset used.
- **Whole frames.** A clip starts on a frame and the engine keeps whole frames of a file (it cuts the source at the last frame boundary). So a sound lands within half a frame of where asked (the -11 ms of a click is lost at 30 fps, and 60 ms becomes 2 frames), a riser loses its last partial frame (its anchor is planned at the end of the last whole frame), and a sound shorter than one frame cannot be a clip: it is listed in `skipped` with the reason, never a failure of the call. No take is that short at 20 fps or more: `synthesizeSfx` pads every take to `SFX_MIN_LENGTH` (50 ms) with silence, so a 35 ms tick is a clip at 24 and 25 fps (this bumped `SFX_KEY_VERSION` to 2; takes made before stay as they are under their old names). A sound whose start would fall before the timeline is cut at its head (`in`) with a warning, or skipped when nothing would be left.
- **Tracks.** The sounds go on the audio track named `SFX` (made when absent) or on `track`. Clips on one track cannot overlap and the sounds of a whoosh and a click do, so a sound that does not fit goes on `SFX 2`, `SFX 3` and so on (found by name, else made); each new clip keeps a spare frame from its neighbour. Only the tracks the call used are listed.
- **Gain.** Clip `gain` = `-style.sound.sfxUnderVoice` plus the tier in `SOUND_TIER_OFFSETS_DB` (primary 0, secondary -4, texture -8 dB), or `gain` when given. The voice is the reference by convention: takes peak at -3 dBFS, and nothing measures the voice (per-asset loudness is ADR 0037 slice 3). A kind has a default tier: tick texture, shutter secondary, the rest primary; a typing run is texture. The linear gains of the ticket body (0.7 to 0.9, 0.45 to 0.6, 0.3 to 0.4) are superseded by this decision comment's dB tiers.
- **Variants.** A sound without `variant` rotates through 1 to 3 along the timeline, starting after the sounds of that kind already on the audio tracks, so the same whoosh is not twice in a row, within a call or across calls.
- **Warnings** (never refusals, decision 5), computed over the new sounds and those already on audio tracks (read from the `fssd` mark of each take): more than 2 anchors on one frame (`SOUND_MAX_PER_FRAME`); two ticks closer than 66 ms or two pops closer than 114 ms (`SOUND_MIN_GAP_MS`; two keys of a typing run closer than 87 ms, `SOUND_KEY_GAP_MS`, measured on the placed anchors); one take twice in a row in time order. Only warnings that involve a new sound are shown, the first 6 and then a count. The same function (`soundWarnings`) is what #457 can lint with.
- **Credits** are the slice 1 path: each take is recorded as `own` when the project keeps a ledger.
- **Stale.** The times are read before the takes are made and the timeline is read again after: a changed revision fails with `StaleRevision` and places nothing (the takes stay, they are cached).
- Protocol 100.

## Considered options

- **B. An official plugin `@frameshell/sound`** (rejected): plugin commands cannot reach the daemon, so placement needs a new plugin API surface for every plugin; the plugin is lost in untrusted projects; a second SPEC §13 amendment right after ADR 0035; against #478.
- **C. HyperFrames `media-use`** (rejected, #478): needs an account and the network.
- **D. A bundled CC0 set instead of synthesis** (deferred, decision 7): downloads on demand with credits, later; the owner notes that synthesis reads cheap next to real recordings, and the audition page of slice 5 lets the person choose.

## Consequences

- Core grows by about 600 lines of DSP for the sound effects, more with music.
- The same seed gives the same samples only on machines whose V8 has the same `Math.sin`, `exp`, `cos` and `tanh`; the hash test in CI on macOS, Linux and Windows shows the day they differ.
- `assets/sound/` is project media: `gc` never touches `assets/`, and a clone carries the takes and their keys.
- A project with a ledger gets one `own` entry per take; a project without one gets none and no export warning.
