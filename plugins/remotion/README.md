# @frameshell/remotion

Official [Frameshell](https://github.com/ThomasPraun/frameshell) clip adapter for [Remotion](https://www.remotion.dev) compositions. It bundles a Remotion project with webpack and renders compositions headlessly to VP9 WebM with alpha, so React-built scenes, UI demos and overlays become `remotion` clips on the timeline (ADR 0009). Compositions may import components from outside the Frameshell project, such as your web app: any edit to bundled code re-renders the clips that use it.

```sh
frameshell plugin install @frameshell/remotion
frameshell remotion new intro --duration 4
(cd compositions/remotion && npm install)
frameshell clip add <track> --type remotion --source compositions/remotion/src/index.ts \
  --start 0 --duration 4 --props '{"composition":"intro","inputProps":{"title":"Launch"}}'
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. Usage for agents: [`skills/remotion/SKILL.md`](skills/remotion/SKILL.md).

## Your Remotion, your licence

The plugin does not depend on Remotion. It loads `@remotion/bundler` and `@remotion/renderer` from the Remotion project a clip points at, so your version, webpack config and dependencies apply. Remotion is not Apache-licensed: companies above a size threshold need a [Remotion company license](https://www.remotion.dev/license). That licence is between you and Remotion.

The project's `remotion.config.ts` (or `.js`) applies as with Remotion's CLI: its webpack override (e.g. Tailwind via `@remotion/tailwind-v4`) and OpenGL renderer. Output settings in it are ignored, since clips are always VP9 with alpha. Reading it needs `@remotion/cli` in the Remotion project; Remotion has no public API for this, so the plugin uses the CLI's own config loader.

Renders use the headless Chrome Frameshell manages, never a browser Remotion would download.

The plugin runs inside the Frameshell daemon with full Node access, like every plugin: a project's plugins load only after you trust the project.

Licence: Apache-2.0.
