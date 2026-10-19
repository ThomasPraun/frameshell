// Cutting to an angle by number key or click (#242, ADR 0016 decision 5): which shot is under the playhead, what
// to split and set, and the serial queue that sends it. The multicam viewer calls `cutToAngle` too.
import type { OperationResult, TimelineView } from "@frameshell/protocol";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { transport as appTransport } from "../preview/transport.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { type ClipBox, type TrackRow, layoutTimeline } from "./layout.js";

/** How long the transaction of one playback stays open after a press, ms: presses may be far apart. */
export const TAKE_GAP_MS = 60_000;

/** What a press does. */
export interface AngleCutPlan {
  /** Shot under the playhead. */
  clip: string;
  /** Frame grid time to split at; null when the shot starts at the playhead already. */
  splitAt: number | null;
  /** `shot.set` args other than the clip: solo of the angle, or the shot's angles plus it. */
  set: { shot?: "solo"; angles: string[] };
  /** Name of the angle, for the history label. */
  angle: string;
}

/** Why a press did nothing. */
export type AngleCutRefusal =
  /** No program track: the keys mean nothing here. */
  | { kind: "no-program" }
  /** The group has fewer angles than the key's number. */
  | { kind: "no-angle"; number: number; count: number }
  /** The playhead is in a gap or past the last shot. */
  | { kind: "no-shot" }
  /** The shot at the playhead already shows exactly this. */
  | { kind: "unchanged" };

/**
 * What pressing `number` (1-based, group order) does at `time` seconds: split the shot under the playhead there
 * and set the new part to solo of the angle (`additive`: the shot's angles plus the angle). The playhead picks
 * the shot on the frame grid, so a press on a shot's first frame sets that shot without splitting.
 * Several program tracks: the topmost one with a shot at `time`.
 */
export function planAngleCut(rows: readonly TrackRow[], time: number, fps: number, number: number, additive: boolean): AngleCutPlan | AngleCutRefusal {
  const programs = rows.filter((row) => row.kind === "program" && row.angles.length > 0);
  if (programs.length === 0) return { kind: "no-program" };
  const frame = Math.round(time * fps);
  const shotAt = (row: TrackRow): ClipBox | undefined =>
    row.clips.find((clip) => clip.shot !== null && Math.round(clip.start * fps) <= frame && frame < Math.round(clip.end * fps));
  const row = programs.find((candidate) => shotAt(candidate));
  if (!row) {
    const count = Math.max(...programs.map((candidate) => candidate.angles.length));
    return number > count ? { kind: "no-angle", number, count } : { kind: "no-shot" };
  }
  const angle = row.angles[number - 1];
  if (!angle) return { kind: "no-angle", number, count: row.angles.length };
  const clip = shotAt(row)!;
  const current = clip.shot!.angles.map((shown) => shown.id);
  if (additive ? current.includes(angle.id) : current.length === 1 && current[0] === angle.id) return { kind: "unchanged" };
  return {
    clip: clip.id,
    splitAt: Math.round(clip.start * fps) === frame ? null : frame / fps,
    set: additive ? { angles: [...current, angle.id] } : { shot: "solo", angles: [angle.id] },
    angle: angle.name,
  };
}

/** What a press came to. */
export type AngleCutOutcome = { kind: "cut"; result: OperationResult; plan: AngleCutPlan } | AngleCutRefusal;

/** The app's side of a cut: reads the timeline, sends edits, and ends the transaction of a playback. */
export interface AngleCutHost {
  show(timeline: string): Promise<TimelineView>;
  edit(timeline: string, edits: TimelineEdit[], options?: EditOptions): Promise<OperationResult>;
  settle(): Promise<void>;
}

/** The slice of the transport store a cut reads. */
export interface AngleCutTransport {
  get(): { time: number; playing: boolean };
  subscribe(listener: () => void): () => void;
}

/**
 * Presses become cuts one at a time, so a press sees the split of the one before it. A press while playing joins
 * the transaction of its playback (one undo for the whole take, closed when playback stops); a press while paused
 * is a transaction of its own.
 */
export function createAngleCutter(host: AngleCutHost, transport: AngleCutTransport, timeline: string = SELECTION_TIMELINE) {
  let queue: Promise<unknown> = Promise.resolve();
  let takes = 0;
  let presses = 0;
  /** Burst key of the playback's transaction once a press opened it; null when none is open. */
  let takeKey: string | null = null;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };

  let wasPlaying = transport.get().playing;
  transport.subscribe(() => {
    const { playing } = transport.get();
    if (wasPlaying && !playing && takeKey !== null) {
      takeKey = null;
      void serial(() => host.settle()).catch(() => undefined);
    }
    wasPlaying = playing;
  });

  return {
    /**
     * Cut to angle `number` (1-based, group order) at the playhead now; `additive` adds it to the shot's angles.
     * The playhead is read at the call, not when the queue gets to it. Rejects with the daemon's message.
     */
    cut(number: number, additive = false): Promise<AngleCutOutcome> {
      const { time, playing } = transport.get();
      if (playing && takeKey === null) takeKey = `angles:take-${++takes}`;
      const burst = playing ? takeKey! : `angles:press-${++presses}`;
      return serial(async () => {
        const view = await host.show(timeline);
        const plan = planAngleCut(layoutTimeline(view).rows, time, view.fps, number, additive);
        if ("kind" in plan) return plan;
        const options: EditOptions = playing ? { burst, burstGap: TAKE_GAP_MS, label: "Cut to angles" } : { burst, label: `Cut to ${plan.angle}` };
        try {
          let clip = plan.clip;
          if (plan.splitAt !== null) {
            const split = await host.edit(timeline, [{ op: "clip.split", args: { clip, at: plan.splitAt } }], options);
            const created = split.changes.added.find((id) => id !== clip);
            if (!created) throw new Error("The daemon did not report the new part of the split shot.");
            clip = created;
          }
          const result = await host.edit(timeline, [{ op: "shot.set", args: { clip, ...plan.set } }], options);
          return { kind: "cut", result, plan };
        } finally {
          // A paused press is a history entry of its own: close it now rather than after the burst gap.
          if (!playing) await host.settle().catch(() => undefined);
        }
      });
    },
  };
}

/** The app's cutter: the window's timeline, playhead and daemon link. */
export const angleCutter = createAngleCutter(
  {
    show: (timeline) => window.frameshell.timeline.show(timeline),
    edit: (timeline, edits, options) => window.frameshell.timeline.edit(timeline, edits, options),
    settle: () => window.frameshell.timeline.settle(),
  },
  appTransport,
);

/** Cut to angle `number` (1-based, group order) at the playhead; see {@link createAngleCutter}. */
export function cutToAngle(number: number, additive = false): Promise<AngleCutOutcome> {
  return angleCutter.cut(number, additive);
}
