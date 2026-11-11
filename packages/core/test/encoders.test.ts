import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENCODER_CACHE_FILE, EncoderCache, type Exec, machineProfile, probeEncoders, tierFps, tierVideoArgs, videoToolboxKbps } from "../src/index.js";
import { tempDir } from "./helpers.js";

const GIB = 1024 ** 3;

describe("tier mapping", () => {
  const hd = { width: 1920, height: 1080, fps: 30 };

  it("maps x264 tiers to the measured presets and CRFs", () => {
    expect(tierVideoArgs("libx264", "master", hd).slice(0, 6)).toEqual(["-c:v", "libx264", "-preset", "medium", "-crf", "16"]);
    expect(tierVideoArgs("libx264", "preview", hd).slice(0, 6)).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"]);
    expect(tierVideoArgs("libx264", "draft", hd).slice(0, 6)).toEqual(["-c:v", "libx264", "-preset", "veryfast", "-crf", "22"]);
    expect(tierVideoArgs("libx264", "final", hd).slice(0, 6)).toEqual(["-c:v", "libx264", "-preset", "slow", "-crf", "16"]);
  });

  it("maps NVENC masters to p6 cq 17 and previews to p5 cq 28", () => {
    expect(tierVideoArgs("h264_nvenc", "master", hd).join(" ")).toContain("-preset p6 -rc vbr -cq 17 -b:v 0");
    expect(tierVideoArgs("h264_nvenc", "preview", hd).join(" ")).toContain("-preset p5 -rc vbr -cq 28 -b:v 0");
  });

  it("sets the VideoToolbox bitrate to width x height x fps x bits per pixel: 62 Mb/s for a 4K30 master", () => {
    expect(videoToolboxKbps("master", { width: 3840, height: 2160, fps: 30 })).toBe(62_208);
    expect(videoToolboxKbps("preview", { width: 3840, height: 2160, fps: 30 })).toBe(14_930);
    expect(tierVideoArgs("h264_videotoolbox", "master", { width: 3840, height: 2160, fps: 30 }).slice(0, 4)).toEqual(["-c:v", "h264_videotoolbox", "-b:v", "62208k"]);
  });

  it("tags masters and finals bt709, drafts and previews not", () => {
    const tagged = (tier: "master" | "preview" | "draft" | "final") => tierVideoArgs("libx264", tier, hd).includes("bt709");
    expect([tagged("master"), tagged("final"), tagged("draft"), tagged("preview")]).toEqual([true, true, false, false]);
  });

  it("caps only the draft frame rate, at 30", () => {
    expect([tierFps("draft", 60), tierFps("draft", 24), tierFps("final", 60), tierFps("master", 59.94)]).toEqual([30, 24, 60, 59.94]);
  });
});

const listing = (names: string[]) => `Encoders:\n V..... = Video\n ------\n${names.map((name) => ` V....D ${name}           test encoder\n`).join("")}`;

/** Fake ffmpeg: lists `compiled`; a test encode succeeds when `works` has the encoder. */
function fakeFfmpeg(compiled: string[], works: string[]) {
  const encodes: string[] = [];
  const exec: Exec = async (_file, args) => {
    if (args.includes("-encoders")) return { code: 0, stdout: listing(compiled), stderr: "" };
    if (args.includes("-version")) return { code: 0, stdout: "ffmpeg version 9.0.2 Copyright\n", stderr: "" };
    const encoder = args[args.indexOf("-c:v") + 1]!;
    encodes.push(encoder);
    return works.includes(encoder) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "no device" };
  };
  return { exec, encodes };
}

describe("probeEncoders", () => {
  it("picks VideoToolbox first when it encodes", async () => {
    const { exec } = fakeFfmpeg(["h264_videotoolbox", "h264_nvenc", "libx264"], ["h264_videotoolbox", "libx264"]);
    const probe = await probeEncoders("/bin/ffmpeg", exec);
    expect(probe.picked).toBe("h264_videotoolbox");
    expect(probe.cached).toBe(false);
    expect(probe.candidates.map((c) => [c.name, c.compiled, c.works])).toEqual([
      ["h264_videotoolbox", true, true],
      ["h264_nvenc", true, false],
      ["libx264", true, true],
    ]);
  });

  it("skips an encoder that is listed but fails its test encode (NVENC without an NVIDIA GPU)", async () => {
    const { exec } = fakeFfmpeg(["h264_nvenc", "libx264"], ["libx264"]);
    const probe = await probeEncoders("/bin/ffmpeg", exec);
    expect(probe.picked).toBe("libx264");
    expect(probe.candidates[1]).toMatchObject({ name: "h264_nvenc", compiled: true, works: false });
  });

  it("does not test-encode an encoder the build lacks", async () => {
    const { exec, encodes } = fakeFfmpeg(["libx264"], ["libx264"]);
    const probe = await probeEncoders("/bin/ffmpeg", exec);
    expect(encodes).toEqual(["libx264"]);
    expect(probe.candidates[0]).toMatchObject({ compiled: false, works: false, ms: null });
  });

  it("reports nothing picked when no encoder works, and when ffmpeg cannot run", async () => {
    expect((await probeEncoders("/bin/ffmpeg", fakeFfmpeg(["libx264"], []).exec)).picked).toBeNull();
    const broken: Exec = async () => {
      throw new Error("spawn ENOENT");
    };
    expect((await probeEncoders("/bin/ffmpeg", broken)).picked).toBeNull();
  });

  it("test-encodes 0.2 s of colour, not a one-frame test", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_file, args) => {
      calls.push(args);
      return args.includes("-encoders") ? { code: 0, stdout: listing(["libx264"]), stderr: "" } : { code: 0, stdout: "", stderr: "" };
    };
    await probeEncoders("/bin/ffmpeg", exec);
    const encode = calls.find((args) => args.includes("-c:v"))!;
    expect(encode.join(" ")).toContain("color=c=0x336699:size=256x256:rate=30:duration=0.2");
  });
});

