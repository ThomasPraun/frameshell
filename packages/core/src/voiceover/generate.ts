// `voiceover.generate` (ADR 0034): script → lines → cache check by take key → cost check → provider → trim →
// marked WAV in assets/voiceover/<script slug>/ → one asset import. The provider only turns text into audio.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { SpeechOptions, SpeechProvider } from "@frameshell/plugin-api";
import { type AssetImportResult, ErrorCode, type Progress, RpcError, type VoiceoverGenerateResult } from "@frameshell/protocol";
import { type VoiceoverLine, parseVoiceoverScript, shootSlug } from "@frameshell/schema";
import { writeTextAtomic } from "../fs-util.js";
import { locateScript } from "../scripts/outline.js";
import { type Pcm16, pcmOfWav, readPcmWav } from "../transcripts/window.js";
import { type TakeFile, type TakeMark, VOICEOVER_DIR, readTakes, takeKey, takeWavBytes } from "./takes.js";
import { trimSilence } from "./trim.js";

/** Input of {@link generateVoiceover}: the call's params plus the daemon services it needs. */
export interface VoiceoverRequest {
  /** Project root. */
  root: string;
  cwd: string;
  script: string;
  lines?: readonly string[];
  provider?: string;
  voice?: string;
  /** The person confirmed the cost of a paid provider. */
  yes: boolean;
  /** Provider by id: built-in or from a loaded plugin. Throws `SpeechProviderNotFound` or `ProjectNotTrusted`. */
  speechProvider(id: string): Promise<SpeechProvider>;
  /** Ids of the providers this project can use, for messages. */
  speechProviders(): Promise<string[]>;
  ensureBinary(name: string): Promise<string>;
  /** Import project files already under `assets/` and queue their ingest. */
  importAssets(files: string[]): Promise<AssetImportResult>;
  progress(update: Progress): void;
  /** Aborted when the daemon stops. */
  signal: AbortSignal;
}

type ResultLine = VoiceoverGenerateResult["lines"][number];

/** One line asked for, with what to do about it. */
interface Plan {
  line: VoiceoverLine;
  key: string;
  /** Project-relative take. */
  file: string;
  /** Bytes to write without asking the provider (`copied`), or null. */
  copy: Buffer | null;
  /** The take file already at `file` (any letter case), or null. */
  existing: TakeFile | null;
  /** Same key as an earlier line of this run that is said once: this one gets a copy of that take. */
  duplicateOf: Plan | null;
  state: ResultLine["state"];
}

