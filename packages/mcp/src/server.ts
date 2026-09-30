import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonConnection,
  ErrorCode,
  type EventParams,
  type FrameResult,
  type Progress,
  RpcError,
} from "@frameshell/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { contactSheet, decodePng, encodePng, fitWithin } from "./png.js";
import { ProjectResources, historyUri, timelineUri, transcriptUri } from "./resources.js";
import { CAPTURE_MAX_SIDE, FramesStripParams, STRIP_MAX_WIDTH, type ToolSpec, buildTools } from "./tools.js";

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /** Directory the server works in: default `cwd` of every tool, and the project resources come from. */
  cwd: string;
  /**
   * Open a handshaken daemon connection. Called lazily on the first tool call
   * or resource read, and again after the connection drops.
   */
  connect: () => Promise<DaemonConnection>;
  /** Reported to MCP clients as the server version. */
  version?: string;
}

const INSTRUCTIONS =
  "Frameshell edits video projects: timelines of clips on tracks, times in decimal seconds (timeline seconds for " +
  "start/end/at/from/to, source seconds for in/out), snapped to the frame grid. Read the timeline (resource " +
  "`frameshell://timelines/main` or `timeline_show`) before editing and use the ids it returns. Every mutating tool " +
  "returns the new `revision` and `operation.tx`; `revert` with that tx id undoes your change, `tx_begin`/`tx_commit` " +
  "group several operations. Look at what you built with `frame_capture` and `frames_strip`. `history` with `since` " +
  "shows what the human changed after your last transaction. When the user says \"this\" or \"here\", read `ui_state` " +
  "(their playhead and selection in the app); `ui_seek`, `ui_select` and `ui_show_tx_diff` show them what you mean. " +
  "Tools default `cwd` to the project this server runs in.";

/**
 * Stdio-agnostic MCP server over frameshelld (SPEC §7b): every public registry
 * method as a tool, project files as resources with change notifications,
 * frames as images. Adds no editing logic: tools map to daemon methods.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const { cwd } = options;
  const server = new Server(
    { name: "frameshell", version: options.version ?? "0.0.0" },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } }, instructions: INSTRUCTIONS },
  );
  const tools = buildTools(cwd);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const subscribed = new Set<string>();
  const known = new Set<string>();

  const notify = (uris: string[], listChanged: boolean) => {
    // Client may be gone; notifications are best effort.
    for (const uri of uris) if (subscribed.has(uri)) server.sendResourceUpdated({ uri }).catch(() => {});
    if (listChanged) server.sendResourceListChanged().catch(() => {});
  };
  const link = new DaemonLink(options.connect, {
    onTimelineChanged: ({ timeline }) => {
      const isNew = !known.has(timeline);
      known.add(timeline);
      notify([timelineUri(timeline), historyUri(timeline)], isNew);
    },
    // Events may have been missed while disconnected.
    onResync: () => notify([...subscribed], true),
  });
  const resources = new ProjectResources(cwd, () => link.get());
  const watch = async () => {
    const root = await resources.root();
    if (root) await link.watch(root);
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name);
    if (!tool) return failure(`Unknown tool \`${request.params.name}\`. Available: ${[...byName.keys()].join(", ")}.`);
    const args: Record<string, unknown> = { ...request.params.arguments };
    if (tool.takesCwd && args["cwd"] === undefined) args["cwd"] = cwd;
    const token = request.params._meta?.progressToken;
    let step = 0;
    const onProgress =
      token === undefined
        ? undefined
        : ({ message }: Progress) =>
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++step, message } })
              .catch(() => {});
    try {
      if (tool.name === "frame_capture") return await capture(await link.get(), args);
      if (tool.name === "frames_strip") return await strip(await link.get(), args);
      const result = await (await link.get()).request(tool.method!, args as never, { onProgress });
      if (tool.method === "transcribe") {
        const transcript = (result as { transcript: string }).transcript.replace(/^transcripts\//, "");
        notify([transcriptUri(transcript)], true);
      }
      return { content: [{ type: "text", text: compact(result) }] };
    } catch (error) {
      return failure(describe(error, tool));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const { resources: list, timelines } = await resources.list();
    for (const timeline of timelines) known.add(timeline);
    await watch().catch(() => {});
    return { resources: list };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: resources.templates() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    return { contents: [{ uri, mimeType: "application/json", text: await resources.read(uri) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribed.add(request.params.uri);
    await watch();
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscribed.delete(request.params.uri);
    return {};
  });

  const close = server.onclose;
  server.onclose = () => {
    link.close();
    close?.();
  };
  return server;
}

/** Tool error: `isError` result the model reads and can act on, never a protocol error. */
function failure(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const CODE_NAMES = new Map<number, string>(Object.entries(ErrorCode).map(([name, code]) => [code, name]));

/** Daemon errors keep their code name, actionable message and data; method names become tool names. */
function describe(error: unknown, tool: ToolSpec): string {
  if (error instanceof RpcError) {
    const name = CODE_NAMES.get(error.code) ?? `Error ${error.code}`;
    const message = tool.method ? error.message.replaceAll(`\`${tool.method}\``, `\`${tool.name}\``) : error.message;
    return `${name}: ${message}${error.data === undefined ? "" : `\ndata: ${JSON.stringify(error.data)}`}`;
  }
  if (error instanceof DaemonUnreachable) return error.message;
  return `${tool.name} failed: ${(error as Error)?.message ?? String(error)}`;
}

/**
 * Compact JSON for the model: no indentation, and operation `inverse`
 * patches dropped (bulky; `revert` takes the tx or op id instead).
 */
function compact(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key, inner: unknown) {
    return key === "inverse" && typeof this["tx"] === "string" ? undefined : inner;
  });
}

