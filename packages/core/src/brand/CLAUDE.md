# Brand capture + Figma import (ADR 0044)

- Files: `policy.ts`, `proxy.ts`, `capture.ts`, `page-script.ts`, `svg.ts` = the sanitiser + allowlist the page script reads, `figma.ts` + `figma-worker.ts`, `fonts.ts`, `findings.ts`. Schema `packages/schema/src/brand.ts`, `packages/schema/src/font-substitutes.ts` (licence-checked table; cmap walker in `packages/schema/src/font-file.ts`). Template hook `plugins/hyperframes/src/templates/components.ts`: `hyperframes new --component` reads `brand.json` leniently. Skill `skills/frameshell/reference/brand.md`. Spike `docs/research/brand-capture-proxy.md`.
- `brand.capture`: guarded proxy, Chrome flags, `http`/`https` only, isolated-world page script. Font licence from name table; icon font by cmap; curated open substitutes. `--sections` crops at 3x. Style suggestions never applied.
- `brand.importFigma`: one scale per folder (`fitFrames`), centred, sanitised in a worker. `brand.show`.
- One SVG allowlist for capture + Figma. Output `brand.json` + credits.
