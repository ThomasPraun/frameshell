# Motion runtime: binding a seek(t) paint to the HyperFrames clock (#465)

Spike for slice 1 of [#465](https://github.com/ThomasPraun/frameshell/issues/465) (ADR 0033, option B). The question: can a composition that paints every frame from a pure function of time, with no GSAP and no CSS animation, be driven by the HyperFrames 0.9.30 page runtime, in renders and in live preview, frame-exact and in any seek order? If both bindings below had failed, the owner's fallback was option C (a separate `motion` clip type).

## Result

Both bindings work on HyperFrames 0.9.30 (`@hyperframes/core` and `@hyperframes/producer` 0.9.30, managed Chrome Headless Shell 154, macOS arm64, software GL).

| Binding | Stage | Render, 1 s at 30 fps, 160x90 | Box moves in the render | Live `ready` | 12 probes cold vs after reseek |
|---|---|---|---|---|---|
| **A. Seek-only object in `window.__timelines[id]`** | without `data-no-timeline` | 3.3 s | yes | 0.12 s | 12 of 12 byte-identical PNGs |
| **B. `hf-seek` event listener** | with `data-no-timeline` | 2.1 s | yes | 0.11 s | 12 of 12 byte-identical PNGs |
| Neither (control) | without `data-no-timeline` | 3.3 s | **no**: frame 0 on every frame | 0.16 s | identical, but frozen |

The runtime (`@frameshell/motion`) registers A and listens to B: the `hf-seek` listener paints only until the registered timeline is first driven, so each seek paints once.

## How the HyperFrames runtime drives a registered object

Read from `@hyperframes/core/dist/hyperframe.runtime.iife.js` 0.9.30 and confirmed by the renders above:

- The root timeline is the entry of `window.__timelines` under the root's `data-composition-id`. Duck typing: an entry counts when it has `play` and `pause` functions; a sole such entry is taken even under another key.
- Seeking calls `totalTime(t, true)` when the object has `totalTime`, else `seek(t, true)`. The motion timeline has only `seek`, so none of the GSAP-specific paths (children, `_first`, `_initted`) run.
- Times reach `seek` quantized to the frame grid by `__player.renderSeek` (a probe at 0.114 s paints 0.1 s at 30 fps), so live preview and renders paint the same instants.
- On every seek the runtime also dispatches `hf-seek` with `{ time, waitUntil }` on `window`. It is undocumented, present in 0.8.92 and 0.9.30.
- The composition script must register synchronously, before the runtime looks for the root timeline; the producer's `playerReadyTimeout` is 45 s.

## The 45 s wait

`plugins/hyperframes/src/scaffold.ts` puts `data-no-timeline` on the scaffold stage because, without it, a render waited 45 s for `window.__timelines[id]`. With 0.9.30, the control composition (no registration, no `data-no-timeline`) rendered in 3.3 s here, so that wait did not reproduce for a script-only page. A motion composition registers synchronously anyway, so it never depends on that timeout: the opt-in test fails if a render takes 40 s or more.

## Determinism

The paint is a pure function of `t`: it reads no clock, no frame callback, no timer and no random source (a unit test scans the sources and the bundle). The real test (`plugins/hyperframes/test/motion-real.test.ts`) captures 12 probe frames at (i + 0.37)·duration/12 on the live page: cold (a fresh page per probe) and after seeking from an unrelated probe first. The composition rotates and fades a sprung box and staggers three dots on a retargeted `track`, so anti-aliasing is part of every probe. Every byte stayed within the 2/255 budget.

The runtime writes only a 2D `transform` and `opacity`. 3D transforms, `translate3d` and `will-change` are out: per the #465 measurements, compositing changed 9 of 12 probes by up to 211/255.

## Element mode

Element adjustments (ADR 0021) are `translate` and `scale` with `!important`. They compose with the `transform` the runtime writes: in the real render, `#box { translate: 0px 30px !important; }` moved the sprung box 30 px down while it kept its spring on x.

## Reproduce

```sh
FRAMESHELL_TEST_REAL_HYPERFRAMES=1 pnpm vitest run plugins/hyperframes/test/motion-real.test.ts
```

The spike's control and binding-B variants were throwaway; binding A is what the test exercises. Re-run the test on every HyperFrames bump (#479): a change to the `__timelines` duck typing or to `hf-seek` would freeze motion compositions on frame 0.
