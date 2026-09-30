import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type CallToolResult, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { methodJsonSchemas } from "@frameshell/protocol";
import { type Daemon, startDaemon } from "../../core/src/index.js";
import { tempDir, uniqueSocketPath } from "../../core/test/helpers.js";
import { makeClip } from "../../core/test/media-fixtures.js";
import { testBinaryManager } from "../../core/test/media-tools.js";
import { commitFixture } from "../../core/test/plugin-fixture.js";

// Contract, black-box: a scripted MCP client drives the built `frameshell mcp` over stdio against an in-process daemon.
const cliBin = fileURLToPath(new URL("../../cli/dist/bin/frameshell.js", import.meta.url));
const FAKE_TRANSCRIBER = fileURLToPath(new URL("./fixtures/fake-transcriber/", import.meta.url));
const SLOW = 180_000;

let daemon: Daemon;
let client: Client;
let project: string;
const updated: string[] = [];

/** Call a tool; fail the test with the tool's own error text when it reports one. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result;
}

// Tool and resource payloads are asserted field by field; typing each shape here would duplicate the registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Payload = Record<string, any>;

/** The JSON text part of a tool result. */
function json(result: CallToolResult): Payload {
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse((text as { text: string }).text);
}

async function read(uri: string): Promise<Payload> {
  const { contents } = await client.readResource({ uri });
  return JSON.parse((contents[0] as { text: string }).text);
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(check(), what).toBe(true);
}

beforeAll(async () => {
  const dirs = { dataDir: tempDir(), configDir: tempDir() };
  daemon = await startDaemon({ socketPath: uniqueSocketPath(), dirs, binaries: testBinaryManager(), idleTimeoutMs: Infinity });
  project = tempDir();
  client = new Client({ name: "contract-test", version: "0.0.0" });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (note) => void updated.push(note.params.uri));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cliBin, "mcp"],
      cwd: project,
      env: {
        ...(process.env as Record<string, string>),
        FRAMESHELL_SOCKET: daemon.socketPath,
        FRAMESHELL_DATA_DIR: dirs.dataDir,
        FRAMESHELL_CONFIG_DIR: dirs.configDir,
      },
      stderr: "inherit",
    }),
  );
}, SLOW);

afterAll(async () => {
  await client?.close();
  await daemon?.close();
});

