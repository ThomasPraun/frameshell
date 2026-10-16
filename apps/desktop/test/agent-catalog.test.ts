import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, detectAgents, extraAgentDirs, findCommand, startCommand } from "../src/main/agent-catalog.js";
import { agentOfCommand } from "../src/main/agent-detect.js";

describe("agent catalog", () => {
  it("offers agents that terminal detection labels with the same id", () => {
    for (const entry of AGENT_CATALOG) expect(agentOfCommand([entry.command])).toBe(entry.id);
  });

  it("finds a command in the first folder holding it, with Windows extensions", async () => {
    const files = new Set(["/opt/homebrew/bin/codex", "/home/ana/.local/bin/codex", "C:\\npm\\gemini.cmd"]);
    const exists = async (file: string) => files.has(file);
    expect(await findCommand("codex", ["/usr/bin", "/opt/homebrew/bin", "/home/ana/.local/bin"], "darwin", exists)).toBe("/opt/homebrew/bin/codex");
    expect(await findCommand("gemini", ["C:\\npm"], "win32", exists)).toBe("C:\\npm\\gemini.cmd");
    expect(await findCommand("claude", ["/usr/bin"], "linux", exists)).toBeNull();
  });

  it("reports each agent found or not, with this platform's install command and Pi's warning", async () => {
    const agents = await detectAgents(["/bin"], "linux", async (file) => file === "/bin/claude");
    expect(agents.map(({ id, path }) => [id, path])).toEqual([
      ["claude", "/bin/claude"],
      ["codex", null],
      ["gemini", null],
      ["opencode", null],
      ["pi", null],
    ]);
    expect(agents[0]?.install).toContain("install.sh");
    expect(agents.find((agent) => agent.id === "pi")?.unattended).toBe(true);
    const windows = await detectAgents([], "win32", async () => false);
    expect(windows[0]?.install).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("also looks where installers put agents that a GUI app's PATH misses", () => {
    expect(extraAgentDirs("darwin", "/Users/ana", {})).toContain("/Users/ana/.local/bin");
    expect(extraAgentDirs("win32", "C:\\Users\\ana", { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" })).toContain("C:\\Users\\ana\\AppData\\Roaming\\npm");
  });

  it("starts an agent by its path, quoted for the terminal's shell", () => {
    expect(startCommand("/Users/ana/.local/bin/claude", "darwin")).toBe("/Users/ana/.local/bin/claude");
    expect(startCommand("/Users/ana/My Tools/claude", "darwin")).toBe("'/Users/ana/My Tools/claude'");
    expect(startCommand("/tmp/it's/pi", "linux")).toBe("'/tmp/it'\\''s/pi'");
    expect(startCommand("C:\\Users\\ana\\.local\\bin\\claude.exe", "win32")).toBe("C:\\Users\\ana\\.local\\bin\\claude.exe");
    expect(startCommand("C:\\Program Files\\pi\\pi.exe", "win32")).toBe('& "C:\\Program Files\\pi\\pi.exe"');
  });
});
