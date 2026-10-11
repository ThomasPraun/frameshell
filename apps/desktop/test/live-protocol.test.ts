import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { LIVE_BRIDGE, LivePages, injectHead, serveLive } from "../src/main/live-protocol.js";

// Seam under test: the `frameshell-live://` handler (ADR 0010) as Electron's protocol.handle calls it, and the bridge
// script it inserts into live pages.

const ENTRY_HTML = `<!doctype html>\n<html lang="en">\n  <head><title>Card</title></head>\n  <body><script src="app.js"></script></body>\n</html>\n`;
const HEAD = "window.frameshellLive = { ready: Promise.resolve(), seek() {} }; var price = '$&$1$$';";

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-live-")));
  const dir = join(root, "compositions", "hyperframes", "card");
  mkdirSync(join(dir, "fonts"), { recursive: true });
  writeFileSync(join(dir, "index.html"), ENTRY_HTML);
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  writeFileSync(join(dir, "fonts", "Inter Bold.woff2"), Buffer.alloc(100, 7));
  writeFileSync(join(root, "frameshell.json"), "{}");
  const pages = new LivePages();
  const url = pages.issue({ project: root, root: "compositions/hyperframes/card", entry: "compositions/hyperframes/card/index.html", head: HEAD });
  return { root, dir, pages, url, base: url.slice(0, url.lastIndexOf("/") + 1) };
}

const get = (url: string, headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers });

describe("serveLive", () => {
  it("serves the entry with the adapter's head, then the bridge, first in <head>, keeping $ sequences literal", async () => {
    const { pages, url } = project();
    expect(url).toMatch(/^frameshell-live:\/\/[0-9a-f]{24}\/index\.html$/);
    const response = await serveLive(get(url), pages);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toBe(ENTRY_HTML.replace("<head>", () => `<head><script>${HEAD}</script><script>${LIVE_BRIDGE}</script>`));
    expect(html.indexOf(HEAD)).toBeLessThan(html.indexOf("<title>"));
  });

  it("serves the page's other files as they are, with byte ranges, and encoded names", async () => {
    const { pages, base } = project();
    const script = await serveLive(get(`${base}app.js`), pages);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await script.text()).toBe("console.log(1)");
    const font = await serveLive(get(`${base}fonts/Inter%20Bold.woff2`, { Range: "bytes=10-19" }), pages);
    expect(font.status).toBe(206);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(font.headers.get("content-range")).toBe("bytes 10-19/100");
    expect((await serveLive(get(`${base}missing.js`), pages)).status).toBe(404);
  });

  it("serves nothing outside the page's root: no .. and no symlink out of it, even inside the project", async () => {
    const { root, dir, pages, base } = project();
    expect((await serveLive(get(`${base}..%2F..%2F..%2Fframeshell.json`), pages)).status).toBe(403);
    // URL parsing resolves encoded dots before the handler sees them: they stay inside the root.
    expect((await serveLive(get(`${base}%2E%2E/%2E%2E/%2E%2E/frameshell.json`), pages)).status).toBe(404);
    if (process.platform !== "win32") {
      symlinkSync(join(root, "frameshell.json"), join(dir, "escape.json"));
      expect((await serveLive(get(`${base}escape.json`), pages)).status).toBe(403);
      // A root that is itself a symlink leaving the project serves nothing.
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-live-outside-")));
      writeFileSync(join(outside, "index.html"), "<html></html>");
      symlinkSync(outside, join(root, "linked"));
      const linked = pages.issue({ project: root, root: "linked", entry: "linked/index.html", head: HEAD });
      expect((await serveLive(get(linked), pages)).status).toBe(403);
    }
  });

  it("stops serving a revoked page, and every page of a closed project", async () => {
    const { root, pages, url } = project();
    const other = pages.issue({ project: root, root: ".", entry: "frameshell.json", head: HEAD });
    pages.revoke(url);
    expect((await serveLive(get(url), pages)).status).toBe(404);
    expect((await serveLive(get(other), pages)).status).toBe(200);
    pages.revokeProject(root);
    expect((await serveLive(get(other), pages)).status).toBe(404);
  });

  it("refuses a head that would close the <script> it goes in", () => {
    const { root, pages } = project();
    expect(() => pages.issue({ project: root, root: ".", entry: "x.html", head: "var s = '</SCRIPT>';" })).toThrow(/cannot be inserted/);
  });
});

