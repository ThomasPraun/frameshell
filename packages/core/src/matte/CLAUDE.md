# Video subject matte (ADR 0032)

- Files: `refine.ts` pure, `video.ts` passes, `job.ts`, `cache.ts`. Spike `docs/research/video-subject-matte.md`; model pin `docs/binaries.md` "Video subject matte". ffmpeg rawvideo reader shared with faces `packages/core/src/media/raw-frames.ts`. Daemon `makeMatte`, `matteInJob` in `daemon.ts`; export `mattedPiece` in `export/compiler.ts`; engine `setBehind`/`clearStaleBehind`. Preview + app: `apps/desktop/src/renderer/src/preview/CLAUDE.md`, `apps/desktop/CLAUDE.md`. Skill recipe `skills/frameshell/reference/reels.md`.
- Cache `.frameshell/cache/mattes/` + gc. `matte.prepare`. Tests + stand-in `FRAMESHELL_MATTE_STAND_IN=1`.
- Sources above 1080p: full-size `<key>.full.mp4` = export only; preview keeps proxy-size.
- Track `behind` flag = plate. Subject clips = plate copies marked `isSubjectClip`, drawn only in `subjectOf(clip).windows` (behind track shows, no shown track between). Layers: `withSubjectLayers` (root Shared truths).
- Render `matte` step runs outside queue slots.
