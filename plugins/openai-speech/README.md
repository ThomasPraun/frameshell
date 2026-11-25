# @frameshell/openai-speech

Official [Frameshell](https://github.com/ThomasPraun/frameshell) speech provider for voiceovers (ADR 0034). It says each line of a voiceover script with OpenAI's text to speech, paid by **your own OpenAI account**.

```sh
frameshell plugin install @frameshell/openai-speech
export OPENAI_API_KEY=...        # see "The key" below
frameshell voiceover generate scripts/launch-vo.md --provider openai --voice nova
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. A project's plugins load only after you trust the project. Usage for agents: [`skills/openai-speech/SKILL.md`](skills/openai-speech/SKILL.md).

## What it costs, and what leaves your machine

- Each line of the script is **sent to OpenAI** to be spoken. Nothing else is: no project files, no names.
- Frameshell refuses to generate until you confirm the estimated cost (`--yes` on the CLI, the cost box in the app). Lines already generated never ask and never cost.
- The default model, `gpt-4o-mini-tts`, is billed by tokens, so the cost shown is an **approximate** price per character. `tts-1` and `tts-1-hd` are billed per character and are exact. The table is `MODEL_PRICES` in [`src/prices.ts`](https://github.com/ThomasPraun/frameshell/blob/main/plugins/openai-speech/src/prices.ts), with its source ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)) and the date it was checked; your OpenAI usage page has the real bill. A model missing from the table has no price, and nothing is generated for it.

## The key

In the app, the easiest way is the **Plugins** view: paste the key in the field under the plugin and Save. The app encrypts it with your system's keychain (Windows DPAPI, the macOS Keychain, the Linux Secret Service), keeps it only in its settings folder, and hands it to the Frameshell daemon in memory while the app is open (ADR 0050). The CLI in the app's terminals uses it too. A key in the environment variable below wins over a saved one.

The plugin reads the key from the **`OPENAI_API_KEY` environment variable** of the daemon at every call. It is never written to a project file, the history, a progress message or an error, and error texts from OpenAI are scrubbed of anything that looks like a key before they are shown.

Without the app (CLI only), the variable must exist in the environment the Frameshell **daemon** was started from. The CLI starts the daemon on demand with the environment of the shell that ran it, and the app starts it with the app's own environment. A running daemon keeps the environment it started with (it exits about 5 minutes after its last client leaves), so after setting the variable close Frameshell and the terminals using it, wait for the daemon to end (or log out and in), and open it again. An app opened from the Dock, Finder, Start menu or a shortcut does **not** see variables set in `~/.zshrc` or `~/.bashrc`:

- **macOS:** run `launchctl setenv OPENAI_API_KEY <key>` and open Frameshell again, or use the CLI from a terminal where the variable is exported. `launchctl setenv` lasts until you log out.
- **Windows:** set it once for your user with `setx OPENAI_API_KEY <key>` (or System Properties, Environment Variables); programs started afterwards see it.
- **Linux:** put it in `~/.config/environment.d/` or export it in the session the app starts from.

Typing the key on a command line leaves it in your shell history: prefer the system settings dialog or a secrets manager that exports it.

## Options

| Environment variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Your key. Required. |
| `FRAMESHELL_OPENAI_SPEECH_MODEL` | Model id. Default `gpt-4o-mini-tts`. Part of every take's cache key: another model says the lines again. |
| `FRAMESHELL_OPENAI_SPEECH_BASE_URL` | Another server speaking the same API (a proxy). Default `https://api.openai.com`; the request goes to `<base>/v1/audio/speech`. Your key goes to that server. |

Voices: `alloy` (default), `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`. The OpenAI API has no language parameter, so the script's `language` is not sent: the voice speaks the language of the text. The voices are optimised for English, so listen to a Spanish take before using it. There is no instructions or style setting in this version. `tts-1` and `tts-1-hd` (set with `FRAMESHELL_OPENAI_SPEECH_MODEL`) do not have `ballad`, `cedar`, `marin` and `verse`: with those models use one of the other nine voices, or every line fails with HTTP 400 after the cost was confirmed.

Licence: Apache-2.0.
