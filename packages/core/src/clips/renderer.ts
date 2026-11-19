import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import {
  type ClipFinalRenderInfo,
  type ClipLiveResult,
  type ClipRenderInfo,
  type ClipRendersResult,
  ErrorCode,
  type GcEntry,
  type GcSkip,
  type JobInfo,
  type JobPriority,
  RpcError,
} from "@frameshell/protocol";
import { type AdapterGcEntry, type ClipAdapter, type LivePage, MOTION_BLUR_REFUSED, type RenderTier, type RenderTiming } from "@frameshell/plugin-api";
import {
  type AdapterClip,
  type BeatsFile,
  type FormatEntry,
  type ResolvedMotionBlur,
  type Timeline,
  clipInFormat,
  elementStyles,
  motionBlurOf,
} from "@frameshell/schema";
import { generatedFrameAt } from "../export/compiler.js";
import { readJsonIfExists, renameRetrying, writeJsonAtomic } from "../fs-util.js";
import { type GcClass, sweep } from "../gc.js";
import type { JobContext, JobQueue } from "../jobs/queue.js";
import { hashFile } from "../media/store.js";
import { readStyleTokens } from "../style/tokens.js";
import { type NestedReader, resolveNested, resolveNestedIn } from "../timeline/nested.js";
import { type TimelineWords, type WordLoader, onceWords } from "../timeline/time-ref.js";
import { clipCacheKey } from "./cache-key.js";
import { clipTiming } from "./timing.js";

/** Project-relative directory of the clip render cache (SPEC §5.1, §6.5). */
export const CLIP_CACHE_DIR = ".frameshell/cache/clips";

/** An adapter with the plugin that registered it: its name and version are part of the cache key. */
export interface RegisteredClipType {
  adapter: ClipAdapter;
  plugin: { name: string; version: string };
}

/** Frame rate and size a render is made for: the project's, or a format's (ADR 0027). */
export interface ClipFormat {
  fps: number;
  width: number;
  height: number;
}

/** A cached render, ready to play or overlay. */
export interface RenderedClip {
  /** Absolute file. */
  path: string;
  /** Project-relative, `/`-separated. */
  file: string;
  hasAlpha: boolean;
  width: number;
  height: number;
  /** Seconds; null when the container does not say. */
  duration: number | null;
  /** What the adapter said about this render (`RenderContext.warn`); absent when nothing. */
  warnings?: string[];
}

/** What the renderer learns from ffprobe about a finished render. */
export interface RenderProbe {
  width: number;
  height: number;
  duration: number | null;
}

/** Options for {@link ClipRenderer}. */
export interface ClipRendererOptions {
  /** Queue the `clip` jobs run on. Its own queue: an export job waits for clip jobs, so they must never share slots. */
  jobs: JobQueue;
  /** Adapters of the project's loaded plugins, by clip type; empty when untrusted. See `PluginHost.clipAdapters`. */
  adapters(root: string): Promise<ReadonlyMap<string, RegisteredClipType>>;
  /** Why no adapter renders `type` in `root` (not installed, not trusted), for `unavailable` states. */
  unavailable?(root: string, type: string): Promise<string>;
  /** Timeline ids of the project (`timelines/<id>.json`). */
  timelines(root: string): Promise<string[]>;
  /** Parsed timeline; see `TimelineService.load`. */
  load(root: string, id: string): Promise<{ timeline: Timeline }>;
  /**
   * Timeline file as on disk, read without side effects: background scans
   * must never race the timeline service taking in a direct edit. Throws when
   * missing or invalid.
   */
  peek(root: string, id: string): Promise<Timeline>;
  /** Nested timeline by clip `source`, for {@link ClipRenderer.status}. Default: read the file. */
  readNested?: NestedReader;
  /** Project fps and resolution from `frameshell.json`. */
  format(root: string): Promise<ClipFormat>;
  /**
   * The project's formats other than the primary one (ADR 0027): `gc` keeps their renders, each clip keyed with
   * its override there (`props`, `elements`). Background renders stay at the project resolution. Default: none.
   */
  formatSizes?(root: string): Promise<FormatEntry[]>;
  /** Size and length of a finished render (ffprobe). */
  probe(root: string, file: string, signal: AbortSignal): Promise<RenderProbe>;
  /** Managed or overridden native tool for adapters; see `RenderContext.ensureBinary`. */
  ensureBinary(root: string, name: string): Promise<string>;
  /**
   * Beats file of a project-relative asset, or null; throws for a broken one. Feeds `RenderContext.timing` of clips
   * that ask for beats (ADR 0029 decision 8). Default: none, so such clips get no beats.
   */
  beatsOf?(root: string, asset: string): Promise<BeatsFile | null>;
  /**
   * Transcript words `timeline` plays, as `word:` references read them (`readTimelineWords`). Feeds
   * `RenderContext.timing` of clips that ask for words; read on each key check of such a clip only. Default: none, so
   * such clips get `wordsProblem` `no-transcript`.
   */
  wordsOf?(root: string, timeline: Timeline, fps: number): Promise<TimelineWords>;
  /** Watch attached projects for composition edits. Default true. */
  watch?: boolean;
  /** Quiet time after the last file event before re-checking keys. Default 200 ms. */
  debounceMs?: number;
}

/** A generated clip as found on a timeline. */
interface Placed {
  clip: AdapterClip;
  track: string;
}

/** A generated clip with the timeline it sits in, whose beats and markers its timing reads. */
interface Sited {
  clip: AdapterClip;
  timeline: Timeline;
}

/**
 * Which render of a clip that keeps two (ADR 0041 decision 11): `draft` the fast one (live preview, draft exports),
 * `final` the expensive one (final and untiered exports, frames). A clip with one render gives it for both.
 */
export type ClipTier = "draft" | "final";

/**
 * The final render of a generated clip whose adapter renders finals (`ClipAdapter.finals`, ADR 0035): `ready`
 * (cached), `rendering` (queued or running), or `missing`, with the adapter's estimate of its time.
 */
export interface FinalRenderState {
  clip: string;
  type: string;
  state: "ready" | "rendering" | "missing";
  /** Estimated seconds of a `missing` final; null when it is not missing, or the adapter could not say. */
  seconds: number | null;
}

