import { type ResolvedSubtitleTrack, SUBTITLE_FONT, type Size, subtitleLayout } from "@frameshell/schema";

/**
 * ASS script burning subtitle cues into export (SPEC §3.5 step 3), laid out
 * with the same `subtitleLayout` the preview draws with: one style per track
 * (bundled face, size, outline, colours), one event per cue, or per spoken
 * word when the style highlights it. Coordinates are output pixels
 * (`PlayRes` = `frame`). Pure.
 *
 * Times are timeline seconds. ffmpeg's `ass` filter shows an event at a frame
 * when `start <= t < end`, `t` = the frame's time in whole ms (truncated);
 * ASS times are centiseconds. Each frame boundary is written as that
 * truncated time floored to a centisecond, so an event covers exactly its
 * frames at any rate up to 100 fps.
 */
export function assSubtitles(tracks: readonly ResolvedSubtitleTrack[], frame: Size, fps: number): string {
  const styles: string[] = [];
  const events: string[] = [];
  tracks.forEach((track, layer) => {
    const { style } = track;
    const layout = subtitleLayout(style, frame);
    const name = `t${layer}`;
    styles.push(
      [
        `Style: ${name}`,
        SUBTITLE_FONT.family,
        num(layout.fontSize * (SUBTITLE_FONT.ascent + SUBTITLE_FONT.descent)),
        color(style.color),
        color(style.color),
        color(style.outlineColor),
        color(style.outlineColor),
        // Bold, italic, underline, strike: the face is already black; synthetic bold would widen it.
        "0,0,0,0,100,100,0,0,1",
        num(layout.outline),
        "0,2,0,0,0,1",
      ].join(","),
    );
    // \an2: the point is the bottom of the line box, i.e. baseline + descent.
    const anchor = `{\\an2\\pos(${num(layout.centerX)},${num(layout.baseline + layout.fontSize * SUBTITLE_FONT.descent)})}`;
    for (const cue of track.cues) {
      const texts = cue.words.map((word) => word.text);
      if (!cue.highlight || style.highlight === null) {
        events.push(dialogue(layer, cue.start, cue.end, name, anchor + texts.join(" "), fps));
        continue;
      }
      cue.words.forEach((word, i) => {
        const from = i === 0 ? cue.start : Math.max(cue.start, word.start);
        const to = i + 1 < cue.words.length ? Math.min(cue.end, cue.words[i + 1]!.start) : cue.end;
        if (to <= from) return;
        const line = texts.map((text, j) => (j === i ? `{\\c${color(style.highlight!)}}${text}{\\c${color(style.color)}}` : text));
        events.push(dialogue(layer, from, to, name, anchor + line.join(" "), fps));
      });
    }
  });
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    // Colours as given: no YCbCr correction by libass.
    "YCbCr Matrix: None",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Centiseconds written for the boundary at timeline frame `frame`; see {@link assSubtitles}. */
export function assCentiseconds(frame: number, fps: number): number {
  return Math.floor(Math.floor((frame * 1000) / fps + 1e-6) / 10);
}

function dialogue(layer: number, from: number, to: number, style: string, text: string, fps: number): string {
  return `Dialogue: ${layer},${time(assCentiseconds(from, fps))},${time(assCentiseconds(to, fps))},${style},,0,0,0,,${text}`;
}

/** `H:MM:SS.cc`. */
function time(centiseconds: number): string {
  const cs = centiseconds % 100;
  const total = Math.floor(centiseconds / 100);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}.${pad(cs)}`;
}

/** `#rrggbb` → ASS `&HBBGGRR&` (opaque). */
function color(hex: string): string {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return `&H00${b}${g}${r}&`.toUpperCase();
}

function num(value: number): string {
  return String(Number(value.toFixed(3)));
}
