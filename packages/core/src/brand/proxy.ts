// The capture proxy (ADR 0044): the only way out for capture Chrome and for the files the daemon fetches.
// CONNECT (https, wss) and absolute-URI HTTP both pass one check: port 80/443, the host resolved once, every
// answer public unicast, then a connection to the checked IP literal, so a second lookup cannot rebind it.
// Redirects are never followed here: Chrome (and `fetchThrough`) open a new proxy request per hop.
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import net, { isIP } from "node:net";
import tls from "node:tls";
import { CAPTURE_PORTS, isPublicUnicast } from "./policy.js";

/** Resolve a host name to every address it has (literals, as `dns.lookup` returns them). */
export type Resolve = (host: string) => Promise<string[]>;
/** Open a TCP connection to a checked IP literal. */
export type Dial = (ip: string, port: number) => net.Socket;

/** Header the proxy sets on its refusal page, so the capture can tell its own 403 from the site's. */
export const PROXY_REFUSAL_HEADER = "x-frameshell-capture-proxy";

/** What the proxy did with one request. */
export interface ProxyEvent {
  allowed: boolean;
  host: string;
  port: number;
  /** The address dialed; null when refused. */
  ip: string | null;
  /** Why it was refused; null when allowed. */
  reason: string | null;
}

/** Options of {@link CaptureProxy.start}. */
export interface CaptureProxyOptions {
  /** Bytes in and out of every socket together; past it every socket is destroyed. */
  maxBytes: number;
  /** Tests only: a fake resolver. Default `dns.lookup` (getaddrinfo), all answers. */
  resolve?: Resolve;
  /** Tests only: map checked fake public IPs to local fixtures. Default `net.connect`. */
  dial?: Dial;
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** One guarded proxy on `127.0.0.1:<ephemeral>`, for one capture; {@link CaptureProxy.close} ends it. */
export class CaptureProxy {
  /** Every request seen, in order. */
  readonly events: ProxyEvent[] = [];
  readonly #server: http.Server;
  readonly #sockets = new Set<net.Socket>();
  readonly #resolve: Resolve;
  readonly #dial: Dial;
  readonly #maxBytes: number;
  #bytes = 0;
  #capped = false;
  #port = 0;

  private constructor(options: CaptureProxyOptions) {
    this.#maxBytes = options.maxBytes;
    this.#resolve = options.resolve ?? (async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((answer) => answer.address));
    this.#dial = options.dial ?? ((ip, port) => net.connect({ host: ip, port }));
    this.#server = http.createServer((request, response) => void this.#forward(request, response));
    this.#server.on("connection", (socket: net.Socket) => this.#track(socket));
    this.#server.on("connect", (request: IncomingMessage, client: net.Socket, head: Buffer) => void this.#tunnel(request, client, head));
  }

  /** Listen on loopback and resolve once ready. */
  static async start(options: CaptureProxyOptions): Promise<CaptureProxy> {
    const proxy = new CaptureProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.#server.once("error", reject);
      proxy.#server.listen(0, "127.0.0.1", resolve);
    });
    proxy.#port = (proxy.#server.address() as net.AddressInfo).port;
    return proxy;
  }

  /** Port on 127.0.0.1. */
  get port(): number {
    return this.#port;
  }

  /** Bytes through every socket so far. */
  get bytes(): number {
    return this.#bytes;
  }

  /** True once the byte cap destroyed the sockets. */
  get capped(): boolean {
    return this.#capped;
  }

  /**
   * Decide on `rawHost:port`: the IP to dial, or why not. A literal skips DNS but passes the same address check;
   * a name answering public and private addresses is refused whole.
   */
  async check(rawHost: string, port: number): Promise<{ ok: true; ip: string } | { ok: false; reason: string }> {
    const host = rawHost.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!CAPTURE_PORTS.includes(port)) return { ok: false, reason: `port ${port} not allowed` };
    if (!host || /[^a-z0-9.:%_-]/.test(host)) return { ok: false, reason: "bad host" };
    let answers: string[];
    try {
      answers = isIP(host) ? [host] : await this.#resolve(host);
    } catch (error) {
      return { ok: false, reason: `dns: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` };
    }
    if (answers.length === 0) return { ok: false, reason: "dns: no answer" };
    const bad = answers.find((ip) => !isPublicUnicast(ip));
    if (bad !== undefined) return { ok: false, reason: `non-public address ${bad}` };
    return { ok: true, ip: answers[0]! };
  }

  /** Stop listening and destroy every socket. */
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #track(socket: net.Socket): net.Socket {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
    socket.on("data", (chunk: Buffer) => {
      this.#bytes += chunk.length;
      if (this.#bytes > this.#maxBytes && !this.#capped) {
        this.#capped = true;
        for (const open of this.#sockets) open.destroy();
      }
    });
    socket.on("error", () => {});
    if (this.#capped) socket.destroy();
    return socket;
  }

  #record(host: string, port: number, verdict: { ok: true; ip: string } | { ok: false; reason: string }): void {
    this.events.push({ allowed: verdict.ok, host, port, ip: verdict.ok ? verdict.ip : null, reason: verdict.ok ? null : verdict.reason });
  }

  async #forward(request: IncomingMessage, response: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? "");
    } catch {
      response.writeHead(400, { connection: "close" }).end("absolute URI required");
      return;
    }
    const port = Number(url.port || 80);
    const verdict = url.protocol === "http:" ? await this.check(url.hostname, port) : ({ ok: false, reason: `scheme ${url.protocol}` } as const);
    this.#record(url.hostname, port, verdict);
    if (!verdict.ok) {
      response.writeHead(403, { "content-type": "text/plain", connection: "close", [PROXY_REFUSAL_HEADER]: "refused" }).end(`blocked: ${verdict.reason}`);
      return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
    // `createConnection` must sit on an Agent: given to `http.request` with `agent: false` it is ignored and Node
    // connects to `localhost` (measured in the spike).
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => this.#track(this.#dial(verdict.ip, port));
    const upstream = http.request({ method: request.method, path: url.pathname + url.search, headers, agent }, (answer) => {
      const back = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !HOP_BY_HOP.has(name)));
      response.writeHead(answer.statusCode ?? 502, back);
      answer.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { connection: "close" }).end();
      else response.destroy();
    });
    request.pipe(upstream);
  }

  async #tunnel(request: IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(request.url ?? "");
    const host = match?.[1] ?? "";
    const port = match ? Number(match[2]) : 0;
    const verdict = match ? await this.check(host, port) : ({ ok: false, reason: "bad CONNECT target" } as const);
    this.#record(host, port, verdict);
    if (!verdict.ok) {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = this.#track(this.#dial(verdict.ip, port));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"));
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  }
}

