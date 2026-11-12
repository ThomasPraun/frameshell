// Look of a film's pictures: brightness, contrast, saturation, warmth and a coarse colour grid. Pure: `picture.ts` feeds it RGB frames.

/** Columns of the colour grid, whatever the shape of the picture. */
export const LOOK_COLUMNS = 8;
/** Rows of the colour grid. */
export const LOOK_ROWS = 6;

/** The look of some frames: every figure is the mean over the frames. */
export interface Look {
  /** Mean luma (Rec. 709 weights on the gamma-coded values), 0 black to 1 white. */
  brightness: number;
  /** Mean over the frames of the spread (standard deviation) of luma inside a frame, 0 to 0.5: flat grey is 0, half black and half white is 0.5. */
  contrast: number;
  /** Mean HSV saturation of the pixels, 0 grey to 1 pure colour. */
  saturation: number;
  /** Mean of (red - blue) over 255, -1 blue to 1 red: above 0 the picture leans warm, below it cool. */
  warmth: number;
  /** Mean colour of each cell of a {@link LOOK_COLUMNS} x {@link LOOK_ROWS} grid laid over the picture, `#rrggbb`, row by row from the top left. */
  grid: string[];
}

/** What one frame comes to before it is averaged: also the brightness the events measure flashes on. */
export interface FrameLook {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

/** Rec. 709 luma of an 8-bit pixel, 0 to 255. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Index 0 to {@link LOOK_COLUMNS}` * `{@link LOOK_ROWS}` - 1` of the grid cell holding pixel (`x`, `y`) of a `width` x `height` frame. */
export function cellOf(x: number, y: number, width: number, height: number): number {
  return Math.min(LOOK_ROWS - 1, Math.floor((y * LOOK_ROWS) / height)) * LOOK_COLUMNS + Math.min(LOOK_COLUMNS - 1, Math.floor((x * LOOK_COLUMNS) / width));
}

/** The figures of one frame of interleaved 8-bit RGB pixels, `width` x `height`. */
export function frameLook(rgb: Uint8Array, width: number, height: number): FrameLook {
  const pixels = width * height;
  let lumaSum = 0;
  let lumaSquares = 0;
  let saturation = 0;
  let warmth = 0;
  for (let i = 0; i < pixels; i++) {
    const r = rgb[i * 3]!;
    const g = rgb[i * 3 + 1]!;
    const b = rgb[i * 3 + 2]!;
    const y = luma(r, g, b);
    lumaSum += y;
    lumaSquares += y * y;
    const high = Math.max(r, g, b);
    if (high > 0) saturation += (high - Math.min(r, g, b)) / high;
    warmth += r - b;
  }
  const mean = lumaSum / pixels;
  return {
    brightness: mean / 255,
    contrast: Math.sqrt(Math.max(0, lumaSquares / pixels - mean * mean)) / 255,
    saturation: saturation / pixels,
    warmth: warmth / pixels / 255,
  };
}

/** Averages the look of the frames added to it; one builder per shot and one for the whole film. */
export class LookBuilder {
  readonly #grid = new Float64Array(LOOK_COLUMNS * LOOK_ROWS * 3);
  readonly #cellPixels = new Float64Array(LOOK_COLUMNS * LOOK_ROWS);
  #brightness = 0;
  #contrast = 0;
  #saturation = 0;
  #warmth = 0;
  #frames = 0;

  /** Frames added so far. */
  get frames(): number {
    return this.#frames;
  }

  /** Add one frame; `figures` is {@link frameLook} of it when the caller has it already. */
  add(rgb: Uint8Array, width: number, height: number, figures: FrameLook = frameLook(rgb, width, height)): void {
    this.#brightness += figures.brightness;
    this.#contrast += figures.contrast;
    this.#saturation += figures.saturation;
    this.#warmth += figures.warmth;
    this.#frames++;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = cellOf(x, y, width, height);
        const at = (y * width + x) * 3;
        this.#grid[cell * 3] = this.#grid[cell * 3]! + rgb[at]!;
        this.#grid[cell * 3 + 1] = this.#grid[cell * 3 + 1]! + rgb[at + 1]!;
        this.#grid[cell * 3 + 2] = this.#grid[cell * 3 + 2]! + rgb[at + 2]!;
        this.#cellPixels[cell] = this.#cellPixels[cell]! + 1;
      }
    }
  }

  /** The look of the frames added; null when there are none. */
  look(): Look | null {
    if (this.#frames === 0) return null;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    const grid = Array.from({ length: LOOK_COLUMNS * LOOK_ROWS }, (_, cell) => {
      const count = this.#cellPixels[cell]!;
      const channel = (c: number) => (count > 0 ? Math.round(this.#grid[cell * 3 + c]! / count) : 0);
      return `#${[0, 1, 2].map((c) => channel(c).toString(16).padStart(2, "0")).join("")}`;
    });
    return {
      brightness: round(this.#brightness / this.#frames),
      contrast: round(this.#contrast / this.#frames),
      saturation: round(this.#saturation / this.#frames),
      warmth: round(this.#warmth / this.#frames),
      grid,
    };
  }
}
