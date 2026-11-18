import type { ScriptOutlineResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { sameBoxes, sceneBoxes, scriptFiles, affectsScenes } from "../src/renderer/src/timeline/scenes.js";
import type { FileNode } from "../src/shared/api.js";

// Seam under test: how `script.outline` results become the scene band of one timeline.

type Scene = ScriptOutlineResult["scenes"][number];

const range = { transcript: "talk.words.json", from: "w_000001", to: "w_000009" };

function scene(slug: string, over: Partial<Scene> = {}): Scene {
  return {
    title: slug[0]!.toUpperCase() + slug.slice(1),
    slug,
    line: 1,
    endLine: 2,
    wordRange: range,
    ref: `scripts/plan.md#${slug}`,
    clips: [],
    span: [],
    ...over,
  } as Scene;
}

function outline(path: string, scenes: Scene[]): ScriptOutlineResult {
  return { path, meta: {}, clips: [], scenes, unresolved: [], warnings: [] } as unknown as ScriptOutlineResult;
}

describe("sceneBoxes", () => {
  it("makes a box per scene whose words the timeline places, in start order", () => {
    const boxes = sceneBoxes(
      [
        outline("scripts/plan.md", [
          scene("outro", { span: [{ timeline: "main", start: 20, end: 30, words: 4, source: "words" }] }),
          scene("intro", { span: [{ timeline: "main", start: 0, end: 12.5, words: 9, source: "words" }] }),
        ]),
      ],
      "main",
    );
    expect(boxes.map((box) => [box.slug, box.start, box.end])).toEqual([
      ["intro", 0, 12.5],
      ["outro", 20, 30],
    ]);
    expect(boxes[0]).toMatchObject({ script: "scripts/plan.md", title: "Intro" });
  });

  it("leaves out scenes without a span on the timeline, or with an empty one", () => {
    const boxes = sceneBoxes(
      [
        outline("scripts/plan.md", [
          scene("elsewhere", { span: [{ timeline: "intro", start: 0, end: 3, words: 1, source: "words" }] }),
          scene("unplaced", { span: [] }),
          scene("empty", { span: [{ timeline: "main", start: 4, end: 4, words: 1, source: "words" }] }),
          scene("kept", { span: [{ timeline: "main", start: 5, end: 6, words: 1, source: "words" }] }),
        ]),
      ],
      "main",
    );
    expect(boxes.map((box) => box.slug)).toEqual(["kept"]);
  });

  it("shows a storyboard scene that has no words: from its clips, or planned from its heading, with its source", () => {
    const boxes = sceneBoxes(
      [
        outline("scripts/film.md", [
          scene("hook", {
            wordRange: null,
            span: [{ timeline: "main", start: 0, end: 6, words: 0, source: "planned" }],
          }),
          scene("proof", {
            wordRange: null,
            clips: [{ timeline: "main", clip: "c_a" }],
            span: [{ timeline: "main", start: 6, end: 18, words: 0, source: "clips" }],
          }),
          scene("payoff", { wordRange: null, span: [{ timeline: "alt", start: 18, end: 24, words: 0, source: "clips" }] }),
        ]),
      ],
      "main",
    );
    expect(boxes.map((box) => [box.slug, box.start, box.end, box.source, box.clips])).toEqual([
      ["hook", 0, 6, "planned", []],
      ["proof", 6, 18, "clips", ["c_a"]],
    ]);
  });

  it("counts only this timeline's clips: a scene realized on another timeline is still hollow here", () => {
    const placed: Scene["span"] = [
      { timeline: "main", start: 0, end: 5, words: 3, source: "words" },
      { timeline: "alt", start: 0, end: 5, words: 3, source: "words" },
    ];
    const [box] = sceneBoxes(
      [
        outline("scripts/plan.md", [
          scene("intro", {
            span: placed,
            clips: [
              { timeline: "alt", clip: "c_x" },
              { timeline: "main", clip: "c_a" },
              { timeline: "main", clip: "c_b" },
            ],
          }),
        ]),
      ],
      "main",
    );
    expect(box!.clips).toEqual(["c_a", "c_b"]);
    const [hollow] = sceneBoxes([outline("scripts/plan.md", [scene("intro", { span: placed, clips: [{ timeline: "alt", clip: "c_x" }] })])], "main");
    expect(hollow!.clips).toEqual([]);
  });

  it("merges scripts, keeping which one each scene is from", () => {
    const boxes = sceneBoxes(
      [
        outline("scripts/b.md", [scene("one", { span: [{ timeline: "main", start: 10, end: 11, words: 1, source: "words" }] })]),
        outline("scripts/a.md", [scene("one", { span: [{ timeline: "main", start: 0, end: 1, words: 1, source: "words" }] })]),
      ],
      "main",
    );
    expect(boxes.map((box) => box.script)).toEqual(["scripts/a.md", "scripts/b.md"]);
  });
});

describe("scriptFiles and affectsScenes", () => {
  const tree: FileNode[] = [
    {
      kind: "dir",
      name: "scripts",
      path: "scripts",
      children: [
        { kind: "file", name: "plan.md", path: "scripts/plan.md" },
        { kind: "file", name: "notes.txt", path: "scripts/notes.txt" },
        { kind: "dir", name: "old", path: "scripts/old", children: [{ kind: "file", name: "a.md", path: "scripts/old/a.md" }] },
      ],
    },
    { kind: "file", name: "README.md", path: "README.md" },
  ];

  it("lists the Markdown files under scripts/", () => {
    expect(scriptFiles(tree)).toEqual(["scripts/plan.md", "scripts/old/a.md"]);
  });

  it("re-reads the spans for scripts and transcripts only", () => {
    expect(affectsScenes(["scripts/plan.md"])).toBe(true);
    expect(affectsScenes(["assets/a.mp4", "transcripts/talk.words.json"])).toBe(true);
    expect(affectsScenes(["beats/music.beats.json"])).toBe(true);
    expect(affectsScenes(["assets/a.mp4", "README.md", "scripts/notes.txt"])).toBe(false);
  });
});

describe("sameBoxes", () => {
  const box = { script: "scripts/plan.md", slug: "intro", title: "Intro", start: 0, end: 5, clips: ["c_a"], source: "words" as const };

  it("tells a re-read that found nothing new from one that did", () => {
    expect(sameBoxes([box], [{ ...box, clips: ["c_a"] }])).toBe(true);
    expect(sameBoxes([box], [{ ...box, clips: [] }])).toBe(false);
    expect(sameBoxes([box], [{ ...box, end: 6 }])).toBe(false);
    expect(sameBoxes([box], [{ ...box, source: "planned" }])).toBe(false);
    expect(sameBoxes([box], [])).toBe(false);
  });
});
