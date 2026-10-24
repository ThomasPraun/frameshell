import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ErrorCode, type GcEntry, RpcError, type SHOOT_CHANGES, type ShootStatusResult } from "@frameshell/protocol";
import {
  PEOPLE_FILE,
  SHOOTS_DIR,
  type ShootFile,
  type ShootScript,
  type ShootTake,
  type Transcript,
  createShootFile,
  parsePeopleFile,
  parseShootFile,
  parseShootScript,
  parseTranscript,
  shootSlug,
  wordSpeaker,
} from "@frameshell/schema";
import { canonicalPath, readJsonIfExists, writeJsonAtomic } from "../fs-util.js";
import { type GcClass, sweep } from "../gc.js";
import { locateScript } from "../scripts/outline.js";
import { resolveAsset, transcriptPathsFor } from "../transcripts/transcriber.js";
import { type HeardWord, type TakeComparison, compareTake } from "./compare.js";

/** Cache of take comparisons, keyed by script text, transcript and people links (derived, swept by `gc`). */
export const SHOOT_CACHE_DIR = ".frameshell/shoot";
/** Bump when {@link compareTake} changes its output, so cached comparisons are redone. */
const COMPARE_VERSION = 1;

/** See {@link SHOOT_CHANGES}. */
export type ShootChange = (typeof SHOOT_CHANGES)[number];

/** Options for {@link ShootService}. */
export interface ShootServiceOptions {
  /** Called after a shoot file is written or a take is compared anew, with the project root and script path. */
  onChanged?: (root: string, script: string, change: ShootChange, take: string | undefined) => void;
  /** Content hash (`sha256:<hex>`) of a project file when known, to tell a stale transcript; null when unknown. */
  assetHash?: (root: string, rel: string) => Promise<string | null>;
}

type TakeInfo = ShootStatusResult["takes"][number];

/** One shoot script with its shoot file, read for one call. */
interface Loaded {
  script: string;
  text: string;
  parsed: ShootScript;
  fileRel: string;
  file: ShootFile;
}

/** A take compared, or why it could not be. */
interface Analysis {
  transcript: string | null;
  state: TakeInfo["state"];
  problem: string | null;
  comparison: TakeComparison | null;
}

/**
 * Shoot files `shoots/<script slug>.json` (ADR 0023): the only writer, one change at a time per
 * project, each written atomically. Takes are compared against their asset's transcript when status
 * is asked; comparisons are cached under {@link SHOOT_CACHE_DIR}.
 */
