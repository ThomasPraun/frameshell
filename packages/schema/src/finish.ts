// Film finish (ADR 0043): the timeline's letterbox bars, drawn by export (`drawbox` before the captions) and by the
// preview (an overlay under the captions) from this one function. No Zod here: the preview imports this file.

/** Width and height of a frame in pixels. */
export interface FrameSize {
  width: number;
  height: number;
}

/** One black bar in frame pixels, top-left origin. */
export interface LetterboxBar {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The black bars that show `frame` at picture aspect `aspect` (width / height): top and bottom when the aspect is
 * wider than the frame, left and right when narrower, none when it matches to the pixel. The picture keeps
 * `round(width / aspect)` rows (or `round(height * aspect)` columns, at least 1); the odd pixel goes to the second bar.
 */
export function letterboxBars(frame: FrameSize, aspect: number): LetterboxBar[] {
  const { width, height } = frame;
  const rows = Math.max(1, Math.round(width / aspect));
  if (rows < height) {
    const top = Math.floor((height - rows) / 2);
    return [
      { left: 0, top: 0, width, height: top },
      { left: 0, top: top + rows, width, height: height - rows - top },
    ].filter((bar) => bar.height > 0);
  }
  const columns = Math.max(1, Math.round(height * aspect));
  if (columns < width) {
    const left = Math.floor((width - columns) / 2);
    return [
      { left: 0, top: 0, width: left, height },
      { left: left + columns, top: 0, width: width - columns - left, height },
    ].filter((bar) => bar.width > 0);
  }
  return [];
}
