import { resolve } from "node:path";
import type { DaemonConnection } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { EXPORT_FLAGS, executeExport, parseExport } from "../src/export-commands.js";
import { runCli } from "../src/run.js";

// Seam under test: `export otio` and `export premiere` (ADR 0045, ADR 0047) from argv to the method request and the report.

const result = { path: "/p/exports/main.xml", timeline: "main", fps: 30, tracks: 2, clips: 3, markers: 1, warnings: ["marker colours not exported."] };

function stub() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const conn = {
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return result;
    },
  } as unknown as DaemonConnection;
  return { conn, calls };
}

describe("parseExport", () => {
  it("reads premiere with the flags it takes, and otio unchanged", () => {
    expect(parseExport(["premiere"], {})).toEqual({ kind: "export.premiereXml" });
    expect(parseExport(["premiere"], { timeline: "intro", out: "x.xml" })).toEqual({ kind: "export.premiereXml", timeline: "intro", out: "x.xml" });
    expect(parseExport(["otio"], { "absolute-paths": true })).toEqual({ kind: "export.otio", absolutePaths: true });
    expect(parseExport(["premiere", "otio"], {})).toBeNull();
    expect(parseExport(["fcpxml"], {})).toBeNull();
    expect(parseExport([], {})).toBeNull();
  });

  it("premiere has no --absolute-paths: its paths are always absolute", () => {
    expect(EXPORT_FLAGS["export premiere"]).toEqual(["timeline", "out"]);
  });
});

describe("executeExport", () => {
  it("sends export.premiereXml with the out resolved against the working folder, and prints the path and the warnings", async () => {
    const { conn, calls } = stub();
    const text = await executeExport(conn, { kind: "export.premiereXml", timeline: "main", out: "edit.xml" }, "/proj", false);
    expect(calls).toEqual([{ method: "export.premiereXml", params: { cwd: "/proj", timeline: "main", out: resolve("/proj", "edit.xml") } }]);
    expect(text).toBe("Wrote /p/exports/main.xml (2 tracks, 3 clips, 1 marker, 30 fps)\nwarning: marker colours not exported.\n");
  });

  it("sends export.otio with absolutePaths only when asked", async () => {
    const { conn, calls } = stub();
    await executeExport(conn, { kind: "export.otio" }, "/proj", true);
    await executeExport(conn, { kind: "export.otio", absolutePaths: true }, "/proj", true);
    expect(calls).toEqual([
      { method: "export.otio", params: { cwd: "/proj" } },
      { method: "export.otio", params: { cwd: "/proj", absolutePaths: true } },
    ]);
  });
});

describe("frameshell export premiere", () => {
  it("is refused with --absolute-paths before any daemon is asked", async () => {
    const err: string[] = [];
    const code = await runCli(["export", "premiere", "--absolute-paths"], {
      cwd: "/proj",
      env: {},
      stdout: () => undefined,
      stderr: (text: string) => err.push(text),
    });
    expect(code).not.toBe(0);
    expect(err.join("")).toMatch(/does not take --absolute-paths/);
  });
});
