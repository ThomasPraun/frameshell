import type { TimelineView } from "@frameshell/protocol";
import { type Transcript, parseTranscript } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { buildTranscriptModel, isKept, paragraphs, placeWord, restoreEdit, restorePlan, rippleScope, struckRun, withWordText, wordAt } from "../src/renderer/src/transcript/model.js";

// Seam under test: the transcript view's pure model. Timeline view and transcript files in; struck words,
// timeline placements, the word under the playhead and the restore operation out.

const ASSET = "assets/take.mp4";
const PATH = "transcripts/take.words.json";

/** Source words, seconds. "hoy vamos" (w_04, w_05) is cut in {@link cutView}. */
const WORDS: [string, string, number, number][] = [
  ["w_000001", "Hola", 0.5, 0.9],
  ["w_000002", "a", 1.0, 1.2],
  ["w_000003", "todos", 1.3, 1.8],
  ["w_000004", "hoy", 2.5, 2.9],
  ["w_000005", "vamos", 3.0, 3.5],
  ["w_000006", "a", 3.6, 3.7],
  ["w_000007", "cortar", 3.8, 4.4],
  ["w_000008", "ya", 5.0, 5.3],
];

const transcript: Transcript = {
  schemaVersion: 1,
  asset: ASSET,
  assetHash: `sha256:${"0".repeat(64)}`,
  provider: "whisper-cpp",
  model: "large-v3-turbo-q5_0",
  words: WORDS.map(([id, text, start, end]) => ({ id, text, start, end })),
  edits: { w_000007: { text: "cortar," } },
};
const sources = [{ path: PATH, transcript }];

const media = (id: string, start: number, inS: number, out: number, speed = 1) => ({
  id,
  type: "media",
  asset: ASSET,
  start,
  in: inS,
  out,
  end: start + (out - inS) / speed,
  ...(speed !== 1 ? { speed } : {}),
});

function view(clips: ReturnType<typeof media>[]): TimelineView {
  return {
    timeline: "main",
    path: "timelines/main.json",
    revision: 3,
    fps: 30,
    duration: Math.max(...clips.map((clip) => clip.end)),
    problems: [],
    tracks: [{ id: "v1", kind: "video", name: null, follows: null, clips }],
  };
}

/** Source 0–2 then 3.55–5.5: "hoy vamos" was cut, "a cortar, ya" follows at 2 s. */
const cutView = view([media("c_a", 0, 0, 2), media("c_b", 2, 3.55, 5.5)]);
const key = (id: string) => `${PATH}#${id}`;
const wordsOf = (model: ReturnType<typeof buildTranscriptModel>) => model.assets[0]!.words;

describe("buildTranscriptModel", () => {
  it("strikes the words no clip keeps and places the kept ones on the timeline clock", () => {
    const model = buildTranscriptModel(cutView, sources);
    expect(model.missing).toEqual([]);
    expect(model.assets.map((a) => [a.asset, a.path])).toEqual([[ASSET, PATH]]);
    const words = wordsOf(model);
    expect(words.filter((w) => w.placements.length === 0).map((w) => w.text)).toEqual(["hoy", "vamos"]);
    expect(words[0]).toMatchObject({ key: key("w_000001"), text: "Hola", placements: [{ clip: "c_a", track: "v1", from: 0.5, to: 0.9 }] });
    // "a" starts 0.05 s after c_b's in: 2.05 on the timeline.
    expect(words[5]!.placements).toEqual([{ clip: "c_b", track: "v1", from: 2.05, to: 2.15 }]);
    // The human edit replaces the text.
    expect(words[6]!.text).toBe("cortar,");
  });

  it("keeps a word by its midpoint, clips its placement to the clip, and maps through speed", () => {
    // c_a ends at 1.6: "todos" (1.3–1.8, midpoint 1.55) is kept, cut at the clip's end.
    const model = buildTranscriptModel(view([media("c_a", 10, 0, 1.6, 2)]), sources);
    const words = wordsOf(model);
    expect(words[2]!.placements).toEqual([{ clip: "c_a", track: "v1", from: 10.65, to: 10.8 }]);
    expect(words[1]!.placements).toEqual([{ clip: "c_a", track: "v1", from: 10.5, to: 10.6 }]);
    expect(words[3]!.placements).toEqual([]);
  });

  it("carries the transcript's speechInside flag, so the view can warn against cutting inside the word (#117)", () => {
    const flagged: Transcript = {
      ...transcript,
      words: transcript.words.map((word) => (word.id === "w_000008" ? { ...word, end: 9, speechInside: true } : word)),
    };
    const words = wordsOf(buildTranscriptModel(cutView, [{ path: PATH, transcript: flagged }]));
    expect(words.filter((w) => w.speechInside).map((w) => w.id)).toEqual(["w_000008"]);
  });

  it("lists timeline assets that have no transcript, and ignores transcripts of assets not on the timeline", () => {
    const other = { ...transcript, asset: "assets/other.mp4" };
    const model = buildTranscriptModel(view([{ ...media("c_x", 0, 0, 2), asset: "assets/broll.mp4" }]), [
      { path: "transcripts/other.words.json", transcript: other },
    ]);
    expect(model.assets).toEqual([]);
    expect(model.missing).toEqual(["assets/broll.mp4"]);
  });
});

