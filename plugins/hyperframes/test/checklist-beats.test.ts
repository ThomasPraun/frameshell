import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { RenderTiming } from "@frameshell/plugin-api";
import { MOTION_RUNTIME } from "../src/motion-runtime.js";
import { checklist } from "../src/templates/checklist.js";
import type { Template } from "../src/templates/kit.js";
import { notificationStack } from "../src/templates/notification-stack.js";
import { workCards } from "../src/templates/work-cards.js";

// The page scripts of the templates with stepped schedules run here against the bundled runtime and a stub page, so
// the step times can be read from an opacity after a seek (a checklist box fills when its tick lands, a card shows
// when it arrives).
const TOKENS = { colors: {}, brand: {}, used: [], problem: null };

/** An element stub that remembers whatever is set on it and hands out the same child for the same name. */
function element(): Record<string, unknown> {
  const kept = new Map<string | symbol, unknown>();
  const style: Record<string, string> = {};
  return new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (key === "style") return style;
      if (key === "appendChild") return () => undefined;
      if (!kept.has(key)) kept.set(key, element());
      return kept.get(key);
    },
    set(_target, key, value) {
      kept.set(key, value);
      return true;
    },
  });
}

/** The element of a created row whose opacity marks its step. */
type Mark = (row: Record<string, unknown>) => { style: { opacity: string } };
const boxFill: Mark = (row) => (row["firstChild"] as Record<string, unknown>)["firstChild"] as { style: { opacity: string } };

/**
 * Opacity (0 to 1) of each created row's `mark` at clip second `t`, for `template`'s page with `timing` and the clip
 * props `given`.
 */
function opacities(template: Template, mark: Mark, timing: RenderTiming | undefined, given: Record<string, unknown>, ...times: number[]): number[][] {
  const duration = template.defaultDuration;
  const html = template.render({ id: "list", width: 1920, height: 1080, duration, tokens: TOKENS });
  const attribute = /data-composition-variables='([^']*)'/.exec(html)![1]!.replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).at(-1)!;
  const rows: Record<string, unknown>[] = [];
  const named = new Map<string, unknown>();
  const root = { getAttribute: (name: string) => ({ "data-composition-id": "list", "data-width": "1920", "data-height": "1080", "data-duration": String(duration) })[name] ?? null };
  const page: Record<string, unknown> = {
    __hyperframes: { getVariables: () => given },
    addEventListener: () => undefined,
    document: {
      documentElement: { getAttribute: (name: string) => (name === "data-composition-variables" ? attribute : null) },
      querySelector: () => root,
      querySelectorAll: () => [root],
      getElementById: (id: string) => (named.has(id) ? named.get(id) : (named.set(id, element()), named.get(id))),
      createElement: () => {
        const row = element();
        rows.push(row);
        return row;
      },
    },
    ...(timing ? { frameshellTiming: timing } : {}),
  };
  page["globalThis"] = page;
  page["window"] = page;
  runInNewContext(`${MOTION_RUNTIME}\nwindow.FrameshellMotion = FrameshellMotion;`, page);
  runInNewContext(script, page);
  const timeline = (page["__timelines"] as Record<string, { seek(t: number): void }>)["list"]!;
  return times.map((t) => {
    timeline.seek(t);
    return rows.map((row) => Number(mark(row).style.opacity));
  });
}

const fills = (timing: RenderTiming | undefined, given: Record<string, unknown>, ...times: number[]) => opacities(checklist, boxFill, timing, given, ...times);

/** Seconds at which each of the first `count` rows starts to show its mark, to 10 ms, found by scanning the clip. */
function stepTimes(template: Template, mark: Mark, count: number, timing: RenderTiming | undefined, given: Record<string, unknown>): number[] {
  const steps = Array.from({ length: 400 }, (_, i) => i / 100);
  const seen = opacities(template, mark, timing, given, ...steps);
  return Array.from({ length: count }, (_, item) => steps[seen.findIndex((row) => row[item]! > 0)]! - 0.01);
}

const tickTimes = (timing: RenderTiming | undefined, given: Record<string, unknown>) => stepTimes(checklist, boxFill, 4, timing, given);

