# Agent skill eval (Case B)

Checks that the `frameshell` agent skill (`skills/frameshell/`) is enough for a fresh agent to edit footage end to end. Opt-in and not in CI: it spends model tokens, needs Claude Code, and downloads ffmpeg and whisper.cpp with its 574 MB model on the first run.

## Run

```sh
pnpm exec tsc -b
node evals/agent-skill/case-b.mjs [--model <id>] [--budget <usd>] [--timeout <minutes>] [--keep]
```

Needs macOS or Linux, `claude` (Claude Code, logged in) and `git` on `PATH`, and network access on the first run. Downloads are cached in `.cache/agent-skill-eval/` (override with `FRAMESHELL_EVAL_CACHE`), so later runs take a few minutes. Exit 0 when every check passes, 1 when one fails, 2 when setup fails.

## What it does

1. Builds a fixture recording: 11 s of public-domain speech (JFK, pinned by hash) with 2.5 s of silence inserted at two natural pauses, over a test pattern.
2. Creates a project with `frameshell init` (which installs the skill into `.claude/skills/frameshell/`) and installs the `whisper-cpp` plugin from this checkout. Transcription is warmed up in a separate project first, so model downloads stay out of the session.
3. Runs `claude -p` in the project with a Case B request in the user's words ("bring it into the project, transcribe it, remove the silences, export it for YouTube at 1080p, check that no words were lost"). The session loads only project settings (`--setting-sources project`), no MCP servers, no web tools, and uses a private daemon, data and config directory. `frameshell` on its `PATH` is this checkout's CLI.
4. Checks the result from the project itself: footage imported, word-level transcript, silences removed with speech kept, cuts snapped (none with snapping off) and grouped in a labelled transaction, a 1080p export, a `transcribe --verify` call in the session, and an independent verify reporting no lost words.

On failure the work directory is kept; `session.jsonl` there is the full session (`--output-format stream-json`). After changing the skill: `pnpm gen:skill`, `pnpm exec tsc -b`, run again.

## Permissions

The session runs with least privilege, not `bypassPermissions`: `--permission-mode default` plus an explicit `--allowedTools` list, `Bash(frameshell:*)`, `Bash(ls:*)`, `Read`, `Glob` and `Grep`, and `WebFetch` / `WebSearch` disallowed. `claude -p` cannot ask for approval, so every other tool call (other shell commands, `Edit`, `Write`, ffmpeg) is denied. That is intended: the skill changes the project only through `frameshell`, so the agent has no reason to need more. Denied calls are listed after the run ("Permission denials") and stay in `session.jsonl`; if Case B fails because the agent tried something denied, that shows the skill leaves a gap, and the fix is in the skill, not a wider allowlist. Only widen `ALLOWED_TOOLS` in `case-b.mjs` for a tool the skill legitimately names.
