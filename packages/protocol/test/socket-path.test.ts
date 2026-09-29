import { describe, expect, it } from "vitest";
import { resolveSocketPath } from "../src/index.js";

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
