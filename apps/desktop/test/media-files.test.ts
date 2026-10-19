import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_EXTENSIONS, START_EXTENSIONS, VIDEO_EXTENSIONS, isAudioFile, partitionFiles } from "../src/main/media-files.js";
import { importNotice } from "../src/renderer/src/file-drop.js";

describe("partitionFiles", () => {
  it("keeps files with a listed extension, in order, and refuses the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frameshell-media-files-"));
    const files = ["b.MOV", "notes.pdf", "a.mp4", "song.mp3"].map((name) => {
      writeFileSync(join(dir, name), "x");
      return join(dir, name);
    });
    mkdirSync(join(dir, "clips.mp4"));
    const folder = join(dir, "clips.mp4");
    const missing = join(dir, "gone.mp4");

    expect(await partitionFiles([...files, folder, missing], VIDEO_EXTENSIONS)).toEqual({
      accepted: [files[0], files[2]],
      refused: [files[1], files[3], folder, missing],
    });
    expect((await partitionFiles(files, MEDIA_EXTENSIONS)).refused).toEqual([files[1]]);
  });

  it("starts a project from video and audio, not from images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frameshell-media-files-"));
    const files = ["talk.mp4", "podcast.MP3", "voice.m4a", "logo.png"].map((name) => {
      writeFileSync(join(dir, name), "x");
      return join(dir, name);
    });
    expect(await partitionFiles(files, START_EXTENSIONS)).toEqual({ accepted: files.slice(0, 3), refused: [files[3]] });
  });
});

describe("isAudioFile", () => {
  it("tells audio from video by extension, ignoring case", () => {
    expect(["a.wav", "b.MP3", "c.opus", "d.flac"].every(isAudioFile)).toBe(true);
    expect(["a.mp4", "b.mov", "c.png", "noext"].some(isAudioFile)).toBe(false);
  });
});

describe("importNotice", () => {
  it("names what was imported and what was not media", () => {
    expect(importNotice(["assets/a.mp4", "assets/b.wav"], [])).toBe("Imported a.mp4, b.wav into assets/.");
    expect(importNotice(["assets/a.mp4"], ["/home/ana/notes.pdf"])).toBe("Imported a.mp4 into assets/. Not media: notes.pdf.");
    expect(importNotice([], ["C:\\Users\\ana\\notes.pdf"])).toBe("Not media: notes.pdf.");
  });
});
