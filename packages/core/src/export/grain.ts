// Export twin of a clip's grain (ADR 0043 decision 7): a seeded ffmpeg `noise` plate, 64 frames from a fresh source
// so a timeline frame always gets the same pattern, merged into the picture by `blend grainmerge`.
// grain-render.test.ts holds it to `grainSpread` and checks frames across segment splits.
import { type FrameSize, GRAIN_PERIOD, type ResolvedGrain } from "@frameshell/schema";

/**
 * Filter lines of the grain plate of a `picture` pixels piece whose first frame is pattern frame `phase`
 * (`grainPhase`), `frames` long at `rate`, ending in stream `[<out>]` in `gbrap`. One period is a mid-grey `gray`
 * source of `plate` cells through `noise` (uniform, temporal, `all_seed`), cut to {@link GRAIN_PERIOD} frames: the same
 * bytes every time it is built, so the plate repeats it once per period it spans (copies joined by `concat`; `loop`
 * would hold a whole period in memory), keeps the frames the piece shows and is scaled up to the picture.
 */
export function grainPlateLines(plate: FrameSize, picture: FrameSize, grain: ResolvedGrain, rate: string, phase: number, frames: number, out: string): string[] {
  const periods = Math.ceil((phase + frames) / GRAIN_PERIOD);
  const period = `color=c=gray:s=${plate.width}x${plate.height}:r=${rate},format=gray,trim=end_frame=${GRAIN_PERIOD},noise=alls=${grain.strength}:allf=t+u:all_seed=${grain.seed},format=gray`;
  const names = Array.from({ length: periods }, (_, index) => `${out}_${index}`);
  const joined = periods > 1 ? `${names.map((name) => `[${name}]`).join("")}concat=n=${periods}:v=1:a=0` : `[${names[0]}]null`;
  const scaled = plate.width === picture.width && plate.height === picture.height ? [] : [`scale=${picture.width}:${picture.height}:flags=bilinear`, "format=gray"];
  // concat retimes in microseconds: frame N gets time N / rate again, so blend pairs it with the picture's frame N.
  const timed = [`trim=start_frame=${phase}:end_frame=${phase + frames}`, `settb=expr=1/(${rate})`, "setpts=N"];
  return [...names.map((name) => `${period}[${name}]`), `${[joined, ...timed, ...scaled, "format=gbrap"].join(",")}[${out}]`];
}

/**
 * Lines that add grain to picture chain `picture` (`size` pixels in `gbrap`, its first frame timeline frame
 * `phase` of the pattern, `frames` long); returns the start of the chain that continues from it, in `gbrap`. Colour
 * channels become `A + B - 128` (`grainmerge`, one grey plate for all three: monochrome grain); alpha is kept.
 * `label` makes the stream names unique in the graph.
 */
export function grainedPicture(
  picture: string,
  size: FrameSize,
  plate: FrameSize,
  grain: ResolvedGrain,
  rate: string,
  phase: number,
  frames: number,
  label: string,
  lines: string[],
): string {
  lines.push(`${picture}[gt${label}]`, ...grainPlateLines(plate, size, grain, rate, phase, frames, `gp${label}`));
  return `[gt${label}][gp${label}]blend=c0_mode=grainmerge:c1_mode=grainmerge:c2_mode=grainmerge:c3_mode=normal`;
}
