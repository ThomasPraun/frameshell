# Desktop main process

App-wide rules (strings, renderer never writes, Move to Trash exception): `apps/desktop/CLAUDE.md`.

## Rules

- Connect Claude Desktop: config edit keeps other bytes (shared JSON edit `packages/cli/src/config-file.ts`).
- Cloud transcription ask (ADR 0046 d10): native box `confirmTranscription` (`index.ts`), same ask as CLI; never stores consent; background paths never ask. One confirm loop `runConfirmed` (`confirmation.ts`) shared with voiceover, never copy. Cost text = `formatCost` (root Shared truths).
- New project from video/audio: ONE transcription ask = the form's "Transcribe" box, with the real download size (`project.transcriptionDownload`, global binaries) or "nothing to download"; never a second native box (#742). Unchecked = nothing installed; audio project status says so.
- Voiceover: Explorer "Generate voiceover…" asks the cost in a native box before `yes`. `runVoiceover` + progress/Stop/verify plan in `voiceover.ts`.
- Live recognition: resident whisper-server in main; download only on consent; model by speed check (`docs/binaries.md` "Live recognition").
- Shoot recorder: recorder store outside view; chunks appended by main into `assets/shoot/<id>/*.part`; state `.frameshell/shoot/sessions/`; End/crash recovery = remux + `multicam.create` `offsets`; preview mute, content protection. e2e `FRAMESHELL_SHOOT_STAND_IN=1` + `--use-fake-device-for-media-stream`.
- Open with: single instance, `open-file`, Windows registry (`build/installer.nsh`).

## Areas

| Working on | Read |
|---|---|
| New project from video (folder beside video, name clash, clone test), new video from an idea (no footage: brief, formats via `format.add`, prompt in agent guide), audio project background + subtitles, drops, Open with | `video-project.ts`, `idea-project.ts`, `audio-background.ts`, `media-files.ts`, `open-paths.ts` |
| Cloud transcription ask | `confirmation.ts`, `transcribe-ask.ts`; test `apps/desktop/test/transcribe-ask.test.ts` |
| Shoot recorder | `shoot-session.ts`, `shoot-capture.ts`, `registerShootIpc` in `index.ts` |
| Live recognition | `live-recognition.ts` |
| Live preview of generated clips (`frameshell-live://` scheme, seek bridge; daemon `clip.live`; ADR 0010) | `live-protocol.ts` (`LIVE_BRIDGE`); renderer: `apps/desktop/src/renderer/src/preview/CLAUDE.md` |
| Media URLs for preview | `media-protocol.ts` |
| Update check (mode per platform, opt-out, release update files, stale daemon after update) | `updater.ts`, `update-check.ts`, `stale-daemon.ts`; `docs/release.md` "Updates" |
| Daemon link (events, reconnect) | `daemon-link.ts` |
| Move to Trash | `trash.ts` |
