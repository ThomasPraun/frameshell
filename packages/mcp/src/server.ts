import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonConnection,
  ErrorCode,
  type EventName,
  type EventParams,
  type AnalyzeDiffResult,
  type AnalyzeResult,
  type FrameResult,
  type Progress,
  type ReviewResult,
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
import { ProjectResolver, type ResolvedProject, appProjectNote, insideProject } from "./project.js";
import { ProjectResources, STATUS_URI, historyUri, timelineUri, transcriptUri } from "./resources.js";
import { CAPTURE_MAX_SIDE, FramesStripParams, REVIEW_MAX_IMAGES, REVIEW_MAX_SIDE, STRIP_MAX_WIDTH, type ToolSpec, buildTools } from "./tools.js";

/** Options for {@link createMcpServer}. */
export interface McpServerOptions {
  /**
   * Directory the server started in. Its project is the default of tools
   * without `cwd` and of resources; when it is in no project, the project of
   * the app window the user works in is (ADR 0014).
   */
  cwd: string;
  /**
   * Open a handshaken daemon connection. Called lazily on the first tool call
   * or resource read, and again after the connection drops. `client` is the
   * MCP client `initialize` named, so the handshake can journal its operations
   * under that agent (ADR 0025 decision 6).
   */
  connect: (client: McpClient) => Promise<DaemonConnection>;
  /** Reported to MCP clients as the server version. */
  version?: string;
  /**
   * Opt in to Claude Code channels (research preview): declare `experimental['claude/channel']` and push each
   * reference sent to this client's inbox as `notifications/claude/channel`, taking it from the inbox (ADR 0025).
   */
  channel?: boolean;
}

/** Seconds one `inbox.wait` of the channel pump blocks before it asks again. */
const CHANNEL_WAIT_S = 120;

const CHANNEL_INSTRUCTIONS =
  " References the person sends from the Frameshell app (\"Chat about this\") also arrive on their own as " +
  "`<channel source=\"frameshell\">` events holding the `[frameshell]` lines: resolve them as `inbox_take` would " +
  "return them. They are one-way and already taken from the inbox, so do not `inbox_take` for them.";

const INSTRUCTIONS =
  "Frameshell edits video projects: timelines of clips on tracks, times in decimal seconds (timeline seconds for " +
  "start/end/at/from/to, source seconds for in/out), snapped to the frame grid. Read the timeline (resource " +
  "`frameshell://timelines/main` or `timeline_show`) before editing and use the ids it returns. Every mutating tool " +
  "returns the new `revision` and `operation.tx`; `revert` with that tx id undoes your change, `tx_begin`/`tx_commit` " +
  "group several operations. Look at what you built with `frame_capture` and `frames_strip`, and review a whole film with `review` (contact, phone, motion and seam sheets, safe-zone sheets with `platform`, and `metrics`: still stretches, loudness of a `file`, sound sync, loop seam, a `file` against its export plan with `preset`, craft warnings); measure a reference video with `analyze` (shots, palette, look, rhythm, events, curve, ink, sync, loudness, tempo) and compare our film with it with `analyze_diff`. `history` with `since` " +
  "shows what the human changed after your last transaction. When the user says \"this\" or \"here\", read `ui_state` " +
  "(their playhead and selection in the app); `ui_seek`, `ui_select` and `ui_show_tx_diff` show them what you mean. " +
  "When they say they sent or pointed at something in Frameshell (\"Chat about this\"), `inbox_take` returns it as " +
  "`[frameshell]` lines. " +
  "Tools without `cwd` act on the project enclosing the directory this server started in; when that is in no " +
  "project (one server for every project, e.g. Claude Desktop), on the project open in the Frameshell app window " +
  "the user used last, and the result then names it in a `Project: <dir>` line: check it is the project you mean, " +
  "since it follows the user switching windows. No project either way: open one in Frameshell, or pass `cwd`.";

/**
 * Stdio-agnostic MCP server over frameshelld (SPEC §7b): every public registry
 * method as a tool, project files as resources with change notifications,
 * frames as images. Adds no editing logic: tools map to daemon methods.
 */