const BEATS: RenderTiming = { beats: Array.from({ length: 10 }, (_, k) => ({ at: 0.25 + k * 0.5, beat: 3 + k })), tempo: { bpm: 120, meter: 4 } };
// Default tickStart 1 s, tickGap 0.7 s: ticks at 1, 1.7, 2.4, 3.1.
const STEPS = [1, 1.7, 2.4, 3.1];

describe("checklist ticks on the music's beats", () => {
  it("ticks on the tickStart and tickGap steps by default, with or without timing in the page", () => {
    expect(tickTimes(undefined, {})).toEqual(STEPS.map((s) => expect.closeTo(s, 1)));
    expect(tickTimes(BEATS, {})).toEqual(STEPS.map((s) => expect.closeTo(s, 1)));
  });

  it("ticks on the first beats at or after tickStart when onBeats is set and the page has a grid", () => {
    // Beats at 0.25 + 0.5 k: the first at or after 1 s is 1.25, then 1.75, 2.25, 2.75.
    expect(tickTimes(BEATS, { onBeats: true })).toEqual([1.25, 1.75, 2.25, 2.75].map((s) => expect.closeTo(s, 1)));
    expect(tickTimes(BEATS, { onBeats: true, tickStart: 1.25 })[0]).toBeCloseTo(1.25, 1);
  });

  it("keeps going on the grid's period past its last beat", () => {
    const short: RenderTiming = { beats: BEATS.beats!.slice(0, 3), tempo: BEATS.tempo! };
    expect(tickTimes(short, { onBeats: true })).toEqual([1.25, 1.75, 2.25, 2.75].map((s) => expect.closeTo(s, 1)));
  });

  it("falls back to the steps when onBeats is set but the page has no usable grid", () => {
    for (const timing of [undefined, { beats: [], beatsProblem: "no-tempo" as const }, { ...BEATS, beatsProblem: "low-confidence" as const }]) {
      expect(tickTimes(timing, { onBeats: true })).toEqual(STEPS.map((s) => expect.closeTo(s, 1)));
    }
  });

  it("paints the same picture for the same time whatever was painted before (a pure function of t)", () => {
    const forward = fills(BEATS, { onBeats: true }, 0.5, 1.3, 2, 3);
    const shuffled = fills(BEATS, { onBeats: true }, 3, 0.5, 2, 1.3);
    expect(shuffled).toEqual([forward[3], forward[0], forward[2], forward[1]]);
  });
});

describe("other templates with steps on the music's beats", () => {
  const card: Mark = (row) => row as unknown as { style: { opacity: string } };
  const near = (times: number[]) => times.map((s) => expect.closeTo(s, 1));

  it("drops notification cards on the first beats at or after startAt, or on the steps without onBeats or a grid", () => {
    // Default startAt 0.4 s, gap 0.9 s, three cards.
    expect(stepTimes(notificationStack, card, 3, BEATS, {})).toEqual(near([0.4, 1.3, 2.2]));
    expect(stepTimes(notificationStack, card, 3, undefined, { onBeats: true })).toEqual(near([0.4, 1.3, 2.2]));
    expect(stepTimes(notificationStack, card, 3, BEATS, { onBeats: true })).toEqual(near([0.75, 1.25, 1.75]));
  });

  it("starts work cards on beats: each lands a quarter second before its beat and pulses on it", () => {
    // Default startAt 0.3 s, gap 0.5 s, three cards: they land at 0.3, 0.8, 1.3 and start 0.25 s later.
    expect(stepTimes(workCards, card, 3, BEATS, {})).toEqual(near([0.3, 0.8, 1.3]));
    expect(stepTimes(workCards, card, 3, { beats: [], beatsProblem: "no-beats" }, { onBeats: true })).toEqual(near([0.3, 0.8, 1.3]));
    // The first beat at or after 0.55 s is 0.75 s, then 1.25 and 1.75: the cards land 0.25 s before each.
    expect(stepTimes(workCards, card, 3, BEATS, { onBeats: true })).toEqual(near([0.5, 1, 1.5]));
  });
});
