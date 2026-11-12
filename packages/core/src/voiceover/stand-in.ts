import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { SpeechProvider } from "@frameshell/plugin-api";
import { pcmWavBytes } from "../transcripts/window.js";

/** Id of {@link standInSpeechProvider}. */
export const STAND_IN_SPEECH_PROVIDER = "stand-in";

const RATE = 16_000;
/** Silence before and after the words: the host must trim it. */
const HEAD_S = 0.3;
const TAIL_S = 0.5;
/** One word: a tone this long, then a gap of silence. */
const WORD_S = 0.3;
const GAP_S = 0.1;
/** Tone frequency per voice, Hz. */
const VOICES: Readonly<Record<string, number>> = { tone: 440, low: 220 };

/**
 * Speech provider for tests (`FRAMESHELL_SPEECH_STAND_IN=1` in `frameshelld`): free, no voice, no download. Each
 * word of the text is a sine tone, with silence between words and around them, so the same text always gives
 * the same bytes and its length follows the word count.
 */
export function standInSpeechProvider(): SpeechProvider {
  return {
    id: STAND_IN_SPEECH_PROVIDER,
    free: true,
    defaultVoice: "tone",
    voices: () => Object.keys(VOICES).map((id) => ({ id, label: `Stand-in ${VOICES[id]} Hz tone` })),
    async synthesize(text, voice, _options, context) {
      const hz = VOICES[voice];
      if (hz === undefined) throw new Error(`unknown voice ${voice}`);
      const words = text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
      const samples = new Int16Array(Math.round((HEAD_S + words * (WORD_S + GAP_S) + TAIL_S) * RATE));
      for (let word = 0; word < words; word++) {
        const start = Math.round((HEAD_S + word * (WORD_S + GAP_S)) * RATE);
        const length = Math.round(WORD_S * RATE);
        for (let i = 0; i < length; i++) samples[start + i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * hz * i) / RATE));
      }
      const file = join(context.outDir, "take.wav");
      await writeFile(file, pcmWavBytes({ sampleRate: RATE, samples }));
      return { file, model: "stand-in" };
    },
  };
}