describe("wordAt", () => {
  it("finds the word under the playhead, none between words", () => {
    const model = buildTranscriptModel(cutView, sources);
    expect(wordAt(model, 0.6)).toBe(key("w_000001"));
    expect(wordAt(model, 1.95)).toBeNull();
    expect(wordAt(model, 2.1)).toBe(key("w_000006"));
    expect(wordAt(model, 99)).toBeNull();
  });
});

describe("placeWord", () => {
  it("gives the timeline range of a selected word, or null once it is cut", () => {
    const word = { transcript: PATH, asset: ASSET, word: "w_000006", text: "a", start: 3.6, end: 3.7 };
    expect(placeWord(cutView, word)).toEqual({ from: 2.05, to: 2.15 });
    expect(placeWord(view([media("c_a", 0, 0, 2)]), word)).toBeNull();
  });
});

describe("restoreEdit", () => {
  it("extends the clip that ends right before a cut word, into the pause after it, rippling", () => {
    const model = buildTranscriptModel(cutView, sources);
    expect(restoreEdit(cutView, model, key("w_000004"))).toEqual({
      how: "extend",
      clip: "c_a",
      edit: { op: "clip.trim", args: { clip: "c_a", out: 2.95, snapBounds: { out: { min: 2.9, max: 3 } }, ripple: true } },
    });
  });

  it("extends the clip that starts right after a cut word backwards when other cut words lie before it", () => {
    const model = buildTranscriptModel(cutView, sources);
    expect(restoreEdit(cutView, model, key("w_000005"))).toEqual({
      how: "extend",
      clip: "c_b",
      edit: { op: "clip.trim", args: { clip: "c_b", in: 2.95, snapBounds: { in: { min: 2.9, max: 3 } }, ripple: true } },
    });
  });

  it("re-inserts only the word's range after the clip before it when cut words lie on both sides", () => {
    const wide = view([media("c_a", 0, 0, 2), media("c_b", 2, 4.7, 5.5)]);
    const model = buildTranscriptModel(wide, sources);
    expect(wordsOf(model).filter((w) => w.placements.length === 0).map((w) => w.text)).toEqual(["hoy", "vamos", "a", "cortar,"]);
    expect(restoreEdit(wide, model, key("w_000005"))).toEqual({
      how: "insert",
      clip: "c_a",
      edit: {
        op: "clip.add",
        args: {
          track: "v1",
          asset: ASSET,
          start: 2,
          in: 2.95,
          out: 3.55,
          ripple: true,
          snap: true,
          snapBounds: { in: { min: 2.9, max: 3 }, out: { min: 3.5, max: 3.6 } },
        },
      },
    });
  });

  it("never extends into source the next clip already plays", () => {
    const close = view([media("c_a", 0, 0, 2), media("c_b", 2, 2.93, 5.5)]);
    const model = buildTranscriptModel(close, sources);
    expect(restoreEdit(close, model, key("w_000004"))?.edit).toEqual({
      op: "clip.trim",
      args: { clip: "c_a", out: 2.93, snapBounds: { out: { min: 2.9, max: 2.93 } }, ripple: true },
    });
  });

  it("gives an inserted clip the anchor clip's speed and sound", () => {
    const tight = view([
      { ...media("c_a", 0, 0, 2.8, 2), audio: { gain: -6, muted: false } },
      media("c_b", 1.4, 4.7, 5.5),
    ] as ReturnType<typeof media>[]);
    const model = buildTranscriptModel(tight, sources);
    // "a" (3.6–3.7): in and out in the pauses around it; placed where c_a ends (1.4 s at speed 2).
    expect(restoreEdit(tight, model, key("w_000006"))).toMatchObject({
      how: "insert",
      edit: { op: "clip.add", args: { in: 3.55, out: 3.75, speed: 2, gain: -6, start: 1.4 } },
    });
  });

  it("fences snapped edges inside sub-200 ms inter-word gaps, so any edge the daemon picks keeps the word and only it", () => {
    // Continuous speech: pause before W, then 80 ms gaps. W and "next" were cut together; c_b resumes at "then".
    const speech: Transcript = {
      ...transcript,
      words: [
        { id: "w_1", text: "before", start: 2.5, end: 2.9 },
        { id: "w_2", text: "W", start: 3.2, end: 3.5 },
        { id: "w_3", text: "next", start: 3.58, end: 3.9 },
        { id: "w_4", text: "then", start: 3.98, end: 4.3 },
      ],
      edits: {},
    };
    const cut = view([media("c_a", 0, 2.4, 3.05), media("c_b", 0.65, 3.94, 5)]);
    const own = [{ path: PATH, transcript: speech }];
    const model = buildTranscriptModel(cut, own);
    const plan = restoreEdit(cut, model, key("w_2"));
    expect(plan?.edit).toEqual({
      op: "clip.trim",
      args: { clip: "c_a", out: 3.54, snapBounds: { out: { min: 3.5, max: 3.58 } }, ripple: true },
    });
    // Wherever in its bounds the daemon puts `out`, W comes back and "next" stays cut.
    for (const out of [3.5, 3.533, 3.567, 3.58]) {
      const restored = view([media("c_a", 0, 2.4, out), media("c_b", out - 2.4, 3.94, 5)]);
      expect(isKept(restored, own, key("w_2")), `out ${out}`).toBe(true);
      expect(isKept(restored, own, key("w_3")), `out ${out}`).toBe(false);
    }
    // The pause before W (where an unfenced snap went) leaves it cut: the view's check catches that.
    expect(isKept(view([media("c_a", 0, 2.4, 3.133), media("c_b", 0.733, 3.94, 5)]), own, key("w_2"))).toBe(false);
  });

  it("returns null for a kept word or an unknown key", () => {
    const model = buildTranscriptModel(cutView, sources);
    expect(restoreEdit(cutView, model, key("w_000001"))).toBeNull();
    expect(restoreEdit(cutView, model, "nope")).toBeNull();
  });
});

