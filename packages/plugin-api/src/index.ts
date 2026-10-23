/**
 * Public API for Frameshell plugins (SPEC §8).
 *
 * A plugin is an npm package with `frameshell-plugin.json` at its root whose
 * `main` ES module exports `activate(api)`. The daemon calls `activate` once
 * per trusted project; everything the plugin registers there must match the
 * manifest's `contributes` lists exactly.
 */
import type { ExportPreset, PluginManifest } from "@frameshell/schema";

export type { ExportPreset, PluginManifest };

/**
 * Plugin API major version this Frameshell implements. A manifest whose
 * `apiVersion` differs is rejected at install and load.
 */
export const PLUGIN_API_VERSION = "1";

/** Handle passed to {@link FrameshellPlugin.activate}. Valid only during `activate`. */
export interface PluginApi {
  /** Always {@link PLUGIN_API_VERSION} of the host. */
  readonly apiVersion: string;
  /** This plugin as installed. */
  readonly plugin: { readonly name: string; readonly version: string; readonly dir: string };
  /** Project the plugin is loaded for. */
  readonly project: { readonly dir: string };
  /** Register a CLI command. `name` is the full `<group> <command>` declared in `contributes.commands`. */
  registerCommand(name: string, command: PluginCommand): void;
  /** Register an export preset declared (by `id`) in `contributes.exportPresets`. Validated against the preset schema. */
  registerExportPreset(preset: ExportPreset): void;
  /** Register a clip adapter declared (by `type`) in `contributes.clipTypes`. */
  registerClipType(adapter: ClipAdapter): void;
  /** Register a transcription provider declared (by `id`) in `contributes.transcriptionProviders`. */
  registerTranscriptionProvider(provider: TranscriptionProvider): void;
  /**
   * Ask the host to re-check the render cache keys of the project's
   * generated clips (calling {@link ClipAdapter.inputs} again) and render
   * what changed. The host already does this on project file edits; call it
   * when something it cannot see changed, such as code outside the project
   * that a composition imports. Cheap and coalesced; unlike the rest of this
   * handle, callable at any time after `activate`.
   */
  refreshRenders(): void;
}

/** Entry points a plugin's `main` module exports, directly or as its default export. */
export interface FrameshellPlugin {
  /** Register contributions. May be async; the host awaits it before serving the project. */
  activate(api: PluginApi): void | Promise<void>;
}

/** CLI command run as `frameshell <group> <command> [args…]` inside the daemon. */
export interface PluginCommand {
  /** One line for help listings. */
  readonly description?: string;
  /** Throw to fail the command; the message reaches the user. */
  run(context: CommandContext): CommandResult | Promise<CommandResult>;
}

/** What a command invocation receives. */
export interface CommandContext {
  /** Arguments after `<group> <command>`, verbatim, minus the CLI's own `--json` and `--trust`. */
  readonly args: readonly string[];
  /** Absolute directory the user ran the command from. */
  readonly cwd: string;
  readonly project: { readonly dir: string };
}

/**
 * Command outcome. A string is human output. `data` must be JSON-serializable:
 * it is what `--json` prints.
 */
export type CommandResult = string | void | { output?: string; data?: unknown };

/**
 * Clip adapter contract (SPEC §8.2). The host renders adapter clips in the
 * background into its clip render cache (SPEC §6.5), keyed by plugin name and
 * version, the clip's `source` and `props`, the content of {@link inputs} and
 * the project format. Preview plays the cached file; export overlays it.
 */