/** `frame_capture`: the `frame` method into a temp PNG unless `out` is given, returned as an image. */
async function capture(conn: DaemonConnection, args: Record<string, unknown>): Promise<CallToolResult> {
  const { out, ...params } = args;
  const temp = typeof out === "string" ? null : await mkdtemp(join(tmpdir(), "frameshell-mcp-"));
  try {
    const result = await conn.request("frame", { ...params, out: temp ? join(temp, "frame.png") : out } as never);
    const png = await readFile(result.path);
    const image = pngForModel(png, CAPTURE_MAX_SIDE, CAPTURE_MAX_SIDE);
    const { path, ...facts } = result;
    const meta = { ...facts, ...(temp ? {} : { path }), image: { width: image.width, height: image.height } };
    return {
      content: [
        { type: "image", data: image.data.toString("base64"), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(meta) },
      ],
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

/** The PNG as is when it fits, else decoded, area-downscaled and re-encoded. */
function pngForModel(png: Buffer, maxWidth: number, maxHeight: number): { data: Buffer; width: number; height: number } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width <= maxWidth && height <= maxHeight) return { data: png, width, height };
  const small = fitWithin(decodePng(png), maxWidth, maxHeight);
  return { data: encodePng(small), width: small.width, height: small.height };
}

/** `frames_strip`: `count` evenly spaced `frame` captures tiled into one contact sheet. */
async function strip(conn: DaemonConnection, args: Record<string, unknown>): Promise<CallToolResult> {
  const parsed = FramesStripParams.safeParse(args);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(({ path, message }) => `  ${["params", ...path.map(String)].join(".")}: ${message}`);
    throw new RpcError(ErrorCode.InvalidParams, `Invalid params for \`frames_strip\`:\n${lines.join("\n")}`);
  }
  const { cwd, timeline, from, to, count, preset } = parsed.data;
  const temp = await mkdtemp(join(tmpdir(), "frameshell-mcp-"));
  try {
    const shots: FrameResult[] = [];
    const frames = [];
    for (let i = 0; i < count; i++) {
      const at = Math.round((from + ((to - from) * i) / (count - 1)) * 1000) / 1000;
      const out = join(temp, `${i}.png`);
      shots.push(await conn.request("frame", { cwd: cwd!, timeline, at, out, ...(preset ? { preset } : {}) }));
      frames.push(decodePng(await readFile(out)));
    }
    const sheet = contactSheet(frames, STRIP_MAX_WIDTH);
    const meta = {
      timeline,
      columns: sheet.columns,
      image: { width: sheet.image.width, height: sheet.image.height },
      tiles: shots.map((shot, i) => ({ at: shot.at, frame: shot.frame, clip: shot.clip, row: sheet.tiles[i]!.row, column: sheet.tiles[i]!.column })),
    };
    return {
      content: [
        { type: "image", data: encodePng(sheet.image).toString("base64"), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(meta) },
      ],
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** The daemon could not be reached or started; the next call retries. */
class DaemonUnreachable extends Error {
  override readonly name = "DaemonUnreachable";
}

/** What a {@link DaemonLink} tells its owner. */
interface LinkEvents {
  onTimelineChanged(params: EventParams<"timeline.changed">): void;
  /** A new connection replaced a lost one while watching: events in between were missed. */
  onResync(): void;
}

/**
 * One lazily opened daemon connection, reopened after it drops, with the
 * `timeline.changed` subscription renewed on each new connection.
 */
class DaemonLink {
  readonly #connect: () => Promise<DaemonConnection>;
  readonly #events: LinkEvents;
  #current: Promise<DaemonConnection> | null = null;
  #watched: string | null = null;
  #lost = false;
  #closed = false;

  constructor(connect: () => Promise<DaemonConnection>, events: LinkEvents) {
    this.#connect = connect;
    this.#events = events;
  }

  /** The open connection, connecting (and resubscribing) first when needed. */
  get(): Promise<DaemonConnection> {
    if (this.#closed) return Promise.reject(new DaemonUnreachable("The MCP server is shutting down."));
    if (this.#current) return this.#current;
    const attempt = this.#open();
    this.#current = attempt;
    attempt.catch(() => {
      if (this.#current === attempt) this.#current = null;
    });
    return attempt;
  }

  /** Follow `timeline.changed` of the project at `root` from now on, across reconnects. */
  async watch(root: string): Promise<void> {
    if (this.#watched === root) return;
    this.#watched = root;
    const conn = await this.get();
    await this.#subscribe(conn, root);
  }

  close(): void {
    this.#closed = true;
    void this.#current?.then((conn) => conn.close(), () => {});
  }

  async #open(): Promise<DaemonConnection> {
    let conn: DaemonConnection;
    try {
      conn = await this.#connect();
    } catch (error) {
      throw new DaemonUnreachable(
        `Could not reach frameshelld: ${(error as Error)?.message ?? String(error)}\n` +
          "Run `frameshell status` in a terminal to see why; the next tool call retries.",
        { cause: error },
      );
    }
    conn.on("timeline.changed", (params) => {
      if (params.project === this.#watched) this.#events.onTimelineChanged(params);
    });
    void conn.closed.then(() => {
      if (this.#current !== null) this.#lost = true;
      this.#current = null;
    });
    if (this.#watched) await this.#subscribe(conn, this.#watched);
    if (this.#lost && this.#watched) this.#events.onResync();
    this.#lost = false;
    return conn;
  }

  async #subscribe(conn: DaemonConnection, root: string): Promise<void> {
    await conn.request("events.subscribe", { cwd: root, events: ["timeline.changed"] });
  }
}

