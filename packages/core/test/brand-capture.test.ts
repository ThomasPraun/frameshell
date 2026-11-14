import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { join } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { parseBrandManifest } from "@frameshell/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrandService, type BrandServiceOptions, guardedChromeFlags } from "../src/brand/capture.js";
import { CaptureProxy } from "../src/brand/proxy.js";
import { Chrome, ChromePage } from "../src/inspect/chrome.js";
import { checkCaptureUrl } from "../src/brand/policy.js";
import { encodeGrayPng } from "../src/segment/png.js";
import { FAKE_PUBLIC_IP, fakeNetwork, nameTable, secretListener, sfnt, woff } from "./brand-fixture.js";
import { tempDir } from "./helpers.js";
import { testBinaryManager } from "./media-tools.js";

// Seam under test: `BrandService.capture` (ADR 0044) on a local fixture site that a fake DNS and dial present as
// the public host `brand.test`, in real headless Chrome behind the real proxy (opt-in: FRAMESHELL_TEST_REAL_CHROME=1).
// The page also tries to reach a loopback listener in several ways: it must see no connection.

const OFL = nameTable({ 1: "Acme Sans", 8: "Acme Type Co", 13: "Licensed under the SIL Open Font License, Version 1.1" });
const CLOSED = nameTable({ 1: "Closed Serif", 13: "All rights reserved. Not for redistribution." });
const png = (size: number, level: number) => encodeGrayPng(new Uint8Array(size * size).fill(level), size, size);

