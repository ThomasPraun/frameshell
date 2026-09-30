// Draws the timeline lanes, clips, ruler and playhead onto a 2D canvas. Pure apart from the context it is given.
import {
  type ClipBox,
  RULER_HEIGHT,
  type TimelineLayout,
  type TrackRow,
  formatDuration,
  rulerTicks,
  visibleClips,
} from "./layout.js";

/**
 * The slice of `CanvasRenderingContext2D` the painter uses; `Img` is what
 * `drawImage` takes. Kept structural so tests pass a recorder.
 */
export interface Paint2D<Img> {
  fillStyle: string | object;
  strokeStyle: string | object;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textBaseline: string;
  textAlign: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  rect(x: number, y: number, w: number, h: number): void;
  clip(): void;
  fill(): void;
  stroke(): void;
  setLineDash(segments: number[]): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  drawImage(image: Img, dx: number, dy: number, dw: number, dh: number): void;
}

/** Colors and fonts; the panel reads them from the app's CSS custom properties. */
export interface TimelineTheme {
  lane: string;
  ruler: string;
  line: string;
  lineSoft: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  danger: string;
  video: string;
  audio: string;
  subtitles: string;
  fontUi: string;
  fontMono: string;
}

/** Same values as `styles.css`; used until (or when) the CSS cannot be read. */
export const DEFAULT_THEME: TimelineTheme = {
  lane: "#1f2023",
  ruler: "#232427",
  line: "#36383c",
  lineSoft: "#2e2f33",
  text: "#dcdcd7",
  textMuted: "#9a9b9e",
  textFaint: "#6b6c70",
  accent: "#e3a53c",
  danger: "#e0675f",
  video: "#7092c4",
  audio: "#6fae8b",
  subtitles: "#b48acb",
  fontUi: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  fontMono: "Menlo, Consolas, monospace",
};

/** Waveform peaks as ingest writes them: `[min, max]` pairs in -128..127. */
export interface Peaks {
  peaksPerSecond: number;
  peaks: readonly (readonly [number, number])[];
}

/** Thumbnails of one asset; `image` returns null until that JPEG is decoded. */
export interface Thumbnails<Img> {
  /** Seconds between thumbnails; 0 for still images (one thumbnail). */
  interval: number;
  count: number;
  /** Width / height of a thumbnail. */
  aspect: number;
  /** 1-based, as the files are numbered. */
  image(index: number): Img | null;
}

/**
 * Derived media of assets, where ingest produced it. Lookups must be cheap:
 * they run per visible clip per frame, and start loads as a side effect.
 */
export interface MediaLookup<Img> {
  waveform(asset: string): Peaks | null;
  thumbnails(asset: string): Thumbnails<Img> | null;
}

/** One frame's input. */
export interface PaintInput<Img> {
  layout: TimelineLayout;
  /** Canvas size in CSS px, and scroll/zoom of the lanes. */
  viewport: { pxPerSecond: number; scrollLeft: number; scrollTop: number; width: number; height: number };
  fps: number;
  /** Playhead, timeline seconds. */
  playhead: number;
  theme: TimelineTheme;
  media: MediaLookup<Img>;
  /** Ids of selected clips (shared selection store), outlined in the accent color; none when absent. */
  selected?: ReadonlySet<string>;
}

/** Clip body inset from its lane, px. */
const CLIP_INSET_Y = 3;
/** Labels need this much clip width, px. */
const MIN_LABEL_WIDTH = 28;

/**
 * Paint one frame. Returns how many clips were drawn (culling is observable)
 * and how many of them showed derived media, a waveform or a thumbnail.
 */
export function paintTimeline<Img>(ctx: Paint2D<Img>, input: PaintInput<Img>): { clipsDrawn: number; mediaDrawn: number } {
  const { layout, viewport, theme } = input;
  const { width, height, pxPerSecond, scrollLeft, scrollTop } = viewport;
  const colors = palette(theme);
  const t0 = scrollLeft / pxPerSecond;
  const t1 = (scrollLeft + width) / pxPerSecond;
  let clipsDrawn = 0;
  let mediaDrawn = 0;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.lane;
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);
  ctx.clip();
  layout.rows.forEach((row, index) => {
    const top = row.top - scrollTop;
    if (top + row.height < RULER_HEIGHT || top > height) return;
    if (index % 2 === 1) {
      ctx.fillStyle = colors.laneAlt;
      ctx.fillRect(0, top, width, row.height);
    }
    ctx.fillStyle = theme.lineSoft;
    ctx.fillRect(0, top + row.height - 1, width, 1);
    if (row.kind === "subtitles") {
      paintSubtitleLane(ctx, row, top, theme);
      return;
    }
    for (const clip of visibleClips(row.clips, t0, t1)) {
      if (paintClip(ctx, input, row, clip, top, colors)) mediaDrawn++;
      clipsDrawn++;
    }
  });
  ctx.restore();

  paintRuler(ctx, input);
  paintPlayhead(ctx, input);
  return { clipsDrawn, mediaDrawn };
}

