---
status: accepted
---

# Export loudness runs on a lossless mix intermediate

With ffmpeg 9.0.2, putting `loudnorm` at the end of the large audio mix graph (per-clip `atrim`/`atempo`/`afade`, per-track `concat`, `amix`) truncated the output: a 30.8 s export lost its last 4.4 s. It happened in linear, dynamic and single-pass modes. Found while implementing #9 (PR #64).

The export therefore renders the audio mix once to a lossless intermediate (WavPack, `mix.wv`) and runs both `loudnorm` passes by reading that file, then muxes. SPEC §3.5 keeps "two-pass loudnorm"; only where it runs changed.

## Consequences

- Temporary disk use: about 0.35 GB per 30 min of stereo during export, removed afterwards.
- One extra read of the mix per pass; negligible next to video encoding.
- Revisit when the pinned ffmpeg changes: if the in-graph path stops truncating (checked by the export loudness test), the intermediate can go.
- Related: `atempo` returns a few ms less audio than requested; sped-up clips read 0.1 s extra source and are trimmed to length, which keeps the fade at the cut click-free.
