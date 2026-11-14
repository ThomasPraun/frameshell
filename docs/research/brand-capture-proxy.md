# Brand capture proxy: spike (#467, slice 3)

Decision 1 of #467 (to be recorded as ADR 0044): capture Chrome reaches the network only through one daemon-local guarded proxy, on `node:net`, `node:http` and `node:dns`, with `net.BlockList`, public unicast addresses only, ports 80/443, resolve once and connect to the checked IP, every redirect hop re-checked, no QUIC, no non-proxied WebRTC UDP, no loopback bypass. This spike proves that on one machine, with the pinned managed Chrome, before the capture job (the rest of slice 3) is built on it.

Code: [`spikes/brand-capture-proxy/`](../../spikes/brand-capture-proxy/) (throwaway, no dependencies, outside the workspace). Nothing in `packages/` changed.

## Result

**The approach holds on macOS arm64.** With the flags below, 200 probes (30 private targets, 6 to 11 ways each to make the page request them) produced **0 connections to listeners on 127.0.0.1, ::1 and 0.0.0.0** (including real listeners on ports 80 and 443) and **0 dials to a non-public address**. The same probes with the flags removed one by one reached the listener on 54 of 68 (proxy without the bypass fix) and 64 of 68 (no proxy), so the test can fail.

Four things the ticket's flag list does not say, found by the spike:

1. **`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` is the flag that matters for UDP, not `--disable-quic`.** Without it a page opened a `RTCPeerConnection` and Chrome sent 4 STUN datagrams to a UDP listener on 127.0.0.1 and exposed 2 host candidates (mDNS names). With it: 0 datagrams, 0 candidates.
2. **`--disable-quic` is belt and braces here.** With an HTTP proxy configured, WebTransport (QUIC) never opened and sent 0 datagrams even without `--disable-quic`; without any proxy it sent 5. Keep the flag (a future Chrome may route differently), but do not count on it alone.
3. **Chrome's `file:` guard is not ours.** `Page.navigate("file:///etc/hosts")` loads and shows the file; file URLs never touch the proxy. The capture job must check the input URL (`http:` or `https:` only) itself, before `Page.navigate`. Page-initiated attempts are blocked by Chrome (see Schemes).
4. **A one-line Node mistake would have been a hole.** The first draft of the proxy used `http.request({ agent: false, createConnection })`; Node ignored `createConnection` and connected to `localhost` instead of the checked IP. Only the "dial spy" assertion (every dial is the checked IP) caught it. Forward plain HTTP with an `http.Agent` whose `createConnection` dials the IP literal, and keep that assertion in the real tests.

## Flags

Pinned set (`guardedFlags()` in `spikes/brand-capture-proxy/src/chrome.mjs`), passed to the managed `chrome-headless-shell` 154.0.8037.57 next to the flags `Chrome.launch` already sets (`--remote-debugging-pipe`, fresh `--user-data-dir`, `--no-sandbox` on Linux):

```
--proxy-server=http://127.0.0.1:<proxy port>
--proxy-bypass-list=<-loopback>
--disable-quic
--force-webrtc-ip-handling-policy=disable_non_proxied_udp
```

- `<-loopback>` removes Chrome's implicit rule that sends `localhost`, `127.0.0.0/8` and `[::1]` around any proxy. Measured: without it, `127.0.0.1`, `localhost`, `[::1]`, and the decimal, hex and short spellings (`2130706433`, `0x7f.0.0.1`, `127.1`, `[::ffff:127.0.0.1]`) all reached the listener directly. `0.0.0.0` was not bypassed (the proxy saw and refused it), but it reaches the local host when sent direct, so the proxy policy blocks `0.0.0.0/8` too.
- Chrome canonicalises the odd spellings before it talks to the proxy, so the proxy sees dotted decimal (or `[::ffff:7f00:1]` for the mapped form). The policy does not rely on that: it refuses on the resolved address.
- Quiet flags used by the spike only (not security): `--no-first-run --no-default-browser-check --hide-scrollbars --mute-audio --disable-background-networking --disable-component-update --disable-sync --disable-default-apps --disable-domain-reliability --no-pings`.
- Test only: `--ignore-certificate-errors` (the https fixture is self-signed). Never in the product.
- Fresh profile per capture (no cookies) is already what `Chrome.launch` does.

