# Frameshell mod for Claude Code

A Claude Code mod (a plugin of function hooks) that shows Frameshell beside the chat, in the terminal, the Code tab of
the Claude desktop app, VS Code and mobile (#798). It reads the running daemon through the `frameshell` CLI and
changes nothing in the project.

- **Pane** (`/frameshell`): the project, its running and queued jobs with progress, and the review proposal waiting
  for the person, if any.
- **Frame** (`/frameshell frame <seconds>`): renders the timeline frame at that time (`frameshell frame --preset
  gif`, written to `.frameshell/claude-code/frame.png`) and shows it in the pane. The picture is drawn in the
  terminal; other surfaces show the file's path.
- **Band above the prompt** while a proposal waits for review. Accept and reject stay in the app: the daemon takes
  those from the app alone (ADR 0019), so an agent cannot approve its own proposal.
- **Status line**: `Frameshell <project> · <n> jobs · proposal waits`.

It polls `frameshell status --json` every 5 seconds, and only in a session whose folder is inside a Frameshell
project, so it never keeps a daemon awake elsewhere.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install frameshell --marketplace ThomasPraun/frameshell
```

From a shell: `claude plugin install frameshell --marketplace ThomasPraun/frameshell`. In the desktop app: click +
next to the prompt box, then Plugins, Add marketplace with `ThomasPraun/frameshell`, then Add plugin.

It needs the `frameshell` CLI on PATH. If a bare name does not start (Windows runs `frameshell.cmd`), set the
plugin's `command` option to the CLI's full path.

## Develop

```sh
claude plugin validate mods/frameshell
claude plugin test mods/frameshell
claude --plugin-dir mods/frameshell   # run it from this folder
```

The mod is not a pnpm workspace package: it runs inside Claude Code, which supplies the `claude-code` types.
