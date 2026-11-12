// `sound.sfx` (ADR 0038): spec → take key → existing file check → synth → marked WAV in assets/sound/ → one asset
// import → credits entry when the project keeps a ledger. Same shape as `voiceover.generate`, minus the provider.
import { join } from "node:path";
import { ErrorCode, RpcError, type SoundSfxResult } from "@frameshell/protocol";
import { SFX_LENGTH_RANGE, type SfxKind } from "@frameshell/schema";
import { writeTextAtomic } from "../fs-util.js";
import type { MediaImportResult } from "../media/service.js";
import { synthesizeSfx } from "./sfx.js";
import { SOUND_DIR, anchorSeconds, readTake, sfxFile, sfxKey, sfxWavBytes } from "./takes.js";

/** Input of {@link generateSfx}: the call's params plus the daemon services it needs. */
export interface SfxRequest {
  /** Project root. */
  root: string;
  kind: SfxKind;
  variant: number;
  seed: number;
  pitch?: number | undefined;
  length?: number | undefined;
  /** Import project files already under `assets/` and queue their ingest. */
  importAssets(files: string[]): Promise<MediaImportResult>;
  /** Record the project-relative take as the project's own work when it keeps `credits.json`; true when the ledger holds it now. */
  credit(file: string): Promise<boolean>;
}

/** Generate (or reuse) one sound effect and import it; see the `sound.sfx` registry entry. */
export async function generateSfx(request: SfxRequest): Promise<SoundSfxResult> {
  const { root, kind, variant, seed } = request;
  const range = SFX_LENGTH_RANGE[kind];
  if (request.length !== undefined) {
    if (!range) throw invalid("length", `A ${kind} has a fixed length: leave \`length\` out (only ${Object.keys(SFX_LENGTH_RANGE).join(" and ")} take one).`);
    if (request.length < range.min || request.length > range.max) throw invalid("length", `A ${kind} is ${range.min} to ${range.max} seconds long, not ${request.length}.`);
  }
  const spec = { kind, variant, seed, pitch: request.pitch, length: request.length };
  const key = sfxKey(spec);
  const file = sfxFile(kind, key);
  const name = file.slice(SOUND_DIR.length + 1);
  const existing = await readTake(join(root, ...SOUND_DIR.split("/")), name);
  if (existing && existing.mark?.key !== key) {
    const found = `${SOUND_DIR}/${existing.name}`;
    throw new RpcError(
      ErrorCode.InvalidOperation,
      existing.mark === null
        ? `${found} was not written by sound sfx (made or edited by hand) and is never overwritten. Move or rename it to generate this sound.`
        : `${found} holds another sound that has the same name. Move or rename it to generate this sound.`,
      { op: "sound.sfx", reason: "not a take of this sound", field: "kind", files: [found], hint: "Rename the file to keep it, then generate again." },
    );
  }

  // Cheap enough to run for a cached take too: the result reports the same numbers either way.
  const render = synthesizeSfx(spec);
  const peakAt = anchorSeconds(render.anchor);
  let imported: SoundSfxResult["imported"] = [];
  if (!existing) {
    const mark = { key, kind, variant, seed, pitch: render.pitch, levelDb: render.levelDb, peakAt };
    const path = join(root, ...file.split("/"));
    await writeTextAtomic(path, sfxWavBytes(render, mark));
    imported = (await request.importAssets([path])).imported.map(({ asset, job }) => ({ asset, job }));
  }
  const credited = await request.credit(file);
  return {
    kind,
    variant,
    seed,
    pitch: render.pitch,
    file,
    state: existing ? "cached" : "generated",
    duration: Math.round((render.channels[0]!.length / render.sampleRate) * 1000) / 1000,
    channels: render.channels.length,
    peakAt: Math.round(peakAt * 1000) / 1000,
    peakDb: Math.round(render.peakDb * 10) / 10,
    rmsDb: Math.round(render.rmsDb * 10) / 10,
    imported,
    credited,
  };
}

function invalid(field: string, message: string): RpcError {
  return new RpcError(ErrorCode.InvalidParams, message, { issues: [{ path: [field], message }] });
}
