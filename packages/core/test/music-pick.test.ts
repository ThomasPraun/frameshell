import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type ClipTrack, type Timeline, createTimeline } from "@frameshell/schema";
import { describe, expect, it } from "vitest";
import { CANDIDATE_TRACK_NAME, candidateName } from "../src/music/candidates.js";
import { musicPickLabel, planMusicPick } from "../src/music/pick.js";

// `planMusicPick`: which tracks of a timeline `music.candidates` made are kept, removed, muted or left alone.
const candidate = (n: number, extra: Partial<ClipTrack> = {}, clip: Record<string, unknown> = {}): ClipTrack =>
  ({
    id: `t_${n}`,
    kind: "audio",
    name: candidateName(n),
    ...(n > 1 ? { muted: true } : {}),
    clips: [{ id: `c_${n}`, type: "media", asset: `assets/music/${n}.wav`, start: 1, in: 2, out: 30, audio: { gain: -3, fadeInMs: 5 }, ...clip }],
    ...extra,
  }) as ClipTrack;

const timelineOf = (...tracks: Timeline["tracks"]): Timeline => ({ ...createTimeline("main"), tracks: [{ id: "t_v", kind: "video", name: "Film", clips: [] }, ...tracks] });
const refusal = (run: () => unknown): RpcError => {
  try {
    run();
  } catch (error) {
    if (error instanceof RpcError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("planMusicPick", () => {
  it("unmutes the chosen track by name, renames it Music and removes the other candidates", () => {
    const { report, requests } = planMusicPick(timelineOf(candidate(1), candidate(2), candidate(3)), { track: "Music 2" });
    expect(requests).toEqual([
      { op: "track.set", args: { track: "t_2", muted: false, name: "Music" } },
      { op: "track.remove", args: { track: "t_1", force: true } },
      { op: "track.remove", args: { track: "t_3", force: true } },
    ]);
    expect(report).toMatchObject({
      chosen: { track: "t_2", name: "Music 2", asset: "assets/music/2.wav", clip: "c_2", renamedTo: "Music", unmuted: true },
      keep: false,
      removed: [
        { track: "t_1", name: "Music 1", asset: "assets/music/1.wav" },
        { track: "t_3", name: "Music 3", asset: "assets/music/3.wav" },
      ],
      muted: [],
      left: [],
      warnings: [],
    });
    expect(report.next).toContain("music fit");
    expect(report.next).toContain("--level");
    expect(musicPickLabel(report)).toBe("Music pick: Music 2");
  });

  it("takes a track id too, and does not unmute a track that already plays", () => {
    const { requests, report } = planMusicPick(timelineOf(candidate(1), candidate(2)), { track: "t_1" });
    expect(requests).toEqual([
      { op: "track.set", args: { track: "t_1", name: "Music" } },
      { op: "track.remove", args: { track: "t_2", force: true } },
    ]);
    expect(report.chosen.unmuted).toBe(false);
  });

  it("with keep, mutes the other candidates and leaves them in place", () => {
    const loud = candidate(3);
    delete loud.muted;
    const { requests, report } = planMusicPick(timelineOf(candidate(1), candidate(2), loud), { track: "Music 2", keep: true });
    expect(requests).toEqual([
      { op: "track.set", args: { track: "t_2", muted: false, name: "Music" } },
      // Music 1 plays (the first candidate is the one left unmuted), Music 3 was unmuted by hand: both go quiet.
      { op: "track.set", args: { track: "t_1", muted: true } },
      { op: "track.set", args: { track: "t_3", muted: true } },
    ]);
    expect(report).toMatchObject({ keep: true, removed: [], muted: [{ track: "t_1" }, { track: "t_3" }], left: [] });
    // A track that is already muted needs no operation but is still listed.
    const quiet = planMusicPick(timelineOf(candidate(1), candidate(2), candidate(3)), { track: "Music 1", keep: true });
    expect(quiet.requests).toEqual([{ op: "track.set", args: { track: "t_1", name: "Music" } }]);
    expect(quiet.report.muted.map((entry) => entry.track)).toEqual(["t_2", "t_3"]);
  });

  it("refuses a track that is not a candidate, naming the ones there are", () => {
    const film = refusal(() => planMusicPick(timelineOf(candidate(1), candidate(2)), { track: "Film" }));
    expect(film.code).toBe(ErrorCode.InvalidOperation);
    expect(film.data).toMatchObject({ reason: "not a candidate", hint: "Candidates: Music 1 (t_1), Music 2 (t_2)." });
    const video = timelineOf(candidate(1), { ...candidate(2), kind: "video" } as ClipTrack);
    expect(refusal(() => planMusicPick(video, { track: "t_1" })).data).toMatchObject({ reason: "no other candidate" });
    const title = candidate(3, {}, { type: "hyperframes", asset: undefined, duration: 3 });
    expect(refusal(() => planMusicPick(timelineOf(candidate(1), title), { track: "t_3" })).data).toMatchObject({ reason: "not a candidate" });
    const renamed = timelineOf(candidate(1), candidate(2, { name: "Theme" }));
    expect(refusal(() => planMusicPick(renamed, { track: "t_2" })).data).toMatchObject({ reason: "not a candidate" });
  });

  it("refuses an unknown track, an ambiguous name and a pick with nothing to pick between", () => {
    expect(refusal(() => planMusicPick(timelineOf(candidate(1), candidate(2)), { track: "Music 9" })).code).toBe(ErrorCode.TrackNotFound);
    const twice = timelineOf(candidate(1), candidate(2, { id: "t_x" }), candidate(2));
    expect(refusal(() => planMusicPick(twice, { track: "Music 2" })).data).toMatchObject({ reason: "ambiguous name" });
    const alone = refusal(() => planMusicPick(timelineOf(candidate(1)), { track: "Music 1" }));
    expect(alone.data).toMatchObject({ reason: "no other candidate" });
  });

  it("leaves a candidate the person edited in place, named, and removes the rest", () => {
    const fitted = candidate(2, {}, { speed: 1.01 });
    const keyed = candidate(3, {}, { keys: { gain: [{ at: 0, value: -6 }] } });
    const faded = candidate(4, {}, { fadeOut: 2 });
    const two = candidate(5);
    two.clips.push({ id: "c_5b", type: "media", asset: "assets/music/x.wav", start: 40, in: 0, out: 5 } as never);
    const shaped = candidate(6, {}, { audio: { gain: -3, effects: [{ kind: "highpass" }] } });
    const { requests, report } = planMusicPick(timelineOf(candidate(1), fitted, keyed, faded, two, shaped, candidate(7)), { track: "Music 1" });
    expect(requests).toEqual([
      { op: "track.set", args: { track: "t_1", name: "Music" } },
      { op: "track.remove", args: { track: "t_7", force: true } },
    ]);
    expect(report.removed.map((entry) => entry.track)).toEqual(["t_7"]);
    expect(report.left.map((entry) => [entry.track, entry.reason])).toEqual([
      ["t_2", "its clip was edited (speed)."],
      ["t_3", "its clip was edited (keys)."],
      ["t_4", "its clip was edited (fadeOut)."],
      ["t_5", "it holds 2 clips, not the one that was placed."],
      ["t_6", "its clip was edited (audio.effects)."],
    ]);
    expect(report.warnings).toHaveLength(5);
    expect(report.warnings[0]).toContain("Music 2 (t_2) is left in place");
  });

  it("does not count the placement's own start, in and gain as an edit", () => {
    const moved = candidate(2, {}, { start: 12.5, in: 7, out: 20, audio: { gain: -9.5, fadeInMs: 5 } });
    expect(planMusicPick(timelineOf(candidate(1), moved), { track: "Music 1" }).report.removed.map((entry) => entry.track)).toEqual(["t_2"]);
  });

  it("leaves a candidate that a subtitle track follows", () => {
    const captions = { id: "t_s", kind: "subtitles", name: "Captions", follows: "t_2", clips: [] } as unknown as Timeline["tracks"][number];
    const { report } = planMusicPick(timelineOf(candidate(1), candidate(2), captions), { track: "Music 1" });
    expect(report.removed).toEqual([]);
    expect(report.left).toEqual([expect.objectContaining({ track: "t_2", reason: "the subtitle track t_s follows it." })]);
  });

  it("keeps the track's own name, with a warning, when a track called Music exists", () => {
    const music = { id: "t_m", kind: "audio", name: "Music", clips: [] } as ClipTrack;
    const { requests, report } = planMusicPick(timelineOf(music, candidate(1), candidate(2)), { track: "Music 2" });
    expect(requests[0]).toEqual({ op: "track.set", args: { track: "t_2", muted: false } });
    expect(report.chosen.renamedTo).toBeNull();
    expect(report.warnings).toEqual(["A track named Music already exists: Music 2 (t_2) keeps its name."]);
  });

  it("warns about a track named like a candidate that is not one, and leaves it", () => {
    const title = candidate(3, {}, { type: "hyperframes", asset: undefined, duration: 3 });
    const { requests, report } = planMusicPick(timelineOf(candidate(1), candidate(2), title), { track: "Music 1" });
    expect(requests.map((request) => request.args["track" as never])).toEqual(["t_1", "t_2"]);
    expect(report.warnings.join(" ")).toContain("Music 3 (t_3) is not an audio track of media clips only");
  });

  it("uses the one candidate name pattern music.candidates writes", () => {
    expect(CANDIDATE_TRACK_NAME.test(candidateName(4))).toBe(true);
    expect(CANDIDATE_TRACK_NAME.test("Music")).toBe(false);
  });
});
