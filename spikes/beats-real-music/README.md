# Spike: the DSP beat detector on generated and CC0 music (#689)

Checks `onset-flux@1` (`packages/core/src/media/beats.ts`) against music that is not a click track. Findings, method and
the go/no-go for a learned detector: [`docs/research/beats-real-music.md`](../../docs/research/beats-real-music.md).

Self-contained, no dependencies, never part of the pnpm workspace. It imports the **built** core (`pnpm build` at the repo
root first) and the managed ffmpeg (`FRAMESHELL_FFMPEG`, or `FRAMESHELL_TEST_BINARIES_DIR`, or `.cache/test-binaries`).
No audio is committed: every script takes a directory outside the repo (`FRAMESHELL_BEATS_MUSIC_DIR` or argv) and
refuses one inside it. Delete the directory when done.

```sh
export FRAMESHELL_BEATS_MUSIC_DIR=<temp dir outside the repo>
node make-corpus.mjs     # synthetic corpus + manifest.json (sound.music takes, ffmpeg variants, drum patterns, rubato)
node run.mjs             # per track: tempo vs expected (octave-aware), confidence, residual; results.json beside the audio
node fetch-cc0.mjs       # CC0 tracks from the Internet Archive (licenseurl checked per item) + manifest.json
```

`manifest.json` entries: `file`, `bpm`, optional `beats` / `beatsFile` (exact truth) or `firstBeat`, `hint`, `decode`
(`sidecar` 48 kHz stereo or `fallback` 16 kHz mono), `group`, `acceptOctave`, `informational`, `source`, `licence`.
