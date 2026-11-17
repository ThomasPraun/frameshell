// What the Audition dialog shows, as pure functions (ADR 0038): which files to audition, the gains of "Match loudness"
// and the colours of a spectrogram.
import type { FileNode } from "../../../shared/api.js";

/**
 * Files one audition reads at most: `AUDIO_INSPECT_MAX` of `audio.inspect` (packages/protocol/src/methods/script-sound.ts),
 * copied because the renderer bundles no protocol values; `audition-model.test.ts` holds them equal.
 */
export const AUDITION_MAX = 32;

/** Extensions of the sound files the dialog offers (the Explorer's `audio` glyph). */
const SOUND_EXTENSIONS = new Set(["wav", "mp3", "aac", "m4a", "flac", "ogg", "opus"]);

/** Whether project-relative `path` names a sound file. */
export function isSoundPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && SOUND_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** The sound files among `paths`, in order, each once, at most {@link AUDITION_MAX}. */
export function soundFiles(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(isSoundPath))].slice(0, AUDITION_MAX);
}

/** The sound files directly inside folder node `dir` (not its subfolders: `assets/` would take every song), by name. */
export function soundFilesIn(dir: FileNode): string[] {
  if (dir.kind !== "dir") return [];
  return soundFiles(dir.children.filter((node) => node.kind === "file").map((node) => node.path).sort());
}

/** Name `music.candidates` gives its tracks: `Music 1` to `Music n`, by rank. */
const CANDIDATE_TRACK = /^Music (\d+)$/;

/** A timeline track as {@link candidateFiles} reads it. */
export interface CandidateRow {
  kind: string;
  name: string | null;
  clips: readonly { asset: string | null }[];
}

/** Rank of `row` when it is a candidate track (an audio track named `Music <rank>`); undefined otherwise. */
const rankOf = (row: CandidateRow) => (row.kind === "audio" ? CANDIDATE_TRACK.exec(row.name ?? "")?.[1] : undefined);

/**
 * The music candidates of a timeline (`music.candidates`) asked from track `from`: the file of the first clip of every
 * audio track named `Music <rank>`, by rank; empty when `from` is not one of them or there are fewer than two.
 */
export function candidateFiles(rows: readonly CandidateRow[], from: CandidateRow): string[] {
  if (rankOf(from) === undefined) return [];
  const ranked = rows.flatMap((row) => {
    const rank = rankOf(row);
    const asset = row.clips.find((clip) => clip.asset !== null)?.asset;
    return rank !== undefined && asset ? [{ rank: Number(rank), asset }] : [];
  });
  const files = soundFiles(ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.asset));
  return files.length >= 2 ? files : [];
}

/** The loudness every sound is brought to by "Match loudness": the quietest one's, LUFS; null when none has a reading. */
export function matchTarget(lufs: readonly (number | null)[]): number | null {
  const readings = lufs.filter((value): value is number => value !== null);
  return readings.length > 0 ? Math.min(...readings) : null;
}

/**
 * Playback gain of each sound, dB: with `match`, target minus its own loudness (never above 0, the target being the
 * quietest), rounded to 0.1 dB; without, or for a sound with no reading (silence), 0.
 */
export function matchGains(lufs: readonly (number | null)[], match: boolean): number[] {
  const target = matchTarget(lufs);
  return lufs.map((value) => (match && target !== null && value !== null ? Math.round((target - value) * 10) / 10 || 0 : 0));
}

/** A dB value for the dialog, one decimal, with a sign when above zero: `-14.2`, `+0.5`, `0.0`. */
export function dbText(value: number): string {
  const text = (Math.round(value * 10) / 10 || 0).toFixed(1);
  return value > 0.05 ? `+${text}` : text;
}

/** Highest level a spectrogram colour scale reaches, dB: louder bins share the top colour. */
const TOP_DB = -6;
/** Stops of the colour scale from the floor to {@link TOP_DB}: dark blue, violet, orange, pale yellow. */
const STOPS: readonly (readonly [number, number, number])[] = [
  [8, 10, 24],
  [72, 30, 120],
  [200, 70, 70],
  [250, 170, 60],
  [255, 245, 200],
];

/** RGB of `db` on the spectrogram scale from `floorDb` (darkest) to -6 dB (brightest). */
export function spectrogramColour(db: number, floorDb: number): readonly [number, number, number] {
  const t = Math.max(0, Math.min(1, (db - floorDb) / (TOP_DB - floorDb)));
  const at = t * (STOPS.length - 1);
  const index = Math.min(STOPS.length - 2, Math.floor(at));
  const [a, b] = [STOPS[index]!, STOPS[index + 1]!];
  const mix = at - index;
  return [0, 1, 2].map((channel) => Math.round(a[channel]! + (b[channel]! - a[channel]!) * mix)) as unknown as readonly [number, number, number];
}
