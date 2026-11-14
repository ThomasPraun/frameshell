# Motion blur spike (#501, slice 0)

PROTOTYPE, throwaway. Measures the HyperFrames producer's built-in sub-frame motion blur on the
`plugins/hyperframes/test/motion-real.test.ts` fixture. Results and conclusions: `docs/research/motion-blur.md`.

Not in the pnpm workspace and has no dependencies of its own: `measure.mjs` loads `@hyperframes/producer`, its sibling
`@hyperframes/engine` and `puppeteer-core` from `plugins/hyperframes/node_modules` (run `pnpm install` at the repo root
first) and the managed ffmpeg and headless Chrome from `.cache/test-binaries`.

```
FRAMESHELL_TEST_BINARIES_DIR=$PWD/.cache/test-binaries node spikes/motion-blur/measure.mjs <stage> [fixture] [reps]
```

Fixtures: `fixture` (the motion-real composition, 160x90, 1 s), `hold` (640x360, 2 s, still after 1 s), `hd` (1280x720, 1 s).

Stages:

- `timing`: wall time and producer perf per mode (`off`, `adaptive`, `fixed4`, `fixed8`, `fixed16`, plus `fixed8lin` and
  `adaptivelin` with the linear blend). `MODES=off,fixed8` picks modes.
- `counts`: page seeks per output frame, counted by a beacon the composition sends on every `seek`.
- `blur-look`: size of the smear and a sprung element with element CSS (ADR 0021).
- `diff`: render-to-render repeatability, and cold vs reseek on the producer's sample times.
- `repeat`: repeatability as PNG sequences and as WebM, three renders per mode.
- `which`, `where`: which frames and pixels of a repeated fixed-8 render differ.

`BURN=n` runs n busy-loop processes during the run. Output is JSON lines on stdout (the producer also prints its own
log lines: filter with `grep '^{'`); scratch files stay in the OS temp directory.

## Why fixed 8 was not repeatable (`cause.mjs`, `threshold.mjs`)

Follow-up of the owner's decision on PR #532 (option B, 2026-11-13). Same setup as `measure.mjs`; `cause.mjs` also
records every sub-frame sample the producer averages (it patches `MotionBlurAccumulator.prototype.add`) and can append
Chrome flags to the producer's launches (`EXTRA_ARGS='["--disable-partial-raster"]'`, through the engine's test hook).

```
FRAMESHELL_TEST_BINARIES_DIR=$PWD/.cache/test-binaries node spikes/motion-blur/cause.mjs <stage> [runs]
FRAMESHELL_TEST_BINARIES_DIR=$PWD/.cache/test-binaries node spikes/motion-blur/threshold.mjs
```

`cause.mjs` stages: `samples` (fixed-8 renders against the first: differing frames and samples), `sharp`, `variants`
(renders until two outputs differ, then which one a cold capture agrees with), `vscold` (every sample of one render
against the same time painted on a fresh page), `sharpcold`, `stale` (does a differing sample show an earlier seek?),
`seeks` (the times the page received). Switches: `WRITE=runtime|fixed3|grid` (the bundled runtime's `write`, runtime
0.2.0's three decimals, or 0.3.0's grid written by hand), `PAGE_FIX=<name>` (page code run after every seek; the tried
ones are listed in the file, `untoggle` undoes 0.3.0's filter change), `SEEKLOG=1`, `BURN=n`, `RENDER_ENV`, `SAVE=file`.

`threshold.mjs`: does Chrome repaint one small step of translation, rotation, scale or opacity, and a slow drift?
`PARENT=0.25` puts both elements in a scaled container, `TOGGLE=outline|custom` tries a style toggle next to each write.
