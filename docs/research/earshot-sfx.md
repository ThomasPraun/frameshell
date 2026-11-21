# earshot as a sound-effect plugin: desk review and the spike to run (#799)

#799 (from Orkestra task 72, item 10) proposes [earshot](https://github.com/Leonxlnx/earshot) (MIT) as a text-to-SFX
plugin and as a ranking for Audition. This note is a **desk review of the source** at commit `7a7f7c5` (2026-11-20,
version 1.0.0): what it is, what a plugin would look like in Frameshell, and the go rule for a hands-on spike. Nothing
was installed or run: the spike installs third-party Python and runs it, which is a step for the owner's machine.

**Status: decided 2026-11-21.** The owner took both recommendations: Python is acceptable for an opt-in plugin that uses the person's own Python, and the spike below runs first, on the Lenovo.

## What earshot is (from its README, `pyproject.toml` and `docs/`)

- **Making sounds (`earshot make "<words>" -o take.wav`)**: a catalogue of 922 designs in 384 families (interface,
  foley, ambience, game, drums, film and motion effects). 309 are learned from 692 public-domain or CC0 recordings
  (BigSoundBank, Kenney, VCSL, VSCO-2 CE, Karoryfer, CC0 Freesound uploads); the repository ships numbers, not audio,
  and every take is rendered by code on request. `--seed`, `--n` (takes), `--pitch`, `--dur`, `--events` (three
  knocks), `--lufs`, `--mono`. No model and no network for `make`. Output format from the file extension (wav and
  flac without ffmpeg).
- **Listening (`describe`, `match`, `rank`, `find`, `realness`, `timeline`, `critique`)**: CLAP
  (`laion/larger_clap_general`, Apache-2.0) and an AudioSet tagger (`MIT/ast-finetuned-audioset`, BSD-3-Clause),
  about 1.1 GB to download and 2.2 GB on disk, through torch + transformers. Its own `docs/LIMITS.md` says a "strong"
  match on single exposed sounds is very reliable, tags inside a busy mix are right about half the time, and mood or
  genre are often wrong.
- **Surfaces**: a CLI with `--json`, a Python package, an MCP server (20 tools), a Claude Code plugin.
- **Install**: Python 3.10+, CPU only. Base install (numpy, scipy, soundfile, soxr, numba) about 350 MB; the `listen`
  extra adds torch (CPU wheels recommended; the default Linux wheel brings CUDA and is several GB). Not on PyPI under
  its own name (the name belongs to another project): `pip install "earshot @ git+https://github.com/Leonxlnx/earshot"`.
- **Licence of what it makes**: MIT code; rendered sounds belong to whoever rendered them, no credit required. Each
  source recording is credited in `CREDITS.md` files next to its numbers.

## How it would fit Frameshell

Today `sound.sfx` (ADR 0038) is a built-in seeded synth of 14 kinds: deterministic, no network, no third-party
samples, takes in `assets/sound/` with an `fssd` chunk. There is **no sound-effect provider contract** for plugins
yet; `contributes.speechProviders` (voiceover) is the nearest shape.

A plugin `@frameshell/earshot` would need, in order:

1. **A provider contract** (`contributes.sfxProviders`, ADR): `make({ want, seed, takes, pitch, length })` → files,
   each with what it is (design id), its peak second (for `sound.place` role offsets) and its source recordings.
   `sound.sfx` keeps the built-in kinds; a `want` in words goes to the provider. The take still lands in
   `assets/sound/` with the `fssd` key so the cache and `sound.place` work unchanged.
2. **Running Python out of process**, as the Blender plugin runs Blender: one `earshot make ... --json` per request,
   a JSON reply. Frameshell has no managed Python, so the plugin finds one (`FRAMESHELL_EARSHOT_PYTHON`, then
   `earshot` on PATH) and `doctor` names what is missing, with the `pip` line. A managed venv download is possible
   later but is a large new binary kind (Python + numba wheels per OS).
3. **Credits**: write each take's source recordings into `credits.json` (ADR 0026) with licence CC0 or public
   domain and the recording's author and URL from earshot's `CREDITS.md` rows, so `credits check` passes.
4. **Ranking in Audition (separate, later)**: `rank` against the cue's words to order candidates. It needs the
   `listen` extra (torch, 1.1 GB of models on first use): an opt-in second step, never part of the first plugin.

## Risks seen in the source

- **Young project**: version 1.0.0, a large surface (922 designs, 20 MCP tools), one author. Pin a commit, not `main`.
- **Determinism**: `make` takes a `--seed`; a pinned commit plus the seed should give the same take, which the
  `fssd` cache key relies on. The spike must check it byte for byte, including across machines (numba).
- **First call is slow**: numba compiles the synthesis loops once and caches them on disk.
- **Install weight**: 350 MB is acceptable for an opt-in plugin; the listening extra is not, without a clear ask.

## The spike (go rule, set before running)

On the owner's machine (Lenovo, Windows), in a throwaway venv:

1. `pip install "earshot @ git+https://github.com/Leonxlnx/earshot@7a7f7c5"` succeeds on Windows with Python 3.12.
2. Ten requests a short video needs ("a soft click", "a whoosh for a cut", "a camera shutter", "a typing burst", "a
   notification", "a riser into a logo", "footsteps on wood", "a door closing", "rain ambience", "a crowd cheer")
   each give a usable take: listened to next to the same cue from `sound sfx`, earshot wins or ties on at least 7.
3. The same request and seed give the same bytes twice, and after a restart.
4. Each take's JSON names the design and its source recordings (for credits).
5. A take renders in under 2 s after the first call.

Go on all five: write the provider ADR and build the plugin without the listening extra. Anything else: close #799
with the numbers.

## Decisions for the owner

1. **Is a Python dependency acceptable for an official plugin?** Recommendation: yes for an opt-in plugin that finds
   the person's own Python (like Blender is found), no managed Python yet.
2. **Spike first?** Recommendation: yes, the five checks above on the Lenovo, before any contract or plugin code.