export class ShootService {
  readonly #onChanged: NonNullable<ShootServiceOptions["onChanged"]>;
  readonly #assetHash: NonNullable<ShootServiceOptions["assetHash"]>;
  /** Last change of each project in flight, by canonical root: the next one waits for it. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: ShootServiceOptions = {}) {
    this.#onChanged = options.onChanged ?? (() => {});
    this.#assetHash = options.assetHash ?? (async () => null);
  }

  /** `shoot.status`. Throws `ScriptNotFound`, `OutsideProject` or `InvalidProjectFile`. */
  async status(root: string, cwd: string, script: string): Promise<ShootStatusResult> {
    const loaded = await this.#load(root, cwd, script);
    const { parsed, file } = loaded;
    const warnings = [...parsed.warnings];
    const sceneSlugs = new Set(parsed.scenes.map((scene) => scene.slug));
    const accepted = new Map(file.accepted.map((entry) => [`${entry.take}\0${entry.deviation}`, entry.by]));

    const takes: TakeInfo[] = [];
    for (const take of file.takes) {
      if (!sceneSlugs.has(take.scene)) warnings.push(`Take ${take.id} starts at scene "${take.scene}", which the script no longer has.`);
      if (!(await isFile(join(root, ...take.asset.split("/"))))) warnings.push(`Take ${take.id}: ${take.asset} does not exist.`);
      const analysis = await this.#analyze(root, loaded, take);
      const comparison = analysis.comparison;
      takes.push({
        id: take.id,
        asset: take.asset,
        scene: take.scene,
        recordedAt: take.recordedAt,
        discarded: take.discarded === true,
        by: take.by ?? null,
        transcript: analysis.transcript,
        state: analysis.state,
        problem: analysis.problem,
        scenes: comparison?.scenes ?? [],
        lines: comparison?.lines ?? [],
        deviations: (comparison?.deviations ?? []).map((deviation) => {
          const by = accepted.get(`${take.id}\0${deviation.id}`) ?? null;
          return { ...deviation, accepted: by !== null, acceptedBy: by };
        }),
      });
    }

    const order = takeOrder(file.takes);
    const scenes = parsed.scenes.map((scene) => {
      const covering = takes.filter((take) => !take.discarded && take.scenes.includes(scene.slug)).sort((a, b) => order(a.id) - order(b.id));
      const picked = file.chosen[scene.slug];
      const pickedTake = picked !== undefined ? covering.find((take) => take.id === picked) : undefined;
      const chosen = pickedTake ?? covering.at(-1) ?? null;
      const pending = chosen ? chosen.deviations.filter((d) => d.scene === scene.slug && !d.accepted).length : 0;
      const whole = chosen !== null && chosen.lines.filter((line) => line.scene === scene.slug).every((line) => line.status !== "outside");
      const state: ShootStatusResult["scenes"][number]["state"] = chosen === null ? "none" : whole && pending === 0 ? "done" : "deviations";
      return {
        slug: scene.slug,
        title: scene.title,
        ref: `${loaded.script}#${scene.slug}`,
        state,
        chosen: chosen?.id ?? null,
        picked: pickedTake !== undefined,
        takes: covering.map((take) => take.id),
        pending,
      };
    });
    // A scene with nothing to say (cues only) is never the next one to record.
    const recordable = new Set(parsed.scenes.filter((scene) => scene.lines.some((line) => line.words.length > 0 || line.cues.some((cue) => cue.free))).map((scene) => scene.slug));
    const next = scenes.find((scene) => scene.state !== "done" && recordable.has(scene.slug))?.slug ?? null;
    const cues = parsed.scenes.flatMap((scene) => scene.lines.flatMap((line) => line.cues.map((cue) => ({ scene: scene.slug, line: line.line, label: cue.label, text: cue.text, free: cue.free }))));
    return { script: loaded.script, file: loaded.fileRel, timeline: file.timeline ?? shootSlug(loaded.script), scenes, takes, next, cues, warnings };
  }

