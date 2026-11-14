// End to end: real headless Chrome against the guarded proxy, with a local fixture world. Prints a summary, writes
// out/results.json. Usage: node scripts/e2e.mjs [section ...]   sections: matrix scheme udp leaks cap resolve
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { Chrome, CHROME, guardedFlags } from "../src/chrome.mjs";
import { publicSite, secretServer, udpServer } from "../src/fixture.mjs";
import { isPublicUnicast } from "../src/policy.mjs";
import { createProxy } from "../src/proxy.mjs";

const sections = new Set(process.argv.slice(2));
const want = (name) => sections.size === 0 || sections.has(name);
const results = { chrome: CHROME, node: process.version, platform: `${process.platform}-${process.arch}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- world -----------------------------------------------------------------------------------------------------
const secret = await secretServer();
const udp = await udpServer();
const site = await publicSite({ secretPort: secret.port });
const privilegedHits = {};
for (const port of [80, 443]) {
  const name = `[::]:${port}`; // the wildcard bind is the one macOS allows without root; it answers 127.0.0.1, ::1 and 0.0.0.0
  try {
    const s = await secretServer(port, "::");
    privilegedHits[name] = s.hits;
  } catch {
    privilegedHits[name] = null; // could not bind: not observable on this machine
  }
}
results.privilegedBound = Object.fromEntries(Object.entries(privilegedHits).map(([k, v]) => [k, v !== null]));
const allSecretHits = () => secret.hits.length + Object.values(privilegedHits).reduce((n, h) => n + (h ? h.length : 0), 0);

const fakeDns = {
  "app.test": ["34.1.1.1"],
  "v6.test": ["2606:4700:4700::1111"],
  "internal.test": ["10.0.0.9"],
  "meta.test": ["169.254.169.254"],
  "lo6.test": ["::1"],
  "localhost": ["127.0.0.1"],
  "mixed.test": ["34.1.1.3", "10.0.0.5"],
  "mixed6.test": ["2606:4700:4700::1111", "fd00::5"],
};
const lookups = [];
let rebindCalls = 0;
const lookup = async (host) => {
  lookups.push(host);
  if (host === "rebind.test") return rebindCalls++ === 0 ? ["34.1.1.2"] : ["127.0.0.1"];
  if (fakeDns[host]) return fakeDns[host];
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
};
const dials = [];
const dial = (ip, port) => {
  dials.push({ ip, port });
  const local = port === 80 ? site.httpPort : port === 443 ? site.httpsPort : null;
  if (isPublicUnicast(ip) && local) return net.connect({ host: "127.0.0.1", port: local });
  const dead = new net.Socket();
  process.nextTick(() => dead.destroy(new Error("unexpected dial")));
  return dead;
};

async function withProxy(options, body) {
  const events = [];
  const proxy = createProxy({ lookup, dial, ...options, onEvent: (e) => events.push(e) });
  const port = await proxy.listen();
  try {
    return await body({ proxy, port, events });
  } finally {
    await proxy.close();
  }
}

async function withChrome(flags, body, launch) {
  const chrome = await Chrome.launch(flags, launch);
  try {
    return await body(chrome);
  } finally {
    await chrome.close();
  }
}

const IGNORE_CERT = ["--ignore-certificate-errors"]; // test only: the https fixture is self-signed

// ---- matrix ----------------------------------------------------------------------------------------------------
const P = secret.port;
const targets = [
  ["loopback v4", `http://127.0.0.1:${P}/s`, true],
  ["localhost", `http://localhost:${P}/s`, true],
  ["loopback v6", `http://[::1]:${P}/s`, true],
  ["0.0.0.0", `http://0.0.0.0:${P}/s`, true],
  ["decimal 2130706433", `http://2130706433:${P}/s`, false],
  ["hex 0x7f.0.0.1", `http://0x7f.0.0.1:${P}/s`, false],
  ["short 127.1", `http://127.1:${P}/s`, false],
  ["mapped [::ffff:127.0.0.1]", `http://[::ffff:127.0.0.1]:${P}/s`, false],
  ["loopback :80", "http://127.0.0.1/s", false],
  ["loopback v6 :80", "http://[::1]/s", false],
  ["loopback https :443", "https://127.0.0.1/s", false],
  ["10.0.0.1", "http://10.0.0.1/s", false],
  ["172.16.0.1", "http://172.16.0.1/s", false],
  ["192.168.1.1", "http://192.168.1.1/s", false],
  ["metadata 169.254.169.254", "http://169.254.169.254/latest/meta-data/", false],
  ["CGNAT 100.64.0.1", "http://100.64.0.1/s", false],
  ["ULA [fd00::1]", "http://[fd00::1]/s", false],
  ["link-local [fe80::1]", "http://[fe80::1]/s", false],
  ["NAT64 [64:ff9b::7f00:1]", "http://[64:ff9b::7f00:1]/s", false],
  ["name -> 10.0.0.9", "http://internal.test/s", false],
  ["name -> 169.254.169.254", "http://meta.test/s", false],
  ["name -> ::1", "http://lo6.test/s", false],
  ["mixed answers public+10.x", "http://mixed.test/s", false],
  ["mixed answers public+fd00", "http://mixed6.test/s", false],
  ["redirect -> loopback:P", "http://app.test/redir-loopback", false],
  ["redirect -> loopback:80", "http://app.test/redir-loopback80", false],
  ["redirect -> https loopback", "http://app.test/redir-https-loopback", false],
  ["redirect -> name 10.0.0.9", "http://app.test/redir-private-name", false],
  ["redirect -> metadata", "http://app.test/redir-metadata", false],
  ["redirect chain -> localhost:P", "http://app.test/redir-chain1", false],
];
const FAST = ["fetch", "img", "iframe", "ws", "worker", "eventsource"];
const SLOW = ["beacon", "preconnect", "prefetch", "css", "form"];

