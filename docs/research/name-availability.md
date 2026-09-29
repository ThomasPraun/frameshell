# Name availability: "Frameshell"

Checked 2026-09-29, read-only. Variants FrameShell / Frame Shell are identical in DNS, npm, GitHub (case-insensitive) and most registries; "Frame Shell" tested only as text search.

## 1. Domains

| Domain | Status | Evidence |
|---|---|---|
| frameshell.dev | Unregistered | RDAP at Google registry (Charleston Road Registry) via `https://rdap.org/domain/frameshell.dev` returned 404 "frameshell.dev not found"; no NS/SOA via `dig @1.1.1.1` |
| frameshell.app | Unregistered | Same: RDAP 404 "frameshell.app not found"; no NS/SOA |
| frameshell.io | Unregistered (likely) | `whois -h whois.nic.io frameshell.io` -> "Domain not found."; no NS/SOA. No RDAP service for .io |
| frameshell.com | **Registered** | Verisign RDAP `https://rdap.verisign.com/com/v1/domain/frameshell.com`: created 2024-08-28, expires 2027-08-28, last changed 2026-08-12, registrar Network Solutions, status clientTransferProhibited. NS ns1/ns2.bluehost.com, A 66.147.244.126. Site returns 200 but blocks curl (mod_security "Not Acceptable"); content unknown. Web search found no site content |

Note: plain `whois` for .dev/.io/.app printed only TLD-level records (created 2014/1997/2015); ignore those dates.

## 2. GitHub

| Check | Status | Evidence |
|---|---|---|
| User `frameshell` | **Exists** (taken) | `gh api users/frameshell`: User, created 2014-01-31, 1 public repo (`frameshell.github.io`, "Personal page", last push 2014-02-04), profile updated 2016-02-27. Dormant, no bio |
| Org `frameshell` | Not an org | `gh api orgs/frameshell` -> 404. The name is held by the user account above, so no org can use it |
| Repos named frameshell | 0 stars each | `gh search repos frameshell`: zenodea/frameshell (shell config, 0 stars, updated 2026-09-22), matang28/ts-frameshell (CLI framework, TS, 0 stars, 2019), cmpct/irc-bot-shell, B2Bolger/Initial-Test-, frameshell/frameshell.github.io, ThomasPraun/frameshell (ours) |

## 3. npm

| Check | Status | Evidence |
|---|---|---|
| Package `frameshell` | Available | `npm view frameshell` -> E404 |
| `@frameshell/core` | Not published | `npm view @frameshell/core` -> E404 |
| Scope `@frameshell` | Likely available (not proven) | `https://registry.npmjs.org/-/org/frameshell/package` -> 404 `{"error":"Scope not found"}`; `registry.npmjs.org/-/v1/search?text=frameshell` -> 0 objects; `npm search frameshell` -> `[]`. npmjs.com pages returned 403 to curl. Note: npm scopes are user or org names; a user named `frameshell` could exist without packages. Confirm by creating the org (not done) |
| Related | `ts-frameshell` exists on GitHub (matang28); not checked on npm |

## 4. Other registries

| Registry | Status | Evidence |
|---|---|---|
| PyPI `frameshell`, `frame-shell` | Available | `https://pypi.org/pypi/<name>/json` -> 404 both |
| crates.io `frameshell`, `frame-shell` | Available | `https://crates.io/api/v1/crates/<name>` -> 404 both |
| Homebrew formula / cask `frameshell` | Available | `formulae.brew.sh/api/formula|cask/frameshell.json` -> 404 |

## 5. Trademarks and existing products

| Source | Result |
|---|---|
| USPTO Trademark Search, WIPO Global Brand Database, EUIPO eSearch, TMview | **Could not be queried.** Sites return 200 but are JS single-page apps with no scriptable public API from here. Justia and Trademarkia returned 403. Manual search required |
| Web search "Frameshell" software/video/trademark | No product, company or mark found. Only similar names: Frame.io (Adobe, media collaboration; FRAME.IO mark), Frame.ai, FRAMEFREE, FRAMERATE Corporation. Search engines index trademark registers poorly, so absence is not proof |
| "Frameshell" as a term | Generic-ish: school technology topic "frameshell structures" (construction/engineering sense, unrelated to software) |

## 6. Collisions in video / AI tooling

- `aregrid/frame`: open-source AI "vibe" video editor with chat agent. Different name but same concept and audience; users may conflate "Frame" products.
- Frame.io (Adobe), Frame.ai: "Frame" prefix is crowded in video. Frameshell shares the "Frame" stem with Frame.io, which matters for likelihood-of-confusion analysis in class 9/42 (video software).
- `zenodea/frameshell`: Linux desktop shell config (Quickshell/caelestia). "Shell" collides with desktop-shell projects; 0 stars, low risk.
- `ts-frameshell`: dormant TS CLI framework, low risk.
- No known video tool named Frameshell found.

## Risks

1. **frameshell.com is taken** (Network Solutions, 2024, unknown use). Spec canonical domain is .dev, which is free, but a third party owning .com is a weak point for trademark and phishing/typosquat exposure. Site content unknown; view in a browser and consider a broker/WHOIS contact only if owner looks like a squatter.
2. **GitHub user `frameshell` is taken** (dormant since 2016). Org name `frameshell` unavailable; GitHub name-release policy may allow a request for inactive accounts, not guaranteed.
3. Trademark clearance not done. "Frame" + software/video crowding (Frame.io) is the main confusion risk. Needs a professional search.
4. `frameshell.dev`/`.app`/`.io` and npm scope unregistered means squatters can grab them any time.

## Recommendation (secure in this order)

1. `frameshell.dev` (spec schema URLs depend on it) and `frameshell.app`, `frameshell.io`: register now.
2. npm org `@frameshell`: create now (plugins scope); also reserve unscoped `frameshell` with a placeholder only if planned for the CLI.
3. Pick an alternate GitHub org name (e.g. `frameshell-dev` or `frameshellhq`) or request the dormant `frameshell` handle; the repo can stay under ThomasPraun until then. Update spec/URLs if org changes.
4. PyPI/crates/Homebrew names: low priority, free; reserve only if publishing there.
5. Run manual USPTO/EUIPO/WIPO searches (classes 9, 42, 41) before filing a trademark; consider trademark counsel given Frame.io proximity.
6. Inspect frameshell.com in a browser to assess owner intent.
