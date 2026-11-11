/**
 * A drawn head-and-shoulders figure centered at x pixel `cx` on a warm wall, as packed BGR (what
 * `encodeFrames` takes) and its own mask (1 = figure). The selfie segmenter takes it for a person.
 */
export function drawFigure(width: number, height: number, cx: number): { bgr: Uint8Array; mask: Uint8Array } {
  const bgr = new Uint8Array(width * height * 3);
  const mask = new Uint8Array(width * height);
  const unit = height / 540;
  const cy = 210 * unit;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const wall = 150 + Math.round((40 * x) / width);
      let [b, g, r] = [wall - 25, wall - 10, wall];
      const head = ((x - cx) / (66 * unit)) ** 2 + ((y - cy) / (88 * unit)) ** 2 <= 1;
      const hair = ((x - cx) / (78 * unit)) ** 2 + ((y - cy + 30 * unit) / (86 * unit)) ** 2 <= 1 && y < cy - 20 * unit;
      const neck = Math.abs(x - cx) < 32 * unit && y > cy + 60 * unit && y < cy + 125 * unit;
      const half = 120 * unit + Math.min(130 * unit, (y - cy - 110 * unit) * 1.6);
      const torso = y > cy + 110 * unit && Math.abs(x - cx) <= half;
      if (torso) [b, g, r] = [150, 70, 40];
      if (neck) [b, g, r] = [120, 150, 196];
      if (head) {
        // Lit from the left, with eyes, nose and mouth: without a face the model sees no person.
        const lit = 1 - 0.18 * Math.max(0, (x - cx) / (66 * unit));
        [b, g, r] = [Math.round(146 * lit), Math.round(176 * lit), Math.round(224 * lit)];
        const eye = (ex: number) => ((x - ex) / (11 * unit)) ** 2 + ((y - (cy - 12 * unit)) / (6 * unit)) ** 2 <= 1;
        if (eye(cx - 26 * unit) || eye(cx + 26 * unit)) [b, g, r] = [30, 30, 40];
        if (Math.abs(y - (cy + 40 * unit)) < 4 * unit && Math.abs(x - cx) < 24 * unit) [b, g, r] = [60, 60, 150];
        if (Math.abs(x - cx) < 5 * unit && y > cy && y < cy + 20 * unit) [b, g, r] = [112, 140, 190];
      }
      if (hair && !(head && y > cy - 60 * unit)) [b, g, r] = [25, 35, 55];
      if (torso || neck || head || hair) mask[i] = 1;
      bgr[i * 3] = b;
      bgr[i * 3 + 1] = g;
      bgr[i * 3 + 2] = r;
    }
  }
  return { bgr, mask };
}

/** Intersection over union of `matte` (bytes, subject above 127) with `mask` (1 = subject). */
export function matteOverlap(matte: Uint8Array, mask: Uint8Array): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < mask.length; i++) {
    const a = matte[i]! > 127;
    const b = mask[i] === 1;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return union === 0 ? 0 : inter / union;
}
