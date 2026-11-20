import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  InvalidConfigError,
  codexConfigPath,
  codexState,
  codexTable,
  connectCodex,
  disconnectCodex,
  runSetup,
} from "../src/index.js";

// Seam under test: Connect Codex (and the ChatGPT desktop app), on real files in a temp home.
const setup = { command: "/Users/ana/Library/Application Support/Frameshell/bin/frameshell", platform: "darwin" as const };

async function codexHome(config?: string) {
  const dir = await mkdtemp(join(tmpdir(), "fs-codex-"));
  await mkdir(join(dir, ".codex"));
  const file = codexConfigPath(dir, {});
  if (config !== undefined) await writeFile(file, config);
  return { dir, file };
}

const OTHER = `# My Codex setup
model = "gpt-5"   # keep
approval_policy = "on-request"

[mcp_servers.files]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.files.env]
TOKEN = "abc"

[projects."/home/ana/app"]
trust_level = "trusted"
`;

describe("codexConfigPath", () => {
  it("uses ~/.codex/config.toml, or CODEX_HOME", () => {
    expect(codexConfigPath("/home/ana", {})).toBe(join("/home/ana", ".codex", "config.toml"));
    expect(codexConfigPath("/home/ana", { CODEX_HOME: "/cfg" })).toBe(join("/cfg", "config.toml"));
  });
});

describe("codexTable", () => {
  it("writes the server with the app's command and long timeouts, as valid TOML", () => {
    const table = codexTable(setup);
    expect(parse(table)).toEqual({
      mcp_servers: { frameshell: { command: setup.command, args: ["mcp"], startup_timeout_sec: 60, tool_timeout_sec: 3600 } },
    });
  });

  it("runs the shim through cmd on Windows and escapes backslashes", () => {
    const windows = { command: String.raw`C:\Users\Ana\AppData\Roaming\Frameshell\bin\frameshell.cmd`, platform: "win32" as const };
    expect(parse(codexTable(windows))).toMatchObject({ mcp_servers: { frameshell: { command: "cmd", args: ["/c", windows.command, "mcp"] } } });
  });
});

