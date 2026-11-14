import http from "node:http";
import type net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaptureProxy, fetchThrough } from "../src/brand/proxy.js";
import { FAKE_PUBLIC_IP, fakeNetwork, secretListener } from "./brand-fixture.js";

// Seam under test: the capture proxy (ADR 0044) with a fake public network: one fake public IP maps to a local
// site; private names, literals, other ports and redirects to them are refused, and nothing reaches a loopback
// listener. Every dial must be the checked public IP. No external network.

let site: http.Server;
let sitePort: number;
let secret: Awaited<ReturnType<typeof secretListener>>;
let proxy: CaptureProxy;
let network: ReturnType<typeof fakeNetwork>;

beforeAll(async () => {
  secret = await secretListener();
  site = http.createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/ok") return void response.writeHead(200, { "content-type": "text/plain" }).end("OK public");
    if (path === "/redir-loopback") return void response.writeHead(302, { location: `http://127.0.0.1:${secret.port}/x` }).end();
    if (path === "/redir-loopback80") return void response.writeHead(302, { location: "http://localhost/x" }).end();
    if (path === "/redir-private") return void response.writeHead(302, { location: "http://private.test/x" }).end();
    if (path === "/redir-file") return void response.writeHead(302, { location: "file:///etc/hosts" }).end();
    if (path === "/redir-ok") return void response.writeHead(301, { location: "/ok" }).end();
    if (path === "/big") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const timer = setInterval(() => response.write(chunk), 1);
      response.on("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  sitePort = (site.address() as net.AddressInfo).port;
});

afterEach(async () => {
  await proxy?.close();
});

afterAll(async () => {
  site.closeAllConnections();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await secret.close();
});

async function start(maxBytes = 50 * 1024 * 1024): Promise<void> {
  network = fakeNetwork(sitePort, {
    "app.test": [FAKE_PUBLIC_IP],
    "private.test": ["10.0.0.9"],
    "metadata.test": ["169.254.169.254"],
    "mixed.test": [FAKE_PUBLIC_IP, "10.0.0.5"],
    "mixed6.test": [FAKE_PUBLIC_IP, "fd00::5"],
    localhost: ["::1", "127.0.0.1"],
  });
  proxy = await CaptureProxy.start({ maxBytes, resolve: network.resolve, dial: network.dial });
}

const get = (url: string, maxBytes = 10 * 1024 * 1024) => fetchThrough(proxy, url, { maxBytes, timeoutMs: 10_000 });

describe("capture proxy", () => {
  it("fetches a public page, resolving once and dialing only the checked IP", async () => {
    await start();
    const fetched = await get("http://app.test/ok");
    expect(fetched.body.toString()).toBe("OK public");
    expect(network.lookups).toEqual(["app.test"]);
    expect(network.dials).toEqual([`${FAKE_PUBLIC_IP}:80`]);
  });

  it("follows a redirect as a new checked request", async () => {
    await start();
    expect((await get("http://app.test/redir-ok")).url).toBe("http://app.test/ok");
    expect(network.lookups).toEqual(["app.test", "app.test"]);
  });

  it.each([
    ["http://private.test/", /non-public address 10\.0\.0\.9/],
    ["http://metadata.test/latest/meta-data/", /non-public address 169\.254\.169\.254/],
    ["http://mixed.test/", /non-public address 10\.0\.0\.5/],
    ["http://mixed6.test/", /non-public address fd00::5/],
    ["http://localhost/", /non-public address ::1/],
    ["http://127.0.0.1/", /non-public address 127\.0\.0\.1/],
    ["http://[::ffff:127.0.0.1]/", /non-public address/],
    ["http://0.0.0.0/", /non-public address 0\.0\.0\.0/],
    ["http://app.test:8080/", /port 8080 not allowed/],
    ["http://unknown.test/", /dns: ENOTFOUND/],
  ])("refuses %s", async (url, reason) => {
    await start();
    await expect(get(url)).rejects.toThrow(reason);
    expect(network.dials).toEqual([]);
  });

  it("refuses a loopback listener on its own port and through redirects; nothing reaches it", async () => {
    await start();
    await expect(get(`http://127.0.0.1:${secret.port}/`)).rejects.toThrow(/port .* not allowed/);
    await expect(get("http://app.test/redir-loopback")).rejects.toThrow(/refused by the capture proxy/);
    await expect(get("http://app.test/redir-loopback80")).rejects.toThrow(/non-public address/);
    await expect(get("http://app.test/redir-private")).rejects.toThrow(/non-public address 10\.0\.0\.9/);
    await expect(get("http://app.test/redir-file")).rejects.toThrow(/only http and https/);
    expect(secret.hits()).toBe(0);
    expect(network.dials.every((dial) => dial === `${FAKE_PUBLIC_IP}:80`)).toBe(true);
    expect(proxy.events.filter((event) => event.allowed).every((event) => event.ip === FAKE_PUBLIC_IP)).toBe(true);
  });

  it("refuses CONNECT tunnels to private addresses", async () => {
    await start();
    await expect(get("https://127.0.0.1/")).rejects.toThrow(/CONNECT 403/);
    await expect(get("https://private.test/")).rejects.toThrow(/CONNECT 403/);
    expect(proxy.events.map((event) => event.reason)).toEqual(["non-public address 127.0.0.1", "non-public address 10.0.0.9"]);
    expect(network.dials).toEqual([]);
  });

  it("answers a raw proxy request for a private host with its marked refusal page", async () => {
    await start();
    const answer = await new Promise<{ status: number; marked: boolean }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: proxy.port, path: `http://127.0.0.1:${secret.port}/`, headers: { host: `127.0.0.1:${secret.port}` } }, (response) => {
        response.resume();
        resolve({ status: response.statusCode ?? 0, marked: response.headers["x-frameshell-capture-proxy"] === "refused" });
      });
      request.on("error", reject);
      request.end();
    });
    expect(answer).toEqual({ status: 403, marked: true });
    expect(secret.hits()).toBe(0);
  });

  it("stops every socket at the byte cap and a fetch at its own size limit", async () => {
    await start(1024 * 1024);
    await expect(get("http://app.test/big")).rejects.toThrow();
    expect(proxy.capped).toBe(true);
    await proxy.close();
    await start();
    await expect(get("http://app.test/big", 256 * 1024)).rejects.toThrow(/larger than/);
  });
});