describe("frameshell mcp", () => {
  it("lists one tool per public registry method, plus frames_strip", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    const publicMethods = Object.entries(methodJsonSchemas()).filter(([, schema]) => !schema.internal);
    expect(names).toHaveLength(publicMethods.length + 1);
    expect(names).toEqual(expect.arrayContaining(["clip_add", "cut", "transcribe", "revert", "frame_capture", "frames_strip", "tx_begin"]));
  });

  it(
    "edits a fixture project end to end: import, cut, transcribe, capture a frame, revert",
    async () => {
      // Project with a 2 s clip and the fake transcription provider.
      expect(json(await call("project_init", { dir: project, name: "Contract" }))).toMatchObject({ project: { name: "Contract" } });
      const plugin = commitFixture((() => {
        const dir = join(tempDir(), "fake-transcriber");
        cpSync(FAKE_TRANSCRIBER, dir, { recursive: true });
        return dir;
      })());
      expect(json(await call("plugin_install", { spec: plugin.spec }))).toMatchObject({ name: "fake-transcriber" });

      const footage = join(tempDir(), "take.mp4");
      await makeClip(footage, { durationS: 2 });
      const imported = json(await call("asset_import", { files: [footage] }));
      const asset = imported["imported"][0].asset as string;
      expect(asset).toBe("assets/take.mp4");

      // Follow the timeline resource, then edit.
      await client.subscribeResource({ uri: "frameshell://timelines/main" });
      const track = json(await call("track_add", { kind: "video" }))["changes"].added[0] as string;
      const added = json(await call("clip_add", { track, asset }));
      expect(added).toMatchObject({ timeline: "main", revision: expect.any(Number), operation: { tx: expect.stringMatching(/^tx_/) } });
      expect(added["operation"]).not.toHaveProperty("inverse");
      await until(() => updated.includes("frameshell://timelines/main"), "timeline change notification");

      // Transcribe with the fake provider; the transcript is a resource.
      const transcribed = json(await call("transcribe", { asset, provider: "fake" }));
      expect(transcribed).toMatchObject({ transcript: "transcripts/take.words.json", words: 2, provider: "fake" });
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual(
        expect.arrayContaining(["frameshell://status", "frameshell://timelines/main", "frameshell://timelines/main/history", "frameshell://transcripts/take.words.json"]),
      );
      const transcript = await read("frameshell://transcripts/take.words.json");
      expect(transcript["words"].map((w: { text: string }) => w.text)).toEqual(["Hola", "mundo."]);

      // A script under scripts/ is served as an outline (`script.outline`), one scene per `## ` heading.
      mkdirSync(join(project, "scripts"), { recursive: true });
      writeFileSync(join(project, "scripts", "launch.md"), "---\ntitle: Launch\n---\n## Intro\nHola mundo.\n\n## Outro\nAdios.\n");
      const withScript = await client.listResources();
      expect(withScript.resources.map((r) => r.uri)).toContain("frameshell://scripts/launch.md/outline");
      expect((await client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toContain("frameshell://scripts/{file}/outline");
      const outline = await read("frameshell://scripts/launch.md/outline");
      expect(outline).toMatchObject({ path: "scripts/launch.md", meta: { title: "Launch" } });
      expect(outline["scenes"].map((scene: { slug: string }) => scene.slug)).toEqual(["intro", "outro"]);

      // Cut 0.5 s out inside an explicit transaction.
      const tx = json(await call("tx_begin", { label: "tighten intro" }))["tx"] as string;
      const cut = json(await call("cut", { from: 0.5, to: 1, snap: false }));
      expect(cut).toMatchObject({ revision: added["revision"] + 1, operation: { op: "cut", tx } });
      expect(json(await call("tx_commit"))).toMatchObject({ tx, operations: 1 });
      expect(await read("frameshell://timelines/main")).toMatchObject({ revision: cut["revision"], duration: 1.5 });

      // See the result: the frame as an image, and a contact sheet.
      const frame = await call("frame_capture", { at: 0.25 });
      const image = frame.content.find((part) => part.type === "image") as { data: string; mimeType: string };
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data, "base64").subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(json(frame)).toMatchObject({ frame: 7, clip: added["changes"].added[0], width: 1920, height: 1080, image: { width: 1280, height: 720 } });
      const sheet = await call("frames_strip", { from: 0, to: 1.4, count: 4 });
      expect(sheet.content.some((part) => part.type === "image")).toBe(true);
      expect(json(sheet)).toMatchObject({ columns: 2, tiles: [{ at: 0, row: 0, column: 0 }, {}, {}, { row: 1, column: 1 }] });

      // Revert the transaction: the cut is undone as a new operation.
      const reverted = json(await call("revert", { target: tx }));
      expect(reverted).toMatchObject({ revision: cut["revision"] + 1, operation: { op: "revert" } });
      expect(await read("frameshell://timelines/main")).toMatchObject({ duration: 2 });
      const history = await read("frameshell://timelines/main/history");
      expect(history["transactions"].map((t: { tx: string }) => t.tx)).toContain(tx);
    },
    SLOW,
  );

  it("prints how to register it with Claude Code", () => {
    const help = spawnSync(process.execPath, [cliBin, "mcp", "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stderr).toContain("claude mcp add frameshell -- frameshell mcp");
  });

  it("returns daemon failures as actionable tool errors", async () => {
    const result = (await client.callTool({ name: "clip_move", arguments: { clip: "c_nope00", start: 1 } })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/^ClipNotFound: .*c_nope00/);
    const outside = (await client.callTool({ name: "frame_capture", arguments: { at: 99 } })) as CallToolResult;
    expect(outside.isError).toBe(true);
    expect((outside.content[0] as { text: string }).text).toMatch(/^InvalidOperation: .*"valid":\{"min":0,"max":1\.967\}/s);
    const invalid = (await client.callTool({ name: "cut", arguments: { from: "soon" } })) as CallToolResult;
    expect((invalid.content[0] as { text: string }).text).toMatch(/^InvalidParams: Invalid params for `cut`/);
  });

  it("answers ui_state without the app, and fails navigation with a hint to open it", async () => {
    expect(json(await call("ui_state"))).toEqual({ connected: false });
    const seek = (await client.callTool({ name: "ui_seek", arguments: { at: 1 } })) as CallToolResult;
    expect(seek.isError).toBe(true);
    expect((seek.content[0] as { text: string }).text).toMatch(/^UiNotConnected: .*\ndata: .*open the project in the Frameshell app/s);
  });
});
