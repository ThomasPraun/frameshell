---
status: accepted
---

# Synthesized sound effects and music: a seeded synth in core, marked takes in assets/sound/, placement by anchor on time references

#463 (epic #451) asks for offline, seeded sound effects (click, tick, pop, whoosh, riser, thump, impact, shutter) and music (tempo, chords, sections, genre presets), written as WAV files under new names, placed on markers or events, the same file for the same seed, with loudness in range per kind. The ticket text proposed an official plugin `@frameshell/sound`. The owner decided on 2026-11-11: option A, every recommendation of the proposed decision accepted (the eight points below). It ships in slices; **slice 1, the sound effects and `sound.sfx`, is what is built so far.**

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
2. `sound.place` on TimeRef cues (the shared resolver of ADR 0037), with gain from the style and the warnings of decision 5; skill reference of the placement grammar.
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

## Considered options

- **B. An official plugin `@frameshell/sound`** (rejected): plugin commands cannot reach the daemon, so placement needs a new plugin API surface for every plugin; the plugin is lost in untrusted projects; a second SPEC §13 amendment right after ADR 0035; against #478.
- **C. HyperFrames `media-use`** (rejected, #478): needs an account and the network.
- **D. A bundled CC0 set instead of synthesis** (deferred, decision 7): downloads on demand with credits, later; the owner notes that synthesis reads cheap next to real recordings, and the audition page of slice 5 lets the person choose.

## Consequences

- Core grows by about 600 lines of DSP for the sound effects, more with music.
- The same seed gives the same samples only on machines whose V8 has the same `Math.sin`, `exp`, `cos` and `tanh`; the hash test in CI on macOS, Linux and Windows shows the day they differ.
- `assets/sound/` is project media: `gc` never touches `assets/`, and a clone carries the takes and their keys.
- A project with a ledger gets one `own` entry per take; a project without one gets none and no export warning.
