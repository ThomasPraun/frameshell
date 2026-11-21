---
title: Troubleshooting
description: The AI does not see Frameshell, Windows warns on first start, a command is not found, and what to send in a bug report.
section: help
order: 2
---

## Claude Desktop or ChatGPT does not see Frameshell

1. Open **Connect your AI** and check that the app's card says it is connected. If it says Frameshell is set up with another command, click **Connect** again.
2. Quit the AI app completely (not only its window) and open it again.
3. Keep your project open in Frameshell: an AI app connected this way works on the project of the Frameshell window you used last.

If the card says the app's settings file is not valid, fix or remove that file first. If it says it could not change the settings, it gives the reason.

## Windows warns on the first start

Frameshell is not signed for Windows yet, so SmartScreen shows a blue window the first time. Click **More info**, then **Run anyway**. It asks once.

## "frameshell: command not found"

Outside Frameshell's own terminal, choose **File > Install 'frameshell' Command in PATH**, then open a new terminal.

## The agent in the terminal does not know Frameshell

Start it from the terminal inside Frameshell, in the project folder. Or ask it to read `.claude/skills/frameshell/SKILL.md`.

## Transcription takes long

The first run downloads the engine and model once. After that it runs on your computer, so its speed depends on the machine: on a laptop without a fast graphics chip a long recording can take several minutes.

## The preview looks different from the export

A generated clip (title, animation) plays a live preview until its render is ready; the export always uses the render. A computer without WebGL2 cannot show colour grades in the preview, and the app says so; the export still applies them.

## Anything else

Run `frameshell doctor` in the project's terminal, or choose **Help > Copy Diagnostics**, and paste it into a bug report: **Help > Report a Problem…** opens one on GitHub.
