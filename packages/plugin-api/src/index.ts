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
  /** Register a speech provider declared (by `id`) in `contributes.speechProviders` (ADR 0034). */
  registerSpeechProvider(provider: SpeechProvider): void;
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
 * it is what `--json` prints. `failed: true` reports a command that ran to
 * completion but found a problem (a linter with errors): the CLI exits 1 and
 * still prints `output` and `data`. Throw instead when the command could not run.
 */
export type CommandResult = string | void | { output?: string; data?: unknown; failed?: boolean };

/**
 * Clip adapter contract (SPEC §8.2). The host renders adapter clips in the
 * background into its clip render cache (SPEC §6.5), keyed by plugin name and
 * version, the clip's `source` and `props`, the content of {@link inputs},
 * the project format and the timing the clip asks for ({@link timing}).
 * Preview plays the cached file; export overlays it.
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
   * `context` (additive, ADR 0035) lets the adapter ask a tool that decides
   * the key, such as the version of the user's Blender, without rendering.
   */
  inputs?(clip: unknown, context?: InputsContext): string[] | Promise<string[]>;
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
  /**
   * Optional. `true` when `render` applies {@link RenderContext.styleCss} (ADR 0028). Only then does the
   * host make the sheet and count it in the clip's render key, so other adapters' renders never re-run on a
   * style edit.
   */
  readonly styleTokens?: boolean;
  /**
   * Optional. `true` when `render` applies {@link RenderContext.motionBlur} (ADR 0041). Only then does the host pass
   * a clip's `motionBlur` and count it in the render key; clips of other adapters render sharp and `clip.set` warns.
   */
  readonly motionBlur?: boolean;
  /**
   * Optional. The adapter renders an expensive final next to a fast draft (ADR 0035, ADR 0041 decision 11): the host
   * keeps two cache entries per clip and says which one it wants in {@link RenderContext.tier}. The draft plays in the
   * preview and in draft exports; final and untiered exports wait for the final, which is never rendered in the
   * background. Final exports whose missing finals are estimated over 5 minutes in all need the person's confirmation.
   */
  readonly finals?: FinalRenders;
  /**
   * Optional. Which of the timeline's timing this clip's render reads (ADR 0029 decision 8): `beats` (the beat grid,
   * with bar starts), `markers` and `words` (the transcript words the timeline plays). Only the kinds returned reach {@link RenderContext.timing} and count in the clip's
   * render key, so a clip that asks for none never re-renders when the music or a marker moves. Called on every key
   * check, like {@link inputs}, with the same `context`. Absent or empty: none. When it throws, or returns something
   * other than an array, the clip has no render key: it is unavailable (preview and export say why) until it answers.
   */
  timing?(clip: unknown, context?: InputsContext): readonly RenderTimingKind[] | Promise<readonly RenderTimingKind[]>;
  /**
   * Optional. The names of the top-level props the clip's composition declares (typed template variables), when it
   * declares any. A batch (ADR 0040) refuses a props slot naming another one, so a misspelt `titel` fails the row
   * instead of rendering the default. Return `null` (or an empty list) when the composition declares none: any prop
   * goes then. A throw counts as `null`.
   */
  declaredProps?(clip: unknown): readonly string[] | null | Promise<readonly string[] | null>;
  /**
   * Optional (ADR 0035 slice 5). Clean up what the adapter keeps in the project outside the render cache, which the
   * host's `gc` does not know: marker files that feed {@link inputs}, listings, probes. The host calls it from `gc`
   * (also a dry run) once it has keyed every generated clip of every timeline of the project, at every format size.
   * It is called once per clip type the adapter is registered for, never in one call for all of them, with the paths
   * {@link inputs} returned for the clips of that type only. It is called even when no clip of that type is left
   * (`inputs` is then empty and all its files are unused), but never when the project has no generated clip at all
   * (plugins are not even loaded), nor when a clip's key is unknown (invalid timeline, plugin missing or untrusted,
   * adapter error), nor while a render or export job of the project runs; `gc` reports why it was skipped in the last two
   * cases. Delete only
   * entries the adapter itself made, recognised by name, that are not in {@link AdapterGcContext.inputs} and are older
   * than {@link AdapterGcContext.keepNewerThan}; return what was deleted (or, with `dryRun`, what would be). Throwing
   * leaves the rest as it is, the other adapters still run, and `gc` reports why.
   */
  gc?(context: AdapterGcContext): Promise<readonly AdapterGcEntry[]>;
}

