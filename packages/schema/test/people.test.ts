import { describe, expect, it } from "vitest";
import { createPeopleFile, findPerson, generateJsonSchemas, parsePeopleFile } from "../src/index.js";

const JUAN = {
  id: "p_3fa2c1",
  name: "Juan",
  speakers: [{ transcript: "transcripts/ep1.words.json", speaker: "s1" }, { transcript: "transcripts/juan-lav.words.json" }],
  angles: [{ timeline: "main", group: "g_talk", angle: "juan", by: "agent:claude:s1" }],
  faces: [{ asset: "assets/ep1.mp4", at: 12.5, x: 0.41, y: 0.33 }],
};
const file = (...people: unknown[]) => ({ schemaVersion: 1, people, dismissed: ["sg_9c04e1d2"] });

describe("people.json", () => {
  it("round-trips the ADR's example unchanged", () => {
    const parsed = parsePeopleFile(file(JUAN));
    expect(parsed.ok && parsed.value).toEqual(file(JUAN));
    const again = parsePeopleFile(JSON.parse(JSON.stringify(parsed.ok && parsed.value)));
    expect(again).toEqual(parsed);
  });

  it("fills in what a hand-written file leaves out", () => {
    const parsed = parsePeopleFile({ schemaVersion: 1, people: [{ id: "p_juan", name: " Juan " }] });
    expect(parsed).toEqual({ ok: true, value: { schemaVersion: 1, people: [{ id: "p_juan", name: "Juan", speakers: [], angles: [], faces: [] }], dismissed: [] } });
    expect(parsePeopleFile({ schemaVersion: 1 })).toEqual({ ok: true, value: { schemaVersion: 1, people: [], dismissed: [] } });
    expect(parsePeopleFile(createPeopleFile()).ok).toBe(true);
  });

  it("refuses bad ids, unknown fields, empty names and anchors outside the picture", () => {
    for (const bad of [
      file({ id: "juan", name: "Juan" }),
      file({ id: "p_", name: "Juan" }),
      file({ id: "p_a", name: "  " }),
      file({ id: "p_a", name: "Juan", embedding: [1] }),
      file({ id: "p_a", name: "Juan", faces: [{ asset: "a.mp4", at: 1, x: 1.2, y: 0.5 }] }),
      file({ id: "p_a", name: "Juan", faces: [{ asset: "a.mp4", at: -1, x: 0.5, y: 0.5 }] }),
      file({ id: "p_a", name: "Juan", speakers: [{ transcript: "t.words.json", speaker: "juan" }] }),
      { ...file(), schemaVersion: 2 },
    ]) {
      expect(parsePeopleFile(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps names unique ignoring case, and ids unique", () => {
    const names = parsePeopleFile(file({ id: "p_a", name: "Juan" }, { id: "p_b", name: "JUAN" }));
    expect(names).toMatchObject({ ok: false });
    expect(!names.ok && names.error).toContain('people.1.name: name "JUAN" is already taken by "Juan"');
    const ids = parsePeopleFile(file({ id: "p_a", name: "Juan" }, { id: "p_a", name: "Ana" }));
    expect(!ids.ok && ids.error).toContain('duplicate id "p_a"');
  });

  it("gives a speaker, an angle and an anchor to one person at most", () => {
    const ana = (links: Record<string, unknown>) => ({ id: "p_ana", name: "Ana", ...links });
    const refuses = (links: Record<string, unknown>) => expect(parsePeopleFile(file(JUAN, ana(links))).ok, JSON.stringify(links)).toBe(false);
    refuses({ speakers: [{ transcript: "transcripts/ep1.words.json", speaker: "s1" }] });
    refuses({ speakers: [{ transcript: "transcripts/juan-lav.words.json" }] });
    // A whole transcript excludes another person's speaker of it, and the other way round.
    refuses({ speakers: [{ transcript: "transcripts/ep1.words.json" }] });
    refuses({ speakers: [{ transcript: "transcripts/juan-lav.words.json", speaker: "s2" }] });
    refuses({ angles: [{ timeline: "main", group: "g_talk", angle: "juan" }] });
    refuses({ faces: [{ asset: "assets/ep1.mp4", at: 12.5, x: 0.41, y: 0.33 }] });
    // Other targets are free.
    const free = ana({
      speakers: [{ transcript: "transcripts/ep1.words.json", speaker: "s2" }],
      angles: [{ timeline: "main", group: "g_talk", angle: "ana" }],
      faces: [{ asset: "assets/ep1.mp4", at: 12.5, x: 0.9, y: 0.33 }],
    });
    expect(parsePeopleFile(file(JUAN, free)).ok).toBe(true);
  });

  it("refuses the same link twice for one person", () => {
    const twice = { ...JUAN, speakers: [JUAN.speakers[0], JUAN.speakers[0]] };
    expect(parsePeopleFile(file(twice)).ok).toBe(false);
  });

  it("finds a person by id, else by name ignoring case", () => {
    const parsed = parsePeopleFile(file(JUAN, { id: "p_ana", name: "Ana" }));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(findPerson(parsed.value, "p_3fa2c1")?.name).toBe("Juan");
    expect(findPerson(parsed.value, "ANA")?.id).toBe("p_ana");
    expect(findPerson(parsed.value, "Ju")).toBeUndefined();
  });

  it("publishes a JSON Schema that leaves defaulted fields optional", () => {
    const schema = generateJsonSchemas()["people.json"] as { $id: string; required: string[]; properties: Record<string, unknown> };
    expect(schema.$id).toBe("https://frameshell.dev/schema/v1/people.json");
    expect(schema.required).toEqual(["schemaVersion"]);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["people", "dismissed"]));
  });
});
