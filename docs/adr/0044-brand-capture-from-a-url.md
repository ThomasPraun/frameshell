---
status: accepted
---

# Brand capture from a URL: guarded headless Chrome, open fonts only, findings proposed, never applied

#467 (epic #451) asks Frameshell to take a brand from a website (logos, colours, fonts, key UI) so motion templates can zoom into sharp vectors instead of blurred screenshots, and to import Figma SVG frames. The owner chose option A of the proposed decision on 2026-11-11 with every recommendation accepted (decisions 1 to 9 below), and on 2026-11-13 approved the Chrome flag list measured by the spike (PR #530, `docs/research/brand-capture-proxy.md`) plus the rule that capture accepts only `http`/`https` URLs. **Slice 3 (the guarded proxy and the `brand.capture` job) is built, with the font licence check of slice 4; the rest is not.**

## Context (verified)

- Managed headless Chrome is pinned (`chrome-headless-shell`, Chrome for Testing 154.0.8037.57, `docs/binaries.md`) and core already has a dependency-free CDP client over `--remote-debugging-pipe` (`packages/core/src/inspect/chrome.ts`, ADR 0011). Before this ADR nothing in core fetched arbitrary URLs: every download went to pinned URLs with SHA-256.
- The credits ledger (ADR 0026, `credits.json`) records provenance per file under `assets/`; `credits check` fails on anything unverified.
- The style guide (ADR 0028) has colours, fonts (`file` must be under `assets/fonts/`) and brand fields; `style.set` is journaled (ADR 0036). ADR 0028 decision 7 said "Frameshell never downloads fonts".
- SVG and font files under `assets/` are non-media assets since #520 (hashed, no derived media, refused as clips).
- The spike measured on macOS arm64: with the four flags of decision 1, 200 probes (30 private targets, 6 to 11 request vectors each, redirects, DNS rebinding, mixed answers) reached a loopback listener 0 times and dialed a non-public address 0 times, against 54/68 and 64/68 hits without them. `Page.navigate("file:///etc/hosts")` loads the file and never asks the proxy. `http.request({ agent: false, createConnection })` silently ignores `createConnection`.

## Decision

