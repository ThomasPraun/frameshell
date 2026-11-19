# Sound (effects, generated music, audition; ADR 0038)

- Files: `sfx.ts` recipes, `dsp.ts`, `takes.ts`, `generate.ts`, `place.ts`; music `music.ts` sequencer, `music-place.ts` plan, `music-take.ts` write, `music-worker.ts`, `loudness.ts` pure meter + limiter. `packages/schema/src/sound.ts` (`SOUND_ROLE_OFFSETS`, tiers, gaps). `transcripts/window.ts` (`wavBytes`). CLI `packages/cli/src/sound-commands.ts`. Skill `skills/frameshell/reference/sound.md`.
- `sound.sfx`: seeded synth, same args = same file. Take in `assets/sound/` with `fssd` RIFF key chunk + `peakAt`; role offsets. `own` credit only if ledger exists.
- `sound.place`: cues/cuts/typing → takes → whole frames → `SFX` lanes, one tx. Gain = `-sfxUnderVoice` + tier. Taste warnings never refuse.
- `sound.music`: seeded sequencer, sections, take -14 LUFS / -1 dBFS, exact beats file.
- Audition (`audio.inspect`, read-only): loudness from `LoudnessStore`, `fssd` take facts, spectrogram via `fft.ts` in a worker, memory cache only. Files `media/spectrogram.ts` (pure), `media/audio-inspect.ts`. App dialog: `apps/desktop/CLAUDE.md`.
