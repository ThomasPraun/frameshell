import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ErrorCode, RpcError } from "@frameshell/protocol";

/** Global config file name inside the config dir. */
export const GLOBAL_CONFIG_FILE = "config.json";

/** One voice the `command` speech provider offers: an id, or an id with a label and the languages it speaks. */
const SpeechCommandVoiceSchema = z.union([
  z.string().min(1),
  z.strictObject({ id: z.string().min(1), label: z.string().optional(), languages: z.array(z.string()).optional() }),
]);

/** `speech.command` of the global config (ADR 0034): the TTS program the `command` speech provider runs. */
export const SpeechCommandSchema = z.strictObject({
  /**
   * Program and arguments, run without a shell. `{voice}`, `{language}` and `{out}` inside an element are replaced;
   * the text goes to stdin. Without `{out}` the program writes the WAV to stdout.
   */
  run: z.array(z.string().min(1)).min(1),
  /** Voices the program speaks with. Absent: any voice id is passed through and none is checked. */
  voices: z.array(SpeechCommandVoiceSchema).optional(),
  /** Voice used when neither the call nor the script names one. */
  defaultVoice: z.string().min(1).optional(),
  /** Part of every take's cache key: change it when the program or its model starts to sound different. Default `"1"`. */
  version: z.string().min(1).optional(),
  /** Seconds one line may take before the program is killed. Default 120. */
  timeoutSeconds: z.number().positive().max(3600).optional(),
});

/** Validated `speech.command` entry of the global config. */
export type SpeechCommandConfig = z.output<typeof SpeechCommandSchema>;

const GlobalConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Tool name to `"managed"` or an executable path (relative = against the config dir). */
  binaries: z.record(z.string(), z.string()).optional(),
  /**
   * Machine-level speech providers (ADR 0034). Only here, never in `frameshell.json`: a downloaded project must
   * not be able to make Frameshell run a command.
   */
  speech: z.strictObject({ command: SpeechCommandSchema.optional() }).optional(),
});

/** Content of `<configDir>/config.json`. */
export type GlobalConfig = z.output<typeof GlobalConfigSchema>;

/**
 * Read `<configDir>/config.json`; `{}` when the file does not exist.
 * Throws `InvalidGlobalConfig` when it is not valid JSON or does not match the schema.
 */
export async function readGlobalConfig(configDir: string): Promise<GlobalConfig> {
  const path = join(configDir, GLOBAL_CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const invalid = (details: string) => new RpcError(ErrorCode.InvalidGlobalConfig, `Invalid ${path}:\n${details}`, { path, details });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalid((error as Error).message);
  }
  const parsed = GlobalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(parsed.error.issues.map((i) => `${i.path.map(String).join(".")}: ${i.message}`).join("\n"));
  }
  return parsed.data;
}
