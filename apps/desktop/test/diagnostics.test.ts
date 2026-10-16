import type { DoctorResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { DIAGNOSTICS_MAX_BYTES, type DiagnosticsInput, buildDiagnostics, redactHome } from "../src/main/diagnostics.js";

// Seam under test: the text Help > Copy Diagnostics puts on the clipboard (#194).

const home = "/Users/ana";

const doctor: DoctorResult = {
  platform: "darwin-arm64",
  dataDir: `${home}/Library/Application Support/Frameshell`,
  binaries: [
    { name: "ffmpeg", package: "ffmpeg", source: "managed", path: `${home}/x/ffmpeg`, installed: true, version: "7.1", pinned: null },
    { name: "whisper", package: "whisper", source: "managed", path: null, installed: false, version: null, pinned: null },
  ],
  codecs: [{ name: "libx264", kind: "encoder", label: "H.264", hardware: false, compiled: true, works: null }],
  problems: [`ffmpeg failed to run at ${home}/x/ffmpeg`],
} as DoctorResult;

const input = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  appVersion: "0.7.0",
  versions: { electron: "40.0.0", chrome: "140.0", node: "22.1.0" },
  os: { platform: "Darwin", release: "25.3.0", arch: "arm64" },
  home,
  dataDir: `${home}/Library/Application Support/Frameshell`,
  daemon: { daemonVersion: "0.7.0", protocolVersion: 9 },
  doctor,
  project: {
    dir: `${home}/videos/launch`,
    schemaVersion: 1,
    jobs: [{ state: "done" }, { state: "done" }, { state: "failed" }],
    rejections: 2,
    transactions: 0,
    openProjects: 1,
    synced: { service: "Dropbox" },
  },
  ...over,
});

describe("buildDiagnostics", () => {
  it("has the app, system, daemon, doctor and project sections", () => {
    const report = buildDiagnostics(input());
    for (const title of ["## App", "## System", "## Daemon", "## Doctor", "## Project"]) expect(report).toContain(title);
    expect(report).toContain("Frameshell 0.7.0");
    expect(report).toContain("Darwin 25.3.0 (arm64)");
    expect(report).toContain("frameshelld 0.7.0, protocol 9");
    expect(report).toContain("Jobs: 3, 2 done, 1 failed");
    expect(report).toContain("Synced folder: Dropbox");
    expect(report).toContain("whisper: missing (managed)");
  });

  it("shows paths under home as ~/ and leaves no home prefix", () => {
    const report = buildDiagnostics(input());
    expect(report).not.toContain(home);
    expect(report).toContain("Folder: ~/videos/launch");
    expect(report).toContain("ffmpeg failed to run at ~/x/ffmpeg");
  });

  it("redactHome handles Windows paths and similarly named folders", () => {
    expect(redactHome("C:\\Users\\Ana\\videos\\a", "C:\\Users\\Ana")).toBe("~/videos/a");
    expect(redactHome("/Users/anabel/x", "/Users/ana")).toBe("/Users/anabel/x");
  });

  it("never reads the environment", () => {
    process.env.FRAMESHELL_SECRET_TEST = "hunter2-token";
    try {
      expect(buildDiagnostics(input())).not.toContain("hunter2-token");
    } finally {
      delete process.env.FRAMESHELL_SECRET_TEST;
    }
  });

  it("reports failed parts and a missing project instead of throwing", () => {
    const report = buildDiagnostics(input({ daemon: { error: "ECONNREFUSED" }, doctor: { error: "timed out" }, project: null }));
    expect(report).toContain("Unreachable: ECONNREFUSED");
    expect(report).toContain("Failed: timed out");
    expect(report).toContain("No project open");
  });

  it("stays under the size bound however long the doctor output is", () => {
    const huge = { ...doctor, problems: Array.from({ length: 500 }, (_, i) => `problem ${i} ${"x".repeat(400)}`) } as DoctorResult;
    const report = buildDiagnostics(input({ doctor: huge }));
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(DIAGNOSTICS_MAX_BYTES);
    expect(report).toContain("[truncated]");
    expect(Buffer.byteLength(buildDiagnostics(input()))).toBeLessThan(DIAGNOSTICS_MAX_BYTES);
  });
});
