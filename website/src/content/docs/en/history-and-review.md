---
title: History, undo and review
description: Every change, yours or the AI's, is a step you can see and revert. Review mode lets you approve the AI's edits before they apply.
section: concepts
order: 3
---

## History

Open **History** in the sidebar, next to Files. Each entry is one step, newest first, with who made it (**You**, **Terminal**, the AI's name, **File** for a direct file edit, **Plugin**), what it did, and when.

- **Select an entry** to see its changes marked on the timeline: `+` added, `−` removed, `↔` moved, `~` changed.
- **Revert** undoes that one step, even if other changes came after it.
- <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> undoes your own last change.

Ask your AI "show me what you changed" and it opens History on its own step.

## Review mode

Want to approve each edit before it lands? Turn on review mode with the switch in **History**, or **File > Review Agent Changes Before Applying**.

From then on, the AI's changes wait as a **proposal**. A bar in every window shows it with **Before** and **After**, so you can look at both, then **Accept** or **Reject** it. While a proposal waits, your own edits still apply.

## Nothing is lost

- Your recordings are never changed: cuts are instructions in the timeline.
- A cut word or part can always come back, from the transcript or History.
- A file deleted from the project goes to your computer's trash, after Frameshell tells you which clips use it.
