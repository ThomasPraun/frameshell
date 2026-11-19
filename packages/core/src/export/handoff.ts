import { type Clip, type ClipTrack, type Track, type TransitionContext, clipLength } from "@frameshell/schema";

/**
 * What the editor hand-off files (OpenTimelineIO, ADR 0045; Premiere XML, ADR 0047) share: one list of what a file
 * leaves out, one wording per warning, one clip placement in whole frames, one percent-encoding of paths.
 */

/** Clip ids listed in a warning before "…". */
const LISTED_IDS = 5;

/** Collects the ids of clips that carry something the file leaves out or only half carries, one warning per kind. */
export class Dropped {
  readonly #kinds = new Map<string, { ids: string[]; outcome: string }>();

  /** `outcome`: what the file does with it, as the warning words it. */
  add(kind: string, clip: string, outcome = "not exported"): void {
    const entry = this.#kinds.get(kind) ?? { ids: [], outcome };
    entry.ids.push(clip);
    this.#kinds.set(kind, entry);
  }

  /** One warning line per kind, in the order the kinds were first added. */
  warnings(): string[] {
    return [...this.#kinds].map(([kind, { ids, outcome }]) => {
      const shown = ids.slice(0, LISTED_IDS).join(", ");
      return `${kind} on ${ids.length} clip${ids.length === 1 ? "" : "s"} ${outcome} (${shown}${ids.length > LISTED_IDS ? ", …" : ""}).`;
    });
  }
}

/**
 * Features of a clip no hand-off file carries, by the words the warning uses. `dissolved`: its dissolve is written as a
 * transition item. `gainOutcome`: what the file does with `audio.gain` when it does not carry it as a level (OTIO keeps
 * it as metadata, xmeml drops it on a clip with no sound to level); undefined when the file carries it, so no warning.
 */
export function leftOut(clip: Clip, dropped: Dropped, dissolved: boolean, gainOutcome: string | undefined): void {
  if (clip.fadeIn !== undefined || clip.fadeOut !== undefined || (clip.dissolve !== undefined && !dissolved)) {
    dropped.add("dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it)", clip.id);
  }
  if (clip.shape !== undefined) dropped.add(dissolved ? "transition shape (its dissolve is written as a plain one)" : "transition shape (no dissolve carries it)", clip.id);
  if (clip.transform !== undefined || clip.keys !== undefined) dropped.add("transform and keys", clip.id);
  if ("grade" in clip && clip.grade !== undefined) dropped.add("colour grade", clip.id);
  if (
    ("vignette" in clip && clip.vignette !== undefined) ||
    ("grain" in clip && clip.grain !== undefined) ||
    ("backdrop" in clip && clip.backdrop !== undefined) ||
    ("motionBlur" in clip && clip.motionBlur !== undefined)
  ) {
    dropped.add("film finish and effects", clip.id);
  }
  if (clip.formats !== undefined) dropped.add("per-format overrides", clip.id);
  if ("asset" in clip && clip.audio?.effects !== undefined && clip.audio.effects.length > 0) dropped.add("audio effects", clip.id);
  if ("asset" in clip && clip.audio !== undefined && (clip.audio.fadeInMs !== undefined || clip.audio.fadeOutMs !== undefined)) {
    dropped.add("sound fades (audio.fadeInMs, audio.fadeOutMs)", clip.id);
  }
  if (gainOutcome !== undefined && "asset" in clip && clip.audio?.muted !== true && clip.audio?.gain !== undefined && clip.audio.gain !== 0) {
    dropped.add("clip gain (audio.gain)", clip.id, gainOutcome);
  }
}

/** Warning of a track no hand-off file carries (program or subtitle); undefined for a video or audio track. */
export function skippedTrackNotice(track: Track): string | undefined {
  if (track.kind === "program") return `program track ${track.id} (multicam shots) not exported: ${track.clips.length} shot${track.clips.length === 1 ? "" : "s"} skipped.`;
  if (track.kind === "subtitles") return `subtitle track ${track.id} not exported.`;
  return undefined;
}

/** Warning of a video track that sits behind the person (subject matte, ADR 0032); undefined for any other. */
export function behindNotice(track: ClipTrack): string | undefined {
  if (track.kind !== "video" || track.behind === undefined) return undefined;
  return `video track ${track.id} sits behind the person on track ${track.behind} (subject matte): exported as a plain track.`;
}

/** Warning of the timeline `letterbox`. */
export const LETTERBOX_NOTICE = "letterbox bars not exported.";

/** Warning of a clip with no known length, which is skipped. */
export function noLengthNotice(clip: Clip): string {
  return `clip ${clip.id} (nested ${"source" in clip ? clip.source : "timeline"}) has no known length: skipped.`;
}

/** The name of a generated or nested clip, which has no file, and the warning that says the editor must relink it. */
export function missingMedia(clip: Clip): { name: string; warning: string } {
  const nested = clip.type === "timeline";
  const label = "source" in clip && clip.source ? sourceName(clip.source) : clip.id;
  return {
    name: nested ? `timeline ${label}` : `${clip.type} ${label}`,
    warning: nested
      ? `nested timeline clip ${clip.id} (${label}) exported as missing media of its length: export that timeline on its own and relink it.`
      : `generated clip ${clip.id} (${clip.type}) exported as missing media of its length: render it and relink the file by hand.`,
  };
}

/** Where a clip sits on the timeline in whole frames: positions from the rounded seconds, never a sum of rounded lengths. */
export interface Placement {
  startFrames: number;
  endFrames: number;
  lengthFrames: number;
}

/** {@link Placement} of `clip` at `fps`; undefined when it has no known length (a nested clip of an unreadable file). */
export function placeClip(clip: Clip, context: TransitionContext, fps: number): Placement | undefined {
  const length = clipLength(clip, context);
  if (!Number.isFinite(length)) return undefined;
  const startFrames = Math.round(clip.start * fps);
  const endFrames = Math.max(startFrames + 1, Math.round((clip.start + length) * fps));
  return { startFrames, endFrames, lengthFrames: endFrames - startFrames };
}

/** Last path segment of a `/`-separated project path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A composition or nested timeline file by name: `compositions/hyperframes/intro/index.html` is `intro`, `timelines/inner.json` is `inner`. */
export function sourceName(source: string): string {
  const parts = source.split("/");
  const file = parts.pop() ?? source;
  const stem = file.replace(/\.[^.]+$/, "");
  return stem === "index" && parts.length > 0 ? parts[parts.length - 1]! : stem;
}

/** Percent-encodes each segment of a `/`-separated path, leaving `/`, `..` and a drive letter (`C:`) alone. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === ".." || /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
}
