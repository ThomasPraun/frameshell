# @frameshell/hyperframes

Official [Frameshell](https://github.com/ThomasPraun/frameshell) clip adapter. It renders [HyperFrames](https://www.npmjs.com/package/@hyperframes/producer) HTML compositions headlessly to VP9 WebM with alpha, so generated titles, lower thirds and overlays become `hyperframes` clips on the timeline (ADR 0002).

```sh
frameshell plugin install @frameshell/hyperframes
frameshell hyperframes new title --duration 4
```

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. Headless Chrome downloads on the first render. Usage for agents: [`skills/hyperframes/SKILL.md`](skills/hyperframes/SKILL.md).

The plugin runs inside the Frameshell daemon with full Node access, like every plugin: a project's plugins load only after you trust the project.

Licence: Apache-2.0.