interface Palette {
  laneAlt: string;
  kind: Record<"video" | "audio", { fill: string; edge: string; full: string; hatch: string }>;
  dangerFill: string;
}

const palettes = new WeakMap<TimelineTheme, Palette>();

/** Alpha variants of the theme, built once per theme instead of per clip per frame. */
function palette(theme: TimelineTheme): Palette {
  let cached = palettes.get(theme);
  if (!cached) {
    const kind = (color: string) => ({
      fill: withAlpha(color, 0.2),
      edge: withAlpha(color, 0.55),
      full: color,
      hatch: withAlpha(color, 0.14),
    });
    cached = {
      laneAlt: "rgba(255, 255, 255, 0.012)",
      kind: { video: kind(theme.video), audio: kind(theme.audio) },
      dangerFill: withAlpha(theme.danger, 0.16),
    };
    palettes.set(theme, cached);
  }
  return cached;
}

/** `#rrggbb` plus alpha as `rgba()`; other notations pass through opaque. */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return color;
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

/** Returns true when derived media (thumbnails, waveform) was drawn. */
function paintClip<Img>(ctx: Paint2D<Img>, input: PaintInput<Img>, row: TrackRow, clip: ClipBox, top: number, colors: Palette): boolean {
  const { pxPerSecond, scrollLeft, width } = input.viewport;
  const theme = input.theme;
  const kind = colors.kind[row.kind === "audio" ? "audio" : "video"];
  // Half-pixel gap on each side keeps back-to-back clips apart.
  const x0 = clip.start * pxPerSecond - scrollLeft + 0.5;
  const x1 = clip.end * pxPerSecond - scrollLeft - 0.5;
  // Off-screen parts are cut: huge coordinates at deep zoom are slow and imprecise.
  const left = Math.max(x0, -2);
  const right = Math.min(Math.max(x1, x0 + 1), width + 2);
  const y = top + CLIP_INSET_Y;
  const h = row.height - 2 * CLIP_INSET_Y;
  const w = right - left;

  ctx.fillStyle = clip.problem ? colors.dangerFill : kind.fill;
  ctx.fillRect(left, y, w, h);

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, y, w, h);
  ctx.clip();
  let media = false;
  if (clip.asset && row.kind === "video") media = paintThumbnails(ctx, input, clip, x0, left, right, y, h);
  if (clip.asset && row.kind === "audio") media = paintWaveform(ctx, input, clip, left, right, y, h, kind.edge);
  if (clip.kind === "generated" || clip.problem) paintHatch(ctx, left, right, y, h, clip.problem ? colors.dangerFill : kind.hatch);
  ctx.restore();

  if (clip.kind === "timeline" && w > 6) {
    // Nested timeline: an inner frame reads as "a stack of clips".
    ctx.strokeStyle = kind.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 2.5, y + 4.5, Math.max(0, w - 5), h - 7);
  }
  // Tally strip along the top in the track color, then the outline.
  ctx.fillStyle = clip.problem ? theme.danger : kind.full;
  ctx.fillRect(left, y, w, 2);
  ctx.strokeStyle = clip.problem ? theme.danger : kind.edge;
  ctx.lineWidth = 1;
  if (clip.problem) ctx.setLineDash([3, 2]);
  ctx.strokeRect(left + 0.5, y + 0.5, Math.max(0, w - 1), h - 1);
  if (clip.problem) ctx.setLineDash([]);
  if (input.selected?.has(clip.id)) {
    // Selected: a 2 px accent frame inside the clip, over the outline, so neighbours stay apart.
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(left + 1, y + 1, Math.max(0, w - 2), h - 2);
  }

  if (w >= MIN_LABEL_WIDTH) paintLabel(ctx, clip, left, w, y, theme);
  return media;
}

/** Name, then length (or why it is unknown) while it fits; sticks to the left edge of the view. */
function paintLabel<Img>(ctx: Paint2D<Img>, clip: ClipBox, left: number, w: number, y: number, theme: TimelineTheme): void {
  const textX = Math.max(left, 0) + 6;
  const room = left + w - textX - 4;
  if (room <= 8) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(textX, y, room, 20);
  ctx.clip();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.font = `600 11px ${theme.fontUi}`;
  ctx.fillStyle = theme.text;
  ctx.fillText(clip.name, textX, y + 11);
  const nameWidth = ctx.measureText(clip.name).width;
  const detail = clip.problem ? "length unknown" : formatDuration(clip.end - clip.start);
  ctx.font = `10px ${theme.fontMono}`;
  if (nameWidth + 8 + ctx.measureText(detail).width <= room) {
    ctx.fillStyle = clip.problem ? theme.danger : theme.textMuted;
    ctx.fillText(detail, textX + nameWidth + 8, y + 11);
  }
  ctx.restore();
}

