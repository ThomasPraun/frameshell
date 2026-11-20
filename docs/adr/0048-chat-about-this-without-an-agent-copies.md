---
status: accepted
---

# "Chat about this" with no agent copies the reference, never types it at a bare shell

Changes one sentence of ADR 0025 decision 3 and the fallback in ADR 0012. The owner chose it on 2026-11-20 (#743 item 6, UX walkthrough round 2): "Copiar y avisar".

## Context (verified)

- ADR 0025 decision 3: with no agent detected anywhere, the reference is typed into the last focused app terminal, so an agent Frameshell does not recognise (aider, a script) still gets it. ADR 0012 says the same for the terminal target.
- In the walkthrough (#743, cloud tester C1 #17) a new user pressed "Hablar de esto" with only a shell open: the reference sat at the shell prompt, where Enter runs it as a command.
- Agent detection reads the terminal's foreground process (`agent-detect.ts`) on macOS and Linux; Windows has no foreground process groups, so an agent in an app terminal there is known only through its MCP registration (ADR 0025 decision 3, "Connect Claude Code").

## Decision

1. **No agent anywhere: the clipboard.** When no app terminal runs a detected agent and no external target is registered, "Chat about this" puts the reference on the clipboard, shows the terminal panel (its agent guide is where one starts) and says in the status bar: "No agent is running: the reference is on the clipboard. Start one in the terminal, then paste it." It is never typed at a shell prompt.
2. **An agent terminal still gets it typed**, unsent, as ADR 0012 says; external targets still get it in their inbox (ADR 0025 decision 4).
3. **An agent Frameshell does not recognise** is named with `FRAMESHELL_AGENT_COMMANDS` (`name=label`), as before; otherwise the person pastes.

## Consequences

- On Windows, an agent in an app terminal that is not connected through MCP (Connect Claude Code) is not detected, so the reference goes to the clipboard there too; connecting Claude Code makes it a target again.
- e2e specs that send to the stand-in agent (`e2e/fake-agent.mjs`) set `FRAMESHELL_AGENT_COMMANDS=fake-agent=fake` and wait for the tab's `data-agent` before sending.