describe("restorePlan", () => {
  it("brings back a run of struck words with one edit, skipping kept and unknown keys", () => {
    const model = buildTranscriptModel(cutView, sources);
    const plan = restorePlan(cutView, model, [key("w_000003"), key("w_000004"), key("w_000005"), "nope"]);
    expect(plan).toEqual({
      edits: [{ op: "clip.trim", args: { clip: "c_a", out: 3.55, snapBounds: { out: { min: 3.5, max: 3.55 } }, ripple: true } }],
      steps: [{ how: "extend", clip: "c_a", edit: plan!.edits[0] }],
      keys: [key("w_000004"), key("w_000005")],
      held: [],
    });
    expect(restorePlan(cutView, model, [key("w_000001")])).toBeNull();
  });

  it("restores separate runs latest first, so an earlier step never lands where a later one opened room", () => {
    const wide = view([media("c_a", 0, 0, 2), media("c_b", 2, 4.7, 5.5)]);
    const model = buildTranscriptModel(wide, sources);
    // "hoy" and "a" selected, "vamos" between them left cut: two runs, both opening room at 2 s.
    const plan = restorePlan(wide, model, [key("w_000004"), key("w_000006")])!;
    expect(plan.keys).toEqual([key("w_000006"), key("w_000004")]);
    expect(plan.steps.map((step) => [step.how, step.clip, step.edit.op])).toEqual([
      ["insert", "c_a", "clip.add"],
      ["extend", "c_a", "clip.trim"],
    ]);
    expect(plan.edits[0]).toMatchObject({ args: { start: 2, in: 3.55, out: 3.75 } });
    expect(plan.edits[1]).toMatchObject({ args: { clip: "c_a", out: 2.95 } });
  });

  it("ripples only tracks where moving later clips opens no gap, and reports the others as held", () => {
    const voice = view([media("c_a", 0, 0, 2), media("c_b", 2, 3.55, 5.5)]);
    const other = (id: string, start: number, end: number) => ({ id, type: "media", asset: "assets/other.wav", start, in: 0, out: end - start, end });
    voice.tracks.push(
      // Music: one bed ending where the next starts at 2 s; moving the second leaves silence.
      { id: "a_music", kind: "audio", name: null, follows: null, clips: [other("m_1", 0, 2), other("m_2", 2, 8)] },
      // Sound effect after a gap: it moves with the voice, no hole opens.
      { id: "a_fx", kind: "audio", name: null, follows: null, clips: [other("fx_1", 3, 3.5)] },
      // Footage crossing the restore point: nothing after it, nothing moves.
      { id: "v_broll", kind: "video", name: null, follows: null, clips: [other("b_1", 1, 4)] },
      { id: "s_subs", kind: "subtitles", name: null, follows: "v1", clips: [] },
    );
    const model = buildTranscriptModel(voice, sources);
    const plan = restorePlan(voice, model, [key("w_000004")])!;
    expect(plan.held).toEqual(["a_music"]);
    expect(plan.edits[0]).toEqual({
      op: "clip.trim",
      args: { clip: "c_a", out: 2.95, snapBounds: { out: { min: 2.9, max: 3 } }, ripple: true, rippleTracks: ["v1", "a_fx", "v_broll"] },
    });
    // The own track always moves, even where it would open a gap; the voice track is held from the music.
    expect(rippleScope(voice, "a_music", 2)).toEqual({ tracks: ["a_music", "a_fx", "v_broll"], held: ["v1"] });
  });
});

