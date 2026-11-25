# @frameshell/openai-transcription

Official [Frameshell](https://github.com/ThomasPraun/frameshell) transcription provider (ADR 0046). It transcribes an asset with OpenAI's `gpt-transcribe`, paid by **your own OpenAI account**, and times its words with whisper.cpp on your machine. The default, whisper.cpp, runs on your machine and costs nothing; this plugin is for when you prefer the service.

```sh
frameshell plugin install @frameshell/openai-transcription
frameshell plugin install @frameshell/whisper-cpp   # times the words; usually installed already
export OPENAI_API_KEY=...        # see "The key" below
frameshell transcribe assets/talk.mp4 --provider openai --model gpt-transcribe
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. A project's plugins load only after you trust the project. Usage for agents: [`skills/openai-transcription/SKILL.md`](skills/openai-transcription/SKILL.md).

## What leaves your machine, and what it costs

- The **audio of the asset** you transcribe is uploaded to OpenAI: the 16 kHz mono WAV Frameshell extracts for transcription, cut into pieces of at most 10 minutes at pauses. Also sent: the language code and, for later pieces, the last words of the piece before. Nothing else: no file names, no project files, no transcripts.
- Frameshell refuses to transcribe until you confirm, on **every** run: the refusal states that the audio is uploaded, its length and the estimated cost (`--yes` on the CLI). Nothing is remembered between runs.
- `gpt-transcribe` costs about $0.0045 a minute of audio, `whisper-1` $0.006. The table is `MODEL_PRICES` in [`src/prices.ts`](https://github.com/ThomasPraun/frameshell/blob/main/plugins/openai-transcription/src/prices.ts), with its sources and the date it was checked: [OpenAI pricing](https://developers.openai.com/api/docs/pricing) does not list `gpt-transcribe` yet, so its price comes from an independent guide. Your OpenAI usage page has the real bill. With `gpt-transcribe` the audio is sent once; with `whisper-1`, a few seconds around over-long words may be sent again in the same run (not in the estimate).
- Other Frameshell checks (`transcribe --verify`, shoot takes, voiceover checks, `analyze`) never use this provider: they need a local one.

## Word timing

OpenAI's `gpt-transcribe` (the default) gives the text without word times. Frameshell transcribes the same audio with whisper.cpp on your machine first, then lays OpenAI's words, spelling and punctuation over whisper.cpp's timed words (ADR 0046 decision 11). So this model needs `@frameshell/whisper-cpp` in the project and its model on the machine, and takes the local transcription time too; without them the run fails before anything is uploaded. The result's warnings say how many words matched whisper.cpp's; the others are timed between their neighbours.

`whisper-1` (`--model whisper-1`) still gives word times from the service, coarser than whisper.cpp's alignment, until OpenAI retires it on 2027-02-26. When OpenAI stops serving a model (a 404 or 400 with `model_not_found`), the error says so and names the way out (`--model gpt-transcribe`, update this plugin, or `--provider whisper-cpp`); nothing is retried. No other model can be chosen.

## The key

In the app, paste the key in the field of the **Plugins** view and Save: it is encrypted by your system's keychain and handed to the daemon in memory (ADR 0050). The plugin reads it from the **`OPENAI_API_KEY` environment variable** of the daemon at every call; a variable set in the environment wins over a saved key. It is never written to a project file, the history, a progress message or an error, and error texts from OpenAI are scrubbed of anything that looks like a key before they are shown.

The variable must exist in the environment the Frameshell **daemon** was started from: see the [`@frameshell/openai-speech` README](../openai-speech/README.md#the-key) for how to set it on macOS, Windows and Linux. The same key serves both plugins.

## Options

| Environment variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Your key. Required. |
| `FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL` | Another server speaking the same API (a proxy). Default `https://api.openai.com`; the request goes to `<base>/v1/audio/transcriptions`. Your key and audio go to that server. |

Licence: Apache-2.0.