## Proxy

`spikes/brand-capture-proxy/src/proxy.mjs`, about 130 lines, Node built-ins only.

- `CONNECT host:port` (https, wss) and absolute-URI `GET http://...` (http, ws) through one `check(host, port)`.
- `check`: port in {80, 443}; host is a literal IP or is resolved **once** with `dns.lookup(host, { all: true, verbatim: true })`; **every** answer must be public unicast, so a name answering public plus private is refused whole; then connect to the first answer as an IP literal. The name is never resolved a second time, so there is no window for rebinding.
- The proxy never follows redirects. Chrome follows them and opens a new proxy request per hop, so each hop is re-checked.
- Byte cap: one counter over every socket; past the cap all sockets are destroyed.
- Denied requests: `403` with a plain-text reason (Chrome shows it as the page body for http, as `ERR_TUNNEL_CONNECTION_FAILED` for CONNECT).

Address policy (`policy.mjs`, table test `npm run policy`: 43 refused rows, 12 accepted rows, 10 port rows, all as expected):

- IPv4 is a `BlockList`: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4.
- IPv6 is an **allowlist** (`2000::/3`) minus Teredo `2001::/32`, documentation `2001:db8::/32` and `3fff::/20`, and 6to4 `2002::/16`. Everything else is refused by not being in it: `::`, `::1`, ULA `fc00::/7`, link-local `fe80::/10` (also with a `%zone`), multicast, IPv4-mapped, IPv4-compatible and NAT64 `64:ff9b::/96`. An embedded IPv4 address is also extracted and checked, as a second line.
- `net.BlockList.check` treats `::ffff:127.0.0.1` as IPv4 127.0.0.1 (Node 22.16), which is why the policy does not depend on it.

## Test world

Real headless Chrome, real proxy, real policy. Only two functions are injected, the ticket's "test-only override of the address policy": a fake resolver (names such as `app.test` answer a fake public IP, `rebind.test` answers public once and `127.0.0.1` after) and a fake dial (a public fake IP on port 80/443 connects to the local fixture; any other address connects nowhere and is recorded).

- **Secret listener**: a raw TCP listener on `[::]` at an ephemeral port, plus `[::]:80` and `[::]:443` (macOS allows the wildcard bind without root, not 127.0.0.1:80). It answers 127.0.0.1, ::1 and 0.0.0.0. Every TCP connection counts as a hit, even if the request would later fail.
- **Public fixture site** (http and https, self-signed): the battery page, 302s to loopback, to `:80`, to `https://127.0.0.1`, to a name resolving to 10.0.0.9, to the metadata address, to `file:///etc/hosts`, a two-hop chain ending at `localhost:<port>`, a WebSocket endpoint, an endless body.
- **Targets (30)**: 127.0.0.1, localhost, [::1], 0.0.0.0, decimal / hex / short / IPv4-mapped spellings, loopback on :80, [::1] on :80, https loopback on :443, 10.0.0.1, 172.16.0.1, 192.168.1.1, 169.254.169.254, 100.64.0.1, [fd00::1], [fe80::1], [64:ff9b::7f00:1], names resolving to 10.0.0.9 / 169.254.169.254 / ::1, names answering public plus 10.0.0.5 and public plus fd00::5, and the six redirects above.
- **Vectors**: `fetch` (no-cors), `<img>`, `<iframe>`, `WebSocket`, `fetch` inside a Worker, `EventSource`; on the first four targets also `sendBeacon`, `<link rel=preconnect>`, `<link rel=prefetch>`, CSS `@import` and `url()`, form POST.

## Measurements

