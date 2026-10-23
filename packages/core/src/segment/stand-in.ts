import type { SegmentEngine } from "./segmenter.js";

/** Half side of each answer's square, as a share of the encoder picture's width: part of a part, a part, the whole. */
const HALF_SIDES = [0.05, 0.1, 0.2];

/**
 * Model-free {@link SegmentEngine} for end-to-end tests (`FRAMESHELL_SEGMENT_STAND_IN=1` in `frameshelld`):
 * three nested squares around the click, the middle one scored best. Downloads and loads nothing.
 */
export function standInSegmentEngine(): SegmentEngine {
  return {
    async encode() {
      return new Float32Array(4);
    },
    async decode(_embedding, point, size) {
      const area = size.width * size.height;
      const logits = new Float32Array(4 * area).fill(-1);
      for (const [index, share] of HALF_SIDES.entries()) {
        const half = share * size.width;
        const x0 = Math.max(0, Math.floor(point.x - half));
        const x1 = Math.min(size.width, Math.ceil(point.x + half));
        const y0 = Math.max(0, Math.floor(point.y - half));
        const y1 = Math.min(size.height, Math.ceil(point.y + half));
        for (let y = y0; y < y1; y++) logits.fill(1, (index + 1) * area + y * size.width + x0, (index + 1) * area + y * size.width + x1);
      }
      return { logits, scores: new Float32Array([0, 0.5, 0.9, 0.7]), width: size.width, height: size.height };
    },
  };
}
