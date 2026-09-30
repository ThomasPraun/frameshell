import { describe, expect, it } from "vitest";
import {
  type BinaryPackage,
  FFMPEG_PACKAGE,
  MIRROR_GENERATED_FILES,
  type MirrorPlan,
  checkMirrorSums,
  mirrorUrl,
  parseSha256Sums,
  planMirror,
} from "../src/index.js";

const sha = (c: string): string => c.repeat(64);
const MIRROR = { repo: "owner/repo", tag: "tool-mirror-1" };

/** Minimal mirrored package: two platforms sharing one source archive. */
function mirrored(overrides: Partial<BinaryPackage> = {}): BinaryPackage {
  const source = { name: "source-tool-1.0.tar.gz", url: "https://example.org/tool-1.0.tar.gz", sha256: sha("c"), size: 10, description: "tool source" };
  const build = (asset: string, digest: string) => ({
    version: "1.0",
    origin: "https://example.org",
    license: "GPL-3.0-or-later",
    archives: [
      {
        urls: [`https://example.org/${asset}`, mirrorUrl(MIRROR, asset)],
        sha256: digest,
        size: 100,
        files: { tool: "tool" },
      },
    ],
    sources: [source],
  });
  return {
    name: "tool",
    tools: ["tool"],
    mirror: MIRROR,
    builds: { "linux-x64": build("tool-linux.tar.xz", sha("a")), "win32-x64": build("tool-win.zip", sha("b")) },
    ...overrides,
  };
}

describe("planMirror", () => {
  it("lists every binary once with its mirror URL, then each shared source once", () => {
    const plan = planMirror(mirrored());
    expect(plan).toMatchObject({ package: "tool", repo: "owner/repo", tag: "tool-mirror-1", licenses: ["GPL-3.0-or-later"] });
    expect(plan.assets.map((a) => [a.name, a.kind, a.platforms])).toEqual([
      ["tool-linux.tar.xz", "binary", ["linux-x64"]],
      ["tool-win.zip", "binary", ["win32-x64"]],
      ["source-tool-1.0.tar.gz", "source", ["linux-x64", "win32-x64"]],
    ]);
    expect(plan.assets[0]).toMatchObject({
      from: "https://example.org/tool-linux.tar.xz",
      url: "https://github.com/owner/repo/releases/download/tool-mirror-1/tool-linux.tar.xz",
    });
  });

  it("rejects a package without a mirror", () => {
    const { mirror: _mirror, ...unmirrored } = mirrored();
    expect(() => planMirror(unmirrored)).toThrow(/no mirror/);
  });

  it("rejects a mirrored build without corresponding source", () => {
    const pkg = mirrored();
    const linux = { ...pkg.builds["linux-x64"]!, sources: [] };
    expect(() => planMirror({ ...pkg, builds: { ...pkg.builds, "linux-x64": linux } })).toThrow(
      /linux-x64: a mirrored build needs its corresponding source/,
    );
  });

  it("rejects an archive whose first URL is the mirror or that has no mirror URL", () => {
    const pkg = mirrored();
    const archive = pkg.builds["linux-x64"]!.archives[0]!;
    const mirrorFirst = { ...archive, urls: [...archive.urls].reverse() };
    const noMirror = { ...archive, urls: [archive.urls[0]!] };
    for (const bad of [mirrorFirst, noMirror]) {
      const linux = { ...pkg.builds["linux-x64"]!, archives: [bad] };
      expect(() => planMirror({ ...pkg, builds: { ...pkg.builds, "linux-x64": linux } })).toThrow(/linux-x64/);
    }
  });

  it("rejects two different files under one asset name, and reserved names", () => {
    const pkg = mirrored();
    const clash = {
      ...pkg.builds["win32-x64"]!,
      archives: [{ ...pkg.builds["win32-x64"]!.archives[0]!, urls: ["https://example.org/other", mirrorUrl(MIRROR, "tool-linux.tar.xz")] }],
    };
    expect(() => planMirror({ ...pkg, builds: { ...pkg.builds, "win32-x64": clash } })).toThrow(
      /tool-linux.tar.xz: two different files share this asset name/,
    );
    const reserved = {
      ...pkg.builds["win32-x64"]!,
      archives: [{ ...pkg.builds["win32-x64"]!.archives[0]!, urls: ["https://example.org/x", mirrorUrl(MIRROR, "SHA256SUMS.txt")] }],
    };
    expect(() => planMirror({ ...pkg, builds: { ...pkg.builds, "win32-x64": reserved } })).toThrow(/reserved/);
  });
});

describe("pinned ffmpeg mirror", () => {
  const plan = planMirror(FFMPEG_PACKAGE);

  it("mirrors every pinned ffmpeg archive as the second URL, in this repository", () => {
    expect(plan.repo).toBe("ThomasPraun/frameshell");
    const binaries = plan.assets.filter((a) => a.kind === "binary");
    const archives = Object.values(FFMPEG_PACKAGE.builds).flatMap((build) => build!.archives);
    expect(binaries).toHaveLength(archives.length);
    for (const archive of archives) {
      expect(archive.urls).toHaveLength(2);
      expect(binaries.find((b) => b.url === archive.urls[1])).toMatchObject({ from: archive.urls[0], sha256: archive.sha256 });
    }
  });

  it("publishes FFmpeg source and build scripts for every platform", () => {
    for (const platform of Object.keys(FFMPEG_PACKAGE.builds)) {
      const sources = plan.assets.filter((a) => a.kind === "source" && a.platforms.includes(platform as never));
      expect(sources.some((s) => /^source-ffmpeg-/.test(s.name))).toBe(true);
      expect(sources.some((s) => /build/i.test(s.name))).toBe(true);
    }
  });
});

describe("mirror checksums", () => {
  const plan: MirrorPlan = planMirror(mirrored());
  const listing = (skip = "", change = ""): string =>
    [...plan.assets.map((a) => [a.name, a.sha256] as const), ["SOURCE-OFFER.txt", sha("d")] as const, ["COPYING.GPLv3", sha("e")] as const]
      .filter(([name]) => name !== skip)
      .map(([name, digest]) => `${name === change ? sha("f") : digest}  ${name}`)
      .join("\n");

  it("parses sha256sum output in text and binary mode", () => {
    expect(parseSha256Sums(`${sha("A")}  a.zip\n${sha("b")} *b c.tar\n\n`)).toEqual(
      new Map([
        ["a.zip", sha("a")],
        ["b c.tar", sha("b")],
      ]),
    );
    expect(() => parseSha256Sums("abc  a.zip")).toThrow(/Malformed/);
  });

  it("accepts a release holding every pinned file and the generated files", () => {
    expect(checkMirrorSums(plan, parseSha256Sums(listing()))).toEqual([]);
    expect(MIRROR_GENERATED_FILES).toContain("SOURCE-OFFER.txt");
  });

  it("reports missing and altered files", () => {
    expect(checkMirrorSums(plan, parseSha256Sums(listing("source-tool-1.0.tar.gz", "tool-win.zip")))).toEqual([
      `tool-win.zip: mirror has ${sha("f")}, manifest pins ${sha("b")}`,
      "source-tool-1.0.tar.gz: missing from the mirror",
    ]);
    expect(checkMirrorSums(plan, parseSha256Sums(listing("SOURCE-OFFER.txt")))).toEqual([
      "SOURCE-OFFER.txt: missing from the mirror",
    ]);
  });
});
