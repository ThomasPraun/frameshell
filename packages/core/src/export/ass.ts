import {
  type ResolvedSubtitleTrack,
  SUBTITLE_ENTRY,
  SUBTITLE_FONT,
  type Size,
  cueTokens,
  entryEnd,
  entryProgress,
  entryUnits,
  subtitleLayout,
} from "@frameshell/schema";

/**
 * ASS script burning subtitle cues into export (SPEC §3.5 step 3), laid out
 * with the same `subtitleLayout` the preview draws with: one style per track
 * (bundled face, size, outline, colours), one event per cue, or per spoken
 * word when the style highlights it. A phrase's keyword takes the style's
 * keyword colour. A cue with an `entry` fades and unblurs its units in (`\t`
 * with the preview's easing; the keyword also settles from `keywordScale`);
 * an event that starts mid-entry carries the rest of it through a negative
 * `\t` start. Coordinates are output pixels (`PlayRes` = `frame`). Pure.
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
    const blur = layout.fontSize * SUBTITLE_ENTRY.blur;
    const base = color(style.color);
    for (const cue of track.cues) {
      const tokens = cueTokens(cue);
      const lead = tokens.length - cue.words.length;
      const keyword = cue.keyword === undefined ? -1 : cue.keyword + lead;
      const units = cue.entry === "none" ? null : entryUnits(cue, fps);
      const settled = units === null ? 0 : entryEnd(cue, fps);
      const tint = (token: number, active: number) =>
        token === keyword && style.keywordColor !== null ? style.keywordColor : token === active && style.highlight !== null ? style.highlight : style.color;
      /** The cue's text with token `active` highlighted (-1: none), `elapsed` seconds after the cue started. */
      const line = (active: number, elapsed: number): string =>
        tokens
          .map((text, token) => {
            const shade = tint(token, active);
            const paint = shade === style.color ? "" : `\\c${color(shade)}`;
            const mine = units?.filter((unit) => unit.token === token);
            if (!mine || elapsed >= settled || mine.every((unit) => entryProgress(elapsed, unit.delay) >= 1)) {
              return paint === "" ? text : `{${paint}}${text}{\\c${base}}`;
            }
            return mine
              .map((unit) => {
                if (entryProgress(elapsed, unit.delay) >= 1) return paint === "" ? unit.text : `{${paint}}${unit.text}{\\c${base}}`;
                const grow = unit.keyword ? style.keywordScale : 1;
                const from = Math.round((unit.delay - elapsed) * 1000);
                const to = Math.round((unit.delay + SUBTITLE_ENTRY.seconds - elapsed) * 1000);
                const size = grow === 1 ? "" : `\\fscx${num(grow * 100)}\\fscy${num(grow * 100)}`;
                const rest = grow === 1 ? "" : "\\fscx100\\fscy100";
                const open = `${paint}\\alpha&HFF&\\blur${num(blur)}${size}\\t(${from},${to},${SUBTITLE_ENTRY.accel},\\alpha&H00&\\blur0${rest})`;
                return `{${open}}${unit.text}{${paint === "" ? "" : `\\c${base}`}\\alpha&H00&\\blur0${rest}}`;
              })
              .join("");
          })
          .join(" ");
      if (!cue.highlight || style.highlight === null) {
        events.push(dialogue(layer, cue.start, cue.end, name, anchor + line(-1, 0), fps));
        continue;
      }
      cue.words.forEach((word, i) => {
        const from = i === 0 ? cue.start : Math.max(cue.start, word.start);
        const to = i + 1 < cue.words.length ? Math.min(cue.end, cue.words[i + 1]!.start) : cue.end;
        if (to <= from) return;
        events.push(dialogue(layer, from, to, name, anchor + line(i + lead, (from - cue.start) / fps), fps));
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
