# Core tests

- Golden files `golden/` (compiler, `otio-edit.json`, `premiere-edit.xml`): regen `UPDATE_GOLDEN=1`.
- Real-library hand-off tests (opt-in; CI ubuntu shard 1 when whole unit suite runs): `FRAMESHELL_TEST_OTIO=1 pnpm test packages/core/test/otio-real`, needs `pip install opentimelineio`; `FRAMESHELL_TEST_OTIO=1 pnpm test packages/core/test/premiere-real`, needs `pip install opentimelineio==0.18.1 otio-fcp-adapter==1.0.0`. Shared runner `test/otio-python.ts`.
- Hand-off tests: `packages/core/test/otio*.ts`, `premiere-xml.test.ts`, `premiere-check.ts` (structure checker), `export-premiere-method.test.ts`, `premiere-real.test.ts`.
- Stand-ins: `FRAMESHELL_MATTE_STAND_IN=1` (matte), `FRAMESHELL_SEGMENT_STAND_IN=1` (`segment/stand-in.ts`; e2e daemon uses it), `FRAMESHELL_SHOOT_STAND_IN=1` (shoot takes), `FRAMESHELL_SPEECH_STAND_IN=1` (voiceover).
- Fixtures: synthetic click tracks `beat-fixture.ts`; fbank reference `fixtures/fbank-reference.json`.
- Parity twins of preview (root Shared truths): `grade-render.test.ts`, `letterbox-render.test.ts`, `vignette-render.test.ts`, `grain-render.test.ts`.
- Cloud provider host load: `openai-speech.test.ts`, `openai-transcription.test.ts`, consent `transcribe-consent.test.ts`. Stub HTTP server only, never real API.