  /** `shoot.add`. Throws `ScriptNotFound`, `AssetNotFound`, `OutsideProject`, `InvalidOperation`, `InvalidProjectFile`. */
  async add(
    root: string,
    cwd: string,
    params: { script: string; asset: string; scene?: string | undefined; recordedAt?: string | undefined; by: string },
  ): Promise<{ file: string; take: TakeInfo }> {
    const take = await this.#change(root, async () => {
      const loaded = await this.#load(root, cwd, params.script);
      const scene = params.scene ?? loaded.parsed.scenes[0]?.slug;
      if (scene === undefined) throw invalid("shoot.add", "no scenes", `${loaded.script} has no scenes: add \`## \` headings first.`);
      if (!loaded.parsed.scenes.some((s) => s.slug === scene)) {
        throw invalid("shoot.add", "unknown scene", `No scene "${scene}" in ${loaded.script}; scenes: ${loaded.parsed.scenes.map((s) => s.slug).join(", ")}.`);
      }
      const asset = await locateAsset(root, cwd, params.asset);
      const take: ShootTake = { id: newTakeId(loaded.file), asset, scene, recordedAt: params.recordedAt ?? new Date().toISOString(), by: params.by };
      await this.#write(root, loaded, { ...loaded.file, takes: [...loaded.file.takes, take] }, "add", take.id);
      return { fileRel: loaded.fileRel, id: take.id };
    });
    const status = await this.status(root, cwd, params.script);
    return { file: take.fileRel, take: status.takes.find((info) => info.id === take.id)! };
  }

  /** `shoot.discard`. Throws `InvalidOperation` for an unknown take. */
  async discard(root: string, cwd: string, params: { script: string; take: string; restore: boolean }): Promise<{ file: string; take: string; discarded: boolean }> {
    return this.#change(root, async () => {
      const loaded = await this.#load(root, cwd, params.script);
      const take = findTake(loaded, params.take);
      const takes = loaded.file.takes.map((t) => (t.id !== take.id ? t : params.restore ? withoutDiscarded(t) : { ...t, discarded: true }));
      const chosen = Object.fromEntries(Object.entries(loaded.file.chosen).filter(([, id]) => params.restore || id !== take.id));
      await this.#write(root, loaded, { ...loaded.file, takes, chosen }, params.restore ? "restore" : "discard", take.id);
      return { file: loaded.fileRel, take: take.id, discarded: !params.restore };
    });
  }

  /** `shoot.accept`. Throws `InvalidOperation` for an unknown take, an unanalyzed one or a deviation it does not have. */
  async accept(
    root: string,
    cwd: string,
    params: { script: string; take: string; deviations?: string[] | undefined; undo: boolean; by: string },
  ): Promise<{ file: string; take: string; deviations: string[] }> {
    return this.#change(root, async () => {
      const loaded = await this.#load(root, cwd, params.script);
      const take = findTake(loaded, params.take);
      const isOf = (entry: ShootFile["accepted"][number]) => entry.take === take.id;
      let changed: string[];
      let accepted = loaded.file.accepted;
      if (params.undo) {
        const wanted = params.deviations ? new Set(params.deviations) : null;
        changed = accepted.filter((entry) => isOf(entry) && (wanted === null || wanted.has(entry.deviation))).map((entry) => entry.deviation);
        accepted = accepted.filter((entry) => !(isOf(entry) && changed.includes(entry.deviation)));
      } else {
        const analysis = await this.#analyze(root, loaded, take);
        if (!analysis.comparison) throw invalid("shoot.accept", "not analyzed", `Take ${take.id} is not compared yet: ${analysis.problem}`);
        const current = analysis.comparison.deviations.map((deviation) => deviation.id);
        const unknown = (params.deviations ?? []).filter((id) => !current.includes(id));
        if (unknown.length > 0) {
          throw invalid("shoot.accept", "unknown deviation", `Take ${take.id} has no deviation ${unknown.join(", ")} now; current ones: ${current.join(", ") || "none"}. See \`frameshell shoot status\`.`);
        }
        const done = new Set(accepted.filter(isOf).map((entry) => entry.deviation));
        changed = (params.deviations ?? current).filter((id) => !done.has(id));
        const at = new Date().toISOString();
        accepted = [...accepted, ...changed.map((deviation) => ({ take: take.id, deviation, by: params.by, at }))];
      }
      if (changed.length > 0) await this.#write(root, loaded, { ...loaded.file, accepted }, params.undo ? "unaccept" : "accept", take.id);
      return { file: loaded.fileRel, take: take.id, deviations: changed };
    });
  }

  /** `shoot.choose`. Throws `InvalidOperation` for an unknown scene or take, a discarded take or one not covering the scene. */
  async choose(root: string, cwd: string, params: { script: string; scene: string; take: string | null }): Promise<{ file: string; scene: string; take: string | null; previous: string | null }> {
    return this.#change(root, async () => {
      const loaded = await this.#load(root, cwd, params.script);
      if (!loaded.parsed.scenes.some((scene) => scene.slug === params.scene)) throw invalid("shoot.choose", "unknown scene", `No scene "${params.scene}" in ${loaded.script}.`);
      const previous = loaded.file.chosen[params.scene] ?? null;
      const chosen = { ...loaded.file.chosen };
      if (params.take === null) delete chosen[params.scene];
      else {
        const take = findTake(loaded, params.take);
        if (take.discarded) throw invalid("shoot.choose", "discarded take", `Take ${take.id} is discarded; restore it first with \`shoot.discard\` \`restore: true\`.`);
        const analysis = await this.#analyze(root, loaded, take);
        if (!analysis.comparison?.scenes.includes(params.scene)) {
          throw invalid("shoot.choose", "take does not cover scene", `Take ${take.id} does not cover scene "${params.scene}"${analysis.comparison ? ` (it covers: ${analysis.comparison.scenes.join(", ") || "nothing"})` : `: ${analysis.problem}`}.`);
        }
        chosen[params.scene] = take.id;
      }
      if (previous !== (params.take ?? null)) await this.#write(root, loaded, { ...loaded.file, chosen }, "choose", params.take ?? undefined);
      return { file: loaded.fileRel, scene: params.scene, take: params.take, previous };
    });
  }

  /** Delete (or list) cached comparisons no take of any shoot file uses now. */
  async gc(root: string, options: { dryRun: boolean; temps: boolean }): Promise<GcEntry[]> {
    const keys = new Set<string>();
    let unsure = false;
    for (const name of await readdirSafe(join(root, SHOOTS_DIR))) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = parseShootFile(await readJsonIfExists(join(root, SHOOTS_DIR, name)));
        if (!parsed.ok) throw new Error(parsed.error);
        const { text } = await locateScript(root, root, parsed.value.script);
        const loaded: Loaded = { script: parsed.value.script, text, parsed: parseShootScript(text), fileRel: `${SHOOTS_DIR}/${name}`, file: parsed.value };
        for (const take of parsed.value.takes) {
          const source = await this.#source(root, take);
          if (source.transcript) keys.add(await cacheKey(root, loaded, source.transcript));
        }
      } catch {
        // A shoot file or script that cannot be read now may be fixed later: keep every comparison.
        unsure = true;
      }
    }
    return sweep({ root, dir: SHOOT_CACHE_DIR, classify: classifyShootCache, keep: (key) => unsure || keys.has(key), temps: options.temps, dryRun: options.dryRun });
  }

  async #load(root: string, cwd: string, script: string): Promise<Loaded> {
    const { path, text } = await locateScript(root, cwd, script);
    const fileRel = `${SHOOTS_DIR}/${shootSlug(path)}.json`;
    const abs = join(root, ...fileRel.split("/"));
    let raw: unknown;
    try {
      raw = await readJsonIfExists(abs);
    } catch (error) {
      throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${abs}:\n${(error as Error).message}`, { path: abs, details: (error as Error).message });
    }
    let file = createShootFile(path);
    if (raw !== undefined) {
      const parsed = parseShootFile(raw);
      if (!parsed.ok) throw new RpcError(ErrorCode.InvalidProjectFile, `Invalid ${abs}:\n${parsed.error}`, { path: abs, details: parsed.error });
      file = parsed.value;
    }
    return { script: path, text, parsed: parseShootScript(text), fileRel, file };
  }

  async #write(root: string, loaded: Loaded, file: ShootFile, change: ShootChange, take: string | undefined): Promise<void> {
    await writeJsonAtomic(join(root, ...loaded.fileRel.split("/")), file);
    this.#onChanged(root, loaded.script, change, take);
  }

  /** The asset's transcript, or why there is none. */
  async #source(root: string, take: ShootTake): Promise<{ transcript: { rel: string; text: string; value: Transcript } | null; state: TakeInfo["state"]; problem: string | null }> {
    for (const rel of new Set(transcriptPathsFor(take.asset))) {
      let text: string;
      try {
        text = await readFile(join(root, ...rel.split("/")), "utf8");
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseTranscript(JSON.parse(text));
      } catch (error) {
        parsed = { ok: false as const, error: (error as Error).message };
      }
      if (!parsed.ok) return { transcript: null, state: "unreadable", problem: `${rel} is not a valid transcript: ${parsed.error.split("\n")[0]}` };
      if (parsed.value.asset !== take.asset) continue;
      const hash = await this.#assetHash(root, take.asset);
      if (hash !== null && hash !== parsed.value.assetHash) {
        return { transcript: null, state: "stale-transcript", problem: `${take.asset} changed since ${rel} was written; run \`frameshell transcribe ${take.asset}\` again.` };
      }
      return { transcript: { rel, text, value: parsed.value }, state: "analyzed", problem: null };
    }
    return { transcript: null, state: "no-transcript", problem: `${take.asset} has no transcript; run \`frameshell transcribe ${take.asset}\` (add \`--speakers\` when several people speak).` };
  }

  async #analyze(root: string, loaded: Loaded, take: ShootTake): Promise<Analysis> {
    const source = await this.#source(root, take);
    if (!source.transcript) return { transcript: null, state: source.state, problem: source.problem, comparison: null };
    const key = await cacheKey(root, loaded, source.transcript);
    const cachePath = join(root, ...SHOOT_CACHE_DIR.split("/"), `${key}.json`);
    const cached = (await readJsonIfExists(cachePath).catch(() => undefined)) as TakeComparison | undefined;
    if (cached !== undefined) return { transcript: source.transcript.rel, state: "analyzed", problem: null, comparison: cached };
    const heard = heardWords(source.transcript.value, await wholeTranscriptPerson(root, source.transcript.rel));
    const comparison = compareTake(loaded.parsed, heard, source.transcript.value.language ?? null);
    await writeJsonAtomic(cachePath, comparison);
    this.#onChanged(root, loaded.script, "analyzed", take.id);
    return { transcript: source.transcript.rel, state: "analyzed", problem: null, comparison };
  }

  async #change<T>(root: string, work: () => Promise<T>): Promise<T> {
    const key = await canonicalPath(root);
    const run = (this.#tails.get(key) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return run;
  }
}