/** One probe: the page's own outcome, the secret listeners' hit delta and the proxy's decisions for it. */
async function probe(page, events, url, vector) {
  const hits0 = allSecretHits();
  const e0 = events.length;
  const dials0 = dials.length;
  const outcome = await page.evaluate(`probe(${JSON.stringify(url)}, ${JSON.stringify(vector)})`, 10_000).catch((e) => `error ${e.message}`);
  await sleep(120);
  const seen = events.slice(e0).filter((e) => e.type !== "cap");
  return {
    outcome,
    hits: allSecretHits() - hits0,
    allowed: seen.filter((e) => e.type === "allow").map((e) => `${e.host}:${e.port}`),
    denied: seen.filter((e) => e.type === "deny").map((e) => `${e.host}:${e.port} (${e.reason})`),
    dialed: dials.slice(dials0).map((d) => `${d.ip}:${d.port}`),
  };
}

async function runMatrix(label, flags, { pageUrl, proxyOptions, useProxy = true, only = targets.length }) {
  const body = async ({ port, events }) =>
    withChrome([...(useProxy ? flags(port) : flags()), ...IGNORE_CERT], async (chrome) => {
      const page = await chrome.page();
      const state = await page.navigate(pageUrl);
      const title = await page.evaluate("document.title").catch(() => null);
      const rows = [];
      for (const [i, [name, url]] of targets.slice(0, only).entries()) {
        for (const vector of i < 4 ? [...FAST, ...SLOW] : FAST) rows.push({ target: name, vector, ...(await probe(page, events, url, vector)) });
      }
      return { pageLoad: `${state}, title=${title}`, rows, secretHits: allSecretHits(), proxyStats: events.length };
    });
  const run = useProxy ? withProxy(proxyOptions ?? {}, body) : body({ port: 0, events: [] });
  const result = await run;
  const reached = result.rows.filter((r) => r.hits > 0);
  const nonPublicDialed = result.rows.flatMap((r) => r.dialed).filter((d) => !isPublicUnicast(d.replace(/:\d+$/, "")));
  log(`\n== ${label}: page ${result.pageLoad}; ${result.rows.length} probes; probes that reached a loopback listener: ${reached.length}; non-public IPs dialed: ${nonPublicDialed.length}`);
  const perTarget = new Map();
  for (const r of result.rows) {
    const t = perTarget.get(r.target) ?? { hits: 0, denied: 0, allowedPrivate: 0 };
    t.hits += r.hits;
    t.denied += r.denied.length;
    perTarget.set(r.target, t);
  }
  for (const [name, t] of perTarget) log(`   ${name.padEnd(32)} secret hits ${String(t.hits).padStart(3)}   proxy denials ${String(t.denied).padStart(3)}`);
  results[label] = { ...result, reached: reached.length, nonPublicDialed };
  return result;
}

if (want("matrix")) {
  log(`secret listener :${P} (+ :80 bound: ${JSON.stringify(results.privilegedBound)}), page server http:${site.httpPort} https:${site.httpsPort}`);
  await runMatrix("strict", guardedFlags, { pageUrl: "http://app.test/" });
  await runMatrix("relaxed-ports", guardedFlags, { pageUrl: "http://app.test/", proxyOptions: { ports: [80, 443, P] } });
  await runMatrix("control-proxy-without-bypass-removal", (port) => [`--proxy-server=http://127.0.0.1:${port}`, "--disable-quic"], { pageUrl: "http://app.test/", proxyOptions: { ports: [80, 443, P] }, only: 8 });
  await runMatrix("control-no-proxy", () => [], { pageUrl: `http://127.0.0.1:${site.httpPort}/`, useProxy: false, only: 8 });
}

