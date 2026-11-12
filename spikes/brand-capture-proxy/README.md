# Spike: guarded proxy for brand capture (PROTOTYPE, throwaway)

Slice 3 of #467 (ADR 0044): prove that managed headless Chrome, pointed at a daemon-local proxy written on Node built-ins,
cannot reach loopback, private, link-local or metadata addresses, however the page asks (direct, redirect, DNS rebinding).
Results, numbers and the exact flags: [`docs/research/brand-capture-proxy.md`](../../docs/research/brand-capture-proxy.md).

Self-contained, no dependencies, not part of any pnpm workspace. Node >= 22, `openssl` (self-signed fixture cert), `lsof` (macOS, Linux).
Chrome: the managed `chrome-headless-shell` in `.cache/test-binaries` (`FRAMESHELL_TEST_BINARIES_DIR`), or `FRAMESHELL_CHROME=<path>`.
Output goes to `out/` (gitignored).

```sh
cd spikes/brand-capture-proxy
export FRAMESHELL_TEST_BINARIES_DIR=<repo>/.cache/test-binaries
npm run policy                      # address table, no Chrome, instant
node scripts/e2e.mjs                # everything, ~15 min; or name sections: matrix resolve scheme udp leaks cap
```

| File | Does |
|---|---|
| `src/policy.mjs` | `isPublicUnicast` on `net.BlockList` (IPv4 blocklist, IPv6 allowlist 2000::/3 minus Teredo/documentation/6to4), ports 80/443 |
| `src/proxy.mjs` | CONNECT + absolute-URI HTTP proxy: resolve once, refuse unless every answer is public, connect to the checked IP literal, never follow redirects, byte cap |
| `src/chrome.mjs` | CDP over `--remote-debugging-pipe` and `guardedFlags()`, the flag set under test |
| `src/fixture.mjs` | loopback "secret" TCP listener, UDP listener, the "public" site (battery page, redirects, ws, big stream) |
| `scripts/e2e.mjs` | fake DNS and fake dial map fake public IPs to the local site; probes every target by every vector in real Chrome; controls without the flags |

The policy and the proxy run unmodified; only the resolver and the connector are injected (the ticket's "test-only override").
