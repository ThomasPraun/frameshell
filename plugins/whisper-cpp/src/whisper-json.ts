import type { EngineWord } from "./timing.js";

/** Subset of whisper-cli `-ojf` output this plugin reads. */
interface WhisperJson {
  result?: { language?: string };
  transcription: {
    text: string;
    offsets: { from: number; to: number };
    tokens?: { text: string; p: number; t_dtw?: number }[];
  }[];
}

/** Special tokens (`[_BEG_]`, `[_TT_150]`, `<|endoftext|>`): not speech. */
const SPECIAL_TOKEN = /^\[_|^<\|/;
/** Whole-segment annotations such as `[BLANK_AUDIO]` or `(music)`: not words. */
const ANNOTATION = /^[[(].*[\])]$/;

/**
 * Words from whisper-cli JSON run with `-ml 1 -sow -ojf -dtw …`: one segment
 * per word. Onset = first DTW time of the segment's real tokens (`t_dtw` is
 * centiseconds, -1 = none). Confidence = mean token probability.
 */
export function parseWhisperJson(text: string): { language: string | undefined; words: EngineWord[] } {
  let json: WhisperJson;
  try {
    json = JSON.parse(text) as WhisperJson;
  } catch (error) {
    throw new Error(`whisper-cli wrote invalid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(json?.transcription)) throw new Error("whisper-cli JSON has no `transcription` array");
  const words: EngineWord[] = [];
  for (const segment of json.transcription) {
    const word = segment.text.trim();
    if (!word || ANNOTATION.test(word)) continue;
    const tokens = (segment.tokens ?? []).filter((token) => !SPECIAL_TOKEN.test(token.text));
    const dtw = tokens.find((token) => typeof token.t_dtw === "number" && token.t_dtw >= 0)?.t_dtw;
    words.push({
      text: word,
      onset: dtw === undefined ? null : dtw / 100,
      tokenStart: segment.offsets.from / 1000,
      ...(tokens.length > 0 ? { confidence: round(tokens.reduce((sum, t) => sum + t.p, 0) / tokens.length) } : {}),
    });
  }
  return { language: json.result?.language, words };
}

function round(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
