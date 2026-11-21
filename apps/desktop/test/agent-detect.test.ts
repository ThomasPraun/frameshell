import { describe, expect, it } from "vitest";
import { agentCommands, agentOfCommand } from "@frameshell/protocol";
import { descendantCommands, parseProcessRows, splitCommandLine } from "../src/main/agent-detect.js";

// Seam: the pure matcher from a foreground command line (as `ps` reports it) to an agent label.
describe("agentOfCommand", () => {
  it("names agent CLIs run as native executables, by path or not", () => {
    expect(agentOfCommand(["claude"])).toBe("claude");
    expect(agentOfCommand(["/Users/ana/.local/bin/claude", "--resume"])).toBe("claude");
    expect(agentOfCommand(["codex", "exec", "tighten the intro"])).toBe("codex");
    expect(agentOfCommand(["pi", "--continue"])).toBe("pi");
    expect(agentOfCommand(["C:\\Users\\ana\\AppData\\Roaming\\npm\\gemini.cmd"])).toBe("gemini");
  });

  it("names agent CLIs run as scripts of an interpreter, skipping its flags", () => {
    expect(agentOfCommand(["node", "/opt/homebrew/bin/codex"])).toBe("codex");
    expect(agentOfCommand(["node", "--no-warnings", "/opt/homebrew/bin/gemini"])).toBe("gemini");
    expect(agentOfCommand(["node", "/opt/homebrew/bin/pi"])).toBe("pi");
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

  it("lets FRAMESHELL_AGENT_COMMANDS=pi= turn Pi detection off", () => {
    expect(agentCommands({}).pi).toBe("pi");
    expect(agentCommands({ FRAMESHELL_AGENT_COMMANDS: "pi=" }).pi).toBeUndefined();
  });

  it("adds, relabels and removes commands from FRAMESHELL_AGENT_COMMANDS", () => {
    const commands = agentCommands({ FRAMESHELL_AGENT_COMMANDS: "my-agent=Mine, llm ,claude=cc,codex=" });
    expect(commands).toMatchObject({ "my-agent": "mine", llm: "llm", claude: "cc", gemini: "gemini" });
    expect(commands).not.toHaveProperty("codex");
  });
});

// Windows (ADR 0048): no foreground process group, so the agent is found among the commands under the shell.
describe("Windows process table", () => {
  it("splits a command line at spaces outside quotes", () => {
    expect(splitCommandLine(String.raw`"C:\Program Files\nodejs\node.exe" "D:\a\frameshell\e2e\fake-agent.mjs"`)).toEqual([
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`D:\a\frameshell\e2e\fake-agent.mjs`,
    ]);
    expect(splitCommandLine(String.raw`C:\Users\ana\.local\bin\claude.exe  --resume`)).toEqual([String.raw`C:\Users\ana\.local\bin\claude.exe`, "--resume"]);
    expect(splitCommandLine(`node "" x`)).toEqual(["node", "", "x"]);
    expect(splitCommandLine("")).toEqual([]);
  });

  it("reads the rows PowerShell prints, skipping blank and broken lines", () => {
    const text = "4\t0\t\r\n120\t4\tpowershell.exe -NoLogo\r\n\r\n130\t120\tnode cli.js\twith a tab\r\nnot a row\r\n";
    expect(parseProcessRows(text)).toEqual([
      { pid: 4, parent: 0, command: "" },
      { pid: 120, parent: 4, command: "powershell.exe -NoLogo" },
      { pid: 130, parent: 120, command: "node cli.js\twith a tab" },
    ]);
  });

  it("lists the commands under the shell, nearest first, never the shell or an unrelated process", () => {
    const rows = [
      { pid: 100, parent: 1, command: "pwsh.exe" },
      { pid: 101, parent: 100, command: "conhost.exe 0x4" },
      { pid: 102, parent: 100, command: String.raw`"C:\Program Files\nodejs\node.exe" C:\npm\node_modules\@anthropic-ai\claude-code\cli.js` },
      { pid: 103, parent: 102, command: String.raw`"C:\Program Files\Git\bin\bash.exe" -c ls` },
      { pid: 200, parent: 1, command: "codex.exe" },
      { pid: 300, parent: 300, command: "loop.exe" },
      { pid: 104, parent: 100, command: "" },
    ];
    const found = descendantCommands(rows, 100);
    expect(found.map((argv) => argv[0])).toEqual(["conhost.exe", String.raw`C:\Program Files\nodejs\node.exe`, String.raw`C:\Program Files\Git\bin\bash.exe`]);
    expect(found.map((argv) => agentOfCommand(argv, agentCommands({ FRAMESHELL_AGENT_COMMANDS: "cli=claude" }))).find(Boolean)).toBe("claude");
    expect(descendantCommands(rows, 999)).toEqual([]);
  });
});