/** What an entry of {@link SHOOT_CACHE_DIR} is, for `gc`: a comparison keyed by its name, or a temp of an atomic write. */
export function classifyShootCache(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return null;
  const keyed = /^([0-9a-f]{24})\.json$/.exec(name);
  if (keyed) return { kind: "shoot", key: keyed[1]! };
  if (/^[0-9a-f]{24}\.json\..+\.tmp$/.test(name)) return { kind: "temp", key: null };
  return null;
}

/** Transcript words as the take says them: human text edits applied, speakers by name. */
function heardWords(transcript: Transcript, whole: string | null): HeardWord[] {
  const names = new Map((transcript.speakers ?? []).map((speaker) => [speaker.id, speaker.name]));
  return transcript.words.map((word) => {
    const speaker = wordSpeaker(transcript, word);
    return { text: transcript.edits[word.id]?.text ?? word.text, start: word.start, end: word.end, speaker: (speaker !== undefined ? names.get(speaker) : undefined) ?? whole };
  });
}

/** Name of the person `people.json` links to all of `transcript` (one source per person); null when none or unreadable. */
async function wholeTranscriptPerson(root: string, transcript: string): Promise<string | null> {
  const parsed = parsePeopleFile(await readJsonIfExists(join(root, PEOPLE_FILE)).catch(() => undefined));
  if (!parsed.ok) return null;
  return parsed.value.people.find((person) => person.speakers.some((link) => link.transcript === transcript && link.speaker === undefined))?.name ?? null;
}

