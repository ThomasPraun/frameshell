# @frameshell/openai-transcription

Official [Frameshell](https://github.com/ThomasPraun/frameshell) transcription provider (ADR 0046). It transcribes an asset with OpenAI's `whisper-1`, paid by **your own OpenAI account**. The default, whisper.cpp, runs on your machine and costs nothing; this plugin is for when you prefer the service.

```sh
frameshell plugin install @frameshell/openai-transcription
export OPENAI_API_KEY=...        # see "The key" below
frameshell transcribe assets/talk.mp4 --provider openai --model whisper-1
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. A project's plugins load only after you trust the project. Usage for agents: [`skills/openai-transcription/SKILL.md`](skills/openai-transcription/SKILL.md).

## What leaves your machine, and what it costs

- The **audio of the asset** you transcribe is uploaded to OpenAI: the 16 kHz mono WAV Frameshell extracts for transcription, cut into pieces of at most 10 minutes at pauses. Also sent: the language code and, for later pieces, the last words of the piece before. Nothing else: no file names, no project files, no transcripts.
- Frameshell refuses to transcribe until you confirm, on **every** run: the refusal states that the audio is uploaded, its length and the estimated cost (`--yes` on the CLI). Nothing is remembered between runs.
- `whisper-1` costs $0.006 a minute of audio. The table is `MODEL_PRICES` in [`src/prices.ts`](https://github.com/ThomasPraun/frameshell/blob/main/plugins/openai-transcription/src/prices.ts), with its source ([OpenAI pricing](https://developers.openai.com/api/docs/pricing)) and the date it was checked; your OpenAI usage page has the real bill. A few seconds around over-long words may be sent again in the same run (not in the estimate).
- Other Frameshell checks (`transcribe --verify`, shoot takes, voiceover checks, `analyze`) never use this provider: they need a local one.

## Word timing

Only `whisper-1` gives word timestamps, so it is the only model this plugin uses (no other model can be chosen). Its word times are coarser than whisper.cpp's alignment; every result says so in its warnings. OpenAI's guide marks `whisper-1` as deprecated, with a shutdown on 2027-02-26.

## The key

The key is read from the **`OPENAI_API_KEY` environment variable** at every call. It is never written to a project file, the history, a progress message or an error, and error texts from OpenAI are scrubbed of anything that looks like a key before they are shown.

The variable must exist in the environment the Frameshell **daemon** was started from: see the [`@frameshell/openai-speech` README](../openai-speech/README.md#the-key) for how to set it on macOS, Windows and Linux. The same key serves both plugins.

## Options

| Environment variable | Meaning |
|---|---|
| `OPENAI_API_KEY` | Your key. Required. |
| `FRAMESHELL_OPENAI_TRANSCRIPTION_BASE_URL` | Another server speaking the same API (a proxy). Default `https://api.openai.com`; the request goes to `<base>/v1/audio/transcriptions`. Your key and audio go to that server. |

Licence: Apache-2.0.
