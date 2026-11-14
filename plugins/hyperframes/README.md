# @frameshell/hyperframes

Official [Frameshell](https://github.com/ThomasPraun/frameshell) clip adapter. It renders [HyperFrames](https://www.npmjs.com/package/@hyperframes/producer) HTML compositions headlessly to VP9 WebM with alpha, so generated titles, lower thirds and overlays become `hyperframes` clips on the timeline (ADR 0002).

```sh
frameshell plugin install @frameshell/hyperframes
frameshell hyperframes new title --duration 4
frameshell hyperframes new hook --template kinetic-headline   # motion template: typed props, brand tokens from style.json
frameshell hyperframes check            # lint every composition; exit 1 on errors
frameshell hyperframes update           # refresh the frozen motion runtime copies
```

`new --template <kinetic-headline|end-card|lower-third|logo-lockup|checklist|comparison|counter|big-word|cursor-click|cursor-drag-drop|cursor-marquee|cursor-text-select|app-window|typing-field|comment-box|terminal|chat-bubble|notification-stack|device-frame|scene-background|prompt-bar|glass-card|product-shot>` scaffolds a composition painted by the Frameshell motion runtime (springs and eases as a pure function of time, ADR 0033), with `frameshell-motion.js` copied next to it so a plugin upgrade never changes an existing clip. Each template declares typed props (change one with `frameshell clip set <clip> --props '{...}'`), lays out for 16:9, 1:1, 4:5 and 9:16, and takes colours, fonts and brand texts from the project's `style.json` as defaults. `update [<composition>] [--dry-run] [--force]` refreshes older runtime copies; clips that use one render again. The 3D template `product-shot` also gets `frameshell-three.js`, a pinned three.js bundle (ADR 0042), frozen and refreshed the same way; HyperFrames renders always use the software WebGL renderer (SwiftShader).

`check [<composition>] [--strict] [--json]` runs the HyperFrames linter ([`@hyperframes/lint`](https://www.npmjs.com/package/@hyperframes/lint)) in the daemon, with no network and no telemetry, plus Frameshell's GSAP and three.js seek-safety rules (the vendored three.js bundle itself is not linted). It prints `file:line:column severity rule message` and a fix per finding; errors exit 1, warnings only with `--strict`. The plugin never uses the `hyperframes` CLI.

While a clip renders, the Frameshell desktop preview plays its composition live at the playhead (ADR 0010); export always uses the render. When the user picks an element of a clip with the Pick tool (ADR 0011), the live page names the file it comes from, the composition or one of its `data-composition-src` sub-compositions.

Install pins the exact version in the project's `frameshell.json` and links the plugin's agent skill into `.claude/skills/`. Headless Chrome downloads on the first render. Usage for agents: [`skills/hyperframes/SKILL.md`](skills/hyperframes/SKILL.md).

The plugin runs inside the Frameshell daemon with full Node access, like every plugin: a project's plugins load only after you trust the project.

Licence: Apache-2.0. The composition authoring rules in the skill follow the guidance of [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0). The plugin ships a bundle of [three.js](https://github.com/mrdoob/three.js) 0.187.0 (MIT License, Copyright 2010-2026 three.js authors), with the full licence notice at the top of `frameshell-three.js`.
