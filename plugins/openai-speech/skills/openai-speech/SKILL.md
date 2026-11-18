---
name: openai-speech
description: Say voiceover lines with OpenAI's paid text to speech (provider `openai`). Use when a voiceover script should use an OpenAI voice, or before confirming the cost of one.
---

# openai-speech voiceover

Provider `openai` says each line of a voiceover script with OpenAI's speech API, paid by the person's own account. The general flow (script format, generate, place, captions) is in the `voiceover` reference of the frameshell skill; this file covers only what is specific to this provider.

```sh
frameshell voiceover generate scripts/launch-vo.md --provider openai --voice nova --json
```

- **Cost.** Every call that has lines to say ends in `ConfirmationRequired` first, with `error.data.cost` (USD) and `error.data.characters`. The figure is an **estimate**: the default model bills by tokens, and the price table in the plugin (`src/prices.ts`, with its source and the date it was checked) turns that into an approximate price per character. Tell the person the amount and that it is approximate. Pass `--yes` (with the `--confirmation` token the refusal printed) only after the person confirms it. Never pass `--yes` on your own, not even for one short line. Cached lines never ask and never cost.
- **The key.** It is read from the `OPENAI_API_KEY` environment variable, at each call, in the environment the Frameshell daemon or app was started from. Never ask the person to paste it into chat, a file, a script or `frameshell.json`, never print or log it, and never put it in a command line. If a call fails with `OPENAI_API_KEY is not set`, tell the person to set it in that environment (README of the plugin) and run again.
- **Voices.** `alloy` (default), `ash`, `ballad`, `cedar`, `coral`, `echo`, `fable`, `marin`, `nova`, `onyx`, `sage`, `shimmer`, `verse`; all speak any language. The API has no language setting: the voice follows the language of the text, so the script's `language` only affects how numbers are spelled and the cache key. Voices are optimised for English; listen to a Spanish take before placing it. `tts-1` and `tts-1-hd` lack `ballad`, `cedar`, `marin` and `verse`: with one of those models pick another voice.
- **Model.** `gpt-4o-mini-tts` unless the person sets `FRAMESHELL_OPENAI_SPEECH_MODEL` (`tts-1` and `tts-1-hd` have prices here; any other id has none and the call fails before anything is said). A different model says the lines again.
- **Failures** arrive as `SpeechFailed` with a plain message: key rejected (check the key), rate limit or quota (wait, or check the account's credit), server error (try again). One short retry already happened. The line's text is sent to OpenAI: never put anything in a voiceover script that the person does not want to leave their machine.
