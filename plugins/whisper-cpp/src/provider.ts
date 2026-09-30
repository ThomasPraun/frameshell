import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscribeContext, TranscriptionProvider, TranscriptionResult } from "@frameshell/plugin-api";
import { readWav, speechFrames } from "./audio.js";
import { type RunEngine, spawnEngine } from "./engine.js";
import { timeWords } from "./timing.js";
import { parseWhisperJson } from "./whisper-json.js";

/** Provider id in `frameshell.json` and `--provider`. */
export const PROVIDER_ID = "whisper-cpp";

/** Managed binary the host installs (pinned whisper.cpp, SPEC §9). */
export const WHISPER_BINARY = "whisper-cli";

/** ADR 0003 default: same Metal speed as f16, faster on CPU, no measurable text loss. */
export const DEFAULT_MODEL = "large-v3-turbo-q5_0";

/**
 * Selectable models: id → whisper.cpp DTW alignment-heads preset. The host
 * manages each file as model `ggml-<id>`.
 */
export const MODELS: Readonly<Record<string, { dtw: string }>> = {
  "large-v3-turbo-q5_0": { dtw: "large.v3.turbo" },
  "large-v3-turbo-q8_0": { dtw: "large.v3.turbo" },
  "large-v3-turbo": { dtw: "large.v3.turbo" },
};

/** Options for {@link createWhisperProvider}. */
export interface WhisperProviderOptions {
  /** Engine seam; defaults to spawning whisper-cli. */
  runEngine?: RunEngine;
  /**
   * Metal shader load taking longer than this (ms) is a cold compile: the user
   * is told to expect 15-25 s. Default 1500; a warm cache loads in ~20 ms.
   */
  coldShaderNoticeMs?: number;
}

/**
 * whisper.cpp provider with ADR 0003 settings: `-dtw <preset> -nfa -ml 1 -sow
 * -ojf` (DTW needs flash attention off; one segment per word), never `--vad`
 * (it breaks DTW times at the pinned version). Word start = DTW onset, end =
 * derived from audio energy. A run that fails after a GPU backend started
 * (driver error, out of GPU memory) is retried once on CPU (`-ng`).
 */
export function createWhisperProvider(options: WhisperProviderOptions = {}): TranscriptionProvider {
  const runEngine = options.runEngine ?? spawnEngine;
  const coldShaderNoticeMs = options.coldShaderNoticeMs ?? 1500;
  return {
    id: PROVIDER_ID,
    async transcribe(audio, { language, model = DEFAULT_MODEL }, context): Promise<TranscriptionResult> {
      const preset = MODELS[model];
      if (!preset) {
        throw new Error(`Unknown whisper.cpp model "${model}". Available: ${Object.keys(MODELS).join(", ")} (default ${DEFAULT_MODEL}).`);
      }
      context.progress({ message: "Preparing whisper.cpp" });
      const binary = await context.ensureBinary(WHISPER_BINARY);
      context.progress({ message: `Preparing model ${model}` });
      const modelPath = await context.ensureModel(`ggml-${model}`);

      const work = await mkdtemp(join(tmpdir(), "frameshell-whisper-"));
      try {
        const prefix = join(work, "out");
        const args = [
          "-m", modelPath,
          "-f", audio,
          "-l", language ?? "auto",
          "-dtw", preset.dtw,
          "-nfa",
          "-ml", "1",
          "-sow",
          "-ojf",
          "-pp",
          "-of", prefix,
        ];
        let monitor = engineMonitor(context, coldShaderNoticeMs);
        context.progress({ message: "Loading model" });
        try {
          await runEngine(binary, args, monitor.line);
        } catch (error) {
          const gpu = monitor.device();
          if (gpu === "cpu") throw error;
          monitor.stop();
          context.progress({ message: `whisper.cpp failed on ${gpu} (${lastLine(error)}); retrying on CPU` });
          monitor = engineMonitor(context, coldShaderNoticeMs);
          await runEngine(binary, [...args, "-ng"], monitor.line);
        } finally {
          monitor.stop();
        }
        const parsed = parseWhisperJson(await readFile(`${prefix}.json`, "utf8"));
        const pcm = readWav(await readFile(audio));
        const speech = speechFrames(pcm);
        const duration = pcm.samples.length / pcm.sampleRate;
        const lang = language ?? parsed.language;
        return {
          model,
          ...(lang ? { language: lang } : {}),
          words: timeWords(parsed.words, speech, duration),
          device: monitor.device(),
        };
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  };
}

/** Seconds of Metal shader compile above which the user hears about it afterwards. */
const NOTICEABLE_COMPILE_SECONDS = 2;

/**
 * Turns whisper-cli log lines into progress reports and the compute device.
 * Metal compiles its shaders on the first run of each installed binary (cache
 * keyed by executable path): 15-21 s measured on an M3, ~20 ms warm. Only a load still
 * running after `coldShaderNoticeMs` is announced.
 */
function engineMonitor(context: TranscribeContext, coldShaderNoticeMs: number) {
  let device = "cpu";
  let lastPercent = -1;
  let shaderTimer: NodeJS.Timeout | undefined;
  return {
    device: () => device,
    stop: () => clearTimeout(shaderTimer),
    line(text: string) {
      if (text.includes("ggml_metal_library_init: using embedded metal library")) {
        shaderTimer = setTimeout(
          () => context.progress({ message: "Compiling Metal GPU shaders (first run after install only, 15-25 s)" }),
          coldShaderNoticeMs,
        );
        return;
      }
      const compiled = /ggml_metal_library_compile_all: loaded \d+ libraries .* in ([\d.]+) sec/.exec(text);
      if (compiled) {
        clearTimeout(shaderTimer);
        const seconds = Number(compiled[1]);
        if (seconds >= NOTICEABLE_COMPILE_SECONDS) {
          context.progress({ message: `Compiled Metal GPU shaders in ${seconds.toFixed(1)} s (cached from now on)` });
        }
        return;
      }
      const backend = /whisper_backend_init_gpu: using (\S+) backend/.exec(text);
      if (backend) {
        device = deviceName(backend[1]!);
        return;
      }
      const progress = /progress =\s*(\d+)%/.exec(text);
      if (progress) {
        const percent = Number(progress[1]);
        if (percent === lastPercent) return;
        lastPercent = percent;
        context.progress({ message: `Transcribing (${device})`, fraction: Math.min(1, percent / 100) });
      }
    },
  };
}

/** Last log line of an engine failure: usually the cause (`CUDA error: out of memory`). */
function lastLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n").filter(Boolean).at(-1) ?? "";
}

/** `MTL0` → `metal`, `CUDA0` → `cuda`, `Vulkan0` → `vulkan`. */
function deviceName(backend: string): string {
  const name = backend.replace(/\d+$/, "").toLowerCase();
  return name === "mtl" ? "metal" : name;
}