describe("EncoderCache", () => {
  it("probes once per ffmpeg build and keeps the answer in the data dir", async () => {
    const dir = tempDir();
    const { exec, encodes } = fakeFfmpeg(["libx264"], ["libx264"]);
    const cache = new EncoderCache(dir, exec);
    expect(await cache.get("/bin/ffmpeg", "9.0.2")).toMatchObject({ picked: "libx264", cached: false });
    expect(await cache.get("/bin/ffmpeg", "9.0.2")).toMatchObject({ picked: "libx264", cached: true });
    expect(encodes).toEqual(["libx264"]);
    // A new process (a new instance) reads the same file.
    const again = await new EncoderCache(dir, fakeFfmpeg([], []).exec).get("/bin/ffmpeg", "9.0.2");
    expect(again).toMatchObject({ picked: "libx264", cached: true });
    expect(JSON.parse(readFileSync(join(dir, ENCODER_CACHE_FILE), "utf8"))).toMatchObject({ version: 1, probes: { "/bin/ffmpeg|9.0.2": { picked: "libx264" } } });
  });

  it("probes again for another ffmpeg path or version, and on refresh", async () => {
    const { exec, encodes } = fakeFfmpeg(["libx264"], ["libx264"]);
    const cache = new EncoderCache(tempDir(), exec);
    await cache.get("/bin/ffmpeg", "9.0.2");
    await cache.get("/bin/ffmpeg", "9.1");
    await cache.get("/other/ffmpeg", "9.0.2");
    await cache.get("/bin/ffmpeg", "9.0.2", true);
    expect(encodes).toHaveLength(4);
  });

  it("does not keep an answer in which nothing worked", async () => {
    const dir = tempDir();
    expect((await new EncoderCache(dir, fakeFfmpeg([], []).exec).get("/bin/ffmpeg", "9.0.2")).picked).toBeNull();
    expect(await new EncoderCache(dir, fakeFfmpeg(["libx264"], ["libx264"]).exec).get("/bin/ffmpeg", "9.0.2")).toMatchObject({ picked: "libx264", cached: false });
  });

  it("runs one probe for concurrent callers", async () => {
    const { exec, encodes } = fakeFfmpeg(["libx264"], ["libx264"]);
    const cache = new EncoderCache(tempDir(), exec);
    await Promise.all([cache.get("/bin/ffmpeg", "9.0.2"), cache.get("/bin/ffmpeg", "9.0.2")]);
    expect(encodes).toEqual(["libx264"]);
  });

  it("pick returns the probe's choice, x264 when nothing worked", async () => {
    expect(await new EncoderCache(tempDir(), fakeFfmpeg(["h264_nvenc", "libx264"], ["h264_nvenc"]).exec).pick("/bin/ffmpeg")).toBe("h264_nvenc");
    expect(await new EncoderCache(tempDir(), fakeFfmpeg([], []).exec).pick("/bin/ffmpeg")).toBe("libx264");
  });
});

describe("machineProfile", () => {
  const project = { resolution: { width: 1920, height: 1080 }, fps: 30 };

  it("calls a many-core machine with a hardware encoder fast, with the sharpest sizes", () => {
    expect(machineProfile({ cpuCores: 10, memoryBytes: 32 * GIB, hardwareEncoder: true }, project)).toMatchObject({ class: "fast", proxyShortSide: 720, draftShortSide: 1080 });
  });

  it("calls a mid laptop medium", () => {
    expect(machineProfile({ cpuCores: 8, memoryBytes: 16 * GIB, hardwareEncoder: false }, project)).toMatchObject({ class: "medium", proxyShortSide: 540, draftShortSide: 720 });
  });

  it("calls a small machine without a hardware encoder slow, but not one with it", () => {
    expect(machineProfile({ cpuCores: 2, memoryBytes: 16 * GIB, hardwareEncoder: false }, project).class).toBe("slow");
    expect(machineProfile({ cpuCores: 4, memoryBytes: 4 * GIB, hardwareEncoder: false }, project)).toMatchObject({ class: "slow", proxyShortSide: 360, draftShortSide: 540 });
    expect(machineProfile({ cpuCores: 4, memoryBytes: 4 * GIB, hardwareEncoder: true }, project).class).toBe("medium");
  });

  it("estimates a master's disk per minute from the project format: 117 MB at 1080p30, 4x at 4K", () => {
    const hd = machineProfile({ cpuCores: 8, memoryBytes: 16 * GIB, hardwareEncoder: false }, project);
    expect(hd.masterMbPerMinute).toBe(117);
    const uhd = machineProfile({ cpuCores: 8, memoryBytes: 16 * GIB, hardwareEncoder: false }, { resolution: { width: 3840, height: 2160 }, fps: 30 });
    expect(uhd.masterMbPerMinute).toBe(467);
  });
});