Machine: Apple M3, macOS 26.3 (Darwin 25.3.0), Node 22.16.0, chrome-headless-shell 154.0.8037.57 darwin-arm64. 2026-11-11.

### Address matrix

| Run | Flags | Probes | Reached a loopback listener | Non-public IP dialed |
|---|---|---|---|---|
| **strict** | pinned set, ports 80/443 | 200 | **0** | **0** |
| **relaxed-ports** | pinned set, ports 80/443 and the secret port | 200 | **0** | **0** |
| control: proxy without `<-loopback>` | `--proxy-server`, `--disable-quic`; first 8 targets | 68 | 54 | 0 (the 14 misses are `0.0.0.0`, refused by the proxy, and `preconnect`) |
| control: no proxy | none; first 8 targets | 68 | 64 | n/a (the 4 misses are `preconnect`, which opens no request) |

`relaxed-ports` exists so the IP rule is shown on its own: the secret port is allowed by the port rule and the connection is still refused by the address rule, for loopback, localhost, [::1], 0.0.0.0 and the four spellings. In `strict` the same targets on 80 and 443 are refused by address (listeners were bound there). Per-vector results in the controls: every vector reached the listener (`fetch`, `img`, `iframe`, `ws`, Worker `fetch`, `EventSource`, `beacon`, `prefetch`, CSS, form) except `preconnect`, which is only a connection hint and made no request in any run; its protection comes from the same proxy setting and is not separately observable.

Not observable on this machine, so shown by the proxy decision and the dial spy only (denied, never dialed): 10/8, 172.16/12, 192.168/16, 169.254/16 (metadata), 100.64/10, fd00::/8, fe80::/10, 64:ff9b::/96. Chrome never connects to those directly in the strict runs: the leak sweep below found no socket to anything but the proxy.

### Resolve once, rebinding, redirects, https

- **Rebinding**: page host `rebind.test` answered `34.1.1.2` on the first lookup and `127.0.0.1` afterwards. The page loaded (title `battery`); the next two fetches (same-origin and by name) were refused `non-public address 127.0.0.1`. Secret hits during the section: 0.
- **One lookup per request, connect to the checked IP**: 6 requests to `app.test` gave 6 lookups, 6 allowed, 6 dials, all to `34.1.1.1`.
- **Mixed answers** (public plus 10.0.0.5, public plus fd00::5): refused, never dialed.
- **Redirects**: `app.test/redir-loopback`, `redir-loopback80`, `redir-https-loopback`, `redir-private-name`, `redir-metadata` and the two-hop chain: each hop reached the proxy as its own request (the first hop allowed and dialed, the last refused). Top-level navigation to the chain ended on the proxy's `blocked: port ...` page; to the metadata redirect on `blocked: non-public address 169.254.169.254`.
- **https through CONNECT**: `https://app.test/` loaded, a fetch returned the body, `wss://app.test/ws` opened; `https://127.0.0.1/` failed with `ERR_TUNNEL_CONNECTION_FAILED`. There is no TLS interception, so the proxy sees host and port only, which is all the policy needs.
- **Real resolver** (no fakes, `getaddrinfo` on this Mac): `localhost`, `localhost.`, `LOCALHOST`, `foo.localhost` resolve to `::1` and are refused; `127.0.0.1`, `[::1]`, `0x7f.1`, `2130706433` refused; `broadcasthost` (255.255.255.255) refused; unknown names refused as `dns: ENOTFOUND`.

### Schemes (do not reach the proxy)

| Attempt | Result |
|---|---|
| `Page.navigate("file:///etc/hosts")` | **loads and shows the file** |
| `Page.navigate("chrome://version")` | `ERR_INVALID_URL` |
| `Page.navigate("view-source:http://app.test/")` | loads (through the proxy) |
| http page answers 302 to `file:///etc/hosts` | `ERR_UNSAFE_REDIRECT` |
| http page sets `location.href = "file:///..."` | ignored, stays on the http page |
| http page `<iframe src="file:///...">`, `fetch("file:///...")`, `window.open("file:///...")` | no load; fetch rejected; the new window stays `about:blank` |