/** Options of {@link ClipRenderer.ensure}. */
export interface ClipEnsureOptions {
  /** Share of clips done, 0..1. */
  onProgress?: ((fraction: number) => void) | undefined;
  /** Render at that frame size instead of the project resolution (a format of the project, ADR 0027); part of the key. */
  size?: { width: number; height: number } | undefined;
  /** Render of a clip that keeps two to use. Default `final`. */
  tier?: ClipTier | undefined;
  /**
   * With `tier` `final`, for clips whose adapter renders finals (`ClipAdapter.finals`, ADR 0035): render a missing
   * final and wait for it (final and untiered exports). Default false: the final when cached, else the draft with a
   * warning, so a frame or a review never waits for a render that can take half an hour.
   */
  waitForFinals?: boolean | undefined;
  /**
   * Timeline seconds of the one frame a still draws (`frame` and `clip.compare` asked for `final`; never `review`, ADR 0035).
   * With `tier` `final`, a clip shown at that frame whose adapter renders windowed finals (`finals.windowed`)
   * and has no motion blur is drawn from its whole final when cached, else from a final of that frame alone, rendered
   * (interactive) and waited for; a failure throws, never falls back to the draft. Every other clip as without it.
   */
  stillFinalAt?: number | undefined;
  /**
   * Something to tell about a clip's render in use: its draft render stands in because the plugin refused the final
   * one (motion blur, ADR 0041 decision 8), or the adapter changed a setting to render it (`RenderContext.warn`).
   * Called once per clip and render per call of `ensure`.
   */
  onWarning?: ((warning: string) => void) | undefined;
}

/**
 * One cached render of a clip: its key and what the render gets beside the clip. `styleCss`: the token sheet the key
 * counts (ADR 0028); `motionBlur`: likewise the clip's resolved blur, for an adapter that applies it (ADR 0041);
 * `timing`: the beats and markers inside the clip, for a clip that asks (ADR 0029 decision 8); `tier`: which render,
 * for an adapter with finals (ADR 0035), whose final is made only when an export waits for it.
 */
interface Variant {
  key: string;
  registered: RegisteredClipType;
  styleCss?: string;
  motionBlur?: ResolvedMotionBlur;
  timing?: RenderTiming;
  tier?: RenderTier;
}

/**
 * Keys of a clip, or why it has none: `key` its draft render's; `final` the render beside it, when it has one (blurred,
 * or the adapter's final); `paths` what the adapter's `inputs` returned, for its `gc`.
 */
type Keyed = (Variant & { final: Variant | null; paths: readonly string[] }) | { key: null; error: string };

/** A failed render: why, and whether the adapter refused the motion blur (then never retried while the key holds). */
interface Failure {
  error: string;
  refused: boolean;
}

/** Cached render of a variant, or the render that makes it. */
type Obtained = { ready: RenderedClip } | { done: Promise<RenderedClip> };

interface Pending {
  job: string;
  done: Promise<RenderedClip>;
  /** Refresh once it is ready: some caller queued it as a draft whose final render follows. */
  refreshAfter: boolean;
}

/** Cache entry metadata, written after the media file: its presence marks a complete entry. */
interface EntryMeta {
  file: string;
  hasAlpha: boolean;
  width: number;
  height: number;
  duration: number | null;
  /** What the adapter said while rendering (`RenderContext.warn`); left out when nothing. */
  warnings?: string[];
  plugin: string;
  version: string;
  type: string;
  source: string | null;
  renderedAt: string;
}

/**
 * Clip render cache (SPEC §6.5): renders every generated clip (adapter
 * clips: `hyperframes`, …) of a project in the background into
 * `.frameshell/cache/clips/<key>.<ext>`, keyed by {@link clipCacheKey}.
 * Unchanged clips reuse their entry; a changed composition, props or project
 * format gives a new key and so a new render. Entries are regenerable.
 *
 * Renders start when a project is attached, when {@link refresh} runs (the
 * daemon calls it on every timeline change), and when a file under the
 * project changes (composition edits). A failed key is not retried by
 * refreshes until its inputs change; {@link ensure} (export) retries it.
 * A clip with motion blur keeps two entries (ADR 0041 decision 11): the
 * sharp draft, and the blurred final queued in the background once the
 * draft is ready. So does a clip whose adapter renders finals (ADR 0035),
 * but its final is rendered only when an export waits for it.
 */
export class ClipRenderer {
  readonly #options: ClipRendererOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #failed = new Map<string, Failure>();
  /** Renders whose adapter refused the motion blur, by entry id, until their `done` reads it. */
  readonly #refused = new Set<string>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** Per root: the running refresh, and whether another was asked for meanwhile. */
  readonly #refreshing = new Map<string, { run: Promise<void>; again: boolean }>();
  /** Input file hashes by absolute path, valid while size and mtime match. */
  readonly #hashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();
  /** Settles the promise of each job the renderer queued, by job id. */
  readonly #settle = new Map<string, (job: JobInfo) => void>();
  /** Handed to adapters as `InputsContext.signal`; aborted by {@link close}, so no key check outlives the daemon. */
  readonly #stopping = new AbortController();
  #closed = false;

  constructor(options: ClipRendererOptions) {
    this.#options = options;
    options.jobs.watch(({ job, stateChanged }) => {
      if (!stateChanged || job.state === "queued" || job.state === "running") return;
      this.#settle.get(job.id)?.(job);
      this.#settle.delete(job.id);
    });
  }

