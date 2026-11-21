import { describe, expect, it } from "vitest";
import { ANNOUNCE_EVERY_MS, type TranscriptionUpdate, announceTranscription } from "../src/transcripts/announce.js";

function setup() {
  let clock = 0;
  const published: TranscriptionUpdate[] = [];
  const forwarded: string[] = [];
  const announcer = announceTranscription("t_1", "assets/talk.mp4", (u) => published.push(u), (u) => forwarded.push(u.message), () => clock);
  return { announcer, published, forwarded, tick: (ms: number) => (clock += ms) };
}

describe("announceTranscription", () => {
  it("forwards every report to the caller and announces step changes at once", () => {
    const { announcer, published, forwarded } = setup();
    announcer.progress({ message: "Loading model", stage: "model-load" });
    announcer.progress({ message: "Transcribing (cpu)", stage: "transcribe", fraction: 0.1 });
    expect(forwarded).toEqual(["Loading model", "Transcribing (cpu)"]);
    expect(published.map((u) => [u.state, u.stage, u.fraction])).toEqual([
      ["running", "model-load", undefined],
      ["running", "transcribe", 0.1],
    ]);
    expect(published[0]).toMatchObject({ id: "t_1", asset: "assets/talk.mp4" });
  });

  it("throttles progress-only updates of one step", () => {
    const { announcer, published, tick } = setup();
    announcer.progress({ message: "Transcribing (cpu)", stage: "transcribe", fraction: 0.1 });
    announcer.progress({ message: "Transcribing (cpu)", stage: "transcribe", fraction: 0.2 });
    tick(ANNOUNCE_EVERY_MS);
    announcer.progress({ message: "Transcribing (cpu)", stage: "transcribe", fraction: 0.3 });
    expect(published.map((u) => u.fraction)).toEqual([0.1, 0.3]);
  });

  it("ends once, done or failed with the message", () => {
    const { announcer, published } = setup();
    announcer.progress({ message: "Loading model", stage: "model-load" });
    announcer.end(new Error("whisper-cli exited 1"));
    announcer.end();
    expect(published.at(-1)).toMatchObject({ state: "failed", message: "whisper-cli exited 1" });
    expect(published).toHaveLength(2);
  });

  it("announces nothing for a run that never reported progress, like a consent refusal", () => {
    const { announcer, published } = setup();
    announcer.end(new Error("confirmation required"));
    expect(published).toEqual([]);
  });
});
