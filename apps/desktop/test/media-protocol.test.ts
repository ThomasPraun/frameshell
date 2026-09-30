import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MediaRoots, serveMedia } from "../src/main/media-protocol.js";

// Seam under test: the `frameshell-media://` handler (SPEC §3.2) as Electron's protocol.handle calls it, Request in, Response out.

const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

function project(): { root: string; roots: MediaRoots; base: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frameshell-media-")));
  mkdirSync(join(root, ".frameshell", "proxies"), { recursive: true });
  mkdirSync(join(root, ".frameshell", "history"), { recursive: true });
  writeFileSync(join(root, ".frameshell", "proxies", "abc.mp4"), BYTES);
  writeFileSync(join(root, ".frameshell", "proxies", "abc.pcm"), BYTES);
  writeFileSync(join(root, ".frameshell", "history", "main.jsonl"), "{}");
  writeFileSync(join(root, "frameshell.json"), "{}");
  const roots = new MediaRoots();
  return { root, roots, base: roots.issue(root) };
}

const get = (url: string, headers: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers });

describe("serveMedia", () => {
  it("serves a proxy whole, with its type and length, and says ranges work", async () => {
    const { roots, base } = project();
    const response = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`), roots);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("answers a byte range with 206 and exactly those bytes", async () => {
    const { roots, base } = project();
    const response = await serveMedia(get(`${base}.frameshell/proxies/abc.pcm`, { Range: "bytes=100-199" }), roots);
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES.subarray(100, 200));
  });

  it("clamps an open or overlong range to the end of the file, and serves a suffix range", async () => {
    const { roots, base } = project();
    const open = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, { Range: "bytes=990-" }), roots);
    expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(Buffer.from(await open.arrayBuffer())).toEqual(BYTES.subarray(990));
    const long = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, { Range: "bytes=995-5000" }), roots);
    expect(long.headers.get("content-range")).toBe("bytes 995-999/1000");
    const suffix = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, { Range: "bytes=-10" }), roots);
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(BYTES.subarray(990));
  });

  it("refuses a range past the end with 416 and the file size", async () => {
    const { roots, base } = project();
    const response = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, { Range: "bytes=1000-1001" }), roots);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
  });

  it("serves only derived preview media: project files, other daemon state and escapes are forbidden", async () => {
    const { root, roots, base } = project();
    symlinkSync(join(root, "frameshell.json"), join(root, ".frameshell", "proxies", "link.mp4"));
    for (const path of [
      "frameshell.json",
      ".frameshell/history/main.jsonl",
      ".frameshell/proxies/../history/main.jsonl",
      ".frameshell/proxies/%2e%2e/history/main.jsonl",
      ".frameshell/proxies/link.mp4",
    ]) {
      const response = await serveMedia(get(`${base}${path}`), roots);
      expect(response.status, path).toBe(403);
    }
  });

  it("answers 404 for a missing proxy and for a project that is no longer open", async () => {
    const { roots, base } = project();
    expect((await serveMedia(get(`${base}.frameshell/proxies/nope.mp4`), roots)).status).toBe(404);
    roots.revoke(base);
    expect((await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`), roots)).status).toBe(404);
  });

  it("lets the renderer's workers read cross-origin: CORS headers and preflight", async () => {
    const { roots, base } = project();
    const response = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, { Range: "bytes=0-9" }), roots);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-expose-headers")).toContain("Content-Range");
    const preflight = await serveMedia(get(`${base}.frameshell/proxies/abc.mp4`, {}, "OPTIONS"), roots);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Range");
  });

  it("issues a distinct base URL per open project", () => {
    const roots = new MediaRoots();
    const a = roots.issue("/tmp/a");
    const b = roots.issue("/tmp/b");
    expect(a).toMatch(/^frameshell-media:\/\/[0-9a-f]{16,}\/$/);
    expect(b).not.toBe(a);
  });
});