/** What {@link ClipAdapter.gc} receives. */
export interface AdapterGcContext {
  readonly projectDir: string;
  /**
   * Union of the project-relative, `/`-separated paths {@link ClipAdapter.inputs} returned for every current clip of
   * the one clip `type` this call is for (not the adapter's other types), in every timeline, nested ones included, and
   * at every format size. Anything named here is in use.
   */
  readonly inputs: ReadonlySet<string>;
  /** Only report what would be deleted. */
  readonly dryRun: boolean;
  /**
   * Milliseconds since the epoch, a minute before `gc` began: entries modified at or after it are kept, so a file a
   * key check writes while `gc` runs is never lost. Files in use are protected by {@link inputs}, not by age.
   */
  readonly keepNewerThan: number;
  /** Aborted when the host stops. */
  readonly signal: AbortSignal;
}

/** One file or folder {@link ClipAdapter.gc} deleted. */
export interface AdapterGcEntry {
  /** Project-relative, `/`-separated; a folder ends with `/`. */
  readonly path: string;
  /** Size on disk; a folder counts its files. */
  readonly bytes: number;
}

/** How an adapter with {@link ClipAdapter.finals} sizes a final render before anyone waits for it. */
export interface FinalRenders {
  /**
   * Seconds the final render of `clip` (props validated) would take on this machine, from start to file, at the
   * context's size and frame rate. A rough figure is fine: it only decides whether to ask the person first.
   * Throwing counts as an unknown time, which is asked about too.
   */
  estimate(clip: unknown, context: EstimateContext): number | Promise<number>;
  /**
   * Optional. True when {@link ClipAdapter.render} draws only the clip's part `[in, in + duration)` of its composition,
   * with the frames before `in` transparent (file time t is still composition time t), and {@link ClipAdapter.inputs}
   * names that part, so a narrower clip keys apart. The host then makes a final of one frame for a still (`frame` and
   * `clip.compare` with `final`, ADR 0035 slice 7): it hands `render` (with `tier` "final") and {@link estimate} a copy of
   * the clip narrowed to that frame, `in` = frame / fps and `duration` = 1 / fps. Absent: stills of the clip use its
   * whole final when cached, else its draft. Hosts older than this never ask for one.
   */
  readonly windowed?: boolean | undefined;
}

/** Project facts for {@link FinalRenders.estimate}: what the final would be rendered for. */
export interface EstimateContext {
  readonly projectDir: string;
  /** Project frame rate. */
  readonly fps: number;
  /** Frame size of the render: the project resolution, or a format of the project (ADR 0027). */
  readonly width: number;
  readonly height: number;
}

/** Which render of a clip with {@link ClipAdapter.finals} is being made: the fast draft or the expensive final. */
export type RenderTier = "draft" | "final";

/** What a clip can ask of the timeline's timing through {@link ClipAdapter.timing}. */
export type RenderTimingKind = "beats" | "markers" | "words";

/** Every {@link RenderTimingKind}, in the order the timing lists them; the host and the official adapters read their kinds from it. */
export const RENDER_TIMING_KINDS: readonly RenderTimingKind[] = ["beats", "markers", "words"];

/**
 * The timeline's timing inside one clip (ADR 0029 decision 8), in composition seconds (file time of the render: the
 * clip shows composition second `in + t` at `t` seconds after its start). Only what falls inside the clip's part of
 * the timeline is listed, so moving or trimming the clip, or moving the music, changes it and re-renders the clip.
 */
