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

/** Clip adapter contract (SPEC §8.2). Rendering is wired by the export pipeline, not by v0.1 of the host. */
export interface ClipAdapter {
  /** Clip `type` in timeline files. */
  readonly type: string;
  /** Project-relative files whose content feeds the render cache key. */
  inputs?(clip: unknown): string[] | Promise<string[]>;
  /** Render one clip. `hasAlpha: true` requires VP9 WebM with `alpha_mode=1`. */
  render(clip: unknown, context: RenderContext): Promise<{ file: string; hasAlpha: boolean }>;
}

/** Project facts an adapter needs to render. */
export interface RenderContext {
  readonly projectDir: string;
  /** Directory the adapter may write its output into. */
  readonly outDir: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
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

/** What the user asked for; both optional, the provider picks defaults. */
export interface TranscribeOptions {
  /** BCP-47-ish language code (`es`, `en`); absent = provider default or auto-detect. */
  language?: string;
  /** Provider-specific model id; absent = provider default. */
  model?: string;
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