export interface ClipAdapter {
  /** Clip `type` in timeline files: lowercase, not `media`, `timeline` or `shot` (`CORE_CLIP_TYPES`, `ADAPTER_CLIP_TYPE_PATTERN` in `@frameshell/schema`). */
  readonly type: string;
  /**
   * Schema of the clip's `props`, checked on `clip.add` and `clip.set`.
   * Any Standard Schema v1 validator works (Zod 4 schemas are one).
   * Absent: any props are accepted.
   */
  readonly propsSchema?: PropsSchema;
  /**
   * Project-relative, `/`-separated files whose content feeds the render
   * cache key: editing one re-renders the clip. A missing file counts too
   * (creating it re-renders). Absent: only `source` and `props` count.
   */
  inputs?(clip: unknown): string[] | Promise<string[]>;
  /**
   * Render one clip (the timeline clip object, `props` validated) into a
   * file under `context.outDir`; the host moves it into the cache. File time
   * t must show composition time t: the clip plays it from its `in`, for its
   * `duration`, so moving or trimming a clip never re-renders.
   * `hasAlpha: true` requires VP9 WebM with `alpha_mode=1` (ADR 0002);
   * opaque renders may be H.264 `.mp4`. Throw to fail; the message reaches the user.
   */
  render(clip: unknown, context: RenderContext): Promise<{ file: string; hasAlpha: boolean }>;
  /**
   * Optional. A page that plays the clip's composition at any time, which the
   * app's preview shows (muted, in a sandboxed iframe) while the clip's render
   * is not ready (ADR 0010). The cached render stays the reference: the
   * preview switches to it once ready. Throw when the clip cannot be shown
   * live; the message reaches the user and the preview keeps its slate.
   */
  livePreview?(clip: unknown, context: LiveContext): Promise<LivePage>;
  /**
   * Optional. `true` when `render` applies {@link RenderContext.elementCss}
   * (ADR 0021). The host refuses `elements` on clips of an adapter without it,
   * so the preview never shows what the render ignores.
   */
  readonly elementStyles?: boolean;
}

/** What {@link ClipAdapter.livePreview} receives: the project facts of {@link RenderContext}, without output or progress. */
export interface LiveContext {
  readonly projectDir: string;
  /** Project frame rate. */
  readonly fps: number;
  /** Project resolution: the page is shown at this size and placed like the render. */
  readonly width: number;
  readonly height: number;
  /** See {@link RenderContext.ensureBinary}. */
  ensureBinary(name: string): Promise<string>;
  /** See {@link RenderContext.elementCss}. */
  readonly elementCss?: string;
}

/**
 * A live page (ADR 0010). The app serves only files under {@link root}, so
 * everything the page loads by relative URL must live there.
 */
export interface LivePage {
  /** Project-relative, `/`-separated directory served to the page. */
  root: string;
  /** Project-relative, `/`-separated HTML file inside {@link root}: the page loaded first. */
  entry: string;
  /**
   * Script the app inserts at the start of the entry's `<head>` on every
   * load; never written to disk. It must define
   * `window.frameshellLive = { ready: Promise<void>, seek(seconds): void | Promise<void> }`,
   * where `seek` shows composition time `seconds` (as file time `seconds` of
   * a render), muted. It may also define `describe(element)`, returning a
   * JSON-safe object of facts the app cannot read from the DOM (ADR 0011):
   * the file the element comes from as `source` (project-relative), the
   * components rendering it as `components` (outermost first). The Pick
   * tool and `inspect` put them under the element's `adapter`.
   */
  head: string;
}

/**
 * Standard Schema v1 validator (https://standardschema.dev), the subset the
 * host calls. Declared here so the plugin API depends on no schema library.
 */
export interface PropsSchema {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): PropsValidation | Promise<PropsValidation>;
  };
}

