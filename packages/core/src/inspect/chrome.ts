// A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe` (ADR 0011): enough to load a live page
// in managed headless Chrome, serve its files from the project and evaluate scripts in it. No dependency: the
// protocol is JSON messages separated by NUL bytes on file descriptors 3 (to Chrome) and 4 (from Chrome).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** A paused request of the page, as `Fetch.requestPaused` reports it. */
export interface PausedRequest {
  url: string;
  method: string;
}

/** What to answer a paused request with: a body and its type, or a status alone; null lets it go to the network. */
export type Served = { status: number; contentType?: string; body?: Buffer } | null;

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/** One headless Chrome, killed with {@link Chrome.close}. */
export class Chrome {
  readonly #process: ChildProcess;
  readonly #input: Writable;
  readonly #profile: string;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(method: string, params: Record<string, unknown>, session: string | undefined) => void>();
  #next = 0;
  #buffer = Buffer.alloc(0);
  #exited: Error | null = null;

  private constructor(child: ChildProcess, profile: string) {
    this.#process = child;
    this.#profile = profile;
    this.#input = child.stdio[3] as Writable;
    const output = child.stdio[4] as Readable;
    output.on("data", (chunk: Buffer) => this.#receive(chunk));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("exit", (code, signal) => {
      this.#exited = new Error(`headless Chrome exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
      for (const pending of this.#pending.values()) pending.reject(this.#exited);
      this.#pending.clear();
    });
  }

  /**
   * Start `executable` (managed `chrome-headless-shell`) with a fresh
   * profile. On Linux the sandbox is off, as renders run it: CI runners and
   * containers forbid the user namespaces it needs.
   */
  static async launch(executable: string): Promise<Chrome> {
    const profile = await mkdtemp(join(tmpdir(), "frameshell-inspect-"));
    const args = [
      "--remote-debugging-pipe",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--force-color-profile=srgb",
      `--user-data-dir=${profile}`,
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      "about:blank",
    ];
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    const chrome = new Chrome(child, profile);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return chrome;
  }

  /** Send `method`, on target session `session` when given; resolves with its result, rejects with its error. */
  send(method: string, params: Record<string, unknown> = {}, session?: string): Promise<Record<string, unknown>> {
    if (this.#exited) return Promise.reject(this.#exited);
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#input.write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`);
    });
  }

  /** Called with every event; returns an unsubscribe function. */
  on(listener: (method: string, params: Record<string, unknown>, session: string | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A new page of `width` x `height` CSS pixels whose requests to `origin`
   * are answered by `serve` (every other request goes to the network).
   */
  async page(width: number, height: number, origin: string, serve: (request: PausedRequest) => Promise<Served>): Promise<ChromePage> {
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const off = this.on((method, params, session) => {
      if (session !== sessionId || method !== "Fetch.requestPaused") return;
      const { requestId, request } = params as { requestId: string; request: PausedRequest };
      void (async () => {
        try {
          const served = await serve(request);
          if (!served) await this.send("Fetch.continueRequest", { requestId }, sessionId);
          else {
            await this.send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: served.status,
                responseHeaders: [
                  ...(served.contentType ? [{ name: "Content-Type", value: served.contentType }] : []),
                  { name: "Cache-Control", value: "no-store" },
                  { name: "Access-Control-Allow-Origin", value: "*" },
                ],
                body: (served.body ?? Buffer.alloc(0)).toString("base64"),
              },
              sessionId,
            );
          }
        } catch {
          await this.send("Fetch.failRequest", { requestId, errorReason: "Failed" }, sessionId).catch(() => undefined);
        }
      })();
    });
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*`, requestStage: "Request" }] }, sessionId);
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    return new ChromePage(this, sessionId, targetId, off);
  }

  /** Kill Chrome and delete its profile. */
  async close(): Promise<void> {
    if (!this.#exited) {
      const exited = new Promise((resolve) => this.#process.once("exit", resolve));
      this.#process.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    await rm(this.#profile, { recursive: true, force: true }).catch(() => undefined);
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (let end = this.#buffer.indexOf(0); end >= 0; end = this.#buffer.indexOf(0)) {
      const text = this.#buffer.subarray(0, end).toString("utf8");
      this.#buffer = this.#buffer.subarray(end + 1);
      let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message: string }; sessionId?: string };
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

/** One page of a {@link Chrome}. */
export class ChromePage {
  readonly #chrome: Chrome;
  readonly #session: string;
  readonly #target: string;
  readonly #off: () => void;

  constructor(chrome: Chrome, session: string, target: string, off: () => void) {
    this.#chrome = chrome;
    this.#session = session;
    this.#target = target;
    this.#off = off;
  }

  /** Load `url` and wait for its `load` event, at most `timeoutMs`. */
  async navigate(url: string, timeoutMs: number): Promise<void> {
    let off = () => {};
    const loaded = new Promise<void>((resolve) => {
      off = this.#chrome.on((method, _params, session) => {
        if (session === this.#session && method === "Page.loadEventFired") resolve();
      });
    });
    try {
      const result = (await this.#chrome.send("Page.navigate", { url }, this.#session)) as { errorText?: string };
      if (result.errorText) throw new Error(`could not load the live page: ${result.errorText}`);
      await withTimeout(loaded, timeoutMs, "the live page did not finish loading");
    } finally {
      off();
    }
  }

  /** Evaluate `expression` (awaiting a promise it returns), its value as JSON; rejects with the page's exception. */
  async evaluate<T>(expression: string, timeoutMs: number): Promise<T> {
    const result = (await withTimeout(
      this.#chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.#session),
      timeoutMs,
      "the live page did not answer",
    )) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description?.split("\n")[0] ?? result.exceptionDetails.text ?? "script error");
    }
    return result.result?.value as T;
  }

  /** Close the page. */
  async close(): Promise<void> {
    this.#off();
    await this.#chrome.send("Target.closeTarget", { targetId: this.#target }).catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${message} in ${ms / 1000} s`)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