describe("injectHead", () => {
  const scripts = `<script>H</script><script>${LIVE_BRIDGE}</script>`;
  it("goes after <head>, else <html>, else the doctype (standards mode), else first", () => {
    expect(injectHead(`<html><head data-x="1"><title>t</title></head></html>`, "H")).toBe(`<html><head data-x="1">${scripts}<title>t</title></head></html>`);
    expect(injectHead(`<!DOCTYPE html><html lang="en"><body></body></html>`, "H")).toBe(`<!DOCTYPE html><html lang="en">${scripts}<body></body></html>`);
    expect(injectHead(`<!doctype html><div></div>`, "H")).toBe(`<!doctype html>${scripts}<div></div>`);
    expect(injectHead(`<div></div>`, "H")).toBe(`${scripts}<div></div>`);
    // <header> is not <head>.
    expect(injectHead(`<html><body><header></header></body></html>`, "H")).toBe(`<html>${scripts}<body><header></header></body></html>`);
  });
});

describe("live page bridge", () => {
  /** Runs the bridge in a page whose `frameshellLive` is `live`; returns what it posts and a way to message it. */
  function bridge(live: unknown) {
    const posted: Record<string, unknown>[] = [];
    const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
    const parent = { postMessage: (message: Record<string, unknown>) => posted.push({ ...message }) };
    const window = { parent, frameshellLive: live, addEventListener: (_type: string, listener: (typeof listeners)[number]) => listeners.push(listener) };
    runInNewContext(LIVE_BRIDGE, { window, Promise, String });
    const send = (data: unknown, source: unknown = parent) => listeners.forEach((listener) => listener({ source, data }));
    return { posted, send };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("says ready, seeks on the parent's messages and reports each time shown", async () => {
    const seeks: number[] = [];
    const { posted, send } = bridge({ ready: Promise.resolve(), seek: (t: number) => void seeks.push(t) });
    await settle();
    expect(posted).toEqual([{ source: "frameshell-live", ready: true }]);
    send({ source: "frameshell-preview", seek: 1.5 });
    await settle();
    expect(seeks).toEqual([1.5]);
    expect(posted.at(-1)).toEqual({ source: "frameshell-live", shown: 1.5 });
  });

  it("ignores messages from anything but the parent, and malformed ones", async () => {
    const seeks: number[] = [];
    const { send } = bridge({ ready: Promise.resolve(), seek: (t: number) => void seeks.push(t) });
    send({ source: "frameshell-preview", seek: 1 }, {});
    send({ source: "other", seek: 1 });
    send({ source: "frameshell-preview", seek: "1" });
    await settle();
    expect(seeks).toEqual([]);
  });

  it("runs one seek at a time and keeps only the latest request meanwhile", async () => {
    const seeks: number[] = [];
    let finish: () => void = () => {};
    const { send } = bridge({
      ready: Promise.resolve(),
      seek: (t: number) => {
        seeks.push(t);
        return new Promise<void>((resolve) => (finish = resolve));
      },
    });
    send({ source: "frameshell-preview", seek: 1 });
    await settle();
    for (const t of [2, 3, 4]) send({ source: "frameshell-preview", seek: t });
    finish();
    await settle();
    finish();
    await settle();
    expect(seeks).toEqual([1, 4]);
  });

  it("reports a page without frameshellLive, a failed ready and a failed seek as errors", async () => {
    expect(bridge(undefined).posted).toEqual([{ source: "frameshell-live", error: expect.stringContaining("frameshellLive") }]);
    const late = bridge({ ready: Promise.reject(new Error("runtime never loaded")), seek: () => {} });
    await settle();
    expect(late.posted).toEqual([{ source: "frameshell-live", error: "runtime never loaded" }]);
    const broken = bridge({ ready: Promise.resolve(), seek: () => { throw new Error("no timeline"); } });
    broken.send({ source: "frameshell-preview", seek: 1 });
    await settle();
    expect(broken.posted.at(-1)).toEqual({ source: "frameshell-live", error: "no timeline" });
  });
});
