import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Clip, Timeline } from "@frameshell/schema";
import { type PremiereAssetInfo, XMEML_VERSION, premiereAssetUrl, timelineToPremiereXml } from "../src/index.js";
import { type XNode, all, one, parseXml, premiereProblems, textOf, tracksOf, within } from "./premiere-check.js";

// Golden file: the reviewed xmeml document. Regenerate with UPDATE_GOLDEN=1 and review the diff.
const GOLDEN_DIR = fileURLToPath(new URL("./golden/", import.meta.url));

function golden(name: string, actual: string): void {
  const path = `${GOLDEN_DIR}${name}.xml`;
  if (process.env["UPDATE_GOLDEN"] || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    if (!process.env["UPDATE_GOLDEN"]) throw new Error(`golden ${name} was missing and has been written; review and rerun`);
  }
  expect(actual).toBe(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

const assetUrl = (asset: string) => premiereAssetUrl({ root: "/p/video", flavour: "posix" }, asset);
const size = { width: 1920, height: 1080 };

const TAKE: PremiereAssetInfo = { seconds: 60, width: 1920, height: 1080, audio: { channels: 2, sampleRate: 48_000 } };
const assetInfo = (asset: string): PremiereAssetInfo | undefined => (asset.endsWith(".wav") ? { seconds: 120, audio: { channels: 2, sampleRate: 44_100 } } : TAKE);

function timelineOf(tracks: unknown[], extra: Record<string, unknown> = {}): Timeline {
  return { schemaVersion: 1, id: "main", revision: 4, tracks, ...extra } as Timeline;
}

function media(id: string, start: number, from: number, to: number, extra: Record<string, unknown> = {}): Clip {
  return { id, type: "media", asset: "assets/take.mp4", start, in: from, out: to, ...extra } as Clip;
}

const GEN = { id: "c_gen", type: "hyperframes", start: 0, duration: 2, source: "compositions/hyperframes/intro/index.html" } as Clip;

function convert(timeline: Timeline, fps = 30, extra: Partial<Parameters<typeof timelineToPremiereXml>[1]> = {}) {
  const result = timelineToPremiereXml(timeline, { fps, size, assetUrl, assetInfo, ...extra });
  return { ...result, doc: parseXml(result.xml) };
}

const num = (node: XNode, name: string) => Number(textOf(node, name));
const clipitems = (track: XNode) => all(track, "clipitem");

describe("timelineToPremiereXml", () => {
  it("writes xmeml version 4 from one constant, with the sequence at the project rate and size", () => {
    expect(XMEML_VERSION).toBe(4);
    const { doc, xml } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4)] }]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n')).toBe(true);
    const sequence = one(doc, "sequence");
    expect(textOf(sequence, "name")).toBe("main");
    expect(textOf(sequence, "duration")).toBe("60");
    const format = one(one(one(one(one(sequence, "media"), "video"), "format"), "samplecharacteristics"), "width");
    expect(format.text).toBe("1920");
    expect(textOf(one(one(sequence, "media"), "video").kids[0]!.kids[0]!, "height")).toBe("1080");
    expect(premiereProblems(xml)).toEqual([]);
  });

  it.each([30, 24])("two media clips with a hole: exact frames at %i fps, the hole is the difference of the two positions", (fps) => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 11.5)] }]);
    const { doc, warnings, tracks, clips, markers, xml } = convert(timeline, fps);
    expect(warnings).toEqual([]);
    // The sound of the two pictures is a track of its own and adds no clip to the count.
    expect([tracks, clips, markers]).toEqual([2, 2, 0]);
    const [first, second] = clipitems(tracksOf(doc, "video")[0]!);
    expect([num(first!, "start"), num(first!, "end"), num(first!, "in"), num(first!, "out")]).toEqual([0, 2 * fps, 2 * fps, 4 * fps]);
    expect([num(second!, "start"), num(second!, "end"), num(second!, "in"), num(second!, "out")]).toEqual([5 * fps, 6.5 * fps, 10 * fps, 11.5 * fps]);
    expect(textOf(first!, "name")).toBe("take.mp4");
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("the file is defined once, in the first picture that uses it, and referenced everywhere else", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 11.5)] }]);
    const { doc } = convert(timeline);
    const files = within(doc, "file");
    // Two pictures and their two sounds: one full definition, three references.
    expect(files.map((file) => [file.attrs["id"], file.kids.length > 0])).toEqual([
      ["file-1", true],
      ["file-1", false],
      ["file-1", false],
      ["file-1", false],
    ]);
    const full = files[0]!;
    expect(textOf(full, "name")).toBe("take.mp4");
    expect(textOf(full, "pathurl")).toBe("file://localhost/p/video/assets/take.mp4");
    expect(textOf(full, "duration")).toBe("1800");
    expect(within(full, "samplerate").map((node) => node.text)).toEqual(["48000"]);
    expect(within(full, "width").map((node) => node.text)).toEqual(["1920"]);
  });

  it.each([
    [24000 / 1001, "24", "TRUE"],
    [30000 / 1001, "30", "TRUE"],
    [60000 / 1001, "60", "TRUE"],
    [24, "24", "FALSE"],
    [25, "25", "FALSE"],
    [30, "30", "FALSE"],
    [60, "60", "FALSE"],
  ])("rate %f is timebase %s, ntsc %s", (fps, timebase, ntsc) => {
    const { doc, warnings } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 2)] }]), fps);
    const rate = one(one(doc, "sequence"), "rate");
    expect([textOf(rate, "timebase"), textOf(rate, "ntsc")]).toEqual([timebase, ntsc]);
    expect(warnings).toEqual([]);
  });

  it("29.97 counts whole frames at 29.97: a clip of 2 s is 60 frames", () => {
    const { doc } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 2)] }]), 30000 / 1001);
    expect(num(clipitems(tracksOf(doc, "video")[0]!)[0]!, "end")).toBe(60);
  });

  it("a rate xmeml cannot name is written at the nearest whole one, with a warning", () => {
    const { doc, warnings } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 2)] }]), 27.5);
    expect(textOf(one(one(doc, "sequence"), "rate"), "timebase")).toBe("28");
    expect(warnings).toEqual(["frame rate 27.5 is not one xmeml can name: times are written at 28 fps and drift against the media."]);
  });

  it("speed 2: `out` reads twice the timeline length of source from `in`, and a Time Remap filter of 200 % is on the picture and its sound", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_fast", 0, 10, 14, { speed: 2 })] }]);
    const { doc, xml } = convert(timeline);
    const [picture] = clipitems(tracksOf(doc, "video")[0]!);
    expect([num(picture!, "start"), num(picture!, "end"), num(picture!, "in"), num(picture!, "out")]).toEqual([0, 60, 300, 420]);
    const remap = (item: XNode) => within(item, "parameter").find((parameter) => all(parameter, "parameterid")[0]?.text === "speed");
    expect(textOf(remap(picture!)!, "value")).toBe("200");
    expect(textOf(within(picture!, "effect")[0]!, "name")).toBe("Time Remap");
    const [sound] = clipitems(tracksOf(doc, "audio")[0]!);
    expect(textOf(sound!, "end")).toBe("60");
    expect(textOf(within(sound!, "effect")[0]!, "mediatype")).toBe("audio");
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("the sound of a video-track clip is a linked audio clip item on a track after the real audio tracks", () => {
    const timeline = timelineOf([
      { id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 4, 0, 1)] },
      { id: "t_a1", kind: "audio", clips: [{ id: "c_m", type: "media", asset: "assets/music/theme.wav", start: 0, in: 0, out: 9 } as Clip] },
    ]);
    const { doc, xml, tracks, clips } = convert(timeline);
    expect([tracks, clips]).toEqual([3, 3]);
    const audio = tracksOf(doc, "audio");
    expect(audio.map((track) => clipitems(track).length)).toEqual([1, 2]);
    const music = clipitems(audio[0]!)[0]!;
    expect(all(music, "link")).toEqual([]);
    const [sound] = clipitems(audio[1]!);
    const picture = clipitems(tracksOf(doc, "video")[0]!)[0]!;
    const links = (item: XNode) => all(item, "link").map((link) => [textOf(link, "linkclipref"), textOf(link, "mediatype"), textOf(link, "trackindex"), textOf(link, "clipindex")]);
    // The first audio track is the real one, so the mirror is the second.
    expect(links(picture)).toEqual([
      [picture.attrs["id"], "video", "1", "1"],
      [sound!.attrs["id"], "audio", "2", "1"],
    ]);
    expect(links(sound!)).toEqual(links(picture));
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("hidden video track, muted audio track and muted video track are disabled where their picture or sound is", () => {
    const timeline = timelineOf([
      { id: "t_v1", kind: "video", hidden: true, clips: [media("c_a", 0, 0, 1)] },
      { id: "t_v2", kind: "video", muted: true, clips: [media("c_b", 0, 0, 1)] },
      { id: "t_a1", kind: "audio", muted: true, clips: [media("c_m", 0, 0, 1)] },
    ]);
    const { doc } = convert(timeline);
    const enabled = (track: XNode) => textOf(track, "enabled");
    expect(tracksOf(doc, "video").map(enabled)).toEqual(["FALSE", "TRUE"]);
    // A hidden video track still plays its sound; a muted one does not, and the real audio track follows its own mute.
    expect(tracksOf(doc, "audio").map(enabled)).toEqual(["FALSE", "TRUE", "FALSE"]);
  });

  it("a muted clip keeps its picture and is a disabled slot in its sound", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 1, { audio: { muted: true } })] }]);
    const { doc } = convert(timeline);
    expect(textOf(clipitems(tracksOf(doc, "video")[0]!)[0]!, "enabled")).toBe("TRUE");
    expect(textOf(clipitems(tracksOf(doc, "audio")[0]!)[0]!, "enabled")).toBe("FALSE");
  });

  it("a still image on a video track has no sound to mirror and a file as long as the timeline plays it", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [{ id: "c_s", type: "media", asset: "assets/photo.png", start: 0, in: 0, out: 3 } as Clip] }]);
    const { doc, tracks, xml } = convert(timeline, 30, { assetInfo: () => ({ seconds: Number.POSITIVE_INFINITY, silent: true, width: 800, height: 600 }) });
    expect(tracks).toBe(1);
    expect(tracksOf(doc, "audio")).toEqual([]);
    expect(textOf(within(doc, "file")[0]!, "duration")).toBe("90");
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("a generated clip keeps its slot as a clip item with an offline file of its length, and a warning", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [GEN, { id: "c_inner", type: "timeline", start: 2, duration: 1.5, source: "timelines/inner.json" } as Clip] }]);
    const { doc, warnings, clips, tracks, xml } = convert(timeline);
    expect([clips, tracks]).toEqual([2, 1]);
    expect(warnings).toEqual([
      "generated clip c_gen (hyperframes) exported as missing media of its length: render it and relink the file by hand.",
      "nested timeline clip c_inner (inner) exported as missing media of its length: export that timeline on its own and relink it.",
    ]);
    const [gen, inner] = clipitems(tracksOf(doc, "video")[0]!);
    expect([textOf(gen!, "name"), num(gen!, "start"), num(gen!, "end"), num(gen!, "in"), num(gen!, "out"), num(gen!, "duration")]).toEqual(["hyperframes intro", 0, 60, 0, 60, 60]);
    expect(textOf(inner!, "name")).toBe("timeline inner");
    const file = one(gen!, "file");
    expect(all(file, "pathurl")).toEqual([]);
    expect(file.attrs["id"]).not.toBe(one(inner!, "file").attrs["id"]);
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("a nested clip of unknown length is skipped with a warning", () => {
    const { warnings, clips } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [{ id: "c_inner", type: "timeline", start: 0, source: "timelines/inner.json" } as Clip] }]));
    expect(clips).toBe(0);
    expect(warnings).toEqual(["clip c_inner (nested timelines/inner.json) has no known length: skipped."]);
  });

  it("markers: label, whole frame, sorted by time; their colour is named in a warning", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 0, 1)] }], {
      markers: [
        { id: "m_2", at: 3, label: "late" },
        { id: "m_1", at: 1.5, label: "hook", color: "blue" },
      ],
    });
    const { doc, markers, warnings } = convert(timeline);
    expect(markers).toBe(2);
    const found = all(one(doc, "sequence"), "marker");
    expect(found.map((marker) => [textOf(marker, "name"), num(marker, "in"), num(marker, "out")])).toEqual([
      ["hook", 45, -1],
      ["late", 90, -1],
    ]);
    expect(warnings).toEqual(["marker colours not exported."]);
  });

  describe("dissolves", () => {
    const muted = { audio: { muted: true } };
    const butted = (extra: Record<string, unknown> = {}, handleSeconds: number | null = 100) =>
      convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4, muted), media("c_b", 2, 5, 7, { ...muted, dissolve: 1, ...extra })] }]), 30, {
        sourceDuration: () => handleSeconds ?? undefined,
      });

    it("a dissolve between butted clips is one Cross Dissolve centred on the cut, half the length each side", () => {
      const { doc, warnings, xml } = butted();
      expect(warnings).toEqual([]);
      const track = tracksOf(doc, "video")[0]!;
      expect(track.kids.map((kid) => kid.name).slice(0, 3)).toEqual(["clipitem", "transitionitem", "clipitem"]);
      const transition = all(track, "transitionitem")[0]!;
      expect([num(transition, "start"), num(transition, "end"), textOf(transition, "alignment")]).toEqual([45, 75, "center"]);
      expect(textOf(one(transition, "effect"), "name")).toBe("Cross Dissolve");
      expect(textOf(one(transition, "effect"), "mediatype")).toBe("video");
      // The clips keep their own lengths: nothing moves for the dissolve.
      expect(clipitems(track).map((item) => [num(item, "start"), num(item, "end")])).toEqual([
        [0, 60],
        [60, 120],
      ]);
      expect(premiereProblems(xml)).toEqual([]);
    });

    it("the sound is crossfaded where both clips have sound", () => {
      const { doc } = convert(timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), media("c_b", 2, 5, 7, { dissolve: 1 })] }]), 30, { sourceDuration: () => 100 });
      const transition = all(tracksOf(doc, "audio")[0]!, "transitionitem")[0]!;
      expect([textOf(one(transition, "effect"), "name"), textOf(one(transition, "effect"), "mediatype"), num(transition, "start"), num(transition, "end")]).toEqual(["Cross Fade (+3dB)", "audio", 45, 75]);
    });

    it("no transition on the sound where the clip before it has none to mirror", () => {
      const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [{ ...GEN }, media("c_b", 2, 5, 7, { dissolve: 0.6 })] }]);
      const { doc } = convert(timeline, 30, { sourceDuration: () => 100 });
      expect(all(tracksOf(doc, "video")[0]!, "transitionitem")).toHaveLength(1);
      expect(all(tracksOf(doc, "audio")[0]!, "transitionitem")).toEqual([]);
    });

    it("a dissolve with no handle plays as a dip: no transition item, one warning", () => {
      const { doc, warnings } = butted({}, null);
      expect(all(tracksOf(doc, "video")[0]!, "transitionitem")).toEqual([]);
      expect(warnings).toEqual(["dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it) on 1 clip not exported (c_b)."]);
    });

    it("a shaped dissolve is a plain Cross Dissolve with a warning", () => {
      const { doc, warnings } = butted({ shape: { kind: "wipe" } });
      expect(all(tracksOf(doc, "video")[0]!, "transitionitem")).toHaveLength(1);
      expect(warnings).toEqual(["transition shape (its dissolve is written as a plain one) on 1 clip not exported (c_b)."]);
    });
  });

  it("names what the file does not carry, one line per kind, the sound of a video clip is not among them", () => {
    const timeline = timelineOf(
      [
        {
          id: "t_v1",
          kind: "video",
          clips: [
            media("c_a", 0, 0, 2, { transform: { x: 10 }, grade: { exposure: 1 }, fadeIn: 0.2, audio: { gain: -6, fadeOutMs: 100 } }),
            media("c_b", 2, 0, 1, { keys: { x: [] }, formats: {}, vignette: { amount: 0.3 } }),
          ],
        },
        { id: "t_a1", kind: "audio", clips: [media("c_m", 0, 0, 1, { audio: { gain: 3, effects: [{ type: "gate" }] } })] },
        { id: "t_s1", kind: "subtitles", follows: "t_a1", cues: [] },
        { id: "t_p1", kind: "program", group: "g", clips: [] },
        { id: "t_v2", kind: "video", behind: "t_v1", clips: [] },
      ],
      { letterbox: { aspect: 2.39 } },
    );
    const { warnings } = convert(timeline);
    expect(warnings).toEqual([
      "subtitle track t_s1 not exported.",
      "program track t_p1 (multicam shots) not exported: 0 shots skipped.",
      "video track t_v2 sits behind the person on track t_v1 (subject matte): exported as a plain track.",
      "letterbox bars not exported.",
      "dips and fades (fadeIn, fadeOut, dissolve with no handle or no clip before it) on 1 clip not exported (c_a).",
      "transform and keys on 2 clips not exported (c_a, c_b).",
      "colour grade on 1 clip not exported (c_a).",
      "sound fades (audio.fadeInMs, audio.fadeOutMs) on 1 clip not exported (c_a).",
      "clip gain (audio.gain) on 2 clips not exported (c_a, c_m).",
      "film finish and effects on 1 clip not exported (c_b).",
      "per-format overrides on 1 clip not exported (c_b).",
      "audio effects on 1 clip not exported (c_m).",
    ]);
  });

  it("escapes & < > \" ' in names and paths, and the text comes back whole", () => {
    const asset = "assets/Tom & Jerry <\"final\"> it's.mp4";
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [{ id: "c_a", type: "media", asset, start: 0, in: 0, out: 1 } as Clip] }], {
      markers: [{ id: "m_1", at: 0, label: "a & b < c" }],
    });
    const { doc, xml } = convert(timeline);
    expect(xml).toContain("Tom &amp; Jerry &lt;&quot;final&quot;&gt; it&apos;s.mp4");
    expect(xml).not.toContain("Tom & Jerry");
    expect(textOf(clipitems(tracksOf(doc, "video")[0]!)[0]!, "name")).toBe("Tom & Jerry <\"final\"> it's.mp4");
    expect(textOf(all(one(doc, "sequence"), "marker")[0]!, "name")).toBe("a & b < c");
    expect(premiereProblems(xml)).toEqual([]);
  });

  it("is deterministic: the same timeline gives the same bytes", () => {
    const timeline = timelineOf([{ id: "t_v1", kind: "video", clips: [media("c_a", 0, 2, 4), GEN].map((clip, index) => (index === 1 ? { ...clip, start: 5 } : clip)) as Clip[] }]);
    expect(convert(timeline).xml).toBe(convert(timeline).xml);
  });

  it("matches the golden document of a small edit", () => {
    const timeline = timelineOf(
      [
        {
          id: "t_v1",
          kind: "video",
          clips: [media("c_a", 0, 2, 4), media("c_b", 5, 10, 14, { speed: 2 }), { id: "c_gen", type: "hyperframes", start: 7, duration: 2, source: "compositions/hyperframes/title/index.html" }],
        },
        { id: "t_a1", kind: "audio", name: "Music", muted: true, clips: [{ id: "c_m", type: "media", asset: "assets/music/theme.wav", start: 0, in: 0, out: 9 }] },
      ],
      { markers: [{ id: "m_1", at: 5, label: "hook", color: "orange" }] },
    );
    const result = convert(timeline);
    golden("premiere-edit", result.xml);
    expect(premiereProblems(result.xml)).toEqual([]);
  });
});