/** Generate (or reuse) the takes of a voiceover script's lines and import the new ones; see the `voiceover.generate` registry entry. */
export async function generateVoiceover(request: VoiceoverRequest): Promise<VoiceoverGenerateResult> {
  const { root } = request;
  const { path, text } = await locateScript(root, request.cwd, request.script);
  const script = parseVoiceoverScript(text);
  if (!script.voiceover.voiceover) {
    throw new RpcError(ErrorCode.InvalidOperation, `${path} is not a voiceover script: add \`voiceover: true\` to its frontmatter.`, {
      op: "voiceover.generate",
      reason: "not a voiceover script",
      field: "script",
      hint: "Write the lines to be read in a script with `voiceover: true` in its frontmatter.",
    });
  }
  const all = script.scenes.flatMap((scene) => scene.lines);
  const lines = pickLines(all, request.lines);

  const providerId = request.provider ?? script.voiceover.provider;
  if (!providerId) {
    const available = await request.speechProviders();
    throw invalid("provider", `Name a speech provider: \`--provider <id>\` or \`provider:\` in ${path}'s frontmatter (available: ${available.join(", ") || "none"}).`);
  }
  const provider = await request.speechProvider(providerId);
  const voices = await providerCall(provider, null, () => provider.voices());
  const voice = request.voice ?? script.voiceover.voice ?? provider.defaultVoice;
  if (!voice) throw invalid("voice", `Speech provider ${providerId} has no default voice: name one (voices: ${voices.map((v) => v.id).join(", ") || "none listed"}).`);
  if (voices.length > 0 && !voices.some((known) => known.id === voice)) {
    throw invalid("voice", `Speech provider ${providerId} has no voice "${voice}" (voices: ${voices.map((v) => v.id).join(", ")}).`);
  }
  const options: SpeechOptions = script.voiceover.language ? { language: script.voiceover.language } : {};

  const dir = `${VOICEOVER_DIR}/${shootSlug(path)}`;
  const absDir = join(root, ...dir.split("/"));
  const takes = await readTakes(absDir);
  const byKey = new Map<string, TakeFile>();
  for (const take of takes.values()) if (take.mark) byKey.set(take.mark.key, take);
  const byName = new Map<string, TakeFile>();
  for (const take of takes.values()) byName.set(take.name.toLowerCase(), take);
  const firstOfKey = new Map<string, Plan>();
  const plans: Plan[] = lines.map((line) => {
    const key = takeKey({ provider: provider.id, providerVersion: provider.version ?? "1", voice, options, text: line.spoken });
    const name = `${line.id}.wav`;
    const file = `${dir}/${name}`;
    // Case-folded: on a case-insensitive filesystem `hook-1.WAV` is the file `hook-1.wav` would replace.
    const existing = byName.get(name.toLowerCase()) ?? null;
    const base = { line, key, file, existing };
    if (existing?.mark?.key === key) return { ...base, copy: null, duplicateOf: null, state: "cached" };
    const same = byKey.get(key);
    if (same) return { ...base, copy: same.bytes, duplicateOf: null, state: "copied" };
    const first = firstOfKey.get(key);
    if (first) return { ...base, copy: null, duplicateOf: first, state: "copied" };
    const plan: Plan = { ...base, copy: null, duplicateOf: null, state: "generated" };
    firstOfKey.set(key, plan);
    return plan;
  });
  const foreign = plans.filter((plan) => plan.state !== "cached" && plan.existing !== null && plan.existing.mark === null);
  if (foreign.length > 0) {
    const files = foreign.map((plan) => `${dir}/${plan.existing!.name}`);
    throw new RpcError(
      ErrorCode.InvalidOperation,
      `${files.join(", ")} ${files.length === 1 ? "was" : "were"} not written by voiceover generate (made or edited by hand) and ${files.length === 1 ? "is" : "are"} never overwritten. ` +
        "Move or rename them to generate those lines again.",
      { op: "voiceover.generate", reason: "not a voiceover take", field: "lines", files, hint: "Rename the file to keep it, then generate again." },
    );
  }

  const toSay = plans.filter((plan) => plan.state === "generated");
  const cost = await providerCall(provider, null, () => estimate(provider, toSay, voice, options));
  if (cost && cost.amount > 0 && !request.yes) {
    const characters = toSay.reduce((total, plan) => total + plan.line.spoken.length, 0);
    throw new RpcError(
      ErrorCode.ConfirmationRequired,
      `Generating ${toSay.length} line${toSay.length === 1 ? "" : "s"} with ${provider.id} costs about ${formatCost(cost)}. ` +
        "Ask the person to confirm the cost, then call again with `yes` (CLI `--yes`).",
      { provider: provider.id, voice, lines: toSay.map((plan) => plan.line.id), cost, characters },
    );
  }

  const results = new Map<string, ResultLine>();
  const written: string[] = [];
  const warnings = [...script.warnings];
  const finish = (plan: Plan, take: { pcm: { sampleRate: number; samples: Int16Array }; head: number; tail: number }) =>
    results.set(plan.line.id, {
      ...lineFields(plan),
      duration: round(take.pcm.samples.length / take.pcm.sampleRate),
      trimmed: { head: take.head, tail: take.tail },
    });
  for (const plan of plans) {
    if (plan.state === "generated" || plan.duplicateOf) continue;
    const bytes = plan.copy ?? plan.existing!.bytes;
    const pcm = pcmOf(bytes);
    if (plan.copy) {
      await writeTextAtomic(join(root, ...plan.file.split("/")), plan.copy);
      written.push(plan.file);
    }
    finish(plan, { pcm, head: 0, tail: 0 });
  }

  const said = new Map<string, { take: { pcm: Pcm16 }; mark: TakeMark }>();
  for (const [index, plan] of toSay.entries()) {
    request.signal.throwIfAborted();
    request.progress({ message: `Saying ${plan.line.id} (${index + 1}/${toSay.length})`, fraction: index / toSay.length, stage: "speak", values: { line: plan.line.id } });
    let take;
    try {
      take = await say(provider, plan, voice, options, request);
    } catch (error) {
      const imported = written.length > 0 ? await request.importAssets(written.map((file) => join(root, ...file.split("/")))) : null;
      const details = (error as Error)?.message ?? String(error);
      throw new RpcError(
        ErrorCode.SpeechFailed,
        `${provider.id} failed on line ${plan.line.id}: ${details}` +
          (imported ? ` The ${written.length} take${written.length === 1 ? "" : "s"} finished before ${written.length === 1 ? "is" : "are"} kept; the next call reuses them.` : ""),
        { provider: provider.id, line: plan.line.id, details, written },
      );
    }
    if (take.silent) warnings.push(`Line ${plan.line.id}: the take is silent; listen to ${plan.file}.`);
    for (const note of take.notes) warnings.push(`Line ${plan.line.id}: ${note}`);
    const mark = { key: plan.key, provider: provider.id, voice, text: plan.line.spoken };
    await writeTextAtomic(join(root, ...plan.file.split("/")), takeWavBytes(take.pcm, mark));
    written.push(plan.file);
    finish(plan, take);
    said.set(plan.key, { take, mark });
  }

  for (const plan of plans) {
    if (!plan.duplicateOf) continue;
    const first = said.get(plan.key)!;
    await writeTextAtomic(join(root, ...plan.file.split("/")), takeWavBytes(first.take.pcm, first.mark));
    written.push(plan.file);
    finish(plan, { pcm: first.take.pcm, head: 0, tail: 0 });
  }

  const imported = written.length > 0 ? (await request.importAssets(written.map((file) => join(root, ...file.split("/"))))).imported : [];
  return {
    script: path,
    dir,
    provider: provider.id,
    voice,
    lines: plans.map((plan) => results.get(plan.line.id)!),
    imported: imported.map(({ asset, job }) => ({ asset, job })),
    cost: cost && toSay.length > 0 ? cost : null,
    warnings,
  };
}

