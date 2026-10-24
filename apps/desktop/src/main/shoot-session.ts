// Shoot session files (ADR 0024 decisions 1 and 3): one file per source under `assets/shoot/<id>/`, appended chunk by
// chunk while recording, plus a small state file so a session cut short by a crash is finished on the next open.
import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { exists, readJsonIfExists, renameRetrying, writeJsonAtomic } from "@frameshell/core/fs-util";
import { ErrorCode, type MethodParams, RpcError } from "@frameshell/protocol";
import { SHOOT_ROLES, type ShootFinish, type ShootRole, type ShootSourceSpec } from "../shared/api.js";
import type { DaemonLink } from "./daemon-link.js";

/** Project-relative folder of every session's media. */
export const SHOOT_ASSETS_DIR = "assets/shoot";
/**
 * Project-relative folder of the state files of sessions not finished yet. Under `.frameshell/` (machine-local,
 * never versioned, never ingested): the file only says how to finish media still being written on this machine.
 */
export const SHOOT_STATE_DIR = ".frameshell/shoot/sessions";
/** Suffix of a file while it is recorded: the daemon's watcher and `asset.list` skip it, so nothing ingests half a file. */
export const PART_SUFFIX = ".part";
/** Session ids: local start time `YYYYMMDD-HHMMSS`, a `-<n>` suffix when two start in one second. */
const SESSION_ID = /^\d{8}-\d{6}(-\d+)?$/;

/** One recorded source as the state file keeps it. */
export interface SessionSource {
  role: ShootRole;
  /** File name in the session folder, e.g. `camera.mp4`; recorded as `<file>.part`. */
  file: string;
  mime: string;
  /** Device or window name, used as the angle or mic name. */
  label: string;
  /** `performance.now()` read right before the recorder's `start()`, ms; null until the recorders started. */
  start: number | null;
}

/** Contents of `<SHOOT_STATE_DIR>/<id>.json`. */
export interface SessionState {
  version: 1;
  id: string;
  /** ISO time the session began. */
  createdAt: string;
  /** Process that records it (Frameshell's main): while it lives, the session is not crashed, whoever looks. */
  pid?: number;
  sources: SessionSource[];
}

/** `true` for a well-formed session id; ids from the renderer are checked with it before any path is built. */
export function isSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID.test(id);
}

/** Id of a session begun at `now` (local time), with a suffix when `taken` says the plain one is in use. */
export function sessionId(now: Date, taken: (id: string) => boolean): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const base = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

/** WebM is written without duration or cues while live: it needs a remux before anything can seek it. */
export function needsRemux(mime: string): boolean {
  return mime.startsWith("video/webm") || mime.startsWith("audio/webm");
}

/** File name of a source: `camera.mp4`, `screen.webm`, `mic.m4a`, `system.webm`… by role and recorded type. */
export function fileNameOf(role: ShootRole, mime: string): string {
  const audio = role === "mic" || role === "system";
  const ext = needsRemux(mime) ? "webm" : audio ? "m4a" : "mp4";
  return `${role}.${ext}`;
}

/** Project-relative folder of session `id`. */
export function sessionFolder(id: string): string {
  return `${SHOOT_ASSETS_DIR}/${id}`;
}

function statePath(root: string, id: string): string {
  return join(root, SHOOT_STATE_DIR, `${id}.json`);
}

/**
 * Start session files for `specs` (one per role, a mic among them): the folder under `assets/shoot/` and the state
 * file. Throws on a spec list without a mic or with a role twice.
 */
export async function beginSession(root: string, specs: readonly ShootSourceSpec[], now = new Date()): Promise<SessionState> {
  const roles = specs.map((spec) => spec.role);
  if (!roles.includes("mic")) throw new Error("A shoot needs a microphone.");
  if (new Set(roles).size !== roles.length || roles.some((role) => !SHOOT_ROLES.includes(role))) throw new Error("Each source records once.");
  const taken = new Set(await readdir(join(root, SHOOT_ASSETS_DIR)).catch(() => [] as string[]));
  const id = sessionId(now, (candidate) => taken.has(candidate));
  await mkdir(join(root, SHOOT_ASSETS_DIR, id), { recursive: true });
  const state: SessionState = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    pid: process.pid,
    sources: specs.map(({ role, mime, label }) => ({ role, file: fileNameOf(role, mime), mime, label, start: null })),
  };
  await writeJsonAtomic(statePath(root, id), state);
  return state;
}

/** Record each recorder's start (`performance.now()` before `start()`, ms) in the state file. */
export async function markStarted(root: string, id: string, starts: Partial<Record<ShootRole, number>>): Promise<void> {
  const state = await readSession(root, id);
  if (!state) throw new Error(`No unfinished shoot session ${id}.`);
  for (const source of state.sources) {
    const start = starts[source.role];
    if (typeof start === "number" && Number.isFinite(start)) source.start = start;
  }
  await writeJsonAtomic(statePath(root, id), state);
}