So only the job's own `Page.navigate` is exposed: accept `http:` and `https:` input URLs only (and no userinfo), and never navigate anywhere else from our side.

### UDP

A UDP listener on 127.0.0.1 counts datagrams. WebRTC: `RTCPeerConnection` with `stun:127.0.0.1:<port>`, 3.5 s. WebTransport: `new WebTransport("https://127.0.0.1:<port>/")` from an https page (it does not exist in insecure contexts). The peer connection is closed and 1.5 s passed before the WebTransport count starts.

| Flags | WebRTC candidates / datagrams | WebTransport datagrams |
|---|---|---|
| none (no proxy) | 2 host / 4 | 5 |
| proxy + `<-loopback>` | 2 host / 4 | 0 (handshake failed) |
| + `--disable-quic` | 2 host / 4 | 0 (handshake failed) |
| + webrtc policy only | **0 / 0** | 0 (handshake failed) |
| **pinned set** | **0 / 0** | 0 (handshake failed) |

### Leak sweep, idle, cap

- `lsof -nP -i` of the whole Chrome process tree (5 processes) after the battery plus 8 s idle: 2 TCP sockets, both to the proxy; **0 other TCP, 0 UDP sockets**. Idle `about:blank` for 10 s: **0** proxy requests, so the quiet flags leave no background traffic here. A snapshot cannot exclude a short-lived socket or a name lookup by the system resolver (which `lsof` does not show).
- Byte cap: 3 MiB cap on an endless 64 KiB-chunk response: the page's stream aborted after 142 ms, the proxy counted 3,149,973 bytes, one cap event. The 150 MB and 120 s numbers of decision 8 are not measured; the wall-clock cap is the job's (kill Chrome), not the proxy's.

## For the capture job

- Launch: `Chrome.launch` needs extra args (the four flags) and a `deviceScaleFactor` option. Both are additive; inspect pages keep going direct. The capture Chrome is its own launch.
- The proxy listens on `127.0.0.1:0`, one per capture, closed with it. Any local process can use it, but it can only reach public addresses; a `Proxy-Authorization` check (Chrome answers the challenge through CDP `Fetch.authRequired`) is optional hardening not tried here.
- Tests: reuse the structure of `scripts/e2e.mjs`: inject resolver and dial, assert the secret listener got 0 connections and every dial is a checked public IP. Keep the controls (flags removed), or the test cannot fail.
- Run the policy table test as a plain unit test (no Chrome needed).
- Protocols that cannot go through an HTTP proxy are the risk when Chrome changes: re-run the UDP table on every Chrome pin bump (`docs/binaries.md` re-pin).

## Not verified

- **Linux and Windows.** Everything above ran on macOS arm64 only. `--proxy-bypass-list=<-loopback>`, `--force-webrtc-ip-handling-policy` and `--disable-quic` are documented Chrome flags and cross-platform, but nothing here shows they behave the same. Differences to expect and check: `getaddrinfo` ordering and `localhost` answers, IPv6 availability in CI containers, `--no-sandbox` on Linux, Windows loopback aliases, and the socket sweep (`lsof` does not exist on Windows; use `Get-NetTCPConnection` / `Get-NetUDPEndpoint`). The decision asks for all three OSes before the job ships.
- Service workers (need a secure origin without cert errors), Chrome-side name lookups, DNS over HTTPS (off by default in the headless shell, not tested), HTTP/2 connection coalescing across hosts (a CONNECT tunnel is checked per host:port; coalescing could only reuse a tunnel already checked for the same host), WebSocket redirects (the fixture accepts every WebSocket path), and `Proxy-Authorization`.
- The 120 s deadline and video handling (URLs recorded, never downloaded) belong to the job.
- A site that needs a non-80/443 port (for example `https://example.com:8443`) is refused by design.
