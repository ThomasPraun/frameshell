import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptWord, TranscriptionProvider } from "@frameshell/plugin-api";
import { describe, expect, it } from "vitest";
import { PHRASE_FADE_S, SPLIT_LEAD_S, SPLIT_TAIL_S, type TakeToCheck, checkLine, splitPhrases, textInRanges, verifyTakes } from "../src/index.js";
import { tempDir } from "./helpers.js";

const RATE = 16_000;

/** Silence of `seconds` with a 440 Hz tone at `amplitude` (of full scale) over each `[from, to)` burst. */
function bursts(seconds: number, ranges: readonly [number, number, number?][]): { sampleRate: number; samples: Int16Array } {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (const [from, to, amplitude = 0.5] of ranges) {
    for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 440 * i) / RATE));
  }
  return { sampleRate: RATE, samples };
}

const word = (text: string, start: number, end = start + 0.3): TranscriptWord => ({ text, start, end });

describe("splitPhrases", () => {
  it("cuts at a silence of 60 ms or more and keeps the lead and the tail around each phrase", () => {
    const phrases = splitPhrases(bursts(2, [[0.3, 0.8], [1.0, 1.5]]));
    expect(phrases).toHaveLength(2);
    expect(phrases[0]!.from).toBeCloseTo(0.3 - SPLIT_LEAD_S, 2);
    expect(phrases[0]!.to).toBeCloseTo(0.8 + SPLIT_TAIL_S, 2);
    expect(phrases[1]!.from).toBeCloseTo(1.0 - SPLIT_LEAD_S, 2);
    expect(phrases[1]!.to).toBeCloseTo(1.5 + SPLIT_TAIL_S, 2);
  });

  it("never overlaps phrases, even at the shortest silence that splits", () => {
    const phrases = splitPhrases(bursts(1, [[0.2, 0.4], [0.465, 0.7]]));
    expect(phrases).toHaveLength(2);
    expect(phrases[0]!.to).toBeLessThanOrEqual(phrases[1]!.from);
  });

  it("keeps words with a gap shorter than 60 ms in one phrase", () => {
    expect(splitPhrases(bursts(1, [[0.2, 0.4], [0.44, 0.7]]))).toHaveLength(1);
  });

  it("treats sound 38 dB or more under the peak as silence, and a quieter murmur above it as speech", () => {
    // Amplitude 0.5 against 0.004 (-42 dB) and 0.02 (-28 dB) between two loud bursts.
    expect(splitPhrases(bursts(2, [[0.2, 0.6], [0.6, 1.0, 0.004], [1.0, 1.4]]))).toHaveLength(2);
    expect(splitPhrases(bursts(2, [[0.2, 0.6], [0.6, 1.0, 0.02], [1.0, 1.4]]))).toHaveLength(1);
  });

  it("clamps the first and the last phrase to the take", () => {
    const [phrase] = splitPhrases(bursts(0.5, [[0.005, 0.49]]));
    expect(phrase).toEqual({ from: 0, to: 0.5 });
  });

  it("returns the whole take as one phrase when it holds no speech", () => {
    expect(splitPhrases({ sampleRate: RATE, samples: new Int16Array(RATE) })).toEqual([{ from: 0, to: 1 }]);
    expect(splitPhrases({ sampleRate: RATE, samples: new Int16Array(0) })).toEqual([{ from: 0, to: 0 }]);
  });

  it("works at the sample rates speech providers write", () => {
    const rate = 22_050;
    const samples = new Int16Array(rate * 2);
    for (const [from, to] of [[0.3, 0.8], [1.1, 1.6]] as const) {
      for (let i = Math.round(from * rate); i < Math.round(to * rate); i++) samples[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 300 * i) / rate));
    }
    expect(splitPhrases({ sampleRate: rate, samples })).toHaveLength(2);
  });

  it("names the 12 ms fade of #470", () => {
    expect(PHRASE_FADE_S).toBe(0.012);
  });
});

