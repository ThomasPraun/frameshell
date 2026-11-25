---
status: accepted
---

# OpenAI key: a field in the app, kept in the OS keychain, handed to the daemon in memory

ADR 0034 decisions 6 and 24 and ADR 0046 decision 5 read the OpenAI key from the `OPENAI_API_KEY` environment variable only, with "the OS keychain later". The UX walkthrough of 2026-11-20 (#731, follow-up #740 item 6) showed people without a terminal stuck at "set the environment variable and restart Frameshell": on Windows and macOS an app started from the Start menu or the Dock does not see a variable set in a shell profile, and the restart has to include the daemon. The owner decided on 2026-11-21: **a field for the key in the Plugins view, stored encrypted by the operating system, handed to the daemon only**. This ADR amends those three decisions; everything else in them stands.

## Decisions

1. **Where it is typed.** The Plugins view of the app shows a key field under each plugin that needs the OpenAI key (`need.kind: "openai-key"`). Save and Remove act on one key for the whole machine (both OpenAI plugins use the same one). The field is a password input; after saving it is cleared and never shows the key again, only "Key saved in this app" or "Key from the environment".
2. **How it is kept.** Electron `safeStorage` encrypts the key (DPAPI on Windows, the login Keychain on macOS, the Secret Service / KWallet on Linux) and the app writes the ciphertext to `openai-key.bin` in `configDir` (`resolveAppDirs`): a user decision, the same place as the app's other settings. When `safeStorage` cannot encrypt, or on Linux picks its `basic_text` fallback (a fixed key, not real protection), the field is replaced by a sentence saying the key cannot be kept safely here and naming `OPENAI_API_KEY`; nothing is written.
3. **How it reaches the daemon.** Only the app's main process decrypts it. It hands the key to the daemon with an internal method, `credentials.provide` (`{ name: "OPENAI_API_KEY", value: string | null }`, never an MCP tool or CLI verb), on every new connection of its daemon link and after each Save or Remove. The daemon sets its own `process.env.OPENAI_API_KEY`, so the plugins keep reading the key as before (decision 5 of ADR 0046: from the environment, at each call) and need no change. The key lives in daemon memory only while the app connection that gave it stays open; when that connection closes the daemon forgets it, like `session.tag`.
4. **The environment still wins.** A daemon whose own environment had `OPENAI_API_KEY` when it started ignores `credentials.provide` and answers `source: "environment"`; the app also shows "Key from the environment" when its own environment has the variable, and offers no Save then. The CLI and terminals keep working exactly as before.
5. **Where the key never goes** (unchanged rule, new paths): project files, the journal, progress, error data, logs, the renderer after Save, the IPC replies, the daemon's replay cache (`credentials.provide` is not `mutating`). Main sends the key to the daemon only over the local socket, as a request param.

## Consequences

- A terminal in the app (and the CLI run from any terminal) uses the saved key through the shared daemon while the app is open; after the app quits, a daemon it started forgets the key.
- `PROTOCOL_VERSION` goes up for the new method.
- The `need` text of the OpenAI plugins says the key can be saved in the Plugins view or set as `OPENAI_API_KEY`.
- Not here: other providers' keys (the `name` enum grows when one exists), syncing the key across machines, reading the key back into the app.