describe("premiereAssetUrl", () => {
  it("is always absolute, in Premiere's spelling, with each segment percent-encoded", () => {
    expect(premiereAssetUrl({ root: "/Users/me/video one", flavour: "posix" }, "assets/clip #1.mp4")).toBe("file://localhost/Users/me/video%20one/assets/clip%20%231.mp4");
  });

  it("writes a Windows drive as C%3a, whatever the machine's separator", () => {
    expect(premiereAssetUrl({ root: "C:\\Users\\me\\video", flavour: "win32" }, "assets/take 2.mp4")).toBe("file://localhost/C%3a/Users/me/video/assets/take%202.mp4");
    expect(premiereAssetUrl({ root: "d:\\p", flavour: "win32" }, "assets/shoot/a.mp4")).toBe("file://localhost/d%3a/p/assets/shoot/a.mp4");
  });
});

describe("premiereProblems", () => {
  it("catches a file referenced before its definition, an overlap and a link nobody answers", () => {
    const bad = `<?xml version="1.0"?>
<!DOCTYPE xmeml>
<xmeml version="4"><sequence><media><video><track>
<clipitem id="a"><duration>9</duration><start>0</start><end>5</end><in>0</in><out>5</out><file id="f1"/></clipitem>
<clipitem id="b"><duration>9</duration><start>3</start><end>8</end><in>0</in><out>5</out><file id="f1"><name>x</name></file>
<link><linkclipref>a</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link></clipitem>
</track></video><audio></audio></media></sequence></xmeml>`;
    expect(premiereProblems(bad)).toEqual([
      "file f1 referenced before it is defined",
      "b: overlaps the clip before it on its track",
      "b: a does not link back",
    ]);
    expect(premiereProblems("<xmeml version=\"4\"><a></xmeml>")[0]).toMatch(/not well-formed/);
  });
});
