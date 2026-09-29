import { describe, expect, it } from "vitest";
import { assertSocketPathFits, resolveSocketPath } from "../src/index.js";

describe("daemon socket path", () => {
  it("honours FRAMESHELL_SOCKET so terminals and tests can target one daemon", () => {
    expect(resolveSocketPath({ FRAMESHELL_SOCKET: "/x/y.sock" }, "linux")).toBe("/x/y.sock");
  });

  it("uses a per-user named pipe on Windows", () => {
    expect(resolveSocketPath({}, "win32")).toMatch(/^\\\\\.\\pipe\\frameshelld-.+/);
  });

  it("puts the unix socket under XDG_RUNTIME_DIR when set", () => {
    expect(resolveSocketPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toMatch(
      /^\/run\/user\/1000\/frameshelld-.+\.sock$/,
    );
  });
});

describe("socket path length check", () => {
  // sun_path is 108 bytes on Linux, 104 on macOS, both including the NUL terminator.
  const pathOf = (bytes: number) => `/${"s".repeat(bytes - 1)}`;

  it.each([
    ["linux", 107],
    ["darwin", 103],
  ] as const)("accepts a %s path of exactly %i bytes and rejects one byte more", (platform, max) => {
    expect(() => assertSocketPathFits(pathOf(max), platform)).not.toThrow();
    expect(() => assertSocketPathFits(pathOf(max + 1), platform)).toThrow(
      expect.objectContaining({ code: "ENAMETOOLONG", message: expect.stringMatching(/too long.*FRAMESHELL_SOCKET/s) }),
    );
  });

  it("counts bytes, not characters", () => {
    expect(() => assertSocketPathFits(`/${"é".repeat(60)}`, "darwin")).toThrow(/too long/);
  });

  it("never limits Windows pipe names", () => {
    expect(() => assertSocketPathFits(`\\\\.\\pipe\\${"p".repeat(200)}`, "win32")).not.toThrow();
  });
});
