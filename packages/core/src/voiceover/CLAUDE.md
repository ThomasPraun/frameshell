# Voiceover (ADR 0034)

- Files: `generate.ts`, `place.ts`, `captions.ts` (display-form captions via `alignWords` + `captions.set`), `script.ts`, `takes.ts`, `trim.ts`, `split.ts`, `verify.ts`, `stand-in.ts`, `command.ts`. Contract `SpeechProvider` + `contributes.speechProviders` in `packages/plugin-api/src/index.ts`; host `#provider` in `packages/core/src/plugins/host.ts`; `packages/core/src/global-config.ts`; `parseVoiceoverScript` in `packages/schema/src/script.ts`; CLI `packages/cli/src/voiceover-commands.ts`. App: `apps/desktop/CLAUDE.md`. Cloud provider: `plugins/CLAUDE.md`.
- Stand-in `FRAMESHELL_SPEECH_STAND_IN=1`.
- Voiceover script `voiceover: true` = shoot-script line rules + display/spoken forms; numbers via `spellNumbersIn`.
- Takes `assets/voiceover/<slug>/<line>.wav` with cache key in RIFF chunk `fsvo`; hand-made files never overwritten.
- Trim + split: own constants, not ADR 0003 threshold. `splitPhrases` = ranges of the take, derived, never stored; `PHRASE_FADE_S` applied by placement.
- Misread check = `compareTake` over a one-line script via `verifyTakes`, spoken + display; skipped never failed.
- Paid provider = `ConfirmationRequired` until `yes`. No `estimate()` + no `free: true` = paid, unknown cost.
- `command` provider = `speech.command` in `configDir` `config.json` only, never `frameshell.json`; read via `readGlobalConfig`.
- `voiceover.place` = phrase clips on a `Voiceover` track; times through the shared TimeRef resolver; `replace` re-places; generate warns on a replaced take a clip plays.
