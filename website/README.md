# Frameshell website

Landing page for [frameshell.dev](https://frameshell.dev). Static [Astro](https://astro.build) site, outside the pnpm workspace: it has its own `package.json` and lockfile and never imports app code.

```sh
cd website
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in website/dist/
npm run check    # type-check .astro and .ts files
```

Needs Node >= 22.22 (Astro's minimum), pinned in `.node-version`.

## Layout

| File | What |
|---|---|
| `src/pages/index.astro` | Section order |
| `src/components/Showcase.astro`, `src/scripts/showcase.ts` | Hero carousel (one clip, a layer per part) and the project tree it leads into |
| `src/styles/showcase.css` | Carousel and tree styles, scoped under `.sc` |
| `public/media/podcast.mp4`, `podcast-poster.jpg` | The clip the carousel edits (AI-generated, 9.4 s) |
| `src/components/Ruler.astro` | Scroll timecode ruler (wide screens) and progress bar |
| `src/styles/global.css` | Colour tokens, shared with the app's palette |

Download links use the latest GitHub release: read at build time, refreshed in the visitor's browser, so a new release shows up without a redeploy. Asset names live in `ASSETS` in `src/site.ts`; update them if the release file names change.

## The carousel clip

The carousel's timings (subtitle cues, the cut, the zooms, the short) come from the clip's word-level transcript and are constants at the top of `src/scripts/showcase.ts`. Replacing the clip means re-transcribing it and updating those constants. Keep media files under 25 MB (Cloudflare Pages limit); this one is about 2 MB. Longer videos go on YouTube or Cloudflare R2, not in the repo.

## Deploy: Cloudflare Pages

Live at [frameshell.pages.dev](https://frameshell.pages.dev). The project is a Pages project (Workers & Pages, Create application, "Looking to deploy Pages?"), connected to `ThomasPraun/frameshell`:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | Astro |
| Root directory | `website` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Variable `SKIP_DEPENDENCY_INSTALL` | `1` |
| Variable `NODE_VERSION` | `22.22.0` (same as `.node-version`) |
| Build watch paths (Settings, Builds) | include `website/**` |

Why the build command installs on its own: Cloudflare sees the repo's pnpm workspace and would run `pnpm install` for the whole monorepo (Electron, node-pty), which never installs this site's dependencies because `website/` is outside the workspace. `SKIP_DEPENDENCY_INSTALL` turns that step off and `npm ci` installs from this folder's lockfile.

Custom domain: Custom domains, add `frameshell.dev` (and `www.frameshell.dev` redirecting to it). With the domain's DNS on Cloudflare the records are created for you.

Pull requests that touch `website/` get preview deployments automatically. `public/_headers` sets long caching for hashed assets.