/**
 * Appends chunks to session files in arrival order, one file at a time each: two chunks of one recorder never
 * interleave, whatever the IPC timing.
 */
export class ChunkWriter {
  readonly #tails = new Map<string, Promise<void>>();

  /** Append `data` to `role`'s `.part` file of session `state`. */
  append(root: string, state: SessionState, role: ShootRole, data: Uint8Array): Promise<void> {
    const source = state.sources.find((candidate) => candidate.role === role);
    if (!source) return Promise.reject(new Error(`Session ${state.id} does not record ${role}.`));
    const path = join(root, SHOOT_ASSETS_DIR, state.id, source.file + PART_SUFFIX);
    const next = (this.#tails.get(path) ?? Promise.resolve()).then(() => appendFile(path, data));
    const tail = next.catch(() => undefined);
    this.#tails.set(path, tail);
    void tail.then(() => this.#tails.get(path) === tail && this.#tails.delete(path));
    return next;
  }

  /** Resolves once every chunk handed over so far is on disk (or failed). */
  async flushed(): Promise<void> {
    await Promise.all(this.#tails.values());
  }
}

/** The state file of session `id`; null when it is finished, missing or unreadable. */
export async function readSession(root: string, id: string): Promise<SessionState | null> {
  const raw = (await readJsonIfExists(statePath(root, id)).catch(() => null)) as SessionState | null;
  if (!raw || raw.version !== 1 || raw.id !== id || !Array.isArray(raw.sources)) return null;
  return raw;
}

/** True while process `pid` runs (signal 0 only checks; EPERM means it runs as another user). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether session `id` was left by a crash and can be finished now: false while the process that records it still
 * runs (another Frameshell instance on the same project, as unpackaged builds allow), so its files are never cut
 * from under it; a later open retries. A reused pid only delays recovery.
 */
export async function recoverable(root: string, id: string, alive: (pid: number) => boolean = processAlive): Promise<boolean> {
  const state = await readSession(root, id);
  if (!state) return false;
  return state.pid === undefined || state.pid === process.pid || !alive(state.pid);
}

/** Ids of the sessions of the project rooted at `root` that have a state file: not finished. Oldest first. */
export async function unfinishedSessions(root: string): Promise<string[]> {
  const names = await readdir(join(root, SHOOT_STATE_DIR)).catch(() => [] as string[]);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isSessionId)
    .sort();
}

/** Group-clock offset per source, s: its start against the earliest one. Sources whose start is unknown get 0. */
export function offsetsOf(sources: readonly SessionSource[]): number[] {
  const known = sources.flatMap((source) => (source.start === null ? [] : [source.start]));
  const first = known.length > 0 ? Math.min(...known) : 0;
  return sources.map((source) => (source.start === null ? 0 : Math.round(source.start - first) / 1000));
}

/**
 * `multicam.create` of the recorded `present` sources (ADR 0024 decision 1): the camera and the screen are angles
 * (the screen marked), the mic and system audio are mics that every angle is heard through, offsets from the
 * recorders' start times. Null when nothing has a picture: a mic alone makes no group.
 */
export function groupRequest(
  root: string,
  id: string,
  present: readonly SessionSource[],
): Omit<MethodParams<"multicam.create">, "timeline"> | null {
  const order: ShootRole[] = ["camera", "screen", "mic", "system"];
  const sorted = order.flatMap((role) => present.filter((source) => source.role === role));
  const pictures = sorted.filter((source) => source.role === "camera" || source.role === "screen");
  const mics = sorted.filter((source) => source.role === "mic" || source.role === "system");
  if (pictures.length === 0) return null;
  const asset = (source: SessionSource) => `${sessionFolder(id)}/${source.file}`;
  const screen = pictures.findIndex((source) => source.role === "screen");
  return {
    cwd: root,
    assets: pictures.map(asset),
    names: pictures.map((source) => source.label),
    ...(mics.length > 0 ? { mics: mics.map(asset), micNames: mics.map((source) => source.label) } : {}),
    soundOf: pictures.map(() => (mics.length > 0 ? "1" : "none")),
    offsets: offsetsOf([...pictures, ...mics]),
    ...(screen >= 0 ? { screens: [screen + 1] } : {}),
    name: `Shoot ${id}`,
  };
}

/** What {@link finishSession} needs from the app; replaced in tests. */
export interface FinishDeps {
  /** The app's daemon connection (`ui` author). */
  request: DaemonLink["request"];
  /** Runs `work` with no gesture burst open around it (`TimelineEditor.alone`). */
  alone: <T>(work: () => Promise<T>) => Promise<T>;
  /** Stream-copy `input` into `output` in the container of `mime` (managed ffmpeg). */
  remux(input: string, output: string, mime: string): Promise<void>;
}

/**
 * Finish session `id`: each `.part` file becomes its final file (remuxed when it is WebM, or always after a crash,
 * which drops a torn last chunk), the files are imported for ingest, and a session with a picture becomes one
 * multicam group on the main timeline. A file whose remux fails keeps its recorded bytes. Idempotent: a retry
 * after a failure skips what is done. The state file goes last, so a failed step is retried on the next open.
 */
export async function finishSession(root: string, id: string, crashed: boolean, deps: FinishDeps): Promise<ShootFinish> {
  const state = await readSession(root, id);
  if (!state) throw new Error(`No unfinished shoot session ${id}.`);
  const folder = join(root, SHOOT_ASSETS_DIR, id);
  const warnings: string[] = [];
  const present: SessionSource[] = [];
  for (const source of state.sources) {
    const final = join(folder, source.file);
    const part = final + PART_SUFFIX;
    const size = (await stat(part).catch(() => null))?.size ?? null;
    if (size === null) {
      if (await exists(final)) present.push(source);
      continue;
    }
    if (size === 0) {
      await removeFile(part);
      warnings.push(`${source.file}: nothing was recorded.`);
      continue;
    }
    if (crashed || needsRemux(source.mime)) {
      // `.tmp`: ignored by the daemon's watcher until the rename.
      const temp = `${final}.remux.tmp`;
      let repaired = true;
      try {
        await deps.remux(part, temp, source.mime);
      } catch (error) {
        repaired = false;
        await removeFile(temp);
        warnings.push(`${source.file}: could not be repaired (${(error as Error).message}); kept as recorded.`);
      }
      if (repaired) {
        await renameRetrying(temp, final);
        await removeFile(part);
      } else {
        await renameRetrying(part, final);
      }
    } else {
      await renameRetrying(part, final);
    }
    present.push(source);
  }
  const files = present.map((source) => `${sessionFolder(id)}/${source.file}`);
  let group: string | null = null;
  if (files.length > 0) {
    await deps.request("asset.import", { cwd: root, files: files.map((file) => join(root, file)), mode: "copy" });
    let grouped = present;
    for (let params = groupRequest(root, id, grouped); params; params = groupRequest(root, id, grouped)) {
      try {
        const result = await deps.alone(() => deps.request("multicam.create", { ...params!, timeline: "main" }));
        group = result.group;
        warnings.push(...result.warnings);
        break;
      } catch (error) {
        // Refused for good (an unreadable file): the files stay as assets. Anything else is retried on the next open.
        if (!(error instanceof RpcError && error.code === ErrorCode.InvalidOperation)) throw error;
        // A crash right after Start can leave a video with no frame yet: group the rest without it.
        const named = grouped.find((source) => error.message.includes(`${sessionFolder(id)}/${source.file}`));
        if (!named) {
          warnings.push(`No multicam group: ${error.message}`);
          break;
        }
        warnings.push(`${named.file}: left out of the group (${error.message})`);
        grouped = grouped.filter((source) => source !== named);
      }
    }
  }
  // Nothing recorded: no empty folder left behind (rmdir refuses one that holds anything).
  if (files.length === 0) await rmdir(folder).catch(() => undefined);
  await rm(statePath(root, id), { force: true });
  return { id, folder: sessionFolder(id), files, group, recovered: crashed, warnings };
}

/** Longest {@link removeFile} waits for a deleted file's name to go, ms. */
const REMOVE_WAIT_MS = 5_000;

/**
 * Delete `path` and wait until its name is gone. On Windows a file another process still has open (an antivirus scan
 * of a file ffmpeg just read, a process killed a moment ago) is only marked for deletion and stays listed until that
 * handle closes; a busy file is retried. Throws when the name is still there after {@link REMOVE_WAIT_MS}.
 */
export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true, maxRetries: 10, retryDelay: 100 });
  const deadline = Date.now() + REMOVE_WAIT_MS;
  while (await exists(path)) {
    if (Date.now() >= deadline) throw new Error(`${path} could not be deleted: another program has it open.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(path, { force: true }).catch(() => undefined);
  }
}

/** {@link FinishDeps.remux} with the ffmpeg at the path `ffmpeg` resolves to. */
export function ffmpegRemux(ffmpeg: () => Promise<string>): FinishDeps["remux"] {
  return async (input, output, mime) => {
    const format = needsRemux(mime) ? "webm" : "mp4";
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-map", "0", "-c", "copy"];
    if (format === "mp4") args.push("-movflags", "+faststart");
    args.push("-f", format, output);
    const path = await ffmpeg();
    await new Promise<void>((resolve, reject) => {
      execFile(path, args, { windowsHide: true }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim().split("\n").at(-1) || error.message));
        else resolve();
      });
    });
  };
}
