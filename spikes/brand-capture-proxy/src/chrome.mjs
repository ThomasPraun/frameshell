// Launches the pinned chrome-headless-shell with CDP over --remote-debugging-pipe (same transport as
// packages/core/src/inspect/chrome.ts) and the flag sets under test.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL("../../..", import.meta.url).pathname;
export const CHROME =
  process.env.FRAMESHELL_CHROME ??
  join(process.env.FRAMESHELL_TEST_BINARIES_DIR ?? join(here, ".cache/test-binaries"), "binaries/chrome-headless-shell/154.0.8037.57", `${process.platform}-${process.arch}`, "chrome-headless-shell");

/** The flags that force every request of the page through the guarded proxy. This is the set to pin. */
export function guardedFlags(proxyPort) {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    "--proxy-bypass-list=<-loopback>", // Chrome never proxies localhost, 127.0.0.0/8 and [::1] unless this implicit rule is removed
    "--disable-quic", // no UDP to origins; an HTTP proxy cannot carry QUIC
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", // WebRTC may only use UDP through a proxy, so none
  ];
}

/** Flags that keep a throwaway profile quiet. Not security flags; kept apart so the tests can tell them from the guard. */
export const QUIET_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-domain-reliability",
  "--no-pings",
];

export class Chrome {
  #child;
  #profile;
  #pending = new Map();
  #listeners = new Set();
  #next = 0;
  #buffer = Buffer.alloc(0);
  pid;

  static async launch(flags = [], { quiet = true } = {}) {
    const profile = mkdtempSync(join(tmpdir(), "brand-proxy-spike-"));
    const args = ["--remote-debugging-pipe", `--user-data-dir=${profile}`, ...(quiet ? QUIET_FLAGS : []), ...flags, ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"];
    const child = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const chrome = new Chrome();
    chrome.#child = child;
    chrome.#profile = profile;
    chrome.pid = child.pid;
    child.stdio[4].on("data", (chunk) => chrome.#receive(chunk));
    child.stderr.on("data", () => {});
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return chrome;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** A blank page with Runtime/Page/Network enabled; returns helpers bound to its session. */
  async page() {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    for (const domain of ["Page", "Runtime", "Network"]) await this.send(`${domain}.enable`, {}, sessionId);
    const events = [];
    this.on((method, params, session) => session === sessionId && events.push({ method, params }));
    return {
      sessionId,
      events,
      send: (method, params) => this.send(method, params, sessionId),
      /** Navigate and wait for load (or the error text). */
      navigate: async (url, timeoutMs = 15_000) => {
        const loaded = new Promise((resolve) => {
          const off = this.on((method, _p, session) => {
            if (session === sessionId && method === "Page.loadEventFired") {
              off();
              resolve("loaded");
            }
          });
          setTimeout(() => (off(), resolve("timeout")), timeoutMs);
        });
        const result = await this.send("Page.navigate", { url }, sessionId);
        if (result.errorText) return result.errorText;
        return loaded;
      },
      evaluate: async (expression, timeoutMs = 20_000) => {
        const result = await Promise.race([
          this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
          new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate timeout")), timeoutMs)),
        ]);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? result.exceptionDetails.text);
        return result.result.value;
      },
    };
  }

  async close() {
    this.#child.kill();
    await new Promise((resolve) => (this.#child.exitCode !== null ? resolve() : (this.#child.once("exit", resolve), setTimeout(resolve, 3000))));
    rmSync(this.#profile, { recursive: true, force: true });
  }

  #receive(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (let end = this.#buffer.indexOf(0); end >= 0; end = this.#buffer.indexOf(0)) {
      const text = this.#buffer.subarray(0, end).toString("utf8");
      this.#buffer = this.#buffer.subarray(end + 1);
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.#listeners) listener(message.method, message.params ?? {}, message.sessionId);
      }
    }
  }
}

