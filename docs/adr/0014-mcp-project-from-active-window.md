---
status: accepted
---

# MCP project resolution from the active window

Refines SPEC §7b and decision 20: how `frameshell mcp` picks the project of a tool call or resource without `cwd`. User approved option (a) on 2026-10-16 (#192).

## Context

- Before, every tool defaulted `cwd` to the directory the server started in. Claude Code starts one server per project directory, so that was the project.
- Claude Desktop runs one global server, started outside any project (often `/`). Every call without `cwd` then failed with `ProjectNotFound`, and the target user (no terminal, ADR 0013) cannot be asked for a path.
- The app already publishes what each window shows to the daemon's UI broker (`ui.publish`), and `ui.*` commands go to the newest window of a project.

## Decision

1. **Server directory first.** When the server's directory is inside a project, that project is the default, as before. It is kept for the server's life once found.
2. **Else the active window.** When it is in no project, a call without `cwd` acts on the project of the app window the user works in, asked from the daemon on every call (internal method `ui.active`). Resources follow the same rule.
3. **Active window** = the project window focused last, among windows showing a project (a detached panel window counts as its project window). It stays active while the app is in the background, so the user can switch to Claude Desktop. Main reports focus with each `ui.publish` (`focused`); a window that reports in the background, e.g. while playing, does not become active. With no focus known, the window that reported last is active. `ui.*` commands for a project go to the same window.
4. **No window**: the call fails with `ProjectNotFound`: "Open a project in Frameshell, or pass cwd". The resource list holds only `frameshell://status`.
5. **Visible**: a tool result whose project came from the app gets a line `Project: <dir> (…)`. When the resolved project changes, the server marks every subscribed resource updated and sends `list_changed`. The server instructions and every `cwd` description state the rule.
6. An explicit `cwd` always wins, and is never checked against the app.

## Considered options

- **(a) Active window (chosen).** No setup for the user, and it matches what they look at.
- **(b) Require `cwd` on every call.** Rejected: the model has to learn a path the user cannot give.
- **(c) A project chosen in the server's config** (`--project`). Rejected as the only way: one config per project defeats a global server. Starting the server inside a project still works.

## Consequences

- Risk: the user switches windows in the middle of a task and the agent's next call lands in the other project. The `Project:` line and the instructions make that visible; for multi-step work the agent can pass `cwd` from the first result.
- Protocol v35: `ui.active`, `ui.publish` `focused`.
- Resource URIs carry no project: after a switch, `frameshell://timelines/main` is the other project's timeline. Subscribers get it as an update, at the next request after the switch.