export function createMcpServer(options: McpServerOptions): Server {
  const { cwd } = options;
  const server = new Server(
    { name: "frameshell", version: options.version ?? "0.0.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        ...(options.channel ? { experimental: { "claude/channel": {} } } : {}),
      },
      instructions: options.channel ? INSTRUCTIONS + CHANNEL_INSTRUCTIONS : INSTRUCTIONS,
    },
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
  /** The MCP client (`initialize`), registered as the agent target of the default project (ADR 0025). */
  let client: McpClient = null;
  const link = new DaemonLink(() => options.connect(client), {
    onTimelineChanged: ({ timeline }) => {
      const isNew = !known.has(timeline);
      known.add(timeline);
      notify([timelineUri(timeline), historyUri(timeline)], isNew);
    },
    // Review mode (ADR 0019): status carries the open proposal.
    onProposalChanged: () => notify([STATUS_URI], false),
    // Events may have been missed while disconnected.
    onResync: () => notify([...subscribed], true),
  });
  const resolver = new ProjectResolver(cwd, () => link.get());
  let current: string | null = null;
  let pumping = false;
  let closing = false;
  /** The default project now; a switch (the user moved to another window) re-announces every resource. */
  const resolve = async (): Promise<ResolvedProject> => {
    const project = await resolver.resolve();
    if (client) void link.register(project.root, client).catch(() => {});
    if (project.root !== current) {
      const switched = current !== null;
      current = project.root;
      if (options.channel) void pump();
      if (switched) {
        known.clear();
        if (subscribed.size > 0) await link.watch(project.root).catch(() => {});
        notify([...subscribed], true);
      }
    }
    return project;
  };
  /**
   * Channel mode: hold an `inbox.wait` for this client and push what arrives as a channel event. Taking is what
   * makes a pushed reference count as read, so a hook or `inbox_take` finds nothing again (no double delivery).
   */
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    let delay = 1_000;
    while (!closing) {
      try {
        const project = await resolve();
        if (client) await link.register(project.root, client);
        const conn = await link.get();
        const { references, target } = await conn.request("inbox.wait", { cwd: project.cwd, timeout: CHANNEL_WAIT_S });
        delay = 1_000;
        for (const reference of references) {
          await server.notification(channelEvent(reference, target) as never);
        }
      } catch {
        // Not registered yet, daemon away or project gone: ask again, slower each time.
        await new Promise((done) => setTimeout(done, delay).unref?.());
        delay = Math.min(delay * 2, 30_000);
      }
    }
  };
  const resources = new ProjectResources(resolve, () => link.get());
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
      let note: string | null = null;
      if (tool.takesCwd && args["cwd"] === undefined) {
        // `tx_begin` works outside any project too: without one it simply goes without `cwd`.
        const project = tool.method === "tx.begin" ? await resolve().catch(() => null) : await resolve();
        if (!project) return await run(tool, args, onProgress);
        args["cwd"] = project.cwd;
        if (project.source === "app") note = appProjectNote(project.root);
      }
      const result = await run(tool, args, onProgress);
      if (note) result.content.push({ type: "text", text: note });
      return result;
    } catch (error) {
      return failure(describe(error, tool));
    }
  });

  const run = async (tool: ToolSpec, args: Record<string, unknown>, onProgress?: (progress: Progress) => void): Promise<CallToolResult> => {
    if (tool.name === "frame_capture") return capture(await link.get(), args);
    if (tool.name === "frames_strip") return strip(await link.get(), args);
    const result = await (await link.get()).request(tool.method!, args as never, { onProgress });
    if (tool.method === "review" || tool.method === "analyze" || tool.method === "analyze.diff") return withSheets(result as ReviewResult | AnalyzeResult | AnalyzeDiffResult);
    if (tool.method === "transcribe" || tool.method === "transcribe.speakers") {
      const transcript = (result as { transcript: string }).transcript.replace(/^transcripts\//, "");
      // Speakers rewrite an existing transcript: its resource changed, the list did not.
      notify([transcriptUri(transcript)], tool.method === "transcribe");
    }
    return { content: [{ type: "text", text: compact(result) }] };
  };

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

  // A server started inside a project registers at once, so "Chat about this" can reach it before any tool call;
  // one started elsewhere (a global server) registers on the project of its first call, never starting a daemon idly.
  server.oninitialized = () => {
    const info = server.getClientVersion();
    if (!info) return;
    client = { name: info.name, ...(info.title ? { title: info.title } : {}) };
    if (insideProject(cwd)) void resolve().catch(() => {});
  };

  const close = server.onclose;
  server.onclose = () => {
    closing = true;
    link.close();
    close?.();
  };
  return server;
}