function page(secretPort: number): string {
  const words = Array.from({ length: 60 }, (_, i) => `Rockets for everyone, number ${i}.`).join(" ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Acme Rockets | Fly anywhere</title>
<meta property="og:site_name" content="Acme Rockets"><meta property="og:image" content="/og.png">
<link rel="icon" href="/icon.png"><link rel="icon" href="/favicon.ico">
<style>
@font-face { font-family: "Acme Sans"; src: url(/fonts/acme.ttf) format("truetype"); font-weight: 400; }
@font-face { font-family: "Closed Serif"; src: url(/fonts/closed.woff) format("woff"); font-weight: 700; }
:root { --brand: #ff5a1f; --ink: #1a1a2e; }
body { margin: 0; background: #fafafa; color: #1a1a2e; font-family: "Acme Sans", sans-serif; }
header { display: flex; gap: 20px; padding: 10px; }
h1, h2 { font-family: "Closed Serif", serif; font-weight: 700; color: #ff5a1f; letter-spacing: 1.6px; font-size: 32px; }
.btn { display: inline-block; background: #ff5a1f; color: #ffffff; padding: 10px; border: 2px solid #ff5a1f; }
.err { color: #e00000; }
.tall { height: 1400px; }
</style></head><body>
<header><a href="/"><svg class="logo" viewBox="0 0 100 40" width="100" height="40" onclick="alert(1)"><script>window.x = 1</script>
<rect width="100" height="40" fill="currentColor" style="color: #ff5a1f"/><foreignObject width="10" height="10"><div>x</div></foreignObject>
<image href="http://evil.test/x.png" width="1" height="1"/></svg></a><img src="/logo.svg" alt="Acme logo" width="80" height="40"></header>
<h1>Rockets for everyone</h1><h2>Fly anywhere</h2><p>${words}</p><a class="btn" href="/buy">Buy now</a><p class="err">Error text</p>
<div class="tall"></div><video src="/promo.mp4" preload="none"></video>
<script>
fetch("http://127.0.0.1:${secretPort}/leak", { mode: "no-cors" }).catch(() => {});
new Image().src = "http://localhost:${secretPort}/img";
try { new WebSocket("ws://127.0.0.1:${secretPort}/ws"); } catch {}
fetch("/redir-loopback").catch(() => {});
</script></body></html>`;
}

const LOGO_SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40" onload="alert(1)"><script>alert(2)</script><circle cx="20" cy="20" r="18" fill="#1a1a2e"/></svg>`;

let site: http.Server;
let secret: Awaited<ReturnType<typeof secretListener>>;
let options: BrandServiceOptions;
let network: ReturnType<typeof fakeNetwork>;
const credited: { assets: string[]; sourceUrl?: string; licence?: string }[] = [];

describe.runIf(process.env["FRAMESHELL_TEST_REAL_CHROME"] === "1")("brand capture in real headless Chrome", () => {
  beforeAll(async () => {
    secret = await secretListener();
    site = http.createServer((request, response) => {
      const path = request.url ?? "/";
      const send = (type: string, body: string | Buffer) => void response.writeHead(200, { "content-type": type }).end(body);
      if (path === "/") return send("text/html", page(secret.port));
      if (path === "/control") return send("text/html", `<!doctype html><script>fetch("http://127.0.0.1:${secret.port}/control", { mode: "no-cors" }).catch(() => {});</script>`);
      if (path === "/empty") return send("text/html", "<!doctype html><title>App</title><body><div id=app></div></body>");
      if (path === "/go-private") return void response.writeHead(302, { location: "http://private.test/" }).end();
      if (path === "/redir-loopback") return void response.writeHead(302, { location: `http://127.0.0.1:${secret.port}/` }).end();
      if (path === "/og.png") return send("image/png", png(40, 200));
      if (path === "/icon.png") return send("image/png", png(16, 30));
      if (path === "/favicon.ico") return send("image/x-icon", Buffer.from([0, 0, 1, 0, 1, 0]));
      if (path === "/logo.svg") return send("image/svg+xml", LOGO_SVG);
      if (path === "/fonts/acme.ttf") return send("font/ttf", sfnt({ name: OFL }));
      if (path === "/fonts/closed.woff") return send("font/woff", woff({ name: CLOSED }));
      response.writeHead(404).end("not found");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    network = fakeNetwork((site.address() as net.AddressInfo).port, { "brand.test": [FAKE_PUBLIC_IP], "private.test": ["10.0.0.9"] });
    options = {
      chrome: () => testBinaryManager().ensure("chrome-headless-shell"),
      credits: async (_root, assets, provenance) => void credited.push({ assets, ...provenance }),
      network: { resolve: network.resolve, dial: network.dial },
      limits: { settleMs: 300, idleMaxMs: 4_000, idleMs: 300 },
    };
  }, 600_000);

  afterAll(async () => {
    site?.closeAllConnections();
    await new Promise<void>((resolve) => site?.close(() => resolve()));
    await secret?.close();
  });

  it(
    "saves sanitised logos, icons, the share image, shots and open fonts, and reaches nothing local",
    async () => {
      const root = tempDir();
      const url = checkCaptureUrl("http://brand.test/");
      if (!url.ok) throw new Error("fixture URL refused");
      const result = await new BrandService(options).capture(root, url.url);
      const { capture } = result;
      expect(capture).toMatchObject({ id: "brand-test", ok: true, reason: null, title: "Acme Rockets | Fly anywhere", finalUrl: "http://brand.test/" });
      const byName = Object.fromEntries(capture.files.map((file) => [file.path.split("/").at(-1), file]));
      expect(Object.keys(byName).sort()).toEqual(["AcmeSans-400.ttf", "hero.png", "icon-1.png", "logo-1.svg", "logo-2.svg", "og.png", "page.png"]);
      expect(byName["hero.png"]).toMatchObject({ role: "hero", width: 3200, height: 2000 });
      const shot = readFileSync(join(root, "assets/brand/brand-test/hero.png"));
      expect([shot.readUInt32BE(16), shot.readUInt32BE(20)]).toEqual([3200, 2000]);
      for (const name of ["logo-1.svg", "logo-2.svg"]) {
        const svg = readFileSync(join(root, "assets/brand/brand-test", name), "utf8");
        expect(svg).not.toMatch(/script|onclick|onload|foreignObject|evil\.test/i);
      }
      expect(readFileSync(join(root, "assets/brand/brand-test/logo-1.svg"), "utf8")).toMatch(/fill="rgb\(255, 90, 31\)"/);
      expect(byName["og.png"]).toMatchObject({ role: "og", width: 40, height: 40, sourceUrl: "http://brand.test/og.png" });
      expect(capture.accent).toBe("#ff5a1f");
      expect(capture.variables["--brand"]).toBe("#ff5a1f");
      expect(capture.headings[0]).toMatchObject({ tag: "h1", family: "Closed Serif", weight: 700, tracking: 0.05, color: "#ff5a1f" });
      expect(capture.buttons[0]).toMatchObject({ text: "Buy now", background: "#ff5a1f" });
      expect(capture.videos).toEqual(["http://brand.test/promo.mp4"]);
      const acme = capture.fonts.find((font) => font.family === "Acme Sans")!;
      expect(acme.faces[0]).toMatchObject({ file: "assets/fonts/AcmeSans-400.ttf", licence: "OFL-1.1" });
      expect(existsSync(join(root, "assets/fonts/AcmeSans-400.ttf"))).toBe(true);
      const closed = capture.fonts.find((font) => font.family === "Closed Serif")!;
      expect(closed.faces[0]).toMatchObject({ file: null, licence: null });
      expect(closed.faces[0]!.note).toMatch(/names no open licence.*All rights reserved/);
      expect(capture.warnings.join("\n")).toMatch(/favicon\.ico was not saved/);
      expect(capture.warnings.join("\n")).toMatch(/refused by the capture proxy/);
      expect(result.style.find((one) => one.path === "colors.accent")?.value).toBe("#ff5a1f");
      expect(result.style.find((one) => one.path === "brand.product")?.value).toBe("Acme Rockets");
      expect(secret.hits()).toBe(0);
      const manifest = parseBrandManifest(JSON.parse(readFileSync(join(root, "brand.json"), "utf8")));
      expect(manifest.ok && manifest.value.captures.map((one) => one.id)).toEqual(["brand-test"]);
      expect(credited.find((entry) => entry.licence === "OFL-1.1")).toMatchObject({ assets: ["assets/fonts/AcmeSans-400.ttf"], sourceUrl: "http://brand.test/fonts/acme.ttf" });
      expect(credited.filter((entry) => !entry.licence).flatMap((entry) => entry.assets).sort()).toHaveLength(6);

      const again = await new BrandService(options).capture(root, url.url);
      expect(again.capture.id).toBe("brand-test-2");
      expect(again.capture.files.find((file) => file.role === "font")?.path).toBe("assets/fonts/AcmeSans-400.ttf");
    },
    600_000,
  );

  it(
    "control: without the loopback rule, the same proxy lets a page reach the loopback listener",
    async () => {
      const proxy = await CaptureProxy.start({ maxBytes: 10_000_000, resolve: network.resolve, dial: network.dial });
      const chrome = await Chrome.launch(await testBinaryManager().ensure("chrome-headless-shell"), guardedChromeFlags(proxy.port).filter((flag) => !flag.includes("<-loopback>")));
      const before = secret.hits();
      try {
        const { targetId } = (await chrome.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
        const { sessionId } = (await chrome.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
        await chrome.send("Page.enable", {}, sessionId);
        await new ChromePage(chrome, sessionId, targetId, () => {}).navigate("http://brand.test/control", 30_000);
        for (let i = 0; i < 50 && secret.hits() === before; i++) await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await chrome.close();
        await proxy.close();
      }
      expect(secret.hits()).toBeGreaterThan(before);
    },
    600_000,
  );

  it(
    "fails honestly on a page with almost no text and nothing to keep",
    async () => {
      const result = await new BrandService(options).capture(tempDir(), new URL("http://brand.test/empty"));
      expect(result.capture).toMatchObject({ ok: false, reason: "little-text" });
      expect(result.capture.warnings.join("\n")).toMatch(/Very little text/);
    },
    600_000,
  );

  it(
    "refuses a page that redirects to a private address",
    async () => {
      const error = await new BrandService(options).capture(tempDir(), new URL("http://brand.test/go-private")).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(ErrorCode.InvalidOperation);
      expect((error as RpcError).data).toMatchObject({ reason: "address" });
      expect((error as RpcError).message).toMatch(/non-public address 10\.0\.0\.9/);
    },
    600_000,
  );
});

describe("brand capture before Chrome starts", () => {
  it("refuses a host that is not public without starting Chrome", async () => {
    const service = new BrandService({
      chrome: async () => {
        throw new Error("Chrome must not start");
      },
      credits: async () => undefined,
      network: { resolve: async () => ["192.168.1.20"] },
    });
    const error = await service.capture(tempDir(), new URL("http://printer.lan/")).catch((caught: unknown) => caught);
    expect((error as RpcError).code).toBe(ErrorCode.InvalidOperation);
    expect((error as RpcError).data).toMatchObject({ op: "brand.capture", reason: "address", field: "url" });
    expect((error as RpcError).message).toMatch(/non-public address 192\.168\.1\.20/);
  });
});
