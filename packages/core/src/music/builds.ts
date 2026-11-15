import type { MusicShapeResult } from "@frameshell/protocol";
import { type AudioEffect, MAX_AUDIO_EFFECTS, SWEEP_SECONDS, type ShapeSettings } from "@frameshell/schema";

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** What the builds of a shaping are asked for; kept as {@link ShapeSettings}`.build`. */
export type MusicBuild = NonNullable<ShapeSettings["build"]>;
/** True for a `highpassSweep` that `music.shape` wrote (`auto: "music"`). */
export const isBuild = (effect: AudioEffect) => effect.kind === "highpassSweep" && effect.auto === "music";

/** The clip as the builds read it: where it plays the file, and the effects it has now. */
export interface BuildClip {
  id: string;
  start: number;
  in: number;
  out: number;
  speed?: number | undefined;
  audio?: { effects?: readonly AudioEffect[] | undefined } | undefined;
}

/**
 * The swept high-pass builds that end at `drops` (timeline seconds) on `clip`, on the file's clock (the hits are on the
 * picture, so they are aimed again whenever the clip moves), and the clip's whole effects list with them: the builds a
 * run wrote earlier (`auto: "music"`) are replaced, every other effect stays. A window is `build.seconds` of the timeline
 * (so `speed` times that in the file) and never overlaps the previous hit's. A hit whose window does not reach the part of
 * the file the clip plays, or is too short, gets a warning and no build. Without `build` the old builds are only removed.
 * `effects` is undefined when the list stays as it is, null when it empties.
 */
export function planBuildEffects(
  clip: BuildClip,
  drops: readonly number[],
  build: MusicBuild | undefined,
  warnings: string[],
): { sweeps: MusicShapeResult["sweeps"]; effects: AudioEffect[] | null | undefined } {
  const speed = clip.speed ?? 1;
  const sweeps: MusicShapeResult["sweeps"] = [];
  let previous = 0;
  for (const at of build ? drops : []) {
    const to = round3(clip.in + (at - clip.start) * speed);
    const from = round3(Math.max(0, previous, to - build!.seconds * speed));
    if (to <= clip.in || from >= clip.out) {
      warnings.push(`The hit at ${at} s: its build is outside the part of the file ${clip.id} plays: none written.`);
    } else if (to - from < SWEEP_SECONDS.min) {
      warnings.push(`The hit at ${at} s: no room for a build before it (the file starts or the previous hit is too close): none written.`);
    } else {
      sweeps.push({ at, from, to, startHz: build!.startHz, endHz: build!.endHz });
      previous = to;
    }
  }
  const existing = clip.audio?.effects ?? [];
  const kept = existing.filter((effect) => !isBuild(effect));
  if (sweeps.length === 0) return { sweeps, effects: kept.length === existing.length ? undefined : kept.length > 0 ? [...kept] : null };
  const room = Math.max(0, MAX_AUDIO_EFFECTS - kept.length);
  if (sweeps.length > room) {
    warnings.push(`${clip.id} takes at most ${MAX_AUDIO_EFFECTS} audio effects: builds before ${sweeps.slice(room).map((sweep) => `${sweep.at} s`).join(", ")} left out.`);
    sweeps.length = room;
  }
  const written: AudioEffect[] = [
    ...kept,
    ...sweeps.map((sweep): AudioEffect => ({ kind: "highpassSweep", from: sweep.from, to: sweep.to, startHz: sweep.startHz, endHz: sweep.endHz, auto: "music" })),
  ];
  return { sweeps, effects: JSON.stringify(written) === JSON.stringify(existing) ? undefined : written };
}