/** Filmstrip: tiles anchored at the clip start, each showing the source time at its left edge. */
function paintThumbnails<Img>(
  ctx: Paint2D<Img>,
  input: PaintInput<Img>,
  clip: ClipBox,
  x0: number,
  left: number,
  right: number,
  y: number,
  h: number,
): boolean {
  const strip = input.media.thumbnails(clip.asset!);
  if (!strip || strip.count === 0) return false;
  let drawn = false;
  const tile = h * strip.aspect;
  const { pxPerSecond } = input.viewport;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (let k = Math.max(0, Math.floor((left - x0) / tile)); x0 + k * tile < right; k++) {
    const source = clip.in + ((k * tile) / pxPerSecond) * clip.speed;
    const index = strip.interval > 0 ? Math.min(strip.count, Math.floor(source / strip.interval + 1e-6) + 1) : 1;
    const image = strip.image(index);
    if (!image) continue;
    ctx.drawImage(image, x0 + k * tile, y, tile, h);
    drawn = true;
  }
  ctx.restore();
  return drawn;
}

/** One bar per pixel column: min/max of the peaks under it, mirrored around the middle. */
function paintWaveform<Img>(
  ctx: Paint2D<Img>,
  input: PaintInput<Img>,
  clip: ClipBox,
  left: number,
  right: number,
  y: number,
  h: number,
  color: string,
): boolean {
  const wave = input.media.waveform(clip.asset!);
  if (!wave || wave.peaks.length === 0) return false;
  const { pxPerSecond, scrollLeft } = input.viewport;
  const mid = y + 2 + (h - 2) / 2;
  const scale = (h - 6) / 2 / 128;
  const sourceAt = (x: number) => clip.in + ((x + scrollLeft) / pxPerSecond - clip.start) * clip.speed;
  const last = wave.peaks.length - 1;
  ctx.fillStyle = color;
  for (let x = Math.floor(left); x < right; x++) {
    const from = Math.max(0, Math.floor(sourceAt(x) * wave.peaksPerSecond));
    if (from > last) break;
    const to = Math.min(last, Math.max(from, Math.ceil(sourceAt(x + 1) * wave.peaksPerSecond) - 1));
    let low = 0;
    let high = 0;
    for (let i = from; i <= to; i++) {
      const peak = wave.peaks[i]!;
      if (peak[0] < low) low = peak[0];
      if (peak[1] > high) high = peak[1];
    }
    const top = mid - high * scale;
    ctx.fillRect(x, top, 1, Math.max(1, (high - low) * scale));
  }
  return true;
}

/** Diagonal hatch: rendered-by-plugin clips, and clips whose length is unknown. */
function paintHatch<Img>(ctx: Paint2D<Img>, left: number, right: number, y: number, h: number, color: string): void {
  const step = 7;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = Math.floor(left / step) * step - h; x < right; x += step) {
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + h, y);
  }
  ctx.stroke();
}

function paintSubtitleLane<Img>(ctx: Paint2D<Img>, row: TrackRow, top: number, theme: TimelineTheme): void {
  ctx.font = `11px ${theme.fontUi}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = theme.textFaint;
  ctx.fillText("Words show here once the followed track is transcribed", 8, top + row.height / 2);
}

function paintRuler<Img>(ctx: Paint2D<Img>, input: PaintInput<Img>): void {
  const { theme, viewport, fps } = input;
  const { width } = viewport;
  ctx.fillStyle = theme.ruler;
  ctx.fillRect(0, 0, width, RULER_HEIGHT);
  ctx.fillStyle = theme.lineSoft;
  ctx.fillRect(0, RULER_HEIGHT - 1, width, 1);
  const ticks = rulerTicks(viewport, fps);
  ctx.fillStyle = theme.line;
  for (const x of ticks.minor) ctx.fillRect(Math.round(x), RULER_HEIGHT - 5, 1, 4);
  ctx.font = `10px ${theme.fontMono}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const tick of ticks.major) {
    const x = Math.round(tick.x);
    ctx.fillStyle = theme.line;
    ctx.fillRect(x, 0, 1, RULER_HEIGHT - 1);
    ctx.fillStyle = theme.textFaint;
    ctx.fillText(tick.label, x + 4, 4);
  }
}

function paintPlayhead<Img>(ctx: Paint2D<Img>, input: PaintInput<Img>): void {
  const { pxPerSecond, scrollLeft, width, height } = input.viewport;
  const x = Math.round(input.playhead * pxPerSecond - scrollLeft);
  if (x < -6 || x > width + 6) return;
  ctx.fillStyle = input.theme.accent;
  ctx.fillRect(x, 0, 1, height);
  ctx.beginPath();
  ctx.moveTo(x - 5, 0);
  ctx.lineTo(x + 6, 0);
  ctx.lineTo(x + 0.5, 7);
  ctx.closePath();
  ctx.fill();
}