/**
 * A reference as a Claude Code channel event: its lines as the body, and `meta` keys that are identifiers (letters,
 * digits, underscores; Claude Code drops others silently).
 */
export function channelEvent(
  reference: { lines: string[]; sentAt: string },
  target: string | null,
): { method: "notifications/claude/channel"; params: { content: string; meta: Record<string, string> } } {
  return {
    method: "notifications/claude/channel",
    params: { content: reference.lines.join("\n"), meta: { ...(target ? { target } : {}), sent_at: reference.sentAt } },
  };
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

/**
 * `frame_capture`: the `frame` method into a temp PNG unless `out` is given, returned as an image. An `out`
 * in JPEG or WebP is written as asked; the model is shown a PNG of the same frame.
 */
async function capture(conn: DaemonConnection, args: Record<string, unknown>): Promise<CallToolResult> {
  const { out, ...params } = args;
  const temp = await mkdtemp(join(tmpdir(), "frameshell-mcp-"));
  const shown = join(temp, "frame.png");
  try {
    const { format: _format, quality: _quality, ...pngParams } = params;
    const result = await conn.request("frame", (typeof out === "string" ? { ...params, out } : { ...pngParams, out: shown }) as never);
    if (result.format !== "png") await conn.request("frame", { ...pngParams, out: shown } as never);
    const png = await readFile(result.format === "png" ? result.path : shown);
    const image = pngForModel(png, CAPTURE_MAX_SIDE, CAPTURE_MAX_SIDE);
    const { path, ...facts } = result;
    const meta = { ...facts, ...(typeof out === "string" ? { path } : {}), image: { width: image.width, height: image.height } };
    return {
      content: [
        { type: "image", data: image.data.toString("base64"), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(meta) },
      ],
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Up to {@link REVIEW_MAX_IMAGES} of `sheets`, in their order: the first image of every sheet (the numbered images of one
 * sheet share a name stem) before the second of any, so a long film's many contact images cannot push out the other sheets.
 */
function imagesToSend<T extends { path: string }>(sheets: readonly T[]): T[] {
  const seen = new Map<string, number>();
  const ranked = sheets.map((sheet) => {
    const stem = sheet.path.replace(/-\d+\.png$/, ".png");
    const n = seen.get(stem) ?? 0;
    seen.set(stem, n + 1);
    return { sheet, n };
  });
  const chosen = new Set([...ranked].sort((a, b) => a.n - b.n).slice(0, REVIEW_MAX_IMAGES).map(({ sheet }) => sheet));
  return sheets.filter((sheet) => chosen.has(sheet));
}

/**
 * `review` and `analyze`: the sheets as images (at most {@link REVIEW_MAX_IMAGES}, see {@link imagesToSend}), then the run's facts with each sheet's
 * tiles reduced to their labels, which name the frame and why it is there.
 */
async function withSheets(result: ReviewResult | AnalyzeResult | AnalyzeDiffResult): Promise<CallToolResult> {
  const content: CallToolResult["content"] = [];
  for (const sheet of imagesToSend<{ path: string }>(result.sheets)) {
    const image = pngForModel(await readFile(sheet.path), REVIEW_MAX_SIDE, REVIEW_MAX_SIDE);
    content.push({ type: "image", data: image.data.toString("base64"), mimeType: "image/png" });
  }
  const facts = { ...result, sheets: result.sheets.map(({ tiles, ...sheet }) => ({ ...sheet, tiles: tiles.map((tile) => tile.label) })) };
  content.push({ type: "text", text: compact(facts) });
  return { content };
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
  const { cwd, timeline, from, to, count, preset, projectFormat } = parsed.data;
  const temp = await mkdtemp(join(tmpdir(), "frameshell-mcp-"));
  try {
    const shots: FrameResult[] = [];
    const frames = [];
    for (let i = 0; i < count; i++) {
      const at = Math.round((from + ((to - from) * i) / (count - 1)) * 1000) / 1000;
      const out = join(temp, `${i}.png`);
      shots.push(await conn.request("frame", { cwd: cwd!, timeline, at, out, ...(preset ? { preset } : {}), ...(projectFormat ? { projectFormat } : {}) }));
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

/** Events a {@link DaemonLink} follows for the watched project. */
const WATCHED: EventName[] = ["timeline.changed", "proposal.changed"];

/** The daemon could not be reached or started; the next call retries. */
class DaemonUnreachable extends Error {
  override readonly name = "DaemonUnreachable";
}

/** MCP client as `initialize` named it. */
export interface AgentClient {
  name: string;
  title?: string;
}

/** The MCP client of a server, null until `initialize`. */
export type McpClient = AgentClient | null;

/** What a {@link DaemonLink} tells its owner. */
interface LinkEvents {
  onTimelineChanged(params: EventParams<"timeline.changed">): void;
  onProposalChanged(params: EventParams<"proposal.changed">): void;
  /** A new connection replaced a lost one while watching: events in between were missed. */
  onResync(): void;
}

/**
 * One lazily opened daemon connection, reopened after it drops, with the
 * `timeline.changed` subscription and the agent target registration renewed
 * on each new connection. The daemon drops the registration with the
 * connection: the process exiting unregisters it.
 */
class DaemonLink {
  readonly #connect: () => Promise<DaemonConnection>;
  readonly #events: LinkEvents;
  #current: Promise<DaemonConnection> | null = null;
  #watched: string | null = null;
  /** Project root registered as an agent target, and as which client. */
  #target: { root: string; client: AgentClient } | null = null;
  #registration: Promise<void> = Promise.resolve();
  #lost = false;
  #closed = false;
  #retry: NodeJS.Timeout | undefined;

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

  /** Follow `timeline.changed` of the project at `root` from now on, instead of the one before, across reconnects. */
  async watch(root: string): Promise<void> {
    if (this.#watched === root) return;
    const previous = this.#watched;
    this.#watched = root;
    const conn = await this.get();
    await this.#subscribe(conn, root);
    // Its events are filtered out anyway; dropping the subscription spares the daemon the sends.
    if (previous) await conn.request("events.unsubscribe", { cwd: previous, events: WATCHED }).catch(() => {});
  }

  /** Register as agent target `client` of the project at `root` from now on, instead of the one before, across reconnects. */
  register(root: string, client: AgentClient): Promise<void> {
    // Same root: wait for the registration under way rather than return before it is done.
    if (this.#target?.root === root) return this.#registration;
    const previous = this.#target?.root;
    this.#target = { root, client };
    const opened = this.#current !== null;
    return (this.#registration = (async () => {
      const conn = await this.get();
      // A connection opened just now registered on its own.
      if (opened) await this.#register(conn);
      if (previous) await conn.request("target.unregister", { cwd: previous }).catch(() => {});
    })());
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#retry);
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
    conn.on("proposal.changed", (params) => {
      if (params.project === this.#watched) this.#events.onProposalChanged(params);
    });
    void conn.closed.then(() => {
      if (this.#current !== null) this.#lost = true;
      this.#current = null;
      this.#reconnect(1_000);
    });
    if (this.#watched) await this.#subscribe(conn, this.#watched);
    // The project may be gone since: the registration is best effort, never a reason to refuse the connection.
    if (this.#target) await this.#register(conn).catch(() => {});
    if (this.#lost && this.#watched) this.#events.onResync();
    this.#lost = false;
    return conn;
  }

  /** While registered as a target, reconnect soon after a loss: the app lists only connected targets. */
  #reconnect(delay: number): void {
    if (this.#closed || !this.#target) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => {
      if (this.#current) return;
      this.get().catch(() => this.#reconnect(Math.min(delay * 2, 30_000)));
    }, delay);
    this.#retry.unref?.();
  }

  async #register(conn: DaemonConnection): Promise<void> {
    const { root, client } = this.#target!;
    await conn.request("target.register", { cwd: root, client: client.name, ...(client.title ? { title: client.title } : {}), kind: "mcp" });
  }

  async #subscribe(conn: DaemonConnection, root: string): Promise<void> {
    await conn.request("events.subscribe", { cwd: root, events: WATCHED });
  }
}

