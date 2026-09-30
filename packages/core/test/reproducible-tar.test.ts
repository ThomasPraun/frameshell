import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packTar } from "../src/index.js";
import { tempDir } from "./helpers.js";

const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";

const entries = () => [
  { name: "whisper-cli", data: new Uint8Array(Buffer.from("#!/bin/sh\necho hi\n")), mode: 0o755 },
  { name: "LICENSE", data: new Uint8Array(Buffer.alloc(1300, "m")), mode: 0o644 },
];

describe("packTar", () => {
  it("produces the same bytes for the same entries: no time, owner or host metadata", () => {
    const first = packTar(entries());
    expect(Buffer.from(packTar(entries())).equals(Buffer.from(first))).toBe(true);
    // Two headers, data padded to 512-byte blocks, two zero blocks.
    expect(first.length).toBe(512 + 512 + 512 + 1536 + 1024);
  });

  it("is read by the system tar with contents and permissions intact", () => {
    const dir = tempDir();
    const archive = join(dir, "a.tar");
    writeFileSync(archive, packTar(entries()));
    execFileSync(tar, ["-xf", archive, "-C", dir]);
    expect(readFileSync(join(dir, "whisper-cli"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    expect(readFileSync(join(dir, "LICENSE"), "utf8")).toBe("m".repeat(1300));
    if (process.platform !== "win32") expect(statSync(join(dir, "whisper-cli")).mode & 0o777).toBe(0o755);
    const listing = execFileSync(tar, ["-tvf", archive], { encoding: "utf8" });
    // mtime 0: 1969 or 1970 depending on the local time zone.
    expect(listing).toMatch(/19(69|70)/);
  });

  it("rejects names ustar cannot hold without a prefix", () => {
    expect(() => packTar([{ name: "x".repeat(101), data: new Uint8Array(), mode: 0o644 }])).toThrow(/1-100 bytes/);
  });
});
