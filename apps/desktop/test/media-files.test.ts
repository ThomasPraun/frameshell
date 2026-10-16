import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, partitionFiles } from "../src/main/media-files.js";
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
});

describe("importNotice", () => {
  it("names what was imported and what was not media", () => {
    expect(importNotice(["assets/a.mp4", "assets/b.wav"], [])).toBe("Imported a.mp4, b.wav into assets/.");
    expect(importNotice(["assets/a.mp4"], ["/home/ana/notes.pdf"])).toBe("Imported a.mp4 into assets/. Not media: notes.pdf.");
    expect(importNotice([], ["C:\\Users\\ana\\notes.pdf"])).toBe("Not media: notes.pdf.");
  });
});
