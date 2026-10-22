// Which proxy samples to decode for one media span, and which program frames each decoded frame shows (ADR 0001).

/** Keyframe index at or before each sample of a proxy. */
export interface SyncTable {
  /** Number of video samples (= frames: CFR, no B-frames). */
  count: number;
  /** Last sync sample at or before `i`. */
  before(i: number): number;
  isSync(i: number): boolean;
}

/** Build a {@link SyncTable} from per-sample sync flags in decode order. */
export function syncTable(isSync: readonly boolean[]): SyncTable {
  const before = new Int32Array(isSync.length);
  for (let i = 0, last = 0; i < isSync.length; i++) {
    if (isSync[i]) last = i;
    before[i] = last;
  }
  return { count: isSync.length, before: (i) => before[i]!, isSync: (i) => isSync[i] === true };
}

/**
 * One chunk to feed the decoder. Its frame is shown for program frames
 * `[from, to)`; `from === to` means decode (a later frame depends on it) and drop.
 */
export interface DecodeStep {
  sample: number;
  /** Feed as a key chunk: every sync sample. */
  key: boolean;
  from: number;
  to: number;
}

/**
 * Placement of a media span: program frames `[start, end)` showing source frame `in` at `start`, `speed` source
 * frames per frame (0: `in` holds).
 */
export interface SpanTiming {
  start: number;
  end: number;
  in: number;
  speed: number;
}

/**
 * Chunks that show program frames `[max(from, span.start), span.end)` of
 * `span`, in decode order. Starts at the keyframe before the first shown
 * source frame; pre-roll and frames skipped by speed are decoded and dropped,
 * unless a later keyframe lets the plan jump past them. Source frames past
 * the proxy's end hold its last frame. Decode order = display order (no
 * B-frames), so the decoder returns frames in this order.
 */
export function* decodeSteps(span: SpanTiming, from: number, table: SyncTable): Generator<DecodeStep> {
  const last = table.count - 1;
  if (last < 0) return;
  // Round half down: a held frame changes on the later program frame, as export's `fps` filter does. `in` is
  // fractional only for a piece of a sped-up clip (a dissolve's split, ADR 0018); the fraction joins the rounding.
  const whole = Math.floor(span.in);
  const fraction = span.in - whole;
  const source = (frame: number) => Math.min(last, Math.max(0, whole + Math.ceil(fraction + (frame - span.start) * span.speed - 0.5)));
  let frame = Math.max(from, span.start);
  let next = -1;
  while (frame < span.end) {
    const target = source(frame);
    let until = frame + 1;
    while (until < span.end && source(until) === target) until++;
    const sync = table.before(target);
    if (next < 0 || sync > next) next = sync;
    for (; next < target; next++) yield { sample: next, key: table.isSync(next), from: frame, to: frame };
    yield { sample: target, key: table.isSync(target), from: frame, to: until };
    next = target + 1;
    frame = until;
  }
}

/** One file and the program frames it plays. */
export interface DecodeRun {
  path: string;
  timing: SpanTiming;
}

/**
 * `runs` in order, each joined to the one before when it plays on from where
 * that one stops: same file and speed, next program frame, next source
 * frame. Decoding then goes on across the join instead of restarting at a
 * keyframe, as at a multicam shot change that keeps showing an angle.
 */
export function joinRuns(runs: Iterable<DecodeRun>): DecodeRun[] {
  const joined: DecodeRun[] = [];
  for (const run of runs) {
    const last = joined.at(-1);
    const b = run.timing;
    if (last && last.path === run.path) {
      const a = last.timing;
      if (a.end === b.start && a.speed === b.speed && a.in + (a.end - a.start) * a.speed === b.in) {
        last.timing = { ...a, end: b.end };
        continue;
      }
    }
    joined.push({ path: run.path, timing: { start: b.start, end: b.end, in: b.in, speed: b.speed } });
  }
  return joined;
}
