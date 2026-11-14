// Export twin of a clip's vignette (ADR 0043): `vignetteGain` and `vignetteLevel` of @frameshell/schema as one `geq`
// frame, multiplied into the picture by `blend`. vignette-render.test.ts holds the plate to the schema function.
import type { FrameSize, ResolvedVignette } from "@frameshell/schema";
import { num } from "./animation.js";

/**
 * `geq` expression of the plate's level at pixel (X, Y) of a W x H picture: the steps of `vignetteGain` in the same
 * order (so the doubles agree), then `vignetteLevel`. A softness of 0 is a hard edge, as there.
 */
export function vignetteExpression(vignette: ResolvedVignette): string {
  const { strength, radius, softness } = vignette;
  const distance = "st(0,X+0.5-W/2);st(1,Y+0.5-H/2);st(2,2*sqrt(ld(0)*ld(0)+ld(1)*ld(1))/sqrt(W*W+H*H))";
  const t = softness > 0 ? `st(3,clip((ld(2)-${num(radius)}+${num(softness)})/${num(softness)},0,1))` : `st(3,gte(ld(2),${num(radius)}))`;
  return `${distance};${t};floor(255*(1-${num(strength)}*(ld(3)*ld(3)*(3-2*ld(3))))+0.5)`;
}

/**
 * Filter chain of the plate of a `size` picture: one `geq` frame in `gbrap` at `rate`. `blend` repeats it for every
 * frame of the picture (its last frame is held), so it is made once per piece.
 */
export function vignettePlate(size: FrameSize, vignette: ResolvedVignette, rate: string): string {
  const level = vignetteExpression(vignette);
  return `color=c=black:s=${size.width}x${size.height}:r=${rate},trim=end_frame=1,format=gbrap,geq=r='${level}':g='${level}':b='${level}'`;
}

/**
 * Lines that darken picture chain `picture` (`size` pixels, ending in `gbrap`) by its vignette; returns the start of
 * the chain that continues from it, in `gbrap`. Colour channels are multiplied by the plate
 * (`floor(byte * level / 255)`); alpha is kept as it is. `label` makes the stream names unique in the graph.
 */
export function vignettedPicture(picture: string, size: FrameSize, vignette: ResolvedVignette, rate: string, label: string, lines: string[]): string {
  lines.push(`${picture}[vt${label}]`, `${vignettePlate(size, vignette, rate)}[vp${label}]`);
  return `[vt${label}][vp${label}]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal`;
}