describe("connectCodex", () => {
  it("adds the table at the end, keeping every other byte, and backs the file up", async () => {
    const { file } = await codexHome(OTHER);
    expect(await codexState(file, setup)).toMatchObject({ installed: true, connected: false, different: false });

    const backup = await connectCodex(file, setup);
    expect(await readFile(backup!, "utf8")).toBe(OTHER);
    const after = await readFile(file, "utf8");
    expect(after).toBe(`${OTHER}\n${codexTable(setup)}`);
    expect(parse(after)).toMatchObject({ model: "gpt-5", mcp_servers: { files: { env: { TOKEN: "abc" } }, frameshell: { command: setup.command } } });
    expect(await codexState(file, setup)).toMatchObject({ connected: true, different: false });
  });

  it("creates the file (and folder) when there is none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fs-codex-"));
    const file = codexConfigPath(dir, {});
    expect(await codexState(file, setup)).toEqual({ installed: false, connected: false, different: false });
    expect(await connectCodex(file, setup)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(codexTable(setup));
  });

  it("is idempotent: a second run changes no byte and makes no backup", async () => {
    const { file } = await codexHome(OTHER);
    await connectCodex(file, setup);
    const text = await readFile(file, "utf8");
    expect(await connectCodex(file, setup)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("keeps timeouts the person tuned on a server that already runs the command", async () => {
    const tuned = `[mcp_servers.frameshell]\ncommand = ${JSON.stringify(setup.command)}\nargs = ["mcp"]\ntool_timeout_sec = 90\n`;
    const { file } = await codexHome(tuned);
    expect(await connectCodex(file, setup)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(tuned);
  });

  it("points a different entry at the new command in place, with its sub-tables, leaving the tables around it", async () => {
    const old = `# top\n[mcp_servers.frameshell]\ncommand = "old"\nargs = [\n  "mcp", # why\n]\n[mcp_servers.frameshell.env]\nX = "1"\n\n# about other\n[other]\na = 1\n`;
    const { file } = await codexHome(old);
    expect(await codexState(file, setup)).toMatchObject({ connected: false, different: true });
    await connectCodex(file, setup);
    expect(await readFile(file, "utf8")).toBe(`# top\n${codexTable(setup)}\n# about other\n[other]\na = 1\n`);
    expect(await codexState(file, setup)).toMatchObject({ connected: true });
  });

  it("handles CRLF files and a last line without a line break", async () => {
    const crlf = OTHER.replace(/\n/g, "\r\n").trimEnd();
    const { file } = await codexHome(crlf);
    await connectCodex(file, setup);
    const after = await readFile(file, "utf8");
    expect(after.startsWith(`${crlf}\r\n\r\n[mcp_servers.frameshell]\r\n`)).toBe(true);
    expect(after).not.toMatch(/[^\r]\n/);
    expect(parse(after)).toMatchObject({ mcp_servers: { frameshell: { args: ["mcp"] } } });
  });

  it("is not fooled by header-looking lines inside multi-line values", async () => {
    const tricky = `notes = """\n[mcp_servers.frameshell]\ncommand = "fake"\n"""\nlist = [\n  [1],\n  [2]\n]\n`;
    const { file } = await codexHome(tricky);
    await connectCodex(file, setup);
    const after = await readFile(file, "utf8");
    expect(after.startsWith(tricky)).toBe(true);
    expect(parse(after)).toMatchObject({ notes: '[mcp_servers.frameshell]\ncommand = "fake"\n', mcp_servers: { frameshell: { command: setup.command } } });
  });

  it("refuses a file that is not TOML and changes nothing", async () => {
    const broken = 'model = "gpt-5\n[oops\n';
    const { file } = await codexHome(broken);
    await expect(connectCodex(file, setup)).rejects.toThrow(InvalidConfigError);
    await expect(connectCodex(file, setup)).rejects.toThrow(/not valid TOML/);
    await expect(disconnectCodex(file)).rejects.toThrow(InvalidConfigError);
    await expect(codexState(file, setup)).rejects.toThrow(InvalidConfigError);
    expect(await readFile(file, "utf8")).toBe(broken);
    await expect(readFile(`${file}.frameshell-backup`)).rejects.toThrow();
  });

  it("refuses an entry written with dotted keys, which it cannot edit in place, and changes nothing", async () => {
    const dotted = `mcp_servers.frameshell.command = "old"\nmcp_servers.frameshell.args = ["mcp"]\n`;
    const { file } = await codexHome(dotted);
    await expect(connectCodex(file, setup)).rejects.toThrow(/cannot edit/);
    await expect(disconnectCodex(file)).rejects.toThrow(/cannot edit/);
    expect(await readFile(file, "utf8")).toBe(dotted);
  });
});

describe("disconnectCodex", () => {
  it("takes the table and its sub-tables out and gives the file back as it was", async () => {
    const { file } = await codexHome(OTHER);
    await connectCodex(file, setup);
    await writeFile(file, `${await readFile(file, "utf8")}\n[mcp_servers.frameshell.env]\nX = "1"\n`);
    const backup = await disconnectCodex(file);
    expect(backup).not.toBeNull();
    expect(await readFile(file, "utf8")).toBe(OTHER);
    expect(await codexState(file, setup)).toMatchObject({ connected: false, different: false });
  });

  it("removes a table in the middle without touching its neighbours", async () => {
    const middle = `a = 1\n\n${codexTable(setup)}\n[other]\nb = 2\n`;
    const { file } = await codexHome(middle);
    await disconnectCodex(file);
    expect(await readFile(file, "utf8")).toBe("a = 1\n\n[other]\nb = 2\n");
  });

  it("does nothing, and makes no backup, when Frameshell is not there", async () => {
    const { file } = await codexHome(OTHER);
    expect(await disconnectCodex(file)).toBeNull();
    expect(await readFile(file, "utf8")).toBe(OTHER);
    const none = join(await mkdtemp(join(tmpdir(), "fs-codex-")), "config.toml");
    expect(await disconnectCodex(none)).toBeNull();
  });
});

describe("frameshell setup codex", () => {
  it("connects, reports and removes through CODEX_HOME in a temp dir", async () => {
    const { dir } = await codexHome(OTHER);
    const env = { CODEX_HOME: join(dir, ".codex") };
    const run = async (args: string[]) => {
      let stdout = "";
      let stderr = "";
      const code = await runSetup(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env, home: dir });
      return { code, stdout, stderr };
    };
    expect(JSON.parse((await run(["codex", "--status", "--json"])).stdout)).toMatchObject({ installed: true, connected: false });
    const connected = await run(["codex", "--command", "/opt/frameshell"]);
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain("Restart the app");
    expect(JSON.parse((await run(["codex", "--command", "/opt/frameshell", "--status", "--json"])).stdout).connected).toBe(true);
    expect(JSON.parse((await run(["codex", "--status", "--json"])).stdout)).toMatchObject({ connected: false, different: true });
    expect((await run(["codex", "--remove"])).code).toBe(0);
    expect(await readFile(join(dir, ".codex", "config.toml"), "utf8")).toBe(OTHER);

    await writeFile(join(dir, ".codex", "config.toml"), "[oops");
    const refused = await run(["codex"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("not valid TOML");
  });
});
