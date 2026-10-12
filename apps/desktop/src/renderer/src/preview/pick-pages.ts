// Pick pages (ADR 0011): live pages of generated clips loaded only to answer the Pick tool's element probes. They sit
// invisible over the frame, are seeked to the paused time and asked what element paints a point; the preview keeps
// showing renders and live frames as before.
import type { ProbedElement } from "@frameshell/protocol";
import type { Size } from "@frameshell/schema/composite";
import { livePage } from "./live-pages.js";
import type { FrameBox } from "./transform-edit.js";

/** Most pick pages open at once: each is a full renderer. The least recently probed one goes first. */
export const PICK_PAGES = 4;
/** A page that does not answer a probe in this long counts as showing nothing there. */
const PROBE_TIMEOUT_MS = 10_000;

/** `source` of the messages to and from a live page's bridge (main's `LIVE_MESSAGE`). */
const TO_PAGE = "frameshell-preview";
const FROM_PAGE = "frameshell-live";

/** A generated clip to probe, at the paused time. */
export interface PickTarget {
  /** Flattened clip id, as `clip.live` addresses it. */
  clip: string;
  /** Render being made or made (its key or file): a new one means a new page. */
  identity: string;
  /** Where the page shows, in fractions of the frame (the project format placed like the render). */
  box: FrameBox;
  /** Composition seconds the page must show. */
  seconds: number;
}

interface Page {
  identity: string;
  host: HTMLDivElement;
  frame: HTMLIFrameElement;
  ready: Promise<void>;
  /** Composition seconds the page shows; null before its first seek. */
  shown: number | null;
  /** Seeks waiting for `shown`. */
  waiting: { seconds: number; resolve: () => void }[];
  probes: Map<number, (elements: ProbedElement[]) => void>;
  settleReady: { resolve: () => void; reject: (error: Error) => void };
}

/** The open pick pages of one preview frame. */
export class PickPages {
  readonly #container: HTMLElement;
  readonly #timeline: string;
  readonly #resolution: Size;
  readonly #view: Window;
  /** By clip, least recently probed first. */
  readonly #pages = new Map<string, Page>();
  #nextProbe = 0;

  /** Pages go into `container` (the preview frame); `timeline` is the one the program plays. */
  constructor(container: HTMLElement, timeline: string, resolution: Size) {
    this.#container = container;
    this.#timeline = timeline;
    this.#resolution = resolution;
    // The page posts to its own parent: the window this frame is drawn in.
    this.#view = container.ownerDocument.defaultView ?? window;
    this.#view.addEventListener("message", this.#onMessage);
  }

  /**
   * The element of `target`'s composition that paints page pixel (`x`, `y`),
   * then up to `depth` ancestors; empty when nothing paints there. Rejects
   * when the clip has no live page (the daemon's message: untrusted
   * project, no adapter, adapter without live preview).
   */
  async probeAt(target: PickTarget, x: number, y: number, depth: number): Promise<ProbedElement[]> {
    return this.#probe(target, { x, y, depth });
  }

  /** Up to `max` elements of `target` that paint at least half inside the page-pixel rectangle, topmost first. */
  async probeRect(target: PickTarget, rect: { x0: number; y0: number; x1: number; y1: number }, max: number): Promise<ProbedElement[]> {
    return this.#probe(target, rect, max);
  }