// ---- resolve once, rebinding, redirects, https, websocket ------------------------------------------------------
if (want("resolve")) {
  log("\n== resolve once / rebinding / redirects / https");
  const out = {};
  await withProxy({}, async ({ port, events }) =>
    withChrome([...guardedFlags(port), ...IGNORE_CERT], async (chrome) => {
      const page = await chrome.page();
      const hits0 = allSecretHits();

      // DNS rebinding, the classic shape: the page host answers public first, loopback afterwards.
      lookups.length = 0;
      rebindCalls = 0;
      out.rebindLoad = await page.navigate("http://rebind.test/");
      const first = await page.evaluate("document.title");
      const second = await page.evaluate("fetch('/ok', {cache:'no-store'}).then(r => r.text()).catch(e => 'blocked: ' + e.name)");
      const third = await page.evaluate("fetch('http://rebind.test/ok', {cache:'no-store'}).then(r => r.text()).catch(e => 'blocked: ' + e.name)");
      out.rebind = { firstTitle: first, sameOriginFetchAfterFlip: second, fetchByNameAfterFlip: third, lookupsForRebindTest: lookups.filter((h) => h === "rebind.test").length };
      log(`   rebind.test: load ${out.rebindLoad}, title "${first}"; later fetches: ${JSON.stringify([second, third])}; lookups ${out.rebind.lookupsForRebindTest}`);

      // One lookup per request: the dial uses the checked address, never the name.
      lookups.length = 0;
      dials.length = 0;
      events.length = 0;
      await page.navigate("http://app.test/");
      for (let i = 0; i < 5; i++) await page.evaluate("fetch('http://app.test/ok?i=" + i + "', {cache:'no-store', mode:'no-cors'}).then(() => 'ok')");
      out.perRequest = { lookups: lookups.length, allowed: events.filter((e) => e.type === "allow").length, dials: dials.length, dialIps: [...new Set(dials.map((d) => d.ip))] };
      log(`   public http: ${JSON.stringify(out.perRequest)}`);

      // https through CONNECT, wss through CONNECT, and the unreachable names.
      events.length = 0;
      out.httpsLoad = await page.navigate("https://app.test/");
      const httpsBody = await page.evaluate("fetch('/ok', {cache:'no-store'}).then(r => r.text())").catch((e) => `error ${e.message}`);
      const wss = await page.evaluate("probe('https://app.test/ws', 'ws')");
      const ws = await page.evaluate("probe('http://app.test/ws', 'ws')").catch((e) => `error ${e.message}`);
      out.tls = { load: out.httpsLoad, body: httpsBody, wss, wsSameOriginFromHttps: ws, connects: events.filter((e) => e.via === "connect").map((e) => `${e.type} ${e.host}:${e.port}`) };
      log(`   https page over CONNECT: ${JSON.stringify(out.tls)}`);

      // Top-level navigations to private targets and a redirect chain: what the person's capture would see.
      events.length = 0;
      const navs = {};
      for (const url of [`http://127.0.0.1:${P}/s`, "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "https://127.0.0.1/", "http://[fd00::1]/", "http://app.test/redir-chain1", "http://app.test/redir-metadata", "http://nx.test/"]) {
        const state = await page.navigate(url, 8000);
        const body = await page.evaluate("document.body ? document.body.innerText.slice(0, 80) : ''").catch(() => "");
        navs[url] = { state, body };
      }
      out.navigations = navs;
      out.navigationEvents = events.map((e) => `${e.type} ${e.via} ${e.host}:${e.port} ${e.reason ?? ""}`.trim());
      for (const [url, v] of Object.entries(navs)) log(`   navigate ${url.padEnd(44)} -> ${v.state}${v.body ? ` | ${v.body}` : ""}`);
      out.secretHitsDuringResolve = allSecretHits() - hits0;
      log(`   secret hits during this section: ${out.secretHitsDuringResolve}`);
    }),
  );
  // Real resolver (getaddrinfo), no fakes: names that must be refused.
  const real = createProxy();
  out.realDns = {};
  for (const host of ["localhost", "localhost.", "LOCALHOST", "foo.localhost", "ip6-localhost", "broadcasthost", "127.0.0.1", "[::1]", "0x7f.1", "2130706433", "no-such-host.invalid"]) {
    const v = await real.check(host, 80);
    out.realDns[host] = v.ok ? `ALLOWED ${v.ip}` : `refused: ${v.reason}`;
    log(`   real dns: ${host.padEnd(22)} ${out.realDns[host]}`);
  }
  results.resolve = out;
}

// ---- scheme guard ----------------------------------------------------------------------------------------------
if (want("scheme")) {
  log("\n== non-http schemes (they never reach the proxy)");
  const out = {};
  await withProxy({}, async ({ port, events }) =>
    withChrome([...guardedFlags(port)], async (chrome) => {
      const page = await chrome.page();
      const tries = {
        "Page.navigate file:///etc/hosts": async () => {
          const s = await page.navigate("file:///etc/hosts");
          return `${s}: ${(await page.evaluate("document.body.innerText.slice(0, 40)").catch(() => "")).replace(/\s+/g, " ")}`;
        },
        "Page.navigate chrome://version": async () => `${await page.navigate("chrome://version")}`,
        "Page.navigate view-source:http://app.test/": async () => `${await page.navigate("view-source:http://app.test/")}`,
        "http page 302 -> file://": async () => {
          const s = await page.navigate("http://app.test/redir-file");
          return `${s}; url ${await page.evaluate("location.href").catch(() => "?")}`;
        },
        "http page location.href = file://": async () => {
          await page.navigate("http://app.test/");
          await page.evaluate("setTimeout(() => { location.href = 'file:///etc/hosts' }, 10)");
          await sleep(800);
          return `url ${await page.evaluate("location.href").catch(() => "?")}`;
        },
        "http page iframe file://": async () => {
          await page.navigate("http://app.test/");
          return await page.evaluate("probe('file:///etc/hosts', 'iframe')");
        },
        "http page fetch file://": async () => {
          await page.navigate("http://app.test/");
          return await page.evaluate("fetch('file:///etc/hosts').then(() => 'resolved', e => 'rejected ' + e.name)");
        },
        "http page window.open file://": async () => {
          await page.navigate("http://app.test/");
          await page.evaluate("window.open('file:///etc/hosts')").catch(() => {});
          await sleep(500);
          const { targetInfos } = await chrome.send("Target.getTargets");
          return targetInfos.map((t) => `${t.type}:${t.url}`).join(" | ");
        },
      };
      for (const [name, run] of Object.entries(tries)) {
        out[name] = await run().catch((e) => `error ${e.message}`);
        log(`   ${name.padEnd(40)} ${out[name]}`);
      }
      out.proxyEvents = events.length;
    }),
  );
  results.scheme = out;
}

// ---- UDP: QUIC, WebTransport, WebRTC ---------------------------------------------------------------------------
if (want("udp")) {
  log("\n== UDP channels (a UDP listener on 127.0.0.1 counts datagrams)");
  const out = {};
  const rtc = `(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.port}' }] });
    pc.createDataChannel('x');
    const candidates = [];
    pc.onicecandidate = (e) => e.candidate && candidates.push(e.candidate.candidate.split(' ').slice(4, 8).join(' '));
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 3500));
    pc.close();
    return candidates;
  })()`;
  const wt = `(async () => {
    if (typeof WebTransport === 'undefined') return 'WebTransport undefined';
    try { const t = new WebTransport('https://127.0.0.1:${udp.port}/'); await Promise.race([t.ready, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000))]); return 'ready'; }
    catch (e) { return 'failed: ' + (e.message || e.name).slice(0, 80); }
  })()`;
  const configs = {
    "no-proxy, no udp flags": { flags: () => [], useProxy: false, pageUrl: `http://127.0.0.1:${site.httpPort}/` },
    "proxy + <-loopback> only": { flags: (p) => [`--proxy-server=http://127.0.0.1:${p}`, "--proxy-bypass-list=<-loopback>"], pageUrl: "https://app.test/" },
    "proxy + <-loopback> + --disable-quic": { flags: (p) => [`--proxy-server=http://127.0.0.1:${p}`, "--proxy-bypass-list=<-loopback>", "--disable-quic"], pageUrl: "https://app.test/" },
    "proxy + <-loopback> + webrtc policy": { flags: (p) => [`--proxy-server=http://127.0.0.1:${p}`, "--proxy-bypass-list=<-loopback>", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"], pageUrl: "https://app.test/" },
    "full guard (pinned set)": { flags: guardedFlags, pageUrl: "https://app.test/" },
  };
  for (const [name, cfg] of Object.entries(configs)) {
    const run = async ({ port }) =>
      withChrome([...cfg.flags(port), ...IGNORE_CERT], async (chrome) => {
        const page = await chrome.page();
        await page.navigate(cfg.pageUrl);
        udp.datagrams.length = 0;
        const candidates = await page.evaluate(rtc, 15_000).catch((e) => `error ${e.message}`);
        await sleep(1500); // let a closed peer connection's last retransmissions land before the WebTransport count starts
        const afterRtc = udp.datagrams.length;
        const transport = await page.evaluate(wt, 10_000).catch((e) => `error ${e.message}`);
        await sleep(300);
        out[name] = { webrtcCandidates: candidates, udpDatagramsAfterWebRTC: afterRtc, webTransport: transport, udpDatagramsAfterWebTransport: udp.datagrams.length - afterRtc };
        log(`   ${name.padEnd(40)} ${JSON.stringify(out[name])}`);
      });
    await (cfg.useProxy === false ? run({ port: 0 }) : withProxy({}, run));
  }
  results.udp = out;
}

// ---- leak sweep: every socket of the Chrome process tree ---------------------------------------------------------
if (want("leaks")) {
  log("\n== socket sweep of the Chrome process tree (lsof) during a page load + battery");
  const out = {};
  await withProxy({}, async ({ port, events }) =>
    withChrome([...guardedFlags(port), ...IGNORE_CERT], async (chrome) => {
      const page = await chrome.page();
      await page.navigate("http://app.test/");
      for (const vector of FAST) await page.evaluate(`probe('http://app.test/ok', '${vector}')`);
      await page.navigate("https://app.test/");
      await sleep(8000); // idle: background services, if any, would show up now
      const tree = (() => {
        const rows = execFileSync("ps", ["-axo", "pid=,ppid="]).toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
        const pids = new Set([chrome.pid]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) (pids.add(pid), (grew = true));
        }
        return [...pids];
      })();
      let sockets = "";
      try {
        sockets = execFileSync("lsof", ["-nP", "-i", "-a", "-p", tree.join(",")], { stdio: ["ignore", "pipe", "ignore"] }).toString();
      } catch (e) {
        sockets = e.stdout?.toString() ?? "";
      }
      const lines = sockets.trim().split("\n").slice(1);
      const tcp = lines.filter((l) => /TCP/.test(l));
      const notProxy = tcp.filter((l) => !l.includes(`127.0.0.1:${port}`) && !/LISTEN/.test(l));
      const udpSockets = lines.filter((l) => /UDP/.test(l));
      out.processes = tree.length;
      out.tcpSockets = tcp.length;
      out.tcpNotToProxy = notProxy;
      out.udpSockets = udpSockets;
      out.proxyDecisions = events.length;
      log(`   processes ${tree.length}; TCP sockets ${tcp.length}; TCP not to the proxy ${notProxy.length}; UDP sockets ${udpSockets.length}`);
      for (const l of [...notProxy, ...udpSockets]) log(`      ${l.replace(/\s+/g, " ")}`);
    }),
  );
  // Same sweep for an idle guarded Chrome that never loads a page: background traffic.
  await withProxy({}, async ({ port, events }) =>
    withChrome(guardedFlags(port), async () => {
      await sleep(10_000);
      out.idleProxyDecisions = events.length;
      log(`   idle 10 s about:blank: proxy decisions ${events.length}`);
    }),
  );
  results.leaks = out;
}

// ---- caps ------------------------------------------------------------------------------------------------------
if (want("cap")) {
  log("\n== byte cap");
  const out = {};
  await withProxy({ maxBytes: 3 * 1024 * 1024 }, async ({ port, proxy, events }) =>
    withChrome(guardedFlags(port), async (chrome) => {
      const page = await chrome.page();
      await page.navigate("http://app.test/");
      const t0 = Date.now();
      const outcome = await page.evaluate("fetch('http://app.test/big', {cache:'no-store'}).then(async r => { const reader = r.body.getReader(); let n = 0; for (;;) { const { done, value } = await reader.read(); if (done) return 'finished ' + n; n += value.length; } }).catch(e => 'aborted: ' + e.name)", 20_000);
      out.fetch = outcome;
      out.ms = Date.now() - t0;
      out.proxy = { ...proxy.stats };
      log(`   cap 3 MiB: fetch ${outcome} after ${out.ms} ms; proxy ${JSON.stringify(proxy.stats)}; cap events ${events.filter((e) => e.type === "cap").length}`);
    }),
  );
  results.cap = out;
}

mkdirSync(new URL("../out/", import.meta.url).pathname, { recursive: true });
writeFileSync(new URL("../out/results.json", import.meta.url), JSON.stringify(results, null, 2));
log("\nresults written to out/results.json");
process.exit(0);