/** Outcome of {@link PropsSchema} validation: `issues` present = invalid. */
export type PropsValidation =
  | { readonly value: unknown; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

/** Project facts and host services for one render. Valid only until `render` settles. */
export interface RenderContext {
  readonly projectDir: string;
  /** Empty directory for the output and any scratch files; removed after the render. */
  readonly outDir: string;
  /** Project frame rate. */
  readonly fps: number;
  /** Project resolution: a render of this size maps 1:1 onto the frame. */
  readonly width: number;
  readonly height: number;
  /** Aborted when the daemon stops: stop work and reject. */
  readonly signal: AbortSignal;
  /**
   * Absolute path of a native tool the host manages (SPEC §9), e.g. `ffmpeg`,
   * `ffprobe`, `chrome-headless-shell`: the user's `binaries` override, or the
   * pinned build, installed first when missing. Rejects for unknown tools.
   */
  ensureBinary(name: string): Promise<string>;
  /** Report progress to the app and CLI (the job's `progress`). Cheap; call freely. */
  progress(update: RenderProgress): void;
  /**
   * Style sheet made by the host from the clip's `elements` (moves and scales by
   * CSS selector, ADR 0021); absent when the clip has none. An adapter that sets
   * {@link ClipAdapter.elementStyles} inserts it last in the page's `<head>`,
   * after the composition's own styles.
   */
  readonly elementCss?: string;
}

/** One render progress report. */
export interface RenderProgress {
  /** 0..1 of the whole render. */
  fraction: number;
  /** Human line, e.g. `Capturing frames`. */
  message?: string;
}

/**
 * Transcription provider contract (SPEC §8.2). The host extracts the audio,
 * assigns word ids, hashes the asset and writes the transcript file; the
 * provider only turns audio into timed words.
 */
export interface TranscriptionProvider {
  /** Name used by `frameshell transcribe --provider` and `transcription.provider` in `frameshell.json`. */
  readonly id: string;
  /**
   * Transcribe `audio`: a 16 kHz mono 16-bit PCM WAV the host extracted from
   * the asset (from its PCM sidecar when ingested). Seconds in this file are
   * source-asset seconds. Throw to fail; the message reaches the user.
   */
  transcribe(audio: string, options: TranscribeOptions, context: TranscribeContext): Promise<TranscriptionResult>;
}

/** What the user asked for, plus host context; all optional, the provider picks defaults. */
export interface TranscribeOptions {
  /** BCP-47-ish language code (`es`, `en`); absent = provider default or auto-detect. */
  language?: string;
  /** Provider-specific model id; absent = provider default. */
  model?: string;
  /**
   * Text spoken right before the audio, set by the host when it re-transcribes
   * a window of a longer recording. Decoding context only: it carries case and
   * punctuation into the window, and is never part of the result. Providers
   * without such a feature ignore it.
   */
  prompt?: string;
}

/** Host services for one transcription. Valid only until `transcribe` settles. */
export interface TranscribeContext {
  /**
   * Absolute path of a native tool the host manages (SPEC §9), e.g.
   * `whisper-cli`: the user's `binaries` override, or the pinned build,
   * installed first when missing. Rejects for tools the host does not know.
   */
  ensureBinary(name: string): Promise<string>;
  /** Absolute path of a model file the host manages by id, downloaded and checksum-verified first when missing. */
  ensureModel(id: string): Promise<string>;
  /** Report progress to whoever waits (CLI stderr, app). Cheap; call freely. */
  progress(update: TranscriptionProgress): void;
}

/** One progress report. */
export interface TranscriptionProgress {
  /** Human line, e.g. `Transcribing`. */
  message: string;
  /** 0..1 of the current step when known. */
  fraction?: number;
  /** Stable code of the step (`model-load`, `transcribe`…) for apps that translate `message`; unknown codes fall back to it. */
  stage?: string;
  /** Facts `message` is built from (`device`, `seconds`…), for the app's own wording of `stage`. */
  values?: Record<string, string | number>;
}

/** What a provider returns. */
export interface TranscriptionResult {
  /** Model actually used; written to the transcript. */
  model: string;
  /** Language actually used or detected. */
  language?: string;
  /** In time order. */
  words: TranscriptWord[];
  /** Compute device used, e.g. `metal`, `cuda`, `cpu`; for reports only. */
  device?: string;
}

/** One word in core transcript format (SPEC §5.4), before the host assigns its id. */
export interface TranscriptWord {
  text: string;
  /** Onset, source seconds. */
  start: number;
  /** End, source seconds; >= start. */
  end: number;
  /** 0..1 */
  confidence?: number;
}

/** Identity helper that type-checks a plugin definition. */
export function definePlugin(plugin: FrameshellPlugin): FrameshellPlugin {
  return plugin;
}