describe("struckRun", () => {
  it("gives the cut passage around a struck word, nothing for a kept one", () => {
    const words = wordsOf(buildTranscriptModel(cutView, sources));
    expect(struckRun(words, 3)).toEqual([key("w_000004"), key("w_000005")]);
    expect(struckRun(words, 4)).toEqual([key("w_000004"), key("w_000005")]);
    expect(struckRun(words, 2)).toEqual([]);
  });
});

describe("withWordText", () => {
  const file = `${JSON.stringify(transcript)}\n`;
  const editsOf = (content: string) => JSON.parse(content).edits;

  it("records a correction as a human edit and keeps the rest of the file", () => {
    const next = withWordText(file, "w_000001", "  Hola, ");
    expect(editsOf(next)).toEqual({ w_000007: { text: "cortar," }, w_000001: { text: "Hola," } });
    expect(JSON.parse(next).words).toEqual(transcript.words);
    expect(next.endsWith("}\n")).toBe(true);
    expect(parseTranscript(JSON.parse(next)).ok).toBe(true);
  });

  it("drops the edit when the text is cleared or back to what was transcribed", () => {
    expect(editsOf(withWordText(file, "w_000007", ""))).toEqual({});
    expect(editsOf(withWordText(file, "w_000007", "cortar"))).toEqual({});
  });

  it("refuses an unknown word", () => {
    expect(() => withWordText(file, "w_000099", "x")).toThrow(/no word w_000099/);
  });
});

describe("paragraphs", () => {
  it("breaks at long pauses, and at shorter ones after a sentence end", () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    const words = [w("Hola.", 0, 0.5), w("Hoy", 1.2, 1.5), w("vamos", 1.6, 2), w("a", 2.7, 2.8), w("cortar", 4.1, 4.5)];
    expect(paragraphs(words).map((p) => p.map((x) => x.text).join(" "))).toEqual(["Hola.", "Hoy vamos a", "cortar"]);
    expect(paragraphs([])).toEqual([]);
  });
});
