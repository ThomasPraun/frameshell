// What the project's style.json gives captions in the preview (ADR 0028 decision 11): `styleCaptionTokens`, as
// export's `readCaptionTokens` (core `style/captions.ts`) calls it, on the same file and font bytes.
import { STYLE_FILE, parseFontMetrics, parseStyleFile, resolveStyle } from "@frameshell/schema";
import { type CaptionTokens, styleCaptionTokens } from "@frameshell/schema/subtitles";
import { useEffect, useState } from "react";
import { mediaSrc } from "../preview/media-src.js";

/** The style's caption values, and the bytes of their face when it is a project font file. */
export interface CaptionStyle {
  /** Undefined without a valid `style.json`: the presets alone. */
  tokens: CaptionTokens | undefined;
  /** Bytes of `tokens.font.file`, which the preview registers under `tokens.font.family`; null for the bundled face. */
  face: ArrayBuffer | null;
}

const NONE: CaptionStyle = { tokens: undefined, face: null };

/** The caption style of `style.json` text (null: no file), a project font read through `load`. Never throws. */
export async function readCaptionStyle(text: string | null, load: (file: string) => Promise<ArrayBuffer>): Promise<CaptionStyle> {
  if (text === null) return NONE;
  let parsed: ReturnType<typeof parseStyleFile>;
  try {
    parsed = parseStyleFile(JSON.parse(text));
  } catch {
    return NONE;
  }
  if (!parsed.ok) return NONE;
  let face: ArrayBuffer | null = null;
  const { tokens, warning } = await styleCaptionTokens(resolveStyle(parsed.value), async (file) => {
    const bytes = await load(file);
    const metrics = parseFontMetrics(new Uint8Array(bytes));
    face = bytes;
    return metrics;
  });
  if (warning) console.warn(warning);
  return { tokens, face: tokens.font.file === null ? null : face };
}

/**
 * The caption style of the window's project, followed live: read again when `style.json` or a file in `assets/fonts/`
 * changes. Project fonts come from `mediaUrl` (`frameshell-media://` serves `assets/fonts/`).
 */
export function useCaptionStyle(mediaUrl: string): CaptionStyle {
  const [style, setStyle] = useState<CaptionStyle>(NONE);
  useEffect(() => {
    let disposed = false;
    const load = async (file: string) => {
      const response = await fetch(mediaSrc(mediaUrl, file));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    };
    const read = async () => {
      const text = await window.frameshell.files.read(STYLE_FILE).catch(() => null);
      const next = await readCaptionStyle(text, load);
      if (disposed) return;
      setStyle(next);
    };
    void read();
    const off = window.frameshell.files.onChanged((paths) => {
      if (paths.some((path) => path === STYLE_FILE || path.startsWith("assets/fonts/"))) void read();
    });
    return () => {
      disposed = true;
      off();
    };
  }, [mediaUrl]);
  return style;
}
