import { describe, expect, it } from "vitest";
import { downloadsSection } from "../scripts/release/downloads.mjs";

const assets = [
  "Frameshell-0.19.0-linux-amd64.deb",
  "Frameshell-0.19.0-linux-x86_64.AppImage",
  "Frameshell-0.19.0-mac-arm64.dmg",
  "Frameshell-0.19.0-mac-arm64.zip",
  "Frameshell-0.19.0-mac-x64.dmg",
  "Frameshell-0.19.0-win-x64.exe",
  "latest-linux.yml",
  "SHA256SUMS.txt",
];

describe("downloadsSection (#740)", () => {
  it("puts one installer per OS on top of the release notes", () => {
    const section = downloadsSection(assets, "ThomasPraun/frameshell", "v0.19.0");
    expect(section).toContain("| Windows | [Frameshell-0.19.0-win-x64.exe](https://github.com/ThomasPraun/frameshell/releases/download/v0.19.0/Frameshell-0.19.0-win-x64.exe) |");
    expect(section).toContain("| macOS (Apple silicon) | [Frameshell-0.19.0-mac-arm64.dmg]");
    expect(section).toContain("| macOS (Intel) | [Frameshell-0.19.0-mac-x64.dmg]");
    expect(section).toContain("| Linux (AppImage) | [Frameshell-0.19.0-linux-x86_64.AppImage]");
    expect(section).toContain("| Linux (Debian, Ubuntu) | [Frameshell-0.19.0-linux-amd64.deb]");
    expect(section).not.toContain(".zip");
    expect(section.startsWith("## Download")).toBe(true);
  });

  it("leaves out what is missing, and says nothing without installers", () => {
    expect(downloadsSection(["Frameshell-1.0.0-win-x64.exe"], "o/r", "v1.0.0")).not.toContain("macOS");
    expect(downloadsSection(["SHA256SUMS.txt"], "o/r", "v1.0.0")).toBe("");
  });
});
