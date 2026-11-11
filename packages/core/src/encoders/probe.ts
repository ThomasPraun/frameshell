import { join } from "node:path";
import type { EncoderName, EncoderReport } from "@frameshell/protocol";
import { codecNames, execProcess, probeVersion, testEncode, type Exec } from "../binaries/probe.js";
import { readJsonIfExists, writeTextAtomic } from "../fs-util.js";
import { ENCODER_PREFERENCE } from "./tiers.js";

const LABELS: Readonly<Record<EncoderName, string>> = {
  h264_videotoolbox: "H.264 (VideoToolbox)",
  h264_nvenc: "H.264 (NVENC)",
  libx264: "H.264 (x264)",
};

/** What the probe of one ffmpeg build found; the `doctor` `encoders` field. */
export type EncoderProbe = EncoderReport;

/**
 * Test-encode every candidate in {@link ENCODER_PREFERENCE} (0.2 s of lavfi colour each) and pick the first that works.
 * `ffmpeg -encoders` lists encoders that fail on the machine, so only an encode counts. Never throws.
 */
export async function probeEncoders(ffmpeg: string, exec: Exec = execProcess): Promise<EncoderProbe> {
  let compiled = new Set<string>();
  try {
    compiled = codecNames((await exec(ffmpeg, ["-hide_banner", "-encoders"])).stdout);
  } catch {
    // Unrunnable ffmpeg: nothing is compiled in, nothing works.
  }
  const candidates: EncoderProbe["candidates"] = [];
  for (const name of ENCODER_PREFERENCE) {
    const isCompiled = compiled.has(name);
    const started = Date.now();
    const works = isCompiled && (await testEncode(ffmpeg, name, exec));
    candidates.push({ name, label: LABELS[name], compiled: isCompiled, works, ms: isCompiled ? Date.now() - started : null });
  }
  return { picked: candidates.find((candidate) => candidate.works)?.name ?? null, cached: false, probedAt: new Date().toISOString(), candidates };
}

/** File in the data dir holding one probe per ffmpeg build. */
export const ENCODER_CACHE_FILE = "encoders.json";

interface CacheFile {
  version: 1;
  /** Keyed by {@link cacheKey}. */
  probes: Record<string, EncoderProbe>;
}

/** A different ffmpeg path or version is a different build: it may have other encoders. */
const cacheKey = (ffmpeg: string, version: string | null) => `${ffmpeg}|${version ?? "unknown"}`;

/**
 * Per-machine cache of {@link probeEncoders} in `dataDir/encoders.json`, so the test encodes run once per
 * ffmpeg build, not per render. A driver or GPU change needs `refresh`.
 */
export class EncoderCache {
  readonly #file: string;
  readonly #exec: Exec;
  /** In-flight probes: concurrent callers share one run. */
  readonly #running = new Map<string, Promise<EncoderProbe>>();

  constructor(dataDir: string, exec: Exec = execProcess) {
    this.#file = join(dataDir, ENCODER_CACHE_FILE);
    this.#exec = exec;
  }

  /** The encoder renders use with this ffmpeg: the probe's pick, x264 when nothing passed (ffmpeg then fails with its own error). */
  async pick(ffmpeg: string): Promise<EncoderName> {
    return (await this.get(ffmpeg, await probeVersion(ffmpeg, this.#exec))).picked ?? "libx264";
  }

  /** The cached probe of this ffmpeg build, or a fresh one (stored) when there is none or `refresh` is set. */
  async get(ffmpeg: string, version: string | null, refresh = false): Promise<EncoderProbe> {
    const key = cacheKey(ffmpeg, version);
    if (!refresh) {
      const hit = (await this.#read()).probes[key];
      if (hit) return { ...hit, cached: true };
    }
    const running = this.#running.get(key) ?? this.#probe(ffmpeg, key);
    this.#running.set(key, running);
    try {
      return await running;
    } finally {
      this.#running.delete(key);
    }
  }

  async #probe(ffmpeg: string, key: string): Promise<EncoderProbe> {
    const probe = await probeEncoders(ffmpeg, this.#exec);
    // Nothing worked: ffmpeg may be broken for now, so ask again next time.
    if (probe.picked === null) return probe;
    const file = await this.#read();
    file.probes[key] = probe;
    try {
      await writeTextAtomic(this.#file, `${JSON.stringify(file, null, 2)}\n`);
    } catch {
      // Read-only data dir: the answer still holds for this run.
    }
    return probe;
  }

  async #read(): Promise<CacheFile> {
    try {
      const parsed = (await readJsonIfExists(this.#file)) as Partial<CacheFile> | undefined;
      if (parsed?.version === 1 && parsed.probes && typeof parsed.probes === "object") return { version: 1, probes: { ...parsed.probes } };
    } catch {
      // Broken file: probe again and overwrite it.
    }
    return { version: 1, probes: {} };
  }
}