/** A file fetched through the proxy. */
export interface Fetched {
  /** URL after redirects. */
  url: string;
  status: number;
  contentType: string | null;
  body: Buffer;
}

/** User agent of the daemon's own fetches; the page's requests keep Chrome's. */
const USER_AGENT = "Mozilla/5.0 (compatible; Frameshell brand capture)";

/**
 * GET `url` through `proxy`, following up to 5 redirects (each hop a new proxy request, so each is checked).
 * Rejects past `maxBytes` of body, after `timeoutMs`, on a refusal, or on a non-2xx answer.
 */
export async function fetchThrough(proxy: CaptureProxy, url: string, options: { maxBytes: number; timeoutMs: number; referer?: string }): Promise<Fetched> {
  let current = new URL(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error(`${current.href}: only http and https are fetched`);
    const answer = await requestOnce(proxy.port, current, options);
    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      current = new URL(answer.location, current);
      continue;
    }
    if (answer.refused) throw new Error(`${current.href}: refused by the capture proxy (${answer.body.toString("utf8").replace(/^blocked: /, "")})`);
    if (answer.status < 200 || answer.status >= 300) throw new Error(`${current.href}: HTTP ${answer.status}`);
    return { url: current.href, status: answer.status, contentType: answer.contentType, body: answer.body };
  }
  throw new Error(`${url}: more than 5 redirects`);
}

interface Answer {
  status: number;
  location: string | null;
  contentType: string | null;
  refused: boolean;
  body: Buffer;
}

function requestOnce(proxyPort: number, url: URL, options: { maxBytes: number; timeoutMs: number; referer?: string }): Promise<Answer> {
  const headers = {
    host: url.host,
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-encoding": "identity",
    ...(options.referer ? { referer: options.referer } : {}),
  };
  return new Promise<Answer>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error(`${url.href}: no answer in ${options.timeoutMs / 1000} s`)), options.timeoutMs);
    let done = false;
    const cleanups: (() => void)[] = [];
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      reject(error);
    };
    const read = (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy();
          fail(new Error(`${url.href}: larger than ${Math.round(options.maxBytes / 1_048_576)} MB`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) => fail(error));
      response.on("close", () => {
        if (!response.complete) fail(new Error(`${url.href}: the connection closed before the end (the capture's byte cap, or the server)`));
      });
      response.on("end", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          location: typeof location === "string" ? location : null,
          contentType: response.headers["content-type"] ?? null,
          refused: response.headers[PROXY_REFUSAL_HEADER] !== undefined,
          body: Buffer.concat(chunks),
        });
      });
    };
    if (url.protocol === "http:") {
      const request = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: url.href, headers, agent: false }, read);
      cleanups.push(() => request.destroy());
      request.on("error", (error) => fail(error));
      request.end();
      return;
    }
    const port = Number(url.port || 443);
    const connect = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname}:${port}`, agent: false });
    cleanups.push(() => connect.destroy());
    connect.on("error", (error) => fail(error));
    connect.on("connect", (answer: IncomingMessage, socket: net.Socket) => {
      cleanups.push(() => socket.destroy());
      if (answer.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`${url.href}: refused by the capture proxy (CONNECT ${answer.statusCode})`));
        return;
      }
      const agent = new https.Agent({ keepAlive: false });
      agent.createConnection = () => tls.connect({ socket, servername: isIP(url.hostname) ? undefined : url.hostname, ALPNProtocols: ["http/1.1"] });
      const request = https.request({ host: url.hostname, port, method: "GET", path: url.pathname + url.search, headers, agent }, read);
      cleanups.push(() => request.destroy());
      request.on("error", (error) => fail(error));
      request.end();
    });
    connect.end();
  });
}