/** Lines `ids` names, in script order; all when absent. Throws `InvalidParams` naming unknown ids. */
function pickLines(all: VoiceoverLine[], ids: readonly string[] | undefined): VoiceoverLine[] {
  if (!ids) {
    if (all.length === 0) throw invalid("script", "The script has no lines to say: write them under `## ` scene headings.");
    return all;
  }
  const known = new Set(all.map((line) => line.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw invalid("lines", `No line ${unknown.join(", ")} in the script (lines: ${all.map((line) => line.id).join(", ") || "none"}).`);
  }
  const wanted = new Set(ids);
  return all.filter((line) => wanted.has(line.id));
}

/** Summed estimate of the lines to say; null when the provider gives none (free). */
async function estimate(provider: SpeechProvider, plans: Plan[], voice: string, options: SpeechOptions): Promise<{ amount: number; currency: string } | null> {
  if (!provider.estimate) return null;
  let amount = 0;
  let currency: string | null = null;
  for (const plan of plans) {
    const one = await provider.estimate(plan.line.spoken, voice, options);
    if (currency !== null && one.currency !== currency) throw new Error(`${provider.id} estimated costs in both ${currency} and ${one.currency}`);
    currency = one.currency;
    amount += Math.max(0, one.cost);
  }
  return currency === null ? null : { amount, currency };
}

/** Runs a provider call that is not a line's synthesis; its failure reaches the caller as `SpeechFailed`, not an internal error. */
async function providerCall<T>(provider: SpeechProvider, line: string | null, call: () => Promise<T> | T): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const details = (error as Error)?.message ?? String(error);
    throw new RpcError(ErrorCode.SpeechFailed, `${provider.id} failed: ${details}`, { provider: provider.id, line, details, written: [] });
  }
}

/** One provider call: WAV in a fresh temp dir, read, trimmed. Throws with a user-facing message. */
async function say(provider: SpeechProvider, plan: Plan, voice: string, options: SpeechOptions, request: VoiceoverRequest) {
  const outDir = await mkdtemp(join(tmpdir(), "frameshell-speech-"));
  try {
    const result = await provider.synthesize(plan.line.spoken, voice, options, {
      outDir,
      signal: request.signal,
      ensureBinary: request.ensureBinary,
      progress: ({ message, fraction }) => request.progress({ message, ...(fraction !== undefined ? { fraction } : {}), stage: "speak", values: { line: plan.line.id } }),
    });
    const inside = relative(outDir, result.file);
    if (!isAbsolute(result.file) || inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`returned ${result.file}, which is not a file in its output folder`);
    }
    const pcm = await readPcmWav(result.file);
    if (!pcm) throw new Error(`returned ${result.file}, which is not a mono 16-bit PCM WAV`);
    return { ...trimSilence(pcm), notes: result.notes ?? [] };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function pcmOf(bytes: Buffer) {
  const pcm = pcmOfWav(bytes);
  if (!pcm) throw new Error("voiceover take is not a mono 16-bit PCM WAV");
  return pcm;
}

function lineFields(plan: Plan): Omit<ResultLine, "duration" | "trimmed"> {
  const { id, scene, line, display, spoken } = plan.line;
  return { id, scene, line, display, spoken, file: plan.file, state: plan.state };
}

function invalid(field: string, message: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, message, { issues: [{ path: [field], message }] });
}

function formatCost(cost: { amount: number; currency: string }): string {
  return `${cost.amount.toFixed(cost.amount < 1 ? 4 : 2)} ${cost.currency}`;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
