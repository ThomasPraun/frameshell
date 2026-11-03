---
status: accepted
---

# "Chat about this" reaches the agent wherever it runs

SPEC decision 21 types a reference of the selection into the prompt of an agent in one of the app's terminals. A person who runs their agent in their own terminal, or in Claude Code, loses that: the CLI and the MCP server already work from anywhere, but the app has no way to point at something for them, and their edits land in History without an agent name. This ADR makes the app's terminals and external agents equal. Decided by the owner on 2026-11-02 (design session), amending decision 21 and SPEC §3.2/§10; terminals across windows (ADR 0012) are unchanged.

## Context (verified)

- One helper opens the right-click menu with "Ask agent" (`openAskMenu`, `renderer/src/ask/ask-agent.ts`). It is in the timeline (clips, transition edges, empty lanes), transcript, preview, Explorer files, History, Layers, People and the editor. Not in: track headers, multicam turn lanes, Explorer folders, editor tabs.
- The target is always an app terminal (`ask/ask-target.ts`). The reference format is `[frameshell] …` lines (`ask/reference.ts`), English, read by the bundled skill.
- Outside app terminals, CLI calls are attributed to a session made per command and MCP calls to `mcp-<random>`, with no agent name unless `FRAMESHELL_AGENT` is set (`packages/cli/src/session.ts`, `mcp-command.ts`).
- Claude Code (docs, 2026-11-02): `UserPromptSubmit` hooks add their output to the prompt's context, stable. **Channels** (`claude/channel` capability, `notifications/claude/channel`) push into an idle session, but are a research preview, need `--channels` per session and, off Anthropic's allowlist, `--dangerously-load-development-channels`; Team and Enterprise orgs must enable them. Cross-session messaging (a per-session inbox socket, v2.1.224+) exists; its message format was not verified.
- Not verified: whether Claude Code sends `clientInfo.name: "claude-code"` in MCP `initialize`.

## Decision

1. **App terminals and external agents are equal.** Whatever an app terminal gets (references, agent name in History, project context), an external terminal or MCP client gets too. The app terminal stays the zero-setup path; no "external mode".
2. **"Ask agent" becomes "Chat about this"** (Spanish UI "Hablar de esto"), Cmd/Ctrl+L unchanged, in every right-click menu over something that can be selected or pointed at, the four missing places included. **"Copy reference"** always sits under it. The reference format does not change.
3. **Agent targets present themselves.** App terminals as today. Each `frameshell mcp` process registers with the daemon (client name from MCP `initialize`, project) and unregisters on exit; `frameshell ask --wait` registers while it waits. Several Claude Code sessions on one project are one target with one inbox (the first to read takes it). One target: the item sends there. Several: a submenu names them ("Claude Code · project", "Terminal 2 (codex)"), Cmd/Ctrl+L goes to the last one used. No target: the reference is copied to the clipboard and the status bar says so.
4. **External targets pull from an inbox.** The daemon queues references per target, in memory only, until read; reading removes them. Read by an MCP tool (every MCP client, the skill says when), by `frameshell ask --take` / `--wait` (any terminal), and for Claude Code by a `UserPromptSubmit` hook running `frameshell ask --take`, so the next message the person types carries them. The hook never starts the daemon and prints nothing outside a Frameshell project or with the app closed. Channels are an opt-in, documented extra so Claude Code reacts without a message; cross-session messaging is research only.
5. **The app shows delivery.** Status bar: "Sent to X, waiting for it to read" then "X read it", and a pending count beside the target's name.
6. **Agents name themselves.** History names an external agent from the MCP client name, or for the CLI from the parent process (the same labels app terminals detect). `FRAMESHELL_AGENT` still overrides.
7. **One supported external agent: Claude Code.** "Connect Claude Code" in the agent guide (and `frameshell setup claude-code`) adds the MCP server and the hook at user level (`~/.claude.json`, `~/.claude/settings.json`), changing only Frameshell's keys and keeping a backup, as "Connect Claude Desktop" does. Other agents use the generic MCP and `frameshell ask` guide.
8. **The terminal panel can be closed** like any panel, remembered per project; connected agents show in the status bar.

## Considered options

- **A chat panel inside Frameshell** (rejected again, as in decision 21): it duplicates the agent's own interface and has to follow its changes.
- **Channels as the main path**: rejected while they are a preview behind per-session flags; the hook works today.
- **One target per Claude Code session**: needs the MCP process tied to its session, not verified possible; split later if one shared inbox proves wrong.
- **Running app terminals on an external terminal runtime** (e.g. herdr-core, announced 2026-10-29): rejected. App terminals already outlive their view (ADR 0012). Kept from it only the idea that a program reports who it is instead of the app guessing.

## Consequences

- New daemon methods (target register, inbox put/take/wait) go in the `methods` registry with a `PROTOCOL_VERSION` bump; the MCP tool follows from the registry; CLI `ask` and `setup` commands need the skill updated.
- The hook adds one `frameshell` process start to every Claude Code prompt on the machine; it must stay fast (no daemon start, no plugin load).
