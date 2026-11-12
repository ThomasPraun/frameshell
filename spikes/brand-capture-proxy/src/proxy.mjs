// The guarded proxy: Chrome's only way out. CONNECT (https, wss) and absolute-URI HTTP, both through one check:
// resolve the host once, refuse unless every answer is public unicast and the port is 80/443, then connect to the
// checked IP literal. Redirects are never followed here: Chrome follows them and opens a new proxy request per hop.
import dns from "node:dns/promises";
import http from "node:http";
import net, { isIP } from "node:net";
import { ALLOWED_PORTS, isPublicUnicast, portVerdict } from "./policy.mjs";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/**
 * @param {object} [options]
 * @param {(host: string) => Promise<string[]>} [options.lookup] resolver; the default is dns.lookup (getaddrinfo), tests inject a fake DNS
 * @param {(ip: string, port: number) => net.Socket} [options.dial] connector; tests map fake public IPs to local fixtures
 * @param {number[]} [options.ports]
 * @param {number} [options.maxBytes] total bytes through the proxy before every socket is destroyed
 * @param {(event: object) => void} [options.onEvent]
 */
export function createProxy(options = {}) {
  const lookup = options.lookup ?? (async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const dial = options.dial ?? ((ip, port) => net.connect({ host: ip, port }));
  const ports = options.ports ?? ALLOWED_PORTS;
  const onEvent = options.onEvent ?? (() => {});
  const sockets = new Set();
  const stats = { bytes: 0, allowed: 0, denied: 0, capped: false };

  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      stats.bytes += chunk.length;
      if (options.maxBytes && stats.bytes > options.maxBytes && !stats.capped) {
        stats.capped = true;
        onEvent({ type: "cap", bytes: stats.bytes });
        for (const s of sockets) s.destroy();
      }
    });
    socket.on("error", () => {});
    return socket;
  };

  /** Resolve once and decide. Literal IPs skip DNS but pass the same address check. */
  async function check(rawHost, port) {
    const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    const portProblem = portVerdict(port, ports);
    if (portProblem) return { ok: false, reason: portProblem };
    if (!host || /[^a-z0-9.:%_-]/.test(host)) return { ok: false, reason: "bad host" };
    let answers;
    try {
      answers = isIP(host) ? [host] : await lookup(host);
    } catch (error) {
      return { ok: false, reason: `dns: ${error.code ?? error.message}` };
    }
    if (answers.length === 0) return { ok: false, reason: "dns: no answer" };
    const bad = answers.find((ip) => !isPublicUnicast(ip));
    if (bad) return { ok: false, reason: `non-public address ${bad}` };
    return { ok: true, ip: answers[0] };
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end("absolute URI required");
      return;
    }
    const port = Number(url.port || 80);
    const verdict = url.protocol === "http:" ? await check(url.hostname, port) : { ok: false, reason: `scheme ${url.protocol}` };
    onEvent({ type: verdict.ok ? "allow" : "deny", via: "http", host: url.hostname, port, ip: verdict.ip, reason: verdict.reason, path: url.pathname });
    if (!verdict.ok) {
      stats.denied++;
      res.writeHead(403, { "content-type": "text/plain", connection: "close" }).end(`blocked: ${verdict.reason}`);
      return;
    }
    stats.allowed++;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
    // A one-shot agent whose connector dials the checked IP literal; the name is never resolved a second time.
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => track(dial(verdict.ip, port));
    const upstream = http.request(
      { method: req.method, path: url.pathname + url.search, headers, agent },
      (response) => {
        const out = Object.fromEntries(Object.entries(response.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
        res.writeHead(response.statusCode ?? 502, out);
        response.pipe(res);
      },
    );
    upstream.on("error", (e) => (process.env.DEBUG_PROXY && console.error("upstream", e), res.headersSent || res.writeHead(502).end()));
    req.pipe(upstream);
  });

  server.on("connection", track);
  server.on("connect", async (req, client, head) => {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    const verdict = match ? await check(match[1], Number(match[2])) : { ok: false, reason: "bad CONNECT target" };
    onEvent({ type: verdict.ok ? "allow" : "deny", via: "connect", host: match?.[1], port: match && Number(match[2]), ip: verdict.ip, reason: verdict.reason });
    if (!verdict.ok) {
      stats.denied++;
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    stats.allowed++;
    const upstream = track(dial(verdict.ip, Number(match[2])));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  return {
    stats,
    check,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
