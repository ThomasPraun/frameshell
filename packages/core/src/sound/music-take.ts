// A music take of `sound.music` (ADR 0038): spec → take key → existing file check → render in a worker → marked WAV in
// assets/sound/ → one asset import → its exact beat grid in beats/ → credits entry when the project keeps a ledger.
// Same shape as `generateSfx`; the beat grid is what a generated track adds.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ErrorCode, RpcError, type SoundMusicResult } from "@frameshell/protocol";
import { BEATS_SCHEMA_URL, type BeatsFile, EXACT_DETECTOR, SCHEMA_VERSION } from "@frameshell/schema";
import { writeTextAtomic } from "../fs-util.js";
import { formatBeatsFile, resolveBeatsFile } from "../media/beats-store.js";
import type { MediaImportResult } from "../media/service.js";
import { runWorkerTask } from "../worker-task.js";
import { type MusicGrid, type MusicRender, type MusicSpec, musicGrid } from "./music.js";
import { type MusicMark, SOUND_DIR, musicFile, musicKey, musicMarkOf, musicWavBytes, readTake } from "./takes.js";

/**
 * Worker script beside this module. Under the test runner this module is the TypeScript source, so the worker runs
 * from the build (`pnpm test` builds first).
 */
const MUSIC_WORKER = import.meta.url.endsWith(".ts") ? new URL("../../dist/sound/music-worker.js", import.meta.url) : new URL("./music-worker.js", import.meta.url);

/** Input of {@link generateMusic}. */
export interface MusicTakeRequest {
  /** Project root. */
  root: string;
  spec: MusicSpec;
  /** Import project files already under `assets/` and queue their ingest. */
  importAssets(files: string[]): Promise<MediaImportResult>;
  /** Record the project-relative take as the project's own work when it keeps `credits.json`; true when the ledger holds it now. */
  credit(file: string): Promise<boolean>;
  /** Render a spec; default: {@link synthesizeMusic} in a worker thread. */
  render?: ((spec: MusicSpec) => Promise<MusicRender>) | undefined;
}

/** A music take on disk with its grid. */
export interface MusicTake {
  file: string;
  state: "generated" | "cached";
  mark: MusicMark;
  grid: MusicGrid;
  beats: SoundMusicResult["beats"];
  imported: SoundMusicResult["imported"];
  credited: boolean;
}

/** Make (or find) the take of `spec`, write its beat grid when it is missing or stale, and credit it. */
export async function generateMusic(request: MusicTakeRequest): Promise<MusicTake> {
  const { root, spec } = request;
  const key = musicKey(spec);
  const file = musicFile(spec.preset, key);
  const name = file.slice(SOUND_DIR.length + 1);
  const existing = await readTake(join(root, ...SOUND_DIR.split("/")), name);
  const existingMark = existing ? musicMarkOf(existing.bytes) : null;
  if (existing && existingMark?.key !== key) {
    const found = `${SOUND_DIR}/${existing.name}`;
    throw new RpcError(
      ErrorCode.InvalidOperation,
      existingMark === null
        ? `${found} was not written by sound music (made or edited by hand) and is never overwritten. Move or rename it to generate this track.`
        : `${found} holds another track that has the same name. Move or rename it to generate this track.`,
      { op: "sound.music", reason: "not a take of this track", field: "preset", files: [found], hint: "Rename the file to keep it, then generate again." },
    );
  }

  const grid = musicGrid(spec);
  let bytes: Buffer;
  let mark: MusicMark;
  let imported: MusicTake["imported"] = [];
  if (existing && existingMark) {
    bytes = existing.bytes;
    mark = existingMark;
  } else {
    const render = await (request.render ?? ((wanted: MusicSpec) => runWorkerTask<MusicRender>(MUSIC_WORKER, wanted, "music", {})))(spec);
    mark = {
      key,
      kind: "music",
      preset: spec.preset,
      bpm: spec.bpm,
      meter: spec.meter,
      sections: spec.sections.map((section) => ({ ...section })),
      chords: [...spec.chords],
      seed: spec.seed,
      accents: [...spec.accents],
      hitAt: grid.hitAt,
      lufs: Math.round(render.lufs * 100) / 100,
      peakDb: Math.round(render.peakDb * 100) / 100,
    };
    bytes = musicWavBytes(render, mark);
    const path = join(root, ...file.split("/"));
    await writeTextAtomic(path, bytes);
    imported = (await request.importAssets([path])).imported.map(({ asset, job }) => ({ asset, job }));
  }

  // The grid is known, not measured: written beside the take, kept when an exact grid of these bytes is already there (with its edits).
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const target = await resolveBeatsFile(root, file);
  const current = target.previous?.detector === EXACT_DETECTOR && target.previous.assetHash === hash;
  if (!current) {
    const beats: BeatsFile = {
      $schema: BEATS_SCHEMA_URL,
      schemaVersion: SCHEMA_VERSION,
      asset: file,
      assetHash: hash,
      detector: EXACT_DETECTOR,
      bpm: spec.bpm,
      meter: spec.meter,
      downbeat: 0,
      confidence: 1,
      edits: {},
      beats: grid.beats,
      onsets: grid.onsets,
    };
    await writeTextAtomic(target.path, formatBeatsFile(beats));
  }
  const credited = await request.credit(file);
  return {
    file,
    state: existing ? "cached" : "generated",
    mark,
    grid,
    beats: { file: target.rel, state: current ? "kept" : "written", count: grid.beats.length },
    imported,
    credited,
  };
}
