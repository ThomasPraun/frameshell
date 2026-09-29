import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Exec, probeFfmpeg } from "../src/index.js";

// Real output of the pinned darwin-arm64 build (Martin Riedl 9.0.2), recorded once.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ffmpeg-9.0.2-darwin-arm64/${name}.txt`, import.meta.url), "utf8");
const recorded = { version: fixture("version"), encoders: fixture("encoders"), decoders: fixture("decoders") };

/** Fake process runner answering like ffmpeg; `encodeOk` decides hardware test encodes. */
function fakeFfmpeg(outputs: { version: string; encoders: string; decoders: string }, encodeOk: (encoder: string) => boolean = () => true) {
  const calls: string[][] = [];
  const exec: Exec = async (_file, args) => {
    calls.push(args);
    if (args.includes("-version")) return { code: 0, stdout: outputs.version, stderr: "" };
    if (args.includes("-encoders")) return { code: 0, stdout: outputs.encoders, stderr: "" };
    if (args.includes("-decoders")) return { code: 0, stdout: outputs.decoders, stderr: "" };
    const encoder = args[args.indexOf("-c:v") + 1]!;
    return encodeOk(encoder) ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "No device" };
  };
  return { exec, calls };
}

const codec = (probe: Awaited<ReturnType<typeof probeFfmpeg>>, name: string, kind: "encoder" | "decoder") =>
  probe.codecs.find((c) => c.name === name && c.kind === kind);

describe("probeFfmpeg", () => {
  it("reads the version of the pinned build", async () => {
    const probe = await probeFfmpeg("/bin/ffmpeg", fakeFfmpeg(recorded).exec);
    expect(probe.version).toBe("9.0.2-https://www.martin-riedl.de");
  });

  it("finds x264 and libvpx VP9 encode and decode in the pinned build", async () => {
    const probe = await probeFfmpeg("/bin/ffmpeg", fakeFfmpeg(recorded).exec);
    expect(codec(probe, "libx264", "encoder")).toMatchObject({ compiled: true, hardware: false, works: null });
    expect(codec(probe, "libvpx-vp9", "encoder")).toMatchObject({ compiled: true });
    expect(codec(probe, "libvpx-vp9", "decoder")).toMatchObject({ compiled: true });
    expect(probe.problems).toEqual([]);
  });

  it("test-encodes only compiled hardware encoders and reports whether they work", async () => {
    const { exec, calls } = fakeFfmpeg(recorded, (encoder) => encoder !== "hevc_videotoolbox");
    const probe = await probeFfmpeg("/bin/ffmpeg", exec);
    expect(codec(probe, "h264_videotoolbox", "encoder")).toMatchObject({ compiled: true, hardware: true, works: true });
    expect(codec(probe, "hevc_videotoolbox", "encoder")).toMatchObject({ compiled: true, works: false });
    expect(codec(probe, "h264_nvenc", "encoder")).toMatchObject({ compiled: false, hardware: true, works: null });
    expect(codec(probe, "h264_vaapi", "encoder")).toMatchObject({ compiled: false, works: null });
    const tested = calls.filter((args) => args.includes("-c:v")).map((args) => args[args.indexOf("-c:v") + 1]);
    expect(tested.sort()).toEqual(["h264_videotoolbox", "hevc_videotoolbox"]);
  });

  it("uploads frames to the GPU for VAAPI test encodes", async () => {
    const linuxEncoders = `${recorded.encoders}\n V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)\n`;
    const { exec, calls } = fakeFfmpeg({ ...recorded, encoders: linuxEncoders });
    const probe = await probeFfmpeg("/bin/ffmpeg", exec);
    expect(codec(probe, "h264_vaapi", "encoder")).toMatchObject({ compiled: true, works: true });
    const vaapi = calls.find((args) => args.includes("h264_vaapi"))!;
    expect(vaapi).toEqual(expect.arrayContaining(["-vaapi_device"]));
    expect(vaapi.join(" ")).toContain("hwupload");
  });

  it("flags a build without the libvpx decoder: VP9 alpha clips would render opaque", async () => {
    const decoders = recorded.decoders.replace(/^.*libvpx-vp9.*$/m, "");
    const probe = await probeFfmpeg("/bin/ffmpeg", fakeFfmpeg({ ...recorded, decoders }).exec);
    expect(codec(probe, "libvpx-vp9", "decoder")).toMatchObject({ compiled: false });
    expect(probe.problems).toEqual([expect.stringMatching(/libvpx-vp9 decoder.*alpha/)]);
  });

  it("flags a build without x264 or the VP9 encoder", async () => {
    const encoders = recorded.encoders.replace(/^.*(libx264|libvpx-vp9) .*$/gm, "");
    const probe = await probeFfmpeg("/bin/ffmpeg", fakeFfmpeg({ ...recorded, encoders }).exec);
    expect(probe.problems).toEqual([expect.stringContaining("libx264"), expect.stringContaining("libvpx-vp9 encoder")]);
  });

  it("handles CRLF output from Windows builds", async () => {
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    const probe = await probeFfmpeg(
      "C:\\ffmpeg.exe",
      fakeFfmpeg({ version: crlf(recorded.version), encoders: crlf(recorded.encoders), decoders: crlf(recorded.decoders) }).exec,
    );
    expect(probe.version).toBe("9.0.2-https://www.martin-riedl.de");
    expect(codec(probe, "libvpx-vp9", "decoder")).toMatchObject({ compiled: true });
  });

  it("reports a binary that cannot run instead of throwing", async () => {
    const exec: Exec = async () => {
      throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
    };
    const probe = await probeFfmpeg("/bin/ffmpeg", exec);
    expect(probe).toMatchObject({ version: null, codecs: [] });
    expect(probe.problems).toEqual([expect.stringMatching(/\/bin\/ffmpeg.*EACCES/)]);
  });
});
