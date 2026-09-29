import { describe, expect, it } from "vitest";
import { terminalLaunch } from "../src/main/terminal-launch.js";

const base = {
  projectDir: "/videos/talk",
  socketPath: "/tmp/frameshelld-501.sock",
  session: "term-4f2a",
  binDir: "/app-data/bin",
};

describe("terminalLaunch", () => {
  it("starts the user's login shell in the project directory", () => {
    const launch = terminalLaunch({ ...base, platform: "darwin", env: { SHELL: "/opt/homebrew/bin/fish", PATH: "/usr/bin" } });
    expect(launch).toMatchObject({ file: "/opt/homebrew/bin/fish", args: ["-l"], cwd: "/videos/talk" });
  });

  it("falls back to the platform's default shell when SHELL is unset", () => {
    expect(terminalLaunch({ ...base, platform: "darwin", env: {} }).file).toBe("/bin/zsh");
    expect(terminalLaunch({ ...base, platform: "linux", env: {} }).file).toBe("/bin/bash");
  });

  it("uses PowerShell on Windows", () => {
    const launch = terminalLaunch({ ...base, platform: "win32", projectDir: "C:\\videos\\talk", env: { Path: "C:\\Windows" } });
    expect(launch.file).toBe("powershell.exe");
    expect(launch.args).toEqual(["-NoLogo"]);
  });

  it("sets the Frameshell variables so CLI calls attribute to this session", () => {
    const { env } = terminalLaunch({ ...base, platform: "linux", env: { PATH: "/usr/bin" } });
    expect(env).toMatchObject({
      FRAMESHELL_SOCKET: "/tmp/frameshelld-501.sock",
      FRAMESHELL_PROJECT: "/videos/talk",
      FRAMESHELL_SESSION: "term-4f2a",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("puts the bundled frameshell CLI first on PATH", () => {
    expect(terminalLaunch({ ...base, platform: "linux", env: { PATH: "/usr/bin:/bin" } }).env["PATH"]).toBe(
      "/app-data/bin:/usr/bin:/bin",
    );
  });

  it("prepends to Windows' case-insensitive Path without duplicating the key", () => {
    const { env } = terminalLaunch({ ...base, platform: "win32", binDir: "C:\\bin", env: { Path: "C:\\Windows" } });
    expect(env["Path"]).toBe("C:\\bin;C:\\Windows");
    expect(env["PATH"]).toBeUndefined();
  });

  it("drops Electron's own variables so tools started in the shell behave normally", () => {
    const { env } = terminalLaunch({
      ...base,
      platform: "linux",
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", HOME: "/home/ana" },
    });
    expect(env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();
    expect(env["ELECTRON_NO_ATTACH_CONSOLE"]).toBeUndefined();
    expect(env["HOME"]).toBe("/home/ana");
  });
});