export interface RenderTiming {
  /**
   * Beats of the timeline's grid (`tempo`) inside the clip, ascending; present when the clip asked for `beats`. Empty
   * when the timeline has no usable grid; {@link beatsProblem} says why.
   */
  readonly beats?: readonly RenderBeat[];
  /** Tempo of the grid on the timeline clock (a sped-up music clip is faster); absent when there is no usable grid. */
  readonly tempo?: { readonly bpm: number; readonly meter: number };
  /** Why {@link beats} is empty although asked, as a stable code (part of the render key); absent when it is not. */
  readonly beatsProblem?: RenderBeatsProblem;
  /** Markers of the timeline inside the clip, ascending; present when the clip asked for `markers`. */
  readonly markers?: readonly RenderMarker[];
  /**
   * Transcript words the timeline plays that start inside the clip, ascending; present when the clip asked for
   * `words`. Empty when the timeline's words cannot be read; {@link wordsProblem} says why.
   */
  readonly words?: readonly RenderWord[];
  /** Why {@link words} is empty although asked, as a stable code (part of the render key); absent when it is not. */
  readonly wordsProblem?: RenderWordsProblem;
}

/**
 * Why a clip that asked for `beats` got none ({@link RenderTiming.beatsProblem}): the same grids `--snap-to` refuses.
 * A code, not a sentence, so its render key only changes when the reason does; {@link RENDER_BEATS_PROBLEMS} words it.
 */
export type RenderBeatsProblem = "no-tempo" | "no-music-clip" | "no-beats" | "broken-beats" | "low-confidence";

/** One sentence per {@link RenderBeatsProblem}, for an adapter or composition that shows why a clip has no beats. */
export const RENDER_BEATS_PROBLEMS: Readonly<Record<RenderBeatsProblem, string>> = {
  "no-tempo": "The timeline has no tempo: set one with `frameshell tempo set`.",
  "no-music-clip": "The tempo follows a clip that is not a media clip of the timeline.",
  "no-beats": "The music clip has no beat grid yet: run `frameshell beats measure` on its asset.",
  "broken-beats": "The music's beats file cannot be read or is not valid.",
  "low-confidence": "The music's beat grid is LOW confidence: check it with `frameshell beats show`, then correct or confirm it.",
};

/**
 * Why a clip that asked for `words` got none ({@link RenderTiming.wordsProblem}), as `word:` time references refuse:
 * a heard clip's transcript is older than its file, or the timeline plays no transcribed word. A code, as
 * {@link RenderBeatsProblem}; {@link RENDER_WORDS_PROBLEMS} words it.
 */
export type RenderWordsProblem = "no-transcript" | "stale-transcript";

/** One sentence per {@link RenderWordsProblem}, for an adapter or composition that shows why a clip has no words. */
export const RENDER_WORDS_PROBLEMS: Readonly<Record<RenderWordsProblem, string>> = {
  "no-transcript": "The timeline plays no transcribed word: run `frameshell transcribe` on the footage.",
  "stale-transcript": "A transcript on the timeline is older than its file: run `frameshell transcribe` on that asset again.",
};

/** One beat of {@link RenderTiming.beats}. */
export interface RenderBeat {
  /** Composition seconds. */
  readonly at: number;
  /** Its number as `beat:N` names it: counted from 1 at the music file's first beat, not the clip's. */
  readonly beat: number;
  /** When the beat starts a bar, the bar's number as `bar:N` names it; absent otherwise. */
  readonly bar?: number;
}

/** One marker of {@link RenderTiming.markers}. */
export interface RenderMarker {
  /** Composition seconds. */
  readonly at: number;
  readonly id: string;
  readonly label: string;
  /** `red`, `orange`, `yellow`, `green`, `blue` or `purple`; absent: the app's accent. */
  readonly color?: string;
}

/** One word of {@link RenderTiming.words}: a transcript word as the timeline plays it. */
export interface RenderWord {
  /** Composition seconds the word starts. */
  readonly at: number;
  /** Composition seconds the word ends (the clip that plays it may cut it short). */
  readonly end: number;
  /** As the person corrected it in the transcript, else as transcribed. */
  readonly text: string;
  /** Transcript word id (`w_000012`), as `word:w_000012` names it. */
  readonly id: string;
}

/**
 * What {@link ClipAdapter.inputs} receives next to the clip. Absent on hosts older than this addition: an adapter
 * that needs it fails with a message asking for a newer Frameshell.
 */