  /** Close every page. */
  dispose(): void {
    this.#view.removeEventListener("message", this.#onMessage);
    for (const page of this.#pages.values()) this.#close(page);
    this.#pages.clear();
  }

  async #probe(target: PickTarget, where: { x: number; y: number; depth: number } | { x0: number; y0: number; x1: number; y1: number }, max?: number) {
    const page = await this.#page(target);
    await page.ready;
    await this.#seek(page, target.seconds);
    const id = ++this.#nextProbe;
    return new Promise<ProbedElement[]>((resolve) => {
      const timer = this.#view.setTimeout(() => {
        page.probes.delete(id);
        resolve([]);
      }, PROBE_TIMEOUT_MS);
      page.probes.set(id, (elements) => {
        this.#view.clearTimeout(timer);
        resolve(elements);
      });
      const message = "depth" in where ? { probe: { id, ...where } } : { probeRect: { id, ...where, max } };
      page.frame.contentWindow?.postMessage({ source: TO_PAGE, ...message }, "*");
    });
  }

  async #page(target: PickTarget): Promise<Page> {
    const known = this.#pages.get(target.clip);
    if (known && known.identity === target.identity) {
      // Most recently used last.
      this.#pages.delete(target.clip);
      this.#pages.set(target.clip, known);
      this.#place(known, target.box);
      return known;
    }
    if (known) {
      this.#close(known);
      this.#pages.delete(target.clip);
    }
    const url = await livePage(this.#timeline, target.clip, target.identity);
    const page = this.#open(url, target);
    this.#pages.set(target.clip, page);
    while (this.#pages.size > PICK_PAGES) {
      const [oldest, gone] = this.#pages.entries().next().value!;
      this.#close(gone);
      this.#pages.delete(oldest);
    }
    return page;
  }

  #open(url: string, target: PickTarget): Page {
    const document = this.#container.ownerDocument;
    const host = document.createElement("div");
    host.className = "preview-pick-page";
    host.setAttribute("data-testid", "preview-pick-page");
    host.setAttribute("data-clip", target.clip);
    host.setAttribute("aria-hidden", "true");
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("allow", "autoplay 'none'");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.tabIndex = -1;
    frame.width = String(this.#resolution.width);
    frame.height = String(this.#resolution.height);
    frame.src = url;
    host.append(frame);
    this.#container.append(host);
    let settleReady!: Page["settleReady"];
    const ready = new Promise<void>((resolve, reject) => (settleReady = { resolve, reject }));
    // Nobody may await it yet: an unawaited failure is not an error.
    ready.catch(() => undefined);
    const page: Page = { identity: target.identity, host, frame, ready, shown: null, waiting: [], probes: new Map(), settleReady };
    this.#place(page, target.box);
    return page;
  }

  /** Lay the page over the frame where the clip's picture is, as the live preview does. */
  #place(page: Page, box: FrameBox): void {
    const percent = (value: number) => `${value * 100}%`;
    Object.assign(page.host.style, { left: percent(box.left), top: percent(box.top), width: percent(box.width), height: percent(box.height) });
    const scale = page.host.clientWidth / this.#resolution.width || 0;
    page.frame.style.transform = `scale(${scale})`;
  }

  #seek(page: Page, seconds: number): Promise<void> {
    if (page.shown !== null && Math.abs(page.shown - seconds) < 1e-6) return Promise.resolve();
    return new Promise((resolve) => {
      page.waiting.push({ seconds, resolve });
      page.frame.contentWindow?.postMessage({ source: TO_PAGE, seek: seconds }, "*");
    });
  }

  #close(page: Page): void {
    page.settleReady.reject(new Error("The pick page was closed"));
    for (const answer of page.probes.values()) answer([]);
    for (const wait of page.waiting) wait.resolve();
    page.host.remove();
  }

  readonly #onMessage = (event: MessageEvent): void => {
    const data = event.data as { source?: unknown; ready?: unknown; shown?: unknown; error?: unknown; probe?: { id?: unknown; elements?: unknown } } | null;
    if (!data || data.source !== FROM_PAGE) return;
    const page = [...this.#pages.values()].find((candidate) => candidate.frame.contentWindow === event.source);
    if (!page) return;
    if (data.ready === true) page.settleReady.resolve();
    else if (typeof data.shown === "number") {
      const shown = data.shown;
      page.shown = shown;
      const done = page.waiting.filter((wait) => Math.abs(wait.seconds - shown) < 1e-6);
      page.waiting = page.waiting.filter((wait) => !done.includes(wait));
      for (const wait of done) wait.resolve();
    } else if (data.probe && typeof data.probe.id === "number") {
      const answer = page.probes.get(data.probe.id);
      page.probes.delete(data.probe.id);
      answer?.(Array.isArray(data.probe.elements) ? (data.probe.elements as ProbedElement[]) : []);
    } else if (typeof data.error === "string") {
      page.settleReady.reject(new Error(data.error));
      // A seek that failed shows nothing new: let waiters go on with what is there.
      for (const wait of page.waiting) wait.resolve();
      page.waiting = [];
    }
  };
}