async function cacheKey(root: string, loaded: Loaded, transcript: { rel: string; text: string }): Promise<string> {
  const whole = await wholeTranscriptPerson(root, transcript.rel);
  return createHash("sha256").update(`${COMPARE_VERSION}\0${loaded.text}\0${transcript.text}\0${whole ?? ""}`).digest("hex").slice(0, 24);
}

/** Project-relative media file: `asset` absolute, or relative to `cwd`, then to `root`. */
async function locateAsset(root: string, cwd: string, asset: string): Promise<string> {
  const candidates = isAbsolute(asset) ? [asset] : [resolve(cwd, asset), resolve(root, asset)];
  let failure: unknown;
  for (const candidate of candidates) {
    try {
      return (await resolveAsset(root, candidate)).rel;
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

function findTake(loaded: Loaded, id: string): ShootTake {
  const take = loaded.file.takes.find((t) => t.id === id);
  if (!take) throw invalid("shoot", "unknown take", `No take ${id} in ${loaded.fileRel}; takes: ${loaded.file.takes.map((t) => t.id).join(", ") || "none"}.`);
  return take;
}

function withoutDiscarded(take: ShootTake): ShootTake {
  const { discarded: _discarded, ...rest } = take;
  return rest;
}

/** Sort key of a take: recorded time, then the order it was added. */
function takeOrder(takes: readonly ShootTake[]): (id: string) => number {
  const sorted = [...takes].map((take, index) => ({ take, index })).sort((a, b) => a.take.recordedAt.localeCompare(b.take.recordedAt) || a.index - b.index);
  const rank = new Map(sorted.map(({ take }, rank) => [take.id, rank]));
  return (id) => rank.get(id) ?? 0;
}

function newTakeId(file: ShootFile): string {
  for (;;) {
    const id = `k_${randomBytes(3).toString("hex")}`;
    if (!file.takes.some((take) => take.id === id)) return id;
  }
}

function invalid(op: string, reason: string, message: string): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, message, { op, reason });
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function readdirSafe(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => []);
}
