# @frameshell/whisper-cpp

Official [Frameshell](https://github.com/ThomasPraun/frameshell) transcription provider. It transcribes project media to word level with a local, pinned [whisper.cpp](https://github.com/ggml-org/whisper.cpp): DTW word onsets, word ends from audio energy (ADR 0003).

```sh
frameshell plugin install @frameshell/whisper-cpp
frameshell transcribe <asset>
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. The whisper.cpp engine and the default model (`large-v3-turbo-q5_0`, 574 MB) download on the first transcription. Usage for agents: [`skills/whisper-cpp/SKILL.md`](skills/whisper-cpp/SKILL.md).

The plugin runs inside the Frameshell daemon with full Node access, like every plugin: a project's plugins load only after you trust the project.

Licence: Apache-2.0.
