import { describe, expect, it } from "vitest";
import { confirmCommand, shellWord } from "../src/voiceover-commands.js";

describe("shellWord", () => {
  it("leaves plain text bare on every platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(shellWord("scripts/vo.md", platform)).toBe("scripts/vo.md");
      expect(shellWord("hook-1,fix-1", platform)).toBe("hook-1,fix-1");
    }
  });

  it("single-quotes what a shell would read: $, backtick, !, backslash, space, empty", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(shellWord("a$HOME", platform)).toBe("'a$HOME'");
      expect(shellWord("a`id`", platform)).toBe("'a`id`'");
      expect(shellWord("a!b", platform)).toBe("'a!b'");
      expect(shellWord("a\\b", platform)).toBe("'a\\b'");
      expect(shellWord("my script.md", platform)).toBe("'my script.md'");
      expect(shellWord("", platform)).toBe("''");
    }
  });

  it("escapes an embedded quote the way each shell reads it", () => {
    expect(shellWord("it's", "linux")).toBe("'it'\\''s'");
    expect(shellWord("it's", "darwin")).toBe("'it'\\''s'");
    expect(shellWord("it's", "win32")).toBe("'it''s'");
    expect(shellWord("it’s", "win32")).toBe("'it’’s'");
  });

  it("has no word for a line break", () => {
    for (const platform of ["linux", "win32"] as const) {
      expect(shellWord("a\nb", platform)).toBeNull();
      expect(shellWord("a\r\nb", platform)).toBeNull();
    }
  });
});

describe("confirmCommand", () => {
  const inv = { kind: "voiceover.generate" as const, script: "scripts/vo.md", verify: true, yes: false };
  const token = "0123456789abcdef0123456789abcdef";

  it("prints the flags the run was priced with", () => {
    expect(confirmCommand({ ...inv, lines: ["hook-1"], provider: "p", voice: "low", verify: false }, token, "linux")).toBe(
      `frameshell voiceover generate scripts/vo.md --lines hook-1 --provider p --voice low --no-verify --yes --confirmation ${token}`,
    );
  });

  it("quotes a hostile script name, and gives no command for a newline", () => {
    expect(confirmCommand({ ...inv, script: "scripts/$(id).md" }, token, "linux")).toBe(
      `frameshell voiceover generate 'scripts/$(id).md' --yes --confirmation ${token}`,
    );
    expect(confirmCommand({ ...inv, script: "scripts/a\nb.md" }, token, "linux")).toBeNull();
    expect(confirmCommand({ ...inv, voice: "a\nb" }, token, "win32")).toBeNull();
  });
});