1. **Network: one daemon-local guarded proxy** is the only way out of capture Chrome and of the files the daemon fetches for a capture. It listens on `127.0.0.1:<ephemeral>`, one per capture. Each request (absolute-URI HTTP or `CONNECT`) passes one check: port 80 or 443; the host resolved **once** (`dns.lookup`, all answers); **every** answer public unicast (IPv4 `BlockList` of the special-purpose ranges incl. 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, multicast and reserved; IPv6 allowlist `2000::/3` minus Teredo, documentation and 6to4, with embedded IPv4 checked too); then a connection to the checked IP literal, so a second lookup cannot rebind it. The proxy never follows redirects: Chrome (and the daemon's own fetch) open a new proxy request per hop, so every hop is checked. No TLS interception. No flag allows private addresses in v1: LAN and staging pages go through screenshots or the Figma path.
2. **Chrome flags** (measured, pinned in `guardedChromeFlags`): `--proxy-server=http://127.0.0.1:<port>`, `--proxy-bypass-list=<-loopback>` (removes Chrome's implicit loopback bypass), `--disable-quic`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (the flag that stops STUN to loopback); plus quiet flags that are not part of the guard. Fresh profile per capture, no cookies. The UDP table of the spike is re-run on every Chrome pin bump.
3. **Only `http:` and `https:` input URLs**, checked before anything starts: `file:`, `data:`, `chrome:`, `javascript:`, `view-source:` and every other scheme are refused, and so are URLs with a user name or password and ports other than 80/443. The capture never navigates anywhere else itself.
4. **Fonts (amends ADR 0028 decision 7):** a face is copied into `assets/fonts/` only when its own name table (name ids 13/14, read from TrueType, OpenType, WOFF or WOFF2) names OFL-1.1, Apache-2.0 or UFL, with a credits entry carrying that licence and the foundry (id 8, else designer 9) as author. Otherwise the family, weights in use and unicode-range are listed with the reason. Icon fonts are never faces. **Google Fonts subsets** (fonts.gstatic.com) strip the licence strings and do not count as open in v1: the skill tells the agent to fetch the family from the google/fonts repository and import it with provenance. The curated substitute table is later.
5. **Component format:** SVG, sanitised by an allowlist (no script, `foreignObject`, event handlers, external `href`/`url()`, external `<use>`; small `data:` rasters kept), plus marked PNG. DOM/HTML components are later, behind a spike. A logo is never redrawn: every file has `origin: captured`.
6. **Layout:** files in `assets/brand/<id>/` (`<id>` from the host, `-2`… when taken), fonts in `assets/fonts/`, manifest `brand.json` at the project root (published schema, the daemon its only writer), like `credits.json`.
7. **Credits:** every captured file gets an entry with `sourceUrl` and no licence, so `credits check` fails on it until the person confirms (`credits set --licence own`), per ADR 0026.
8. **Style:** capture only returns suggested `style.set` calls; the journaled `style.set` of ADR 0036 applies them after the agent lists the findings to the person. Capture never writes `style.json`.
9. **Caps per capture:** 150 MB through the proxy (page and fetched files together; past it every socket is destroyed), 120 s wall clock (Chrome is killed), full-page shot only up to 16 384 px tall, at most 20 MB per fetched file and 12 font faces; video URLs recorded, never downloaded. Starting points, not measured.
10. **Figma:** one scale factor per imported folder (canvas width / widest frame, default 1440), centred; no per-frame fitting.
11. **Honest failure:** `capture.ok` is false with `reason: little-text` when the page loaded but has under 200 characters of text and no logo, icon, share image or font. A page whose main document is refused (a redirect to a private address) fails the call with reason `address`.

## Considered options

- **B. CDP `Fetch` interception, the daemon fetching every request itself:** WebSockets, WebRTC and service workers are outside the Fetch domain, so a second guard would still be needed; every body would cross CDP as base64; redirects and compression re-implemented. Rejected for A.
- **C. Report and images only, no fonts, agent edits `style.json`:** style edits would stay unjournaled and the font licence rule would be skill prose, not code.
- **D. No URL fetching (import only):** drops the main ask, and agents would fetch pages with ad-hoc tools that ignore the policy.

## Slice 3: guarded proxy and capture job (built)

- `packages/core/src/brand/policy.ts`: `checkCaptureUrl` (decision 3) and `isPublicUnicast` (decision 1), the spike's policy table as unit tests. `brand/proxy.ts`: `CaptureProxy` (Node built-ins only; the dial goes through an `http.Agent` whose `createConnection` dials the IP literal) and `fetchThrough`, the daemon's own fetch through the same proxy (redirects re-checked, per-file size cap; `https` by `CONNECT` and TLS to the real host name).
- `brand/capture.ts`: `BrandService.capture`. Chrome is launched with `Chrome.launch(path, extraArgs)` (additive; inspect pages keep going direct) at 1600x1000, device pixel ratio 2. It waits for the network to be idle (500 ms quiet, at most 15 s) plus 2.5 s, scrolls in 700 px steps, then measures in an **isolated world** (`Page.createIsolatedWorld`) so the page's scripts cannot replace the DOM APIs the measuring uses: colours by role (text, background, border, heading, link, button) through a canvas so every CSS colour syntax reads as `#rrggbb`, fonts by use, `:root` variables, headings and buttons, logo candidates (SVG in `header`/`nav`/banner, named `logo`/`brand`, or the home link; images named so), icons, `og:image`, videos. Fetched SVG files go through the same sanitiser (parsed with `DOMParser` in that world), and every SVG is checked again in Node (`svgProblems`). `@font-face` rules come from every stylesheet's text through the CSS domain, so cross-origin sheets are read too; the face for each weight in use is the upright one covering Latin `A`, woff2 first.
- The accent is the non-neutral colour seen in the most roles, then the most used; never a browser default link colour, never a strong red seen only in text or borders (`brand/findings.ts`). Style suggestions: `colors.bg`, `colors.ink`, `colors.accent`, `fonts.display` (the headings' family), `fonts.ui`, `brand.product` (`og:site_name`, else the title before ` | `), `brand.url`, `brand.mustShow: ["logo"]`.
- `brand.capture { url }` (mutating, job kind `brand`, step `capture`, protocol 128), CLI `frameshell brand capture <url>`, MCP `brand_capture`. `brand.json` schema `packages/schema/src/brand.ts` (`pnpm gen:json-schema`). The name-table walker is shared with export's font metrics (`readNameTable` in `packages/schema/src/font-file.ts`).
- Tests: the policy table and the URL guard; the proxy against a local site that a fake resolver and dial present as a public host (Windows-safe, loopback ephemeral ports only, every dial asserted to be the checked IP, a loopback listener asserted untouched); font names from TrueType, WOFF and WOFF2 built in the test; the accent and suggestions; `brand.capture` over the wire refusing schemes and private hosts before any job. With `FRAMESHELL_TEST_REAL_CHROME=1`: a whole capture of the fixture site in the managed Chrome (sanitised logos, shots, OFL font copied, closed font listed, page probes to loopback refused), the little-text failure, a redirect to a private address refused, and a control that drops `<-loopback>` and must reach the listener.

## Not built yet

- Linux and Windows runs of the flags (the spike measured macOS arm64 only; the real-Chrome tests are opt-in, as for inspect).
- `--sections` crops at DPR 3, the curated substitute fonts, the icon-font `cmap` check (names and Private Use Area ranges only today).
- Figma import (`brand.import-figma`, decision 10) and `brand.show`; the template hook (`--component`) for #466; a skill brand reference beyond the credits section.
- Service workers, DNS over HTTPS, `Proxy-Authorization` on the proxy, WebSocket redirects: not measured.

## Consequences

- SPEC decision 49. `PROTOCOL_VERSION` 128. New job kind `brand` and step `capture`; new published schema `brand.json`.
- ADR 0028 decision 7 is amended by decision 4: Frameshell may copy a font a page serves when the file itself names an open licence.
- Capturing someone else's site is possible. The credits gate (no licence = fail) and the skill's "is this your brand?" step are the guard; Frameshell does not judge trademark use. Robots.txt and site terms are not read.
- Sites behind a login cannot be captured (fresh profile, no cookies); a capture of them fails honestly as `little-text` or shows the login page.
