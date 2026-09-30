import { describe, expect, it } from "vitest";
import { agentCommands, agentOfCommand } from "../src/main/agent-detect.js";

// Seam: the pure matcher from a foreground command line (as `ps` reports it) to an agent label.
describe("agentOfCommand", () => {
  it("names agent CLIs run as native executables, by path or not", () => {
    expect(agentOfCommand(["claude"])).toBe("claude");
    expect(agentOfCommand(["/Users/ana/.local/bin/claude", "--resume"])).toBe("claude");
    expect(agentOfCommand(["codex", "exec", "tighten the intro"])).toBe("codex");
    expect(agentOfCommand(["C:\\Users\\ana\\AppData\\Roaming\\npm\\gemini.cmd"])).toBe("gemini");
  });

  it("names agent CLIs run as scripts of an interpreter, skipping its flags", () => {
    expect(agentOfCommand(["node", "/opt/homebrew/bin/codex"])).toBe("codex");
    expect(agentOfCommand(["node", "--no-warnings", "/opt/homebrew/bin/gemini"])).toBe("gemini");
    expect(agentOfCommand(["python3", "-m", "aider"])).toBe("aider");
    expect(agentOfCommand(["python3", "/home/ana/.local/bin/aider"])).toBe("aider");
  });

  it("is null for shells, editors and other programs", () => {
    expect(agentOfCommand(["-zsh"])).toBeNull();
    expect(agentOfCommand(["vim", "claude.md"])).toBeNull();
    expect(agentOfCommand(["node", "server.js"])).toBeNull();
    expect(agentOfCommand([])).toBeNull();
  });

  it("uses the commands it is given, so detection can be extended", () => {
    expect(agentOfCommand(["my-agent"], { "my-agent": "mine" })).toBe("mine");
    expect(agentOfCommand(["claude"], { "my-agent": "mine" })).toBeNull();
  });
});

describe("agentCommands", () => {
  it("knows the common agent CLIs", () => {
    expect(agentCommands({})).toMatchObject({ claude: "claude", codex: "codex", gemini: "gemini" });
  });

  it("adds, relabels and removes commands from FRAMESHELL_AGENT_COMMANDS", () => {
    const commands = agentCommands({ FRAMESHELL_AGENT_COMMANDS: "my-agent=Mine, llm ,claude=cc,codex=" });
    expect(commands).toMatchObject({ "my-agent": "mine", llm: "llm", claude: "cc", gemini: "gemini" });
    expect(commands).not.toHaveProperty("codex");
  });
});
