---
name: openai-transcription
description: Transcribe an asset with OpenAI's paid cloud service (provider `openai`, model whisper-1) instead of local whisper.cpp. Use when the person asks for OpenAI transcription, or before confirming the upload and cost of one.
---

# openai-transcription

Provider `openai` transcribes one asset with OpenAI's `whisper-1`, paid by the person's own account. whisper.cpp (`whisper-cpp`) stays the default and runs on the machine; use this provider only when the person asks for it. The general flow (transcribe, cut, verify) is in the `transcript-editing` reference of the frameshell skill; this file covers only what is specific to this provider.

```sh
frameshell transcribe assets/talk.mp4 --provider openai --model whisper-1 --language es --json
```

- **Upload and cost.** Every run ends in `ConfirmationRequired` first: the message says the asset's audio is **uploaded** to OpenAI, how long it is, and the estimated cost (`error.data.cost`, USD; `error.data.seconds`). Tell the person both: their recording leaves the machine, and what it costs. Pass `--yes` with the `--confirmation` token the refusal printed only after they agree. Never pass `--yes` on your own. Nothing is remembered: every run asks again. If the asset or price changed meanwhile the call fails with `ConfirmationStale` and sends nothing: ask again.
- **Model.** Only `whisper-1` (the only OpenAI model with word timestamps). When the project names a whisper.cpp model in `transcription.model`, pass `--model whisper-1`, or the call fails before uploading. OpenAI plans to retire `whisper-1` on 2027-02-26.
- **Word timing** is the service's, coarser than whisper.cpp's; `warnings` says so. Let cut snapping place edges and run `frameshell transcribe --verify` after exporting (with `--provider whisper-cpp`: background checks never use a cloud provider).
- **Other commands never upload.** `transcribe --verify`, shoot takes, the voiceover misread check and captions, and `analyze` use only a local free provider: with `transcription.provider` set to `openai` they refuse or skip. Pass `--provider whisper-cpp` where the command takes one.
- **The key.** It is read from the `OPENAI_API_KEY` environment variable, at each call, in the environment the Frameshell daemon or app was started from. Never ask the person to paste it into chat, a file or `frameshell.json`, never print or log it, and never put it in a command line. If a call fails with `OPENAI_API_KEY is not set`, tell the person to set it in that environment (README of the plugin) and run again.
- **Failures** arrive as `TranscriptionFailed` with a plain message: key rejected (check the key), rate limit or quota (wait, or check the account's credit), server error (try again). One short retry already happened.
