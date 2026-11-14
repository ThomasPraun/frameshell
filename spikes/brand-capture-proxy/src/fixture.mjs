// Local fixtures: a "secret" TCP listener on loopback (what the page must never reach), a UDP listener (QUIC, WebRTC),
// and a "public" site served over http and https that a fake DNS and a fake dial map to fake public IPs.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const out = new URL("../out/", import.meta.url).pathname;

/** Raw TCP listener on every loopback address ([::] is dual-stack: 127.0.0.1, ::1, 0.0.0.0). Counts connections, answers HTTP. */
export async function secretServer(port = 0, host = "::") {
  const hits = [];
  const server = net.createServer((socket) => {
    const hit = { remote: socket.remoteAddress, first: "" };
    hits.push(hit);
    socket.on("data", (chunk) => {
      hit.first ||= chunk.toString("latin1").split("\r\n")[0];
      socket.write("HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nSECRET");
      socket.end();
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => (server.once("error", reject), server.listen(port, host, resolve)));
  return { port: server.address().port, hits, close: () => new Promise((r) => (server.close(r), server.closeAllConnections?.())) };
}

/** UDP listener on 127.0.0.1 counting datagrams (STUN binding requests, QUIC initial packets). */
export async function udpServer() {
  const datagrams = [];
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, rinfo) => datagrams.push({ bytes: msg.length, from: `${rinfo.address}:${rinfo.port}` }));
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { port: socket.address().port, datagrams, close: () => socket.close() };
}

function certificate() {
  mkdirSync(out, { recursive: true });
  if (!existsSync(`${out}cert.pem`)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${out}key.pem`, "-out", `${out}cert.pem`, "-days", "2", "-subj", "/CN=app.test"], { stdio: "ignore" });
  }
  return { key: readFileSync(`${out}key.pem`), cert: readFileSync(`${out}cert.pem`) };
}

const PAGE = `<!doctype html><meta charset=utf-8><title>battery</title><script>
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.probe = async (url, vector) => {
  const done = (async () => {
    try {
      if (vector === 'fetch') { await fetch(url, { mode: 'no-cors', cache: 'no-store' }); return 'resolved'; }
      if (vector === 'img') return await new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = url; });
      if (vector === 'iframe') return await new Promise((r) => { const f = document.createElement('iframe'); f.onload = () => r('loaded'); f.onerror = () => r('error'); f.src = url; document.body.append(f); });
      if (vector === 'ws') return await new Promise((r) => { let w; try { w = new WebSocket(url.replace(/^http/, 'ws')); } catch (e) { return r('throw'); } w.onopen = () => r('open'); w.onerror = () => r('error'); w.onclose = () => r('closed'); });
      if (vector === 'beacon') return String(navigator.sendBeacon(url, 'x')) + (await wait(700), '');
      if (vector === 'worker') {
        const blob = new Blob(['fetch(' + JSON.stringify(url) + ', { mode: "no-cors" }).then(() => postMessage("resolved"), () => postMessage("rejected"))'], { type: 'text/javascript' });
        return await new Promise((r) => { const w = new Worker(URL.createObjectURL(blob)); w.onmessage = (e) => r(e.data); w.onerror = () => r('error'); });
      }
      if (vector === 'preconnect') { const l = document.createElement('link'); l.rel = 'preconnect'; l.href = url; document.head.append(l); await wait(700); return 'hinted'; }
      if (vector === 'prefetch') { const l = document.createElement('link'); l.rel = 'prefetch'; l.href = url; document.head.append(l); await wait(700); return 'hinted'; }
      if (vector === 'css') { const s = document.createElement('style'); s.textContent = '@import url(' + JSON.stringify(url) + ');body{background:url(' + JSON.stringify(url) + ')}'; document.head.append(s); await wait(700); return 'inserted'; }
      if (vector === 'eventsource') return await new Promise((r) => { const e = new EventSource(url); e.onerror = () => { e.close(); r('error'); }; e.onopen = () => r('open'); });
      if (vector === 'form') { const f = document.createElement('form'); f.method = 'POST'; f.action = url; f.target = 'ftarget'; const t = document.createElement('iframe'); t.name = 'ftarget'; document.body.append(t, f); f.submit(); await wait(700); return 'submitted'; }
      return 'unknown vector';
    } catch (e) { return 'threw ' + e.name; }
  })();
  return Promise.race([done, wait(4000).then(() => 'timeout')]);
};
</script><body>battery</body>`;

/**
 * The "public" site. One http server and one https server answer for every fake host; the route decides what they do.
 * `ctx.secretPort` is the loopback listener the redirects point at.
 */
export async function publicSite(ctx) {
  const requests = [];
  const handler = (scheme) => (req, res) => {
    requests.push({ scheme, host: req.headers.host, url: req.url });
    const url = new URL(req.url, `${scheme}://${req.headers.host}`);
    const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
    if (url.pathname === "/") return res.writeHead(200, { ...cors, "content-type": "text/html" }).end(PAGE);
    if (url.pathname === "/ok") return res.writeHead(200, { ...cors, "content-type": "text/plain" }).end("OK public");
    if (url.pathname === "/redir-loopback") return res.writeHead(302, { ...cors, location: `http://127.0.0.1:${ctx.secretPort}/redirected` }).end();
    if (url.pathname === "/redir-loopback80") return res.writeHead(302, { ...cors, location: "http://127.0.0.1/redirected" }).end();
    if (url.pathname === "/redir-https-loopback") return res.writeHead(302, { ...cors, location: "https://127.0.0.1/redirected" }).end();
    if (url.pathname === "/redir-private-name") return res.writeHead(302, { ...cors, location: "http://internal.test/redirected" }).end();
    if (url.pathname === "/redir-metadata") return res.writeHead(302, { ...cors, location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (url.pathname === "/redir-file") return res.writeHead(302, { ...cors, location: "file:///etc/hosts" }).end();
    if (url.pathname === "/redir-chain1") return res.writeHead(302, { ...cors, location: "/redir-chain2" }).end();
    if (url.pathname === "/redir-chain2") return res.writeHead(302, { ...cors, location: `http://localhost:${ctx.secretPort}/chain` }).end();
    if (url.pathname === "/big") {
      res.writeHead(200, { ...cors, "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const timer = setInterval(() => res.write(chunk), 2);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404, cors).end("not found");
  };
  const upgrade = (req, socket) => {
    requests.push({ scheme: "upgrade", host: req.headers.host, url: req.url });
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
  };
  const plain = http.createServer(handler("http"));
  plain.on("upgrade", upgrade);
  const secure = https.createServer(certificate(), handler("https"));
  secure.on("upgrade", upgrade);
  await Promise.all([new Promise((r) => plain.listen(0, "127.0.0.1", r)), new Promise((r) => secure.listen(0, "127.0.0.1", r))]);
  return {
    httpPort: plain.address().port,
    httpsPort: secure.address().port,
    requests,
    close: () => Promise.all([plain, secure].map((s) => new Promise((r) => (s.close(r), s.closeAllConnections?.())))),
  };
}
