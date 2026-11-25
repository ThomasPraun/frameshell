---
title: Connect your AI
description: Link Claude Desktop, the ChatGPT desktop app or a coding agent to Frameshell, so it can edit your projects.
section: start
order: 2
---

Frameshell does the video work; an AI app you already use does the thinking. Connect it once and it can open, edit and export any project you have open in Frameshell.

## Claude Desktop or the ChatGPT desktop app

1. Install [Claude Desktop](https://claude.ai/download) or the ChatGPT desktop app, and open it once. Its card in Frameshell offers **Connect** only after the app has made its settings folder.
2. In Frameshell, click **Connect your AI**: it is in the project window's title bar and on the welcome screen.
3. Click **Connect** on the app's card.
4. Quit the AI app completely and open it again.

Once connected, **Open Claude Desktop** or **Open ChatGPT** on the card starts the app and copies a starter phrase you can paste as your first message. **Disconnect** undoes it; Frameshell keeps a copy of the app's settings before it changes them.

> ChatGPT on the web is not supported: it needs a public server. On Linux there is no Connect button for Claude Desktop; use a developer tool below.

## Coding agents in the terminal

If you already use Claude Code, Codex, Gemini CLI or OpenCode, you can run it inside Frameshell. Open the terminal (**View > Terminal**, or <kbd>Ctrl</kbd>+<kbd>\\</kbd>, <kbd>Cmd</kbd>+<kbd>\\</kbd> on a Mac): its guide lists the agents found on your computer with a **Start** button each, and the install command for the others.

The "For developers" group of **Connect your AI** also connects Claude Code, Codex CLI and Gemini CLI, and has a snippet to paste into Cursor, VS Code or any other MCP client.

The [Agents page](/agents/) has every agent step by step, with the commands for each system.

## Check that it works

Open a project in Frameshell, then ask your AI: "What is open in Frameshell right now?" It should name your project and its timeline. If it does not, quit and reopen the AI app, and see [Troubleshooting](../troubleshooting/).
