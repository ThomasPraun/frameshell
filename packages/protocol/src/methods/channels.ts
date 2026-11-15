import { z } from "zod";
import {
  AgentClientSchema,
  AgentTargetKindSchema,
  AgentTargetSchema,
  INBOX_WAIT_DEFAULT_S,
  INBOX_WAIT_MAX_S,
  InboxTakeResultSchema,
} from "../targets.js";
import { type MethodSpec, AbsolutePath, CwdParam, EventNameSchema, EventsParams } from "./shared.js";

/** Daemon methods: project file writes, events, agent targets and inboxes. */
export const channelMethods = {
  "file.write": {
    mutating: true,
    description:
      "Write a UTF-8 text file inside a Frameshell project (scripts, compositions, config), replacing it atomically. " +
      "Missing parent directories are created. `frameshell.json`, `timelines/*.json`, `transcripts/**/*.words.json`, `beats/**/*.beats.json`, `people.json`, `style.json` and `brand.json` must pass schema validation " +
      "or the write is rejected with InvalidProjectFile and the old file kept. A timeline write is a direct edit (SPEC §6.4): it must " +
      "carry the timeline's current `revision` (else StaleRevision), is checked against timeline rules like any operation, and is " +
      "journaled as a `timeline.patch` operation by author `file` with the revision bumped. In review mode (ADR 0019) a " +
      "timeline write by anyone but the app joins a proposal instead; a new timeline file, or one replacing an unreadable " +
      "file, is kept with the proposal, not in `timelines/`, until the person accepts it. A `frameshell.json` write that " +
      "changes `formats` is journaled as a `file.write` config operation (ADR 0036) in the writer's transaction, so `history` " +
      "lists it and `revert` undoes it; in review mode its formats change waits in the proposal while its other keys are " +
      "written at once. A `style.json` write that changes a value is a `file.write` config operation the same way, and in " +
      "review mode it waits in the proposal whole (prefer `style.set`). Fails with OutsideProject for paths in no project, under daemon-owned `.frameshell/` (any letter case), " +
      "resolving outside the project through a symlink, or naming a symlink.",
    params: z.strictObject({
      path: AbsolutePath.describe("Absolute file path inside a project, e.g. `/home/ana/videos/launch/scripts/launch.md`."),
      content: z.string().describe("Full new file content, UTF-8."),
    }),
    result: z.object({
      project: z.string().describe("Absolute root of the project holding the file."),
      path: z.string().describe("Written file, project-relative and `/`-separated."),
    }),
  },
  "file.uses": {
    // The app's Move to Trash only: it lists what would go missing before asking the person.
    internal: true,
    description:
      "What in the enclosing project's timelines names a file or folder: media, timeline and generated clips by " +
      "`asset` or `source`, multicam angles and mics by `asset`. A folder matches everything under it. Read-only.",
    params: z.strictObject({
      path: AbsolutePath.describe("Absolute file or folder path inside a project."),
    }),
    result: z.object({
      project: z.string().describe("Absolute root of the project holding the path."),
      path: z.string().describe("The path, project-relative and `/`-separated."),
      uses: z
        .array(
          z.object({
            timeline: z.string().describe("Timeline id."),
            id: z.string().describe("Clip id, or multicam group id for an angle or mic."),
            ref: z.string().describe("The project-relative path it names."),
          }),
        )
        .describe("Sorted by timeline, then id; empty when nothing names it."),
    }),
  },
  "events.subscribe": {
    description:
      "Receive the given events of the enclosing project as notifications on this connection until it closes or " +
      "`events.unsubscribe`. Idempotent. Used by the app and the MCP server to follow changes made by other clients.",
    internal: true,
    params: EventsParams,
    result: z.object({
      dir: z.string().describe("Project root the subscription is scoped to; notifications carry it as `project`."),
      events: z.array(EventNameSchema).describe("Every event this connection now receives for `dir`."),
    }),
  },
  "events.unsubscribe": {
    description: "Stop receiving the given events of the enclosing project on this connection. Unknown subscriptions are ignored.",
    internal: true,
    params: EventsParams,
    result: z.object({
      dir: z.string().describe("Project root."),
      events: z.array(EventNameSchema).describe("Events this connection still receives for `dir`."),
    }),
  },
  "target.register": {
    description:
      "Register this connection as an agent target of the enclosing project (ADR 0025) until it closes or " +
      "`target.unregister`: the app's \"Chat about this\" can then send it references, read with `inbox.take` or " +
      "`inbox.wait`. Every connection of one client on one project is one target with one inbox. Sent by `frameshell mcp` " +
      "on MCP `initialize` and by `frameshell ask --wait`. Registering again (another client) moves the registration.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      client: AgentClientSchema,
      title: z.string().min(1).max(200).optional().describe("Display name, e.g. MCP `clientInfo.title` (`Claude Code`)."),
      kind: AgentTargetKindSchema,
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      target: AgentTargetSchema,
    }),
  },
  "target.unregister": {
    description: "This connection stops being an agent target of the enclosing project. Not registered: nothing happens.",
    internal: true,
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({ dir: z.string().describe("Project root.") }),
  },
  "target.list": {
    description: "Agent targets of the enclosing project (ADR 0025): who \"Chat about this\" can reach outside the app's terminals.",
    internal: true,
    params: z.strictObject({ cwd: CwdParam }),
    result: z.object({
      dir: z.string().describe("Project root."),
      targets: z.array(AgentTargetSchema).describe("Sorted by id."),
    }),
  },
  "inbox.put": {
    description:
      "Queue a reference for agent target `target` of the enclosing project; it waits, in memory only, until the target " +
      "reads it. Sent by the app's \"Chat about this\". Fails with InvalidParams naming the targets when `target` is unknown.",
    internal: true,
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).describe("Target id, e.g. `claude`."),
      lines: z.array(z.string()).min(1).describe("The reference's lines."),
    }),
    result: z.object({
      dir: z.string().describe("Project root."),
      target: AgentTargetSchema.describe("The target after queueing."),
      read: z.boolean().describe("A reader waiting with `inbox.wait` took it at once: nothing was queued."),
    }),
  },
  "inbox.take": {
    description:
      "Take the references the person sent you from the Frameshell app (right-click \"Chat about this\" or Cmd/Ctrl+L on " +
      "clips, words, a range, a frame region, files…): each is `[frameshell] …` lines naming what they point at, then " +
      "maybe their request. Call it when the person says \"this\", \"here\", \"what I sent\" or \"what I selected\" " +
      "and no `[frameshell]` line is in their message, then resolve the lines before acting. Taking removes them; " +
      "`references` is empty when nothing waits. Reads this client's inbox; `target` reads another one.",
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).optional().describe("Target id to read, e.g. `claude`. Default: the caller's own."),
    }),
    result: InboxTakeResultSchema,
  },
  "inbox.wait": {
    description:
      "Wait for the person to point at something in the Frameshell app, then take it as `inbox.take` does: when " +
      "nothing waits, block until the person sends a reference or `timeout` seconds pass " +
      `(default ${INBOX_WAIT_DEFAULT_S}, max ${INBOX_WAIT_MAX_S}); \`references\` is empty after a timeout. Fails with ` +
      "InvalidParams when the caller is no target and names none.",
    params: z.strictObject({
      cwd: CwdParam,
      target: z.string().min(1).optional().describe("Target id to read, e.g. `claude`. Default: the caller's own."),
      timeout: z
        .number()
        .positive()
        .max(INBOX_WAIT_MAX_S)
        .optional()
        .describe(`Seconds to wait, at most ${INBOX_WAIT_MAX_S}. Default ${INBOX_WAIT_DEFAULT_S}.`),
    }),
    result: InboxTakeResultSchema,
  },
} as const satisfies Record<string, MethodSpec>;
