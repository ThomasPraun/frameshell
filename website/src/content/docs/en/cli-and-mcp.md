---
title: CLI and MCP
description: For developers. The frameshell command, the MCP server, and where the full reference lives.
section: reference
order: 2
---

Everything the app and your AI do goes through one daemon. You can reach it two ways: the `frameshell` command line and the MCP server. Both take the same arguments and land in the same History.

## The `frameshell` command

It is ready in Frameshell's own terminal. To use it from any other terminal, choose **File > Install 'frameshell' Command in PATH**. On Linux the `.deb` installs it for you.

A few to start with:

```sh
frameshell init                              # turn this folder into a project
frameshell import assets/talk.mp4            # add media
frameshell transcribe assets/talk.mp4        # words with times
frameshell timeline show --json              # the edit, as data
frameshell cut --from 12.4 --to 15.1         # remove a range and close the gap
frameshell render --preset youtube-1080p     # export
frameshell history                           # every step, with who made it
frameshell --help                            # every command and flag
```

Times can be seconds, marker names (`--at hook+0.5`), beats and bars (`--at bar:8`) or words (`--from word:so --to word:so#2`).

## The MCP server

`frameshell mcp` serves every operation as an MCP tool, plus frames as images and the app's state (playhead, selection). Claude Desktop and the ChatGPT desktop app use it through [Connect your AI](../connect-your-ai/). Others:

```sh
frameshell setup claude-code    # or codex, gemini
claude mcp add frameshell -- frameshell mcp
```

## Full reference

- [Every CLI command](https://github.com/ThomasPraun/frameshell/blob/main/skills/frameshell/reference/cli.md)
- [MCP server](https://github.com/ThomasPraun/frameshell/blob/main/docs/mcp.md)
- [The agent skill](https://github.com/ThomasPraun/frameshell/tree/main/skills/frameshell): what your AI reads to learn Frameshell
- [Project files](https://github.com/ThomasPraun/frameshell/blob/main/skills/frameshell/reference/project-model.md): `frameshell.json`, timelines, transcripts
- [Specification](https://github.com/ThomasPraun/frameshell/blob/main/docs/SPEC.md): architecture and decisions
