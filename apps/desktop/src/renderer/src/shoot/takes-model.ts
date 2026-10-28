// Pure parts of the Shoot view's takes (ADR 0023, 0024): the current scene, the take keys, and deviations shown as
// tracked changes against a script line.
import type { ShootStatusResult } from "@frameshell/protocol";
import { editsText } from "../history-commands.js";

/** A deviation as `shoot.status` reports it. */
export type DeviationInfo = ShootStatusResult["takes"][number]["deviations"][number];

/** The scene the next take starts at: the one picked, else the next one to record, else the first. */
export function currentScene(status: ShootStatusResult | null, picked: string | null): string | null {
  if (!status) return null;
  if (picked !== null && status.scenes.some((scene) => scene.slug === picked)) return picked;
  return status.next ?? status.scenes[0]?.slug ?? null;
}

/** The scene after `scene` in script order; null at the last. */
export function sceneAfter(status: ShootStatusResult | null, scene: string | null): string | null {
  if (!status || scene === null) return null;
  const index = status.scenes.findIndex((candidate) => candidate.slug === scene);
  return status.scenes[index + 1]?.slug ?? null;
}

/** The take being recorded: its start on the session clock, the scene it starts at, and its number in that scene. */
export interface OpenTake {
  start: number;
  scene: string;
  number: number;
}

/** The take cut last: its id once the daemon has it, or why it was not kept. */
export interface CutTake {
  /** Null while the cut is on its way, and for a take not kept. */
  id: string | null;
  session: string;
  scene: string;
  number: number;
  /** Cut under half a second after T: nothing was kept. */
  short: boolean;
  /** The cut itself failed. */
  error: string | null;
}

/** Number of the next take of `scene`: one past its takes in the status and the cut still on its way. */
export function nextTakeNumber(status: ShootStatusResult | null, scene: string, last: CutTake | null): number {
  const listed = status?.takes.filter((take) => take.scene === scene && !take.discarded).length ?? 0;
  const pending = last && last.scene === scene && !last.short && last.error === null ? last.number : 0;
  return Math.max(listed, pending) + 1;
}

/** A scene's title as the status names it; the slug when unknown. */
export function sceneTitle(status: ShootStatusResult | null, slug: string): string {
  return status?.scenes.find((scene) => scene.slug === slug)?.title || slug;
}

/** Where the take cut last is: being analyzed, analyzed (with its number of differences), failed, or not kept. */
export type CutOutcome = { kind: "analyzing" } | { kind: "analyzed"; differences: number } | { kind: "failed"; problem: string } | { kind: "short" };

/** The outcome of `last`, read from the status: the take's state there is the one truth. */
export function cutOutcome(status: ShootStatusResult | null, last: CutTake): CutOutcome {
  if (last.short) return { kind: "short" };
  if (last.error !== null) return { kind: "failed", problem: last.error };
  const take = last.id === null ? undefined : status?.takes.find((candidate) => candidate.id === last.id);
  if (!take || take.state === "transcribing") return { kind: "analyzing" };
  if (take.state === "analyzed") return { kind: "analyzed", differences: take.deviations.length };
  return { kind: "failed", problem: take.problem ?? take.state };
}

/** What a key press asks of the takes while recording: `take` (T, a new take), `cut` (C), or null. */
export function takeKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "repeat" | "isComposing" | "target">): "take" | "cut" | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return null;
  if (editsText(event.target)) return null;
  const key = event.key.toLowerCase();
  return key === "t" ? "take" : key === "c" ? "cut" : null;
}

/** One word of a script line as the take came out: said, missing (struck), or heard instead or in addition. */
export interface LineMark {
  text: string;
  kind: "said" | "missing" | "heard";
  /** Deviation the mark shows; null for a word said as written. */
  deviation: string | null;
}

/**
 * A script line's words with the take's deviations on it, as tracked changes: words `missing` or `changed` are struck,
 * what was heard instead (`changed`) or in addition (`added`) is inserted after them. Deviations a word range cannot
 * show (a pause, a restart, the wrong speaker, a moved line) are left in `notes`.
 */
export function lineMarks(words: readonly string[], deviations: readonly DeviationInfo[]): { marks: LineMark[]; notes: DeviationInfo[] } {
  const struck = new Map<number, string>();
  const inserted = new Map<number, { text: string; deviation: string }[]>();
  const notes: DeviationInfo[] = [];
  const insert = (after: number, text: string, deviation: string) => {
    if (text.trim() === "") return;
    inserted.set(after, [...(inserted.get(after) ?? []), { text, deviation }]);
  };
  for (const deviation of deviations) {
    const range = deviation.words;
    if ((deviation.kind === "missing" || deviation.kind === "changed") && range) {
      for (let i = range.from; i <= range.to; i++) struck.set(i, deviation.id);
      if (deviation.kind === "changed") insert(range.to, deviation.heard, deviation.id);
    } else if (deviation.kind === "added") {
      insert(range ? range.to : words.length - 1, deviation.heard, deviation.id);
    } else {
      notes.push(deviation);
    }
  }
  const marks: LineMark[] = [];
  for (const heard of inserted.get(-1) ?? []) marks.push({ text: heard.text, kind: "heard", deviation: heard.deviation });
  words.forEach((word, i) => {
    const deviation = struck.get(i) ?? null;
    marks.push({ text: word, kind: deviation ? "missing" : "said", deviation });
    for (const heard of inserted.get(i) ?? []) marks.push({ text: heard.text, kind: "heard", deviation: heard.deviation });
  });
  return { marks, notes };
}