describe("checkLine", () => {
  it("is clean when every word is heard", () => {
    const heard = [word("Hola", 0), word("a", 0.4), word("todos.", 0.8)];
    expect(checkLine("hola a todos", "hola a todos", heard, "es")).toEqual({ status: "clean", heard: "Hola a todos.", misreads: [] });
  });

  it("reads digits the transcription writes as the number said", () => {
    expect(checkLine("son veintitrés pestañas", "son 23 pestañas", [word("Son", 0), word("23", 0.4), word("pestañas.", 0.8)], "es").status).toBe("clean");
  });

  it("reports a word the voice dropped as misread, with what was expected", () => {
    const check = checkLine("cierra todas las pestañas", "cierra todas las pestañas", [word("cierra", 0), word("las", 0.4), word("pestañas", 0.8)], "es");
    expect(check.status).toBe("misread");
    expect(check.misreads).toEqual([expect.objectContaining({ kind: "missing", expected: "todas", heard: "" })]);
  });

  it("reports a word said as another one as changed", () => {
    const check = checkLine("cierra todas las pestañas", "cierra todas las pestañas", [word("cierra", 0), word("todos", 0.4), word("los", 0.8), word("tabs", 1.2)], "es");
    expect(check.status).toBe("misread");
    expect(check.misreads.map((misread) => misread.kind)).toContain("changed");
  });

  it("calls a lost short word doubtful: the transcription may have dropped it", () => {
    const check = checkLine("hola a todos", "hola a todos", [word("Hola", 0), word("todos", 0.4)], "es");
    expect(check.status).toBe("doubtful");
    expect(check.misreads).toEqual([expect.objectContaining({ kind: "missing", expected: "a", maybeTranscription: true })]);
  });

  it("accepts a respelled name heard as people spell it", () => {
    const heard = [word("Frameshell", 0), word("las", 0.6), word("cierra", 0.9)];
    expect(checkLine("freim shel las cierra", "Frameshell las cierra", heard, "es")).toMatchObject({ status: "clean", misreads: [] });
    expect(checkLine("freim shel las cierra", "Frameshell las cierra", [word("frame", 0), word("shell", 0.4), word("las", 0.8), word("cierra", 1.2)], "es").status).not.toBe("misread");
    // A real misread still fails.
    expect(checkLine("freim shel las cierra", "Frameshell las cierra", [word("Frameshell", 0), word("las", 0.6), word("abre", 0.9)], "es").status).toBe("misread");
  });

  it("calls a take that shares almost nothing with its line a misread of the whole line", () => {
    const check = checkLine("cierra todas las pestañas", "cierra todas las pestañas", [word("buenos", 0), word("días", 0.4)], "es");
    expect(check).toMatchObject({ status: "misread", heard: "buenos días", misreads: [{ kind: "changed", expected: "cierra todas las pestañas", heard: "buenos días", maybeTranscription: false }] });
  });

  it("calls a take where nothing was heard a missing line", () => {
    expect(checkLine("cierra todas las pestañas", "cierra todas las pestañas", [], "es")).toMatchObject({ status: "misread", misreads: [{ kind: "missing", heard: "", at: null }] });
  });
});

describe("textInRanges", () => {
  it("gives each range the words whose middle falls inside it", () => {
    const words = [word("uno", 0.1), word("dos", 0.5), word("tres", 1.1)];
    expect(textInRanges([{ from: 0, to: 0.7 }, { from: 0.7, to: 0.9 }, { from: 0.9, to: 2 }], words)).toEqual(["uno dos", "", "tres"]);
  });
});