  /** Watch `root` for composition edits and render what is missing. Idempotent. */
  attach(root: string): void {
    if (this.#closed || this.#watchers.has(root)) return;
    if (this.#options.watch !== false) {
      const watcher = watch(root, {
        ignoreInitial: true,
        // Only files and folders: watching a FIFO or socket can block a libuv thread forever.
        // Installed packages anywhere (a composition's own node_modules too): an install would flood refreshes.
        ignored: (path, stats) => {
          const parts = relative(root, path).split(sep);
          return IGNORED.has(parts[0] ?? "") || parts.includes("node_modules") || (stats !== undefined && !stats.isFile() && !stats.isDirectory());
        },
      });
      watcher.on("all", () => this.#schedule(root));
      // A vanished project must not crash the daemon.
      watcher.on("error", () => {});
      this.#watchers.set(root, watcher);
    }
    void this.refresh(root).catch(() => {});
  }

  /**
   * Queue a render for every generated clip of every timeline whose key has
   * no cache entry yet. Never waits for renders. Concurrent calls coalesce.
   */
  refresh(root: string): Promise<void> {
    const current = this.#refreshing.get(root);
    if (current) {
      current.again = true;
      return current.run;
    }
    const state = { run: Promise.resolve(), again: false };
    state.run = (async () => {
      try {
        do {
          state.again = false;
          await this.#refreshOnce(root);
        } while (state.again && !this.#closed);
      } finally {
        this.#refreshing.delete(root);
      }
    })();
    this.#refreshing.set(root, state);
    return state.run;
  }

  /**
   * Render state of every generated clip timeline `id` shows, nested ones
   * included under their flattened id (`<nested clip>/<clip>`, as export and
   * the preview name them) and their root track; queues renders that are due.
   * `size`: in that format of the project other than the primary (ADR 0027), at its size and with each clip's
   * override there, as export renders it.
   */
  async status(root: string, id: string, size?: FormatEntry): Promise<ClipRendersResult> {
    const { timeline } = await this.#options.load(root, id);
    const hosts = timeline.tracks.map((track) => track.id);
    // Flattening adds layers `<track>/<n>`: report the root track that shows them.
    const host = (track: string) => (hosts.includes(track) ? track : (hosts.find((candidate) => track.startsWith(`${candidate}/`)) ?? track));
    const flat = await resolveNestedIn(root, timeline, size?.id, this.#options.readNested);
    const placed = generatedClips(flat).map((p) => ({ ...p, track: host(p.track) }));
    const adapters = placed.length > 0 ? await this.#options.adapters(root) : new Map<string, RegisteredClipType>();
    const project = await this.#options.format(root);
    const format = size ? { fps: project.fps, width: size.width, height: size.height } : project;
    const clips: ClipRenderInfo[] = [];
    const words = this.#wordsPass(root, format.fps);
    for (const { clip, track } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format, flat, undefined, words(flat));
      const about = { clip: clip.id, track, type: clip.type, source: clip.source ?? null };
      if (keyed.key === null) {
        clips.push({ ...about, ...UNRENDERED, state: "unavailable", error: keyed.error });
        continue;
      }
      const draft = await this.#stateOf(root, keyed, clip, format, "interactive", backgroundFinal(keyed.final));
      // Never `waiting`: a missing draft is always queued.
      const info: ClipRenderInfo = { ...about, ...draft, state: draft.state as ClipRenderInfo["state"] };
      // The final is queued behind its draft, in the background: the preview shows the draft meanwhile (ADR 0041).
      // An adapter's own final waits for an export that asks for it (ADR 0035).
      if (keyed.final) {
        const queue = draft.state === "ready" && backgroundFinal(keyed.final) ? "background" : null;
        const final = await this.#stateOf(root, keyed.final, clip, format, queue);
        info.final = {
          ...final,
          refused: this.#failed.get(entryId(root, keyed.final.key))?.refused === true,
          ...(backgroundFinal(keyed.final) ? {} : { onDemand: true }),
        };
      }
      clips.push(info);
    }
    return { timeline: timeline.id, revision: timeline.revision, clips };
  }

  /**
   * State of render `variant` of `clip`. Missing and not failed, it is queued at `queue` priority (an interactive
   * one moves a queued background render of the same key up); with `queue` null it is `waiting` unless already pending.
   * `refreshAfter` as for {@link #render}.
   */
  async #stateOf(
    root: string,
    variant: Variant,
    clip: AdapterClip,
    format: ClipFormat,
    queue: JobPriority | null,
    refreshAfter = false,
  ): Promise<Omit<ClipFinalRenderInfo, "refused">> {
    const { key } = variant;
    const ready = await this.#ready(root, key);
    if (ready) {
      const { file, hasAlpha, width, height, duration } = ready;
      return { ...UNRENDERED, state: "ready", key, file, hasAlpha, width, height, duration, progress: 1 };
    }
    const id = entryId(root, key);
    const failed = this.#failed.get(id);
    if (failed) return { ...UNRENDERED, state: "failed", key, error: failed.error };
    const pending = queue ? this.#render(root, variant, clip, format, queue, refreshAfter) : this.#pending.get(id);
    if (!pending) return { ...UNRENDERED, state: "waiting", key };
    const job = this.#options.jobs.get(pending.job);
    return { ...UNRENDERED, state: job?.state === "running" ? "rendering" : "queued", key, job: pending.job, progress: job?.progress ?? 0 };
  }

  /**
   * Live page of generated clip `clipId` of timeline `id` (ADR 0010), from
   * its adapter's `livePreview`, with the clip's render key so the app knows
   * when to ask again. `clipId` is flattened as in {@link status}. Reads
   * only: never renders. Throws ClipNotFound, LiveUnavailable, or
   * OutsideProject when the page's `root` or `entry` leaves the project or
   * `entry` leaves `root`.
   */
  async live(root: string, id: string, clipId: string): Promise<ClipLiveResult> {
    const { timeline } = await this.#options.load(root, id);
    const flat = await resolveNested(root, timeline, this.#options.readNested);
    const clips = generatedClips(flat);
    const clip = clips.find((placed) => placed.clip.id === clipId)?.clip;
    if (!clip) {
      const ids = clips.map((placed) => placed.clip.id);
      throw new RpcError(
        ErrorCode.ClipNotFound,
        `No generated clip "${clipId}" on timeline ${timeline.id}` + (ids.length > 0 ? ` (generated clips: ${ids.join(", ")}).` : " (it has none)."),
        { clip: clipId },
      );
    }
    const unavailable = (details: string) =>
      new RpcError(ErrorCode.LiveUnavailable, `${clip.type} clip ${clipId} cannot be shown live: ${details}`, {
        clip: clipId,
        type: clip.type,
        timeline: timeline.id,
        details,
      });
    const format = await this.#options.format(root);
    const keyed = await this.#keyOf(root, clip, await this.#options.adapters(root), format, flat, undefined, this.#wordsPass(root, format.fps)(flat));
    if (keyed.key === null) throw unavailable(keyed.error);
    const { adapter, plugin } = keyed.registered;
    if (!adapter.livePreview) throw unavailable(`the ${plugin.name} ${plugin.version} adapter has no live preview.`);
    let page: LivePage;
    try {
      page = await adapter.livePreview(structuredClone(clip), {
        projectDir: root,
        fps: format.fps,
        width: format.width,
        height: format.height,
        ensureBinary: (name) => this.#options.ensureBinary(root, name),
        ...(keyed.timing ? { timing: keyed.timing } : {}),
      });
    } catch (error) {
      throw unavailable(`${plugin.name}: ${(error as Error)?.message ?? error}`);
    }
    for (const field of ["root", "entry", "head"] as const) {
      if (typeof page?.[field] !== "string" || page[field] === "") throw unavailable(`${plugin.name} returned a live page without \`${field}\`.`);
    }
    const dir = livePath(page.root, "root");
    const entry = livePath(page.entry, "entry");
    if (dir !== "." && !entry.startsWith(`${dir}/`)) {
      throw new RpcError(ErrorCode.OutsideProject, `${plugin.name} returned a live entry ${entry} outside its root ${dir}.`, { path: entry });
    }
    if (!(await stat(join(root, ...entry.split("/"))).then((info) => info.isFile(), () => false))) {
      throw unavailable(`its live page ${entry} does not exist.`);
    }
    return { clip: clipId, root: dir, entry, head: page.head, key: keyed.key, ...elementCssOf(clip), ...(keyed.styleCss ? { styleCss: keyed.styleCss } : {}) };
  }

  /**
   * Cached render of every generated clip on a video track of `timeline`,
   * by clip id, rendering missing ones first (SPEC §3.5 step 2). Retries
   * failed keys. Throws `ClipRenderFailed` for the first clip that cannot be
   * rendered, or has no adapter. A clip that keeps two renders (ADR 0041)
   * gives its `tier`'s; where the plugin refused the final one, the draft
   * with a warning (decision 8). See {@link ClipEnsureOptions}.
   */
  async ensure(root: string, timeline: Timeline, options: ClipEnsureOptions = {}): Promise<Map<string, RenderedClip>> {
    const { onProgress, size, tier = "final", waitForFinals = false, stillFinalAt, onWarning } = options;
    const placed = generatedClips(timeline);
    const rendered = new Map<string, RenderedClip>();
    if (placed.length === 0) return rendered;
    const adapters = await this.#options.adapters(root);
    const project = await this.#options.format(root);
    const format = size ? { fps: project.fps, width: size.width, height: size.height } : project;
    const waits: { clip: AdapterClip; done: Promise<RenderedClip> }[] = [];
    const sharp = (clip: AdapterClip, draft: Variant, refusal: string): Promise<Obtained> => {
      onWarning?.(`Clip ${clip.id} is used without motion blur, from its sharp render: ${refusal}`);
      return this.#obtain(root, draft, clip, format);
    };
    const words = this.#wordsPass(root, format.fps)(timeline);
    for (const { clip } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format, timeline, undefined, words);
      if (keyed.key === null) throw renderFailed(timeline.id, clip, keyed.error);
      const { final } = keyed;
      const failed = final ? this.#failed.get(entryId(root, final.key)) : undefined;
      const cachedFinal = final?.tier === "final" && tier === "final" && !waitForFinals ? await this.#ready(root, final.key) : null;
      const still = stillFinalAt !== undefined && tier === "final" && !waitForFinals && !cachedFinal ? stillFrame(keyed, clip, stillFinalAt, format.fps) : null;
      let got: Obtained;
      if (!final || tier === "draft") got = await this.#obtain(root, keyed, clip, format, backgroundFinal(final));
      else if (cachedFinal) got = { ready: cachedFinal };
      else if (still !== null) {
        const stillKeyed = await this.#keyOf(root, clip, adapters, format, timeline, still, words);
        if (stillKeyed.key === null || !stillKeyed.final) throw renderFailed(timeline.id, clip, stillKeyed.key === null ? stillKeyed.error : "its adapter keyed no final");
        onWarning?.(
          `Clip ${clip.id} (${clip.type}) is drawn from a final render of this frame alone (composition frame ${still}); ` +
            "a final export (`render` with quality final, or no quality) renders its whole final.",
        );
        got = await this.#obtain(root, stillKeyed.final, stillClip(clip, still, format.fps), format);
      } else if (final.tier === "final" && !waitForFinals) {
        const windowed = keyed.registered.adapter.finals?.windowed === true;
        const exported = "a final export (`render` with quality final, or no quality)";
        onWarning?.(
          `Clip ${clip.id} (${clip.type}) is drawn from its draft render: ` +
            (stillFinalAt !== undefined && !windowed
              ? `${keyed.registered.plugin.name} renders finals only of the whole clip, made by ${exported}.`
              : `its final render is made only by ${exported}${stillFinalAt === undefined && windowed ? ", or for one frame by `frame` or `clip.compare` with `final`" : ""}.`),
        );
        got = await this.#obtain(root, keyed, clip, format);
      } else if (failed?.refused) got = await sharp(clip, keyed, failed.error);
      else {
        got = await this.#obtain(root, final, clip, format);
        if ("done" in got) {
          const blurred = got.done;
          got = {
            done: blurred.catch(async (error: unknown) => {
              if ((error as Refusal).refused !== true) throw error;
              const fallback = await sharp(clip, keyed, (error as Error).message);
              return "ready" in fallback ? fallback.ready : fallback.done;
            }),
          };
        }
      }
      if ("ready" in got) rendered.set(clip.id, got.ready);
      else waits.push({ clip, done: got.done });
    }
    let done = rendered.size;
    onProgress?.(done / placed.length);
    for (const { clip, done: render } of waits) {
      try {
        rendered.set(clip.id, await render);
      } catch (error) {
        throw renderFailed(timeline.id, clip, (error as Error).message);
      }
      onProgress?.(++done / placed.length);
    }
    for (const { warnings = [] } of rendered.values()) for (const warning of warnings) onWarning?.(warning);
    return rendered;
  }

  /**
   * The cached render of `variant`, or the render queued interactive for it; a failed key is tried again.
   * `refreshAfter` as for {@link #render}.
   */
  async #obtain(root: string, variant: Variant, clip: AdapterClip, format: ClipFormat, refreshAfter = false): Promise<Obtained> {
    const ready = await this.#ready(root, variant.key);
    if (ready) return { ready };
    this.#failed.delete(entryId(root, variant.key));
    return { done: this.#render(root, variant, clip, format, "interactive", refreshAfter).done };
  }

  /**
   * Final renders of the generated clips of `timeline` whose adapter renders finals (ADR 0035), in track then time
   * order, at the project resolution or `size`; never renders. A missing final carries the adapter's estimate of its
   * time. Clips without a key are left out: {@link check} and {@link ensure} report them. With `stillAt` (timeline
   * seconds), what {@link ensure} with `stillFinalAt` would draw instead: a clip's whole final when cached, else
   * its final of that one frame; clips that would get neither (not shown there, no windowed finals) are left out.
   */
  async finals(root: string, timeline: Timeline, size?: { width: number; height: number }, stillAt?: number): Promise<FinalRenderState[]> {
    const placed = generatedClips(timeline);
    if (placed.length === 0) return [];
    const adapters = await this.#options.adapters(root);
    const project = await this.#options.format(root);
    const format = size ? { fps: project.fps, width: size.width, height: size.height } : project;
    const states: FinalRenderState[] = [];
    const words = this.#wordsPass(root, format.fps)(timeline);
    for (const { clip } of placed) {
      const finals = adapters.get(clip.type)?.adapter.finals;
      if (!finals) continue;
      const keyed = await this.#keyOf(root, clip, adapters, format, timeline, undefined, words);
      if (keyed.key === null || !keyed.final) continue;
      const about = { clip: clip.id, type: clip.type };
      if (await this.#ready(root, keyed.final.key)) {
        states.push({ ...about, state: "ready", seconds: null });
        continue;
      }
      let due = keyed.final;
      let sized = clip;
      if (stillAt !== undefined) {
        const still = stillFrame(keyed, clip, stillAt, format.fps);
        if (still === null) continue;
        const stillKeyed = await this.#keyOf(root, clip, adapters, format, timeline, still, words);
        if (stillKeyed.key === null || !stillKeyed.final) continue;
        due = stillKeyed.final;
        sized = stillClip(clip, still, format.fps);
      }
      if (await this.#ready(root, due.key)) states.push({ ...about, state: "ready", seconds: null });
      else if (this.#pending.has(entryId(root, due.key))) states.push({ ...about, state: "rendering", seconds: null });
      else {
        const seconds = await Promise.resolve()
          .then(() => finals.estimate(structuredClone(sized), { projectDir: root, ...format }))
          .then((value) => (Number.isFinite(value) && value >= 0 ? value : null), () => null);
        states.push({ ...about, state: "missing", seconds });
      }
    }
    return states;
  }

  /**
   * Keys the checks of {@link ensure} without rendering: throws
   * `ClipRenderFailed` when a generated clip of `timeline` has no adapter.
   */
  async check(root: string, timeline: Timeline): Promise<void> {
    const placed = generatedClips(timeline);
    if (placed.length === 0) return;
    const adapters = await this.#options.adapters(root);
    const format = await this.#options.format(root);
    const words = this.#wordsPass(root, format.fps)(timeline);
    for (const { clip } of placed) {
      const keyed = await this.#keyOf(root, clip, adapters, format, timeline, undefined, words);
      if (keyed.key === null) throw renderFailed(timeline.id, clip, keyed.error);
    }
  }

  /**
   * Delete cache entries no generated clip of any timeline keys now, plus
   * `.tmp-*` render folders when `temps`. Every clip is keyed first; when one
   * cannot be (invalid timeline, plugin missing or untrusted, adapter error),
   * entries are kept and `skipped` says why. A key with a render pending is
   * kept. `busy`: a render or export job runs, so nothing is deleted.
   * Then each adapter with a `gc` hook cleans its own files, given the paths its clips' inputs name now (ADR 0035);
   * what it removes is reported as kind `clip`. It is not asked when a key is unknown.
   */
  async gc(root: string, options: { dryRun: boolean; temps: boolean; busy: boolean }): Promise<{ removed: GcEntry[]; skipped: GcSkip[] }> {
    const skipped: GcSkip[] = [];
    let keys: Set<string> | null = null;
    let inputs: Map<RegisteredClipType, Set<string>> | null = null;
    // A file an adapter writes after this moment is newer than the floor and kept.
    const keepNewerThan = Date.now() - ADAPTER_GC_GRACE_MS;
    if (options.busy) {
      skipped.push({ area: "clips", reason: "a clip render or export job of this project is running; it may read any cache entry." });
    } else {
      const found = await this.#currentKeys(root);
      if (typeof found === "string") skipped.push({ area: "clips", reason: found });
      else ({ keys, inputs } = found);
    }
    const removed = await sweep({
      root,
      dir: CLIP_CACHE_DIR,
      classify: classifyClipEntry,
      keep: (key) => keys === null || keys.has(key),
      temps: options.temps && !options.busy,
      dryRun: options.dryRun,
      claim: async (key) => (this.#pending.has(entryId(root, key)) ? null : () => {}),
    });
    if (inputs) removed.push(...(await this.#adapterGc(root, inputs, { dryRun: options.dryRun, keepNewerThan }, skipped)));
    return { removed, skipped };
  }

  /** Runs the `gc` hook of every adapter that has one; one that throws is skipped, with why, and the others still run. */
  async #adapterGc(
    root: string,
    inputs: ReadonlyMap<RegisteredClipType, ReadonlySet<string>>,
    options: { dryRun: boolean; keepNewerThan: number },
    skipped: GcSkip[],
  ): Promise<GcEntry[]> {
    const removed: GcEntry[] = [];
    for (const [{ adapter, plugin }, paths] of inputs) {
      if (!adapter.gc) continue;
      try {
        const found: readonly AdapterGcEntry[] = await adapter.gc({ projectDir: root, inputs: paths, signal: this.#stopping.signal, ...options });
        for (const entry of found) removed.push({ path: entry.path, kind: "clip", bytes: entry.bytes });
      } catch (error) {
        skipped.push({ area: "clips", reason: `${plugin.name} could not clean its own files: ${(error as Error)?.message ?? error}` });
      }
    }
    return removed;
  }

  /**
   * Keys of every generated clip on every timeline of `root`, at every format size, with the paths `inputs` named for
   * the clips of each adapter that has a `gc` hook; or why they cannot all be known.
   */
  async #currentKeys(root: string): Promise<{ keys: Set<string>; inputs: Map<RegisteredClipType, Set<string>> } | string> {
    const placed: Sited[] = [];
    for (const id of await this.#options.timelines(root)) {
      try {
        const timeline = await this.#options.peek(root, id);
        const flat = await resolveNested(root, timeline, this.#options.readNested);
        // Flattened too: a nested timeline file may live outside `timelines/`.
        placed.push(...sited(timeline), ...sited(flat));
      } catch (error) {
        return `timelines/${id}.json could not be read (${(error as Error).message}); its clips may use any entry.`;
      }
    }
    const keys = new Set<string>();
    const inputs = new Map<RegisteredClipType, Set<string>>();
    // No generated clips: never load plugins (an untrusted project stays untouched).
    if (placed.length === 0) return { keys, inputs };
    const adapters = await this.#options.adapters(root);
    // An adapter with a hook is asked even when none of its clips is left: all its files are then unused.
    for (const registered of new Set(adapters.values())) if (registered.adapter.gc) inputs.set(registered, new Set());
    const project = await this.#options.format(root);
    const sizes = (await this.#options.formatSizes?.(root)) ?? [];
    const formats = [{ id: undefined, ...project }, ...sizes.map((size) => ({ id: size.id, fps: project.fps, width: size.width, height: size.height }))];
    const wordsFor = this.#wordsPass(root, project.fps);
    for (const { clip, timeline } of placed) {
      for (const { id, ...format } of formats) {
        const keyed = await this.#keyOf(root, id === undefined ? clip : clipInFormat(clip, id), adapters, format, timeline, undefined, wordsFor(timeline));
        if (keyed.key === null) return `clip ${clip.id} has no cache key: ${keyed.error}`;
        keys.add(keyed.key);
        if (keyed.final) keys.add(keyed.final.key);
        const used = inputs.get(keyed.registered);
        if (used) for (const path of keyed.paths) used.add(path);
      }
    }
    return { keys, inputs };
  }

  /** Stop watching. Running renders are the queue's to stop. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#stopping.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }

  #schedule(root: string): void {
    if (this.#closed) return;
    clearTimeout(this.#timers.get(root));
    const timer = setTimeout(() => {
      this.#timers.delete(root);
      void this.refresh(root).catch(() => {});
    }, this.#options.debounceMs ?? 200);
    timer.unref?.();
    this.#timers.set(root, timer);
  }

  /**
   * Queue background renders of every generated clip, keyed as `status` and export key them: in its timeline
   * flattened, so a nested clip hears its host's beats and markers. A clip that reads timing in a timeline file
   * another one nests is keyed only through that host; keyed against its own file it would render a second time.
   */
  async #refreshOnce(root: string): Promise<void> {
    const files: { id: string; timeline: Timeline }[] = [];
    for (const id of await this.#options.timelines(root)) {
      try {
        files.push({ id, timeline: await this.#options.peek(root, id) });
      } catch {
        // Invalid or vanished timeline: its own errors surface where it is used.
      }
    }
    const hosted = nestedSources(files);
    const placed: (Sited & { hosted: boolean })[] = [];
    for (const { id, timeline } of files) {
      let flat: Timeline;
      try {
        flat = await resolveNested(root, timeline, this.#options.readNested);
      } catch {
        continue;
      }
      const isHosted = hosted.has(`timelines/${id}.json`);
      placed.push(...sited(flat).map((site) => ({ ...site, hosted: isHosted })));
    }
    // No generated clips: never load plugins (an untrusted project stays untouched).
    if (placed.length === 0) return;
    const adapters = await this.#options.adapters(root);
    const format = await this.#options.format(root);
    const wordsFor = this.#wordsPass(root, format.fps);
    for (const { clip, timeline, hosted: isHosted } of placed) {
      if (this.#closed) return;
      const keyed = await this.#keyOf(root, clip, adapters, format, timeline, undefined, wordsFor(timeline));
      if (keyed.key === null || this.#failed.has(entryId(root, keyed.key))) continue;
      if (isHosted && keyed.timing) continue;
      const { final } = keyed;
      if (!(await this.#ready(root, keyed.key))) {
        // A final render waits for its draft: the refresh after the draft is ready queues it.
        this.#render(root, keyed, clip, format, "background", backgroundFinal(final));
        continue;
      }
      if (final && backgroundFinal(final) && !this.#failed.has(entryId(root, final.key)) && !(await this.#ready(root, final.key))) {
        this.#render(root, final, clip, format, "background");
      }
    }
  }

  /**
   * The words reader of one pass (one call of a public method) over its timelines: for each timeline the first clip
   * that asks for `words` reads them and the rest share that read, so a pass reads the transcript once per timeline
   * however many clips ask. Never kept past the pass, so a transcript change between two calls re-keys. Absent when
   * `wordsOf` is not configured: such clips get `wordsProblem` `no-transcript`.
   */
  #wordsPass(root: string, fps: number): (timeline: Timeline) => WordLoader | undefined {
    const { wordsOf } = this.#options;
    const loaders = new Map<Timeline, WordLoader>();
    return (timeline) => {
      if (!wordsOf) return undefined;
      let loader = loaders.get(timeline);
      if (!loader) loaders.set(timeline, (loader = onceWords(() => wordsOf(root, timeline, fps))));
      return loader;
    };
  }

  /**
   * Keys of `clip`, placed on `timeline` (whose beats and markers a clip that asks for timing reads). With `still`, its
   * `final` is the final of that one composition frame: the adapter's inputs are those of {@link stillClip},
   * its timing still the whole clip's, as the frame shows it in the whole final. `words` is the pass's memoised read of
   * `timeline`'s words ({@link #wordsPass}); without it, a clip that asks for words reads them itself.
   */
  async #keyOf(
    root: string,
    clip: AdapterClip,
    adapters: ReadonlyMap<string, RegisteredClipType>,
    format: ClipFormat,
    timeline: Timeline,
    still?: number,
    words?: WordLoader,
  ): Promise<Keyed> {
    const registered = adapters.get(clip.type);
    if (!registered) {
      const reason = (await this.#options.unavailable?.(root, clip.type)) ?? `No loaded plugin renders \`${clip.type}\` clips.`;
      return { key: null, error: reason };
    }
    const context = { projectDir: root, ensureBinary: (name: string) => this.#options.ensureBinary(root, name), signal: this.#stopping.signal };
    let paths: string[];
    try {
      const shown = still === undefined ? clip : stillClip(clip, still, format.fps);
      paths = registered.adapter.inputs ? await registered.adapter.inputs(structuredClone(shown), context) : [];
    } catch (error) {
      return { key: null, error: `${registered.plugin.name} could not list the inputs of ${clip.id}: ${(error as Error)?.message ?? error}` };
    }
    let timing: RenderTiming | undefined;
    try {
      const kinds = registered.adapter.timing ? await registered.adapter.timing(structuredClone(clip), context) : [];
      if (!Array.isArray(kinds)) throw new Error('timing() must return an array such as ["beats", "markers"]');
      const { beatsOf, wordsOf } = this.#options;
      timing = await clipTiming({
        clip,
        timeline,
        fps: format.fps,
        kinds,
        beatsOf: async (asset) => (beatsOf ? beatsOf(root, asset) : null),
        ...(wordsOf ? { wordsOf: words ?? (() => wordsOf(root, timeline, format.fps)) } : {}),
      });
    } catch (error) {
      return { key: null, error: `${registered.plugin.name} could not say which timing ${clip.id} reads: ${(error as Error)?.message ?? error}` };
    }
    const inputs = await Promise.all(paths.map(async (path) => ({ path, hash: await this.#hashInput(root, path) })));
    let sheet: Awaited<ReturnType<typeof readStyleTokens>> = null;
    if (registered.adapter.styleTokens) {
      try {
        sheet = await readStyleTokens(root);
      } catch (error) {
        return { key: null, error: (error as Error).message };
      }
    }
    const recipe = { plugin: registered.plugin, clip, inputs, format, ...(sheet ? { style: sheet.hash } : {}), ...(timing ? { timing } : {}) };
    const finals = registered.adapter.finals !== undefined;
    const draft: Variant = {
      key: clipCacheKey(recipe),
      registered,
      ...(sheet ? { styleCss: sheet.css } : {}),
      ...(timing ? { timing } : {}),
      ...(finals ? { tier: "draft" as const } : {}),
    };
    // A blurred clip keeps its sharp render as the draft and the blurred one as a second entry (ADR 0041 decision 11);
    // so does a clip whose adapter renders finals (ADR 0035), its final blurred too when both apply.
    const blur = registered.adapter.motionBlur ? motionBlurOf(clip) : null;
    const final: Variant | null =
      blur || finals
        ? {
            ...draft,
            key: clipCacheKey({
              ...recipe,
              ...(blur ? { motionBlur: blur } : {}),
              ...(finals ? { final: true as const } : {}),
              ...(still !== undefined ? { still } : {}),
            }),
            ...(blur ? { motionBlur: blur } : {}),
            ...(finals ? { tier: "final" as const } : {}),
          }
        : null;
    return { ...draft, final, paths };
  }

  /** Content hash of a project-relative input; null when missing or outside the project. */
  async #hashInput(root: string, rel: string): Promise<string | null> {
    const path = resolve(root, ...rel.split("/"));
    const inside = relative(root, path);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const known = this.#hashes.get(path);
      if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.hash;
      const hash = await hashFile(path, info.size);
      this.#hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, hash });
      return hash;
    } catch {
      return null;
    }
  }

  /** Complete cache entry of `key`, or null. */
  async #ready(root: string, key: string): Promise<RenderedClip | null> {
    const dir = join(root, ...CLIP_CACHE_DIR.split("/"));
    const meta = (await readJsonIfExists(join(dir, `${key}.json`)).catch(() => undefined)) as EntryMeta | undefined;
    if (!meta || typeof meta.file !== "string" || meta.file.includes("/") || meta.file.includes("\\")) return null;
    const path = join(dir, meta.file);
    if (!(await stat(path).then((info) => info.isFile(), () => false))) return null;
    const { warnings } = meta;
    return {
      path,
      file: `${CLIP_CACHE_DIR}/${meta.file}`,
      hasAlpha: meta.hasAlpha,
      width: meta.width,
      height: meta.height,
      duration: meta.duration,
      ...(Array.isArray(warnings) && warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * The pending render of `variant`, queueing one when none runs. `interactive`: somebody waits for it (the preview
   * reading {@link status}, an export, a frame); it moves a queued background render of the same key up.
   * `background`: the refresh after an edit, behind every interactive render. `refreshAfter`: refresh once it is
   * ready (a draft, whose final render is queued then).
   */
  #render(root: string, variant: Variant, clip: AdapterClip, format: ClipFormat, priority: JobPriority, refreshAfter = false): Pending {
    const { key, registered } = variant;
    const id = entryId(root, key);
    const running = this.#pending.get(id);
    if (running) {
      if (priority === "interactive") this.#options.jobs.promote(running.job);
      running.refreshAfter ||= refreshAfter;
      return running;
    }
    const dir = join(root, ...CLIP_CACHE_DIR.split("/"));
    let settle!: (job: JobInfo) => void;
    const finished = new Promise<JobInfo>((resolve) => (settle = resolve));
    const snapshot = structuredClone(clip);
    const info = this.#options.jobs.enqueue({
      kind: "clip",
      priority,
      project: root,
      asset: clip.source ?? `${clip.type}:${clip.id}`,
      output: join(dir, key),
      run: (ctx) => this.#run(root, dir, key, snapshot, registered, format, ctx, variant),
    });
    const done = (async () => {
      const job = info.state === "canceled" ? info : await finished;
      const refused = this.#refused.delete(id);
      if (job.state === "done") {
        const ready = await this.#ready(root, key);
        if (ready) return ready;
        throw new Error(`the render of ${clip.id} finished but left no cache entry`);
      }
      const error: Refusal = new Error(job.error ?? `the render of ${clip.id} was canceled`);
      if (refused) error.refused = true;
      throw error;
    })();
    if (info.state !== "canceled") this.#settle.set(info.id, settle);
    const pending: Pending = { job: info.id, done, refreshAfter };
    this.#pending.set(id, pending);
    // Kept for status until settled; a failure is remembered so refreshes do not loop on it.
    done.then(
      () => {
        this.#pending.delete(id);
        if (pending.refreshAfter) this.#schedule(root);
      },
      (error: unknown) => {
        this.#pending.delete(id);
        if (info.state !== "canceled" && !this.#closed) this.#failed.set(id, { error: (error as Error).message, refused: (error as Refusal).refused === true });
      },
    );
    return pending;
  }

  async #run(
    root: string,
    dir: string,
    key: string,
    clip: AdapterClip,
    registered: RegisteredClipType,
    format: ClipFormat,
    ctx: JobContext,
    extras: Pick<Variant, "styleCss" | "motionBlur" | "timing" | "tier">,
  ): Promise<void> {
    const { styleCss, motionBlur, timing, tier } = extras;
    ctx.update({ step: "render", progress: 0 });
    const outDir = join(dir, `.tmp-${key}-${randomBytes(4).toString("hex")}`);
    await mkdir(outDir, { recursive: true });
    try {
      let result: Awaited<ReturnType<ClipAdapter["render"]>>;
      const warnings: string[] = [];
      try {
        result = await registered.adapter.render(clip, {
          projectDir: root,
          outDir,
          ...format,
          signal: ctx.signal,
          ensureBinary: (name) => this.#options.ensureBinary(root, name),
          ...elementCssOf(clip),
          ...(styleCss ? { styleCss } : {}),
          ...(motionBlur ? { motionBlur } : {}),
          ...(timing ? { timing } : {}),
          ...(tier ? { tier } : {}),
          warn: (message) => {
            if (typeof message === "string" && message !== "" && !warnings.includes(message)) warnings.push(message);
          },
          progress: ({ fraction }) => {
            if (Number.isFinite(fraction)) ctx.update({ progress: Math.min(0.99, Math.max(0, fraction)) });
          },
        });
      } catch (error) {
        if (motionBlur && (error as { code?: unknown } | null)?.code === MOTION_BLUR_REFUSED) this.#refused.add(entryId(root, key));
        throw error;
      }
      if (typeof result?.file !== "string" || typeof result.hasAlpha !== "boolean") {
        throw new Error(`${registered.plugin.name} returned no { file, hasAlpha } for ${clip.id}`);
      }
      const produced = resolve(outDir, result.file);
      const ext = extname(produced).toLowerCase();
      if (!(await stat(produced).then((info) => info.isFile() && info.size > 0, () => false))) {
        throw new Error(`${registered.plugin.name} reported ${result.file}, but it is missing or empty`);
      }
      // ADR 0002: alpha only survives as VP9 WebM, the one alpha format Chromium's <video> plays.
      if (result.hasAlpha ? ext !== ".webm" : ext !== ".mp4" && ext !== ".webm") {
        throw new Error(
          `${registered.plugin.name} rendered ${ext || "a file without extension"}; ` +
            (result.hasAlpha ? "renders with alpha must be VP9 WebM (.webm)." : "opaque renders must be .mp4 (H.264) or .webm."),
        );
      }
      const probed = await this.#options.probe(root, produced, ctx.signal);
      const file = `${key}${ext}`;
      await moveFile(produced, join(dir, file));
      const meta: EntryMeta = {
        file,
        hasAlpha: result.hasAlpha,
        width: probed.width,
        height: probed.height,
        duration: probed.duration,
        ...(warnings.length > 0 ? { warnings } : {}),
        plugin: registered.plugin.name,
        version: registered.plugin.version,
        type: clip.type,
        source: clip.source ?? null,
        renderedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(join(dir, `${key}.json`), meta);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
}

/** Top-level project entries whose changes never feed a render: daemon state, timelines (refreshed on change), VCS, exports. */
const IGNORED = new Set([".frameshell", ".git", "node_modules", "timelines", "exports"]);

/**
 * True when `final` exists and is queued in the background once its draft is ready (a blurred render, ADR 0041); false
 * for an adapter's own final (ADR 0035), made only when an export waits for it, and for a clip with one render.
 */
function backgroundFinal(final: Variant | null): boolean {
  return final !== null && final.tier !== "final";
}

/**
 * Composition frame of `clip` that a still at timeline `at` draws from a final of that frame alone (ADR 0035), or
 * null when it gets none: its adapter has no windowed finals (`finals.windowed`), its final is blurred (that key ignores the
 * window), or the clip does not show at `at`.
 */
function stillFrame(keyed: Variant & { final: Variant | null }, clip: AdapterClip, at: number, fps: number): number | null {
  if (keyed.final?.tier !== "final" || keyed.final.motionBlur || keyed.registered.adapter.finals?.windowed !== true) return null;
  return generatedFrameAt(clip, at, fps);
}

/** `clip` narrowed to composition frame `frame` alone: what a windowed adapter renders and estimates for a still final. */
function stillClip(clip: AdapterClip, frame: number, fps: number): AdapterClip {
  return { ...clip, in: frame / fps, duration: 1 / fps };
}

/** A render error; `refused`: the adapter refused the motion blur ({@link MOTION_BLUR_REFUSED}). */
type Refusal = Error & { refused?: boolean };

/** A render's state fields before anything is known: nothing rendered, nothing running. */
const UNRENDERED = { key: null, file: null, hasAlpha: null, width: null, height: null, duration: null, job: null, progress: 0, error: null } as const;

/**
 * Files an adapter wrote less than this long before `gc` began are kept: a key check running beside it may have
 * written one that the inputs, gathered earlier, do not name.
 */
const ADAPTER_GC_GRACE_MS = 60_000;

const CLIP_ENTRY = /^([0-9a-f]{32})\.(json|mp4|webm)$/;
const CLIP_TEMP = /^\.tmp-[0-9a-f]{32}-[0-9a-f]+$/;
/** Atomic-write temps of an entry's metadata. */
const META_TEMP = /^[0-9a-f]{32}\.json\..+\.tmp$/;

/** What an entry of {@link CLIP_CACHE_DIR} is, for `gc`: part of entry `key`, a render temp, or null (kept). */
function classifyClipEntry(name: string, isDirectory: boolean): GcClass {
  if (isDirectory) return CLIP_TEMP.test(name) ? { kind: "temp", key: null } : null;
  if (META_TEMP.test(name)) return { kind: "temp", key: null };
  const key = CLIP_ENTRY.exec(name)?.[1];
  return key ? { kind: "clip", key } : null;
}

function entryId(root: string, key: string): string {
  return `${root}\0${key}`;
}

/** Adapter clips on video tracks, in track then time order. */
export function generatedClips(timeline: Timeline): Placed[] {
  const placed: Placed[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (clip.type !== "media" && clip.type !== "timeline") placed.push({ clip: clip as AdapterClip, track: track.id });
    }
  }
  return placed;
}

/** Project-relative files that a nested clip of the timeline files shows, other than the timeline's own file. */
function nestedSources(files: readonly { id: string; timeline: Timeline }[]): Set<string> {
  const sources = new Set<string>();
  for (const { id, timeline } of files) {
    const own = `timelines/${id}.json`;
    for (const track of timeline.tracks) {
      if (track.kind === "subtitles" || track.kind === "program") continue;
      for (const clip of track.clips) {
        if (clip.type !== "timeline" || !("source" in clip) || !clip.source) continue;
        const source = posix.normalize(clip.source.replaceAll("\\", "/"));
        if (source !== own) sources.add(source);
      }
    }
  }
  return sources;
}

/** {@link generatedClips} of `timeline`, each with the timeline it sits in. */
function sited(timeline: Timeline): Sited[] {
  return generatedClips(timeline).map(({ clip }) => ({ clip, timeline }));
}

function renderFailed(timeline: string, clip: AdapterClip, details: string): RpcError {
  return new RpcError(
    ErrorCode.ClipRenderFailed,
    `Could not render ${clip.type} clip ${clip.id} of timeline ${timeline}: ${details} ` +
      "Fix the composition (or install and trust the plugin that renders it), then retry; " +
      `\`frameshell clip remove ${clip.id}\` drops the clip.`,
    { clip: clip.id, type: clip.type, timeline, details },
  );
}

/**
 * Normalized project-relative, `/`-separated path of a live page field;
 * throws OutsideProject for an absolute path or one that leaves the project.
 */
function livePath(value: string, field: "root" | "entry"): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/\/+$/, "") || ".";
  if (posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new RpcError(ErrorCode.OutsideProject, `The adapter's live ${field} ${value} is outside the project.`, { path: value });
  }
  return normalized;
}

/** Rename, or copy when the adapter wrote across devices. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await renameRetrying(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Timeline ids of `root`: `timelines/<id>.json`. */
export async function listTimelineIds(root: string): Promise<string[]> {
  const names = await readdir(join(root, "timelines")).catch(() => [] as string[]);
  return names.flatMap((name) => {
    const id = /^([A-Za-z0-9][A-Za-z0-9_-]*)\.json$/.exec(name)?.[1];
    return id ? [id] : [];
  });
}

/** `{ elementCss }` for a clip with adjustments, else nothing: the context stays as before (ADR 0021). */
function elementCssOf(clip: AdapterClip): { elementCss?: string } {
  const css = elementStyles(clip.elements);
  return css === "" ? {} : { elementCss: css };
}