export interface InputsContext {
  readonly projectDir: string;
  /** See {@link RenderContext.ensureBinary}. Called on every key check, so ask only for tools whose answer is cheap. */
  ensureBinary(name: string): Promise<string>;
  /**
   * Aborted when the host stops (the daemon shuts down). A key check that starts a process of its own, as listing a
   * `.blend`'s files does, passes it on and kills the process, so none outlives the host. A host older than this
   * addition passes none: an adapter that reads it copes with `undefined`.
   */
  readonly signal?: AbortSignal | undefined;
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
  /** See {@link RenderContext.timing}: the page shows what the render will, so it gets the same timing. */
  readonly timing?: RenderTiming;
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
  /**
   * Frame size rendered: the project resolution, or a format of the project (ADR 0027).
   * A render of this size maps 1:1 onto the frame.
   */
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
   * Say something about this render that the person should know (a setting the adapter changed to render it, say).
   * The host keeps it with the cached render, so it is shown whenever that render is used: on export jobs, `frame`
   * and `review`. One short sentence naming the clip. Absent on hosts older than this addition: ignore it then.
   */
  warn?(message: string): void;
  /**
   * Style sheet made by the host from the clip's `elements` (moves and scales by
   * CSS selector, ADR 0021); absent when the clip has none. An adapter that sets
   * {@link ClipAdapter.elementStyles} inserts it last in the page's `<head>`,
   * after the composition's own styles.
   */
  readonly elementCss?: string;
  /**
   * The project style's tokens (ADR 0028) as a style sheet: `:root` custom properties (`--fs-color-accent`,
   * `--fs-font-display`, `--fs-motion-quick`, ...) and an `@font-face` with inline data per project font file.
   * Absent when the project has no `style.json` or the adapter does not set {@link ClipAdapter.styleTokens}. An
   * adapter inserts it first in the page's `<head>`, so a composition that sets a variable itself keeps its value.
   */
  readonly styleCss?: string;
  /**
   * The clip's motion blur (ADR 0041), defaults filled in; absent when the clip has none or the adapter does not set
   * {@link ClipAdapter.motionBlur}. Each output frame is the average of `samples` pictures at sub-frame times spread
   * evenly across a window of `shutter` degrees of one frame, centred on the frame time. An adapter that cannot blur
   * this clip throws an error whose `code` is {@link MOTION_BLUR_REFUSED}: the host then uses the clip's sharp render,
   * with a warning, where the blurred one was asked for.
   */
  readonly motionBlur?: RenderMotionBlur;
  /**
   * The render asked for, for an adapter with {@link ClipAdapter.finals}: `draft` (fast, for the preview and draft
   * exports) or `final` (the delivery); absent for other adapters. The two have separate cache entries.
   */
  readonly tier?: RenderTier;
  /**
   * The timeline's beats, markers and words inside the clip, of the kinds {@link ClipAdapter.timing} asked for (ADR 0029
   * decision 8); absent when it asked for none. Part of the render key.
   */
  readonly timing?: RenderTiming;
}

/**
 * `code` of the error a render throws when it cannot apply {@link RenderContext.motionBlur} to this clip (HyperFrames:
 * HDR content, shader transitions). Any other error fails the blurred render as usual.
 */
export const MOTION_BLUR_REFUSED = "MOTION_BLUR_REFUSED";

