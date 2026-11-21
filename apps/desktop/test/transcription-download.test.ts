import { describe, expect, it, vi } from "vitest";
import { chooseDownload } from "../src/main/transcription-download.js";
import { downloadSize, sizeText } from "../src/shared/sizes.js";

describe("chooseDownload", () => {
  it("asks when something is still to download and returns the answer", async () => {
    const ask = vi.fn(async () => "skip" as const);
    expect(await chooseDownload(620_000_000, ask)).toBe("skip");
    expect(ask).toHaveBeenCalledWith(620_000_000);
    expect(await chooseDownload(1, async () => "transcribe")).toBe("transcribe");
  });

  it("does not ask when nothing is to download", async () => {
    const ask = vi.fn(async () => "skip" as const);
    expect(await chooseDownload(0, ask)).toBe("transcribe");
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("downloadSize", () => {
  it("rounds to megabytes below a gigabyte and to tenths of a gigabyte above", () => {
    expect(downloadSize(574_000_000)).toBe("~574 MB");
    expect(downloadSize(10)).toBe("~1 MB");
    expect(downloadSize(1_240_000_000)).toBe("~1.2 GB");
  });

  it("drops the approximate mark for a size on disk", () => {
    expect(sizeText(2_500_000)).toBe("3 MB");
    expect(sizeText(3_040_000_000)).toBe("3.0 GB");
  });
});
