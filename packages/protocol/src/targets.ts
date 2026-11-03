// Agent targets and inboxes (ADR 0025 decisions 3-5): agents outside the app's terminals that "Chat about this" reaches.
import { z } from "zod";

/** How a target reads its inbox: `frameshell mcp` (an MCP client) or `frameshell ask --wait` (a terminal). */
export const AgentTargetKindSchema = z
  .enum(["mcp", "cli"])
  .describe("`mcp`: the `frameshell mcp` server of an MCP client; `cli`: `frameshell ask --wait` in a terminal.");

/** Client name a target registers with. */
export const AgentClientSchema = z
  .string()
  .min(1)
  .max(200)
  .describe("Client name, e.g. MCP `clientInfo.name` (`claude-code` for Claude Code) or `frameshell ask --as`.");

/** One agent target of a project, as the daemon lists it. */
export const AgentTargetSchema = z.object({
  id: z
    .string()
    .describe(
      "Target id within the project: the client's agent label, e.g. `claude` for Claude Code (client `claude-code`). Every " +
        "connection of one client on one project shares it.",
    ),
  kind: AgentTargetKindSchema.describe("How its first connection registered."),
  client: z.string().describe("Client name as its first connection gave it."),
  title: z.string().nullable().describe("Display name the client gave (MCP `clientInfo.title`, e.g. `Claude Code`); null when none."),
  connections: z.int().describe("Connections registered as this target now; 0 once every one closed while references still wait."),
  pending: z.int().describe("References waiting to be read."),
});

/** One reference sent to a target: the `[frameshell]` lines of a selection, and any request after them. */
export const AgentReferenceSchema = z.object({
  lines: z.array(z.string()).describe("Lines as the app's terminals would get them: `[frameshell] …` selection lines, then any request text."),
  sentAt: z.string().describe("ISO time the person sent it."),
});

/** Params of `target.changed`. */
export const TargetChangedSchema = z.object({
  project: z.string().describe("Absolute project root, as returned by `events.subscribe`."),
  targets: z.array(AgentTargetSchema).describe("Every target of the project now, by id."),
  read: z
    .string()
    .nullable()
    .describe("Id of the target whose references were just read (taken from its inbox); null for any other change."),
});

/** Result of `inbox.take` and `inbox.wait`. */
export const InboxTakeResultSchema = z.object({
  dir: z.string().describe("Project root."),
  target: z.string().nullable().describe("Target whose inbox was read; null when the caller is no target and named none."),
  references: z.array(AgentReferenceSchema).describe("References taken, oldest first; empty when none waited. Taking removes them."),
});

/** Default and longest `inbox.wait` in seconds. */
export const INBOX_WAIT_DEFAULT_S = 300;
/** See {@link INBOX_WAIT_DEFAULT_S}. */
export const INBOX_WAIT_MAX_S = 3600;

/** An agent target of a project. */
export type AgentTarget = z.output<typeof AgentTargetSchema>;
/** A reference waiting in a target's inbox. */
export type AgentReference = z.output<typeof AgentReferenceSchema>;
/** Kind of an {@link AgentTarget}. */
export type AgentTargetKind = z.output<typeof AgentTargetKindSchema>;