/** Motion blur settings of one render; see {@link RenderContext.motionBlur}. */
export interface RenderMotionBlur {
  /** Shutter angle, degrees of one frame (1 to 360), centred on the frame time. */
  readonly shutter: number;
  /** Sub-frame pictures averaged into each frame (1 to 64). */
  readonly samples: number;
  /** Averaging space: `linear` light, or `srgb` values. */
  readonly blend: "linear" | "srgb";
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
   * Models this provider ships (pinned and verified by the host), for model pickers and `frameshell model list`.
   * Models users register themselves are not listed here: the host knows them.
   */
  readonly models?: readonly ProviderModel[];
  /** Model used when neither the call, the project nor the machine names one. */
  readonly defaultModel?: string;
  /** How the provider reads model files users register (see {@link TranscribeContext.userModel}); absent: it reads none. */
  readonly userModels?: UserModelSupport;
  /**
   * Set to `true` by a provider that never charges and has no {@link estimate}. Without `estimate` and without
   * `free: true` the cost is unknown, which counts as paid: `transcribe` refuses until the person confirms (CLI
   * `--yes`), and checks that transcribe in the background (shoot takes, voiceover checks, `transcribe --verify`,
   * `analyze`) never use the provider. Ignored when `estimate` exists (ADR 0046).
   */
  readonly free?: boolean;
  /**
   * `true` when the audio leaves this machine (a cloud service). `transcribe` then asks the person first even at no
   * cost, and the background checks never use the provider.
   */
  readonly remote?: boolean;
  /**
   * Optional. What transcribing `audio` with `options` would cost. A total above 0 makes the provider paid: the
   * host refuses to transcribe until the person confirms the cost, also when an agent asks. Throw when the cost
   * cannot be known (a model with no price): the run then fails before any audio is sent.
   */
  estimate?(audio: TranscriptionAudio, options: TranscribeOptions): TranscriptionEstimate | Promise<TranscriptionEstimate>;
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

/** The audio a {@link TranscriptionProvider.estimate} prices. */
export interface TranscriptionAudio {
  /** Length of the WAV `transcribe` would get, in seconds. */
  seconds: number;
}

/** Cost of one transcription, from {@link TranscriptionProvider.estimate}. */
export interface TranscriptionEstimate {
  /** Amount in {@link currency}; 0 = free. */
  cost: number;
  /** ISO 4217 code, e.g. `USD`. */
  currency: string;
  /** Minutes the provider bills, when it bills by time. */
  minutes?: number;
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
  /**
   * A model file the user registered on this machine under `id` (`frameshell model add <id> <file>`), not
   * verified by the host: registering it was the user's consent. Rejects with a message naming the id and how to
   * register it when it is not registered, when its file is gone, or when its format is not in `formats`. A file
   * that changed since it was registered is used anyway; the host warns and records its new hash.
   * Absent on hosts older than this API addition: treat every non-pinned id as unknown then.
   */
  userModel?(id: string, formats: readonly ModelFormat[]): Promise<UserModel>;
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

/**
 * File format of a user model. Only formats that hold data and cannot run code are accepted: whisper.cpp `ggml`,
 * `gguf` and `onnx`. Pickle-based files (`.nemo`, `.pt`, `.ckpt`) are refused at registration.
 */
export type ModelFormat = "ggml" | "gguf" | "onnx";

/** A model the provider ships, as listed in {@link TranscriptionProvider.models}. */
export interface ProviderModel {
  /** Id for `--model` and `transcription.model`, e.g. `large-v3-turbo-q5_0`. */
  id: string;
  /** Host-managed model file behind it (see {@link TranscribeContext.ensureModel}), for its size and download state. */
  managedModel?: string;
}

/** What a provider accepts as a registered model, for model pickers. */
export interface UserModelSupport {
  /** Formats it reads. */
  formats: readonly ModelFormat[];
  /** Settings a registration may carry, each with the values it takes (whisper.cpp: `dtw` and its presets). */
  options?: readonly { key: string; values: readonly string[] }[];
}

/** A model file the user registered on this machine; see {@link TranscribeContext.userModel}. */
export interface UserModel {
  id: string;
  /** Absolute path of the file. */
  path: string;
  format: ModelFormat;
  /** Lowercase hex SHA-256 of the file as it is now. */
  sha256: string;
  /** True when the file's bytes differ from the ones registered. */
  changed: boolean;
  /** Provider settings stored with the registration (`--dtw large.v3` → `{ dtw: "large.v3" }`). */
  options: Readonly<Record<string, string>>;
}

/** What a provider returns. */
export interface TranscriptionResult {
  /** Model actually used; written to the transcript. */
  model: string;
  /**
   * What the user should know about this result, one sentence each, e.g. that word timing is coarser without
   * alignment data for a custom model. Reported back with the transcription; not written to the transcript.
   */
  notes?: string[];
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

/**
 * Speech provider contract (ADR 0034): text to one spoken take. The transcription contract turned around:
 * the host parses the voiceover script, spells out numbers, caches each take by its text, provider, voice
 * and options, trims silence, writes the file under `assets/voiceover/` and imports it; the provider only
 * turns one line of text into a WAV.
 */
export interface SpeechProvider {
  /** Name used by `frameshell voiceover generate --provider` and `provider` in a voiceover script's frontmatter. */
  readonly id: string;
  /**
   * Version of the voice output: part of every take's cache key, so a change that makes the same text sound
   * different (a new model, a new engine build) regenerates takes. Absent: `"1"`.
   */
  readonly version?: string;
  /** Voice used when neither the call nor the script names one. Absent: the call must name one. */
  readonly defaultVoice?: string;
  /** Voices this provider speaks with, for pickers and to check a requested voice before anything is generated. */
  voices(): readonly SpeechVoice[] | Promise<readonly SpeechVoice[]>;
  /**
   * Set to `true` by a provider that never charges (a local engine) and has no {@link estimate}. Without
   * `estimate` and without `free: true` the cost is unknown, which counts as paid: the host refuses to generate
   * until the person confirms (CLI `--yes`, app dialog). Ignored when `estimate` exists.
   */
  readonly free?: boolean;
  /**
   * Optional. What saying `text` would cost. A total above 0 makes the provider paid: the host refuses to
   * generate until the person confirms the cost (CLI `--yes`, app dialog), also when an agent asks. A provider
   * with neither `estimate` nor `free: true` is paid at an unknown cost.
   */
  estimate?(text: string, voice: string, options: SpeechOptions): SpeechEstimate | Promise<SpeechEstimate>;
  /**
   * Say `text` with `voice` into a mono 16-bit PCM WAV (any sample rate) under `context.outDir` and return
   * its path. `text` is already the spoken form: numbers spelled out, respellings applied. Leading and
   * trailing silence may be left in; the host trims it. Throw to fail; the message reaches the user.
   */
  synthesize(text: string, voice: string, options: SpeechOptions, context: SpeechContext): Promise<SpeechResult>;
}

/** One voice of a {@link SpeechProvider}. */
export interface SpeechVoice {
  /** Id for `--voice` and `voice` in the frontmatter, e.g. `ef_dora`. */
  id: string;
  /** Human name, e.g. `Dora (Spanish, female)`. */
  label?: string;
  /** BCP-47-ish codes the voice speaks (`es`, `en-US`); absent = not stated. */
  languages?: readonly string[];
}

/** What the script asked for besides the text and the voice; part of every take's cache key. */
export interface SpeechOptions {
  /** BCP-47-ish language code of the text (`es`, `en`), from the script's `language`; absent = provider default. */
  language?: string;
}

/** Cost of saying one text, from {@link SpeechProvider.estimate}. */
export interface SpeechEstimate {
  /** Amount in {@link currency}; 0 = free. */
  cost: number;
  /** ISO 4217 code, e.g. `USD`. */
  currency: string;
  /** Characters the provider bills, when it bills by character. */
  characters?: number;
}

/** Host services for one {@link SpeechProvider.synthesize} call. Valid only until it settles. */
export interface SpeechContext {
  /** Empty directory for the WAV and any scratch files; removed after the host has read the WAV. */
  readonly outDir: string;
  /** Aborted when the daemon stops: stop work and reject. */
  readonly signal: AbortSignal;
  /** See {@link RenderContext.ensureBinary}. */
  ensureBinary(name: string): Promise<string>;
  /** Report progress to whoever waits (CLI stderr, app). Cheap; call freely. */
  progress(update: SpeechProgress): void;
}

/** One progress report of a {@link SpeechProvider.synthesize} call. */
export interface SpeechProgress {
  /** Human line, e.g. `Loading voice`. */
  message: string;
  /** 0..1 of this line when known. */
  fraction?: number;
}

/** What {@link SpeechProvider.synthesize} returns. */
export interface SpeechResult {
  /** Absolute path of the WAV, inside {@link SpeechContext.outDir}. */
  file: string;
  /** Model actually used, for the result; absent when the provider has none. */
  model?: string;
  /** What the user should know about this take, one sentence each. Reported back; not written to the take. */
  notes?: string[];
}

/** Identity helper that type-checks a plugin definition. */
export function definePlugin(plugin: FrameshellPlugin): FrameshellPlugin {
  return plugin;
}