describe("verifyTakes", () => {
  const take = (id: string, spoken: string, rate = RATE): TakeToCheck => ({ id, spoken, display: spoken, file: join(tempDir(), `${id}.wav`), pcm: { sampleRate: rate, samples: new Int16Array(rate) } });
  const request = (provider: () => Promise<TranscriptionProvider>, takes: TakeToCheck[], extra: Record<string, unknown> = {}) => ({
    root: tempDir(),
    takes,
    language: "es-MX",
    providerId: "fake",
    provider,
    tools: { ensureBinary: async () => "ffmpeg", ensureModel: async () => "model" },
    progress: () => {},
    signal: new AbortController().signal,
    ...extra,
  });
  const fake = (words: (audio: string, call: number) => TranscriptWord[], seen: { audio: string; options: unknown }[] = []): TranscriptionProvider => {
    let calls = 0;
    return {
      id: "fake",
      async transcribe(audio, options) {
        seen.push({ audio, options });
        return { model: "fake-model", words: words(audio, calls++) };
      },
    };
  };

  it("transcribes each take in the voice's language and reports a check per line", async () => {
    const seen: { audio: string; options: unknown }[] = [];
    const outcome = await verifyTakes(request(async () => fake((_audio, call) => (call === 0 ? [word("hola", 0)] : [word("adiós", 0)]), seen), [take("a-1", "hola"), take("a-2", "hola")]));
    expect(outcome.verification).toEqual({ status: "checked", provider: "fake", model: "fake-model", reason: null, misread: 1, doubtful: 0 });
    expect(outcome.checks.get("a-1")!.check.status).toBe("clean");
    expect(outcome.checks.get("a-2")!.check.status).toBe("misread");
    expect(seen.map((call) => call.options)).toEqual([{ language: "es" }, { language: "es" }]);
  });

  it("leaves no audio behind in the project's verify folder", async () => {
    const options = request(async () => fake(() => [word("hola", 0)]), [take("a-1", "hola")]);
    await verifyTakes(options);
    const folder = join(options.root, ".frameshell", "cache", "verify");
    mkdirSync(folder, { recursive: true });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("hands a take that is not 16 kHz to the audio extractor, and one that is straight to the provider", async () => {
    const extracted: string[] = [];
    const extractAudio = async (input: { path: string }, output: string) => {
      extracted.push(input.path);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(output, "converted");
    };
    const slow = take("slow", "hola", 24_000);
    const outcome = await verifyTakes(request(async () => fake(() => [word("hola", 0)]), [slow, take("fast", "hola")], { extractAudio }));
    expect(extracted).toEqual([slow.file]);
    expect(outcome.verification.status).toBe("checked");
  });

  it("is skipped, with the reason, when the provider cannot be had", async () => {
    const outcome = await verifyTakes(request(() => Promise.reject(new Error("Project is not trusted: its plugins are not loaded.")), [take("a-1", "hola")]));
    expect(outcome.verification).toMatchObject({ status: "skipped", reason: "Verification skipped: Project is not trusted: its plugins are not loaded.", misread: 0 });
    expect(outcome.checks.size).toBe(0);
  });

  it("is skipped when the first transcription fails, and keeps what was checked when a later one does", async () => {
    const broken = await verifyTakes(request(async () => ({ id: "fake", transcribe: () => Promise.reject(new Error("model missing")) }), [take("a-1", "hola")]));
    expect(broken.verification).toMatchObject({ status: "skipped", reason: "Verification stopped at line a-1: model missing" });

    const late = await verifyTakes(
      request(
        async () =>
          fake((_audio, call) => {
            if (call === 1) throw new Error("whisper crashed");
            return [word("hola", 0)];
          }),
        [take("a-1", "hola"), take("a-2", "hola"), take("a-3", "hola")],
      ),
    );
    expect(late.verification.status).toBe("checked");
    expect([...late.checks.keys()]).toEqual(["a-1"]);
    expect(late.warnings).toEqual(["Verification stopped at line a-2: whisper crashed"]);
  });

  it("passes the provider's notes on as warnings", async () => {
    const noted: TranscriptionProvider = { id: "fake", transcribe: async () => ({ model: "m", words: [word("hola", 0)], notes: ["word timing is coarse"] }) };
    const outcome = await verifyTakes(request(async () => noted, [take("a-1", "hola")]));
    expect(outcome.warnings).toEqual(["Line a-1: word timing is coarse"]);
  });

  it("stops with the abort instead of reporting it as a skip", async () => {
    const controller = new AbortController();
    const options = request(async () => fake(() => [word("hola", 0)]), [take("a-1", "hola")], { signal: controller.signal });
    controller.abort();
    await expect(verifyTakes(options)).rejects.toThrow();
  });
});
