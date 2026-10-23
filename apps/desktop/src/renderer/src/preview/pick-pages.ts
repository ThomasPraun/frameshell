// Pick pages (ADR 0011): live pages of generated clips loaded to answer element probes, for the Pick tool and element
// mode (ADR 0021). They sit invisible over the frame, are seeked to the paused time and asked what element paints a
// point; the preview keeps showing renders and live frames as before. Element mode also swaps a page's element sheet
// and shows the page while a drag lasts.
import type { MovableElement, ProbedElement } from "@frameshell/protocol";
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

/** What a page's bridge answers a probe: the elements, and for `probeMovable`/`probeSelector` the element's unit. */
interface ProbeAnswer {
  elements: ProbedElement[];
  unit?: number;
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
  probes: Map<number, (answer: ProbeAnswer) => void>;
  /** `elements` requests waiting for their match counts. */
  restyles: Map<number, (counts: Record<string, number>) => void>;
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
    return (await this.#probe(target, { probe: { x, y, depth } })).elements;
  }

  /** Up to `max` elements of `target` that paint at least half inside the page-pixel rectangle, topmost first. */
  async probeRect(target: PickTarget, rect: { x0: number; y0: number; x1: number; y1: number }, max: number): Promise<ProbedElement[]> {
    return (await this.#probe(target, { probeRect: { ...rect, max } })).elements;
  }

  /**
   * The element an adjustment moves for page pixel (`x`, `y`) (ADR 0021): the
   * one painting there, stepped up from an inline box, then `depth`
   * ancestors; null when nothing paints there. Rejects as {@link probeAt}.
   */
  async movableAt(target: PickTarget, x: number, y: number, depth: number): Promise<MovableElement | null> {
    return movable(await this.#probe(target, { probeMovable: { x, y, depth } }));
  }

  /** The first element of `target` matching `selector`; null when none does. Rejects as {@link probeAt}. */
  async elementOf(target: PickTarget, selector: string): Promise<MovableElement | null> {
    return movable(await this.#probe(target, { probeSelector: { selector } }));
  }

  /**
   * Swap `target`'s element sheet for `css` (undefined keeps it, "" clears it)
   * and count, at the target's time, how many elements each of `selectors`
   * matches; empty when the page does not answer in time. Rejects as {@link probeAt}.
   */
  async restyle(target: PickTarget, css: string | undefined, selectors: readonly string[]): Promise<Record<string, number>> {
    const page = await this.#page(target);
    await page.ready;
    await this.#seek(page, target.seconds);
    const id = ++this.#nextProbe;
    return new Promise((resolve) => {
      const timer = this.#view.setTimeout(() => {
        page.restyles.delete(id);
        resolve({});
      }, PROBE_TIMEOUT_MS);
      page.restyles.set(id, (counts) => {
        this.#view.clearTimeout(timer);
        resolve(counts);
      });
      page.frame.contentWindow?.postMessage({ source: TO_PAGE, elements: { id, css, selectors } }, "*");
    });
  }

  /** Swap the element sheet of `clip`'s open page now, unanswered: once per pointer move of a drag. */
  sheet(clip: string, css: string): void {
    const page = this.#pages.get(clip);
    page?.frame.contentWindow?.postMessage({ source: TO_PAGE, elements: { id: ++this.#nextProbe, css } }, "*");
  }

  /** Show `clip`'s open page at `opacity` over the picture, where its render would be; null hides it again. */
  show(clip: string, opacity: number | null): void {
    const page = this.#pages.get(clip);
    if (!page) return;
    page.host.classList.toggle("is-shown", opacity !== null);
    page.host.style.opacity = opacity === null ? "" : String(opacity);
  }

  /** Close every page. */
  dispose(): void {
    this.#view.removeEventListener("message", this.#onMessage);
    for (const page of this.#pages.values()) this.#close(page);
    this.#pages.clear();
  }

  /** Send one probe request (`{ kind: fields }`, the bridge's message without its id) and wait for its answer. */
  async #probe(target: PickTarget, request: Record<string, Record<string, unknown>>): Promise<ProbeAnswer> {
    const page = await this.#page(target);
    await page.ready;
    await this.#seek(page, target.seconds);
    const id = ++this.#nextProbe;
    return new Promise<ProbeAnswer>((resolve) => {
      const timer = this.#view.setTimeout(() => {
        page.probes.delete(id);
        resolve({ elements: [] });
      }, PROBE_TIMEOUT_MS);
      page.probes.set(id, (answer) => {
        this.#view.clearTimeout(timer);
        resolve(answer);
      });
      const [kind, fields] = Object.entries(request)[0]!;
      page.frame.contentWindow?.postMessage({ source: TO_PAGE, [kind]: { id, ...fields } }, "*");
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
    const page: Page = { identity: target.identity, host, frame, ready, shown: null, waiting: [], probes: new Map(), restyles: new Map(), settleReady };
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
    for (const answer of page.probes.values()) answer({ elements: [] });
    for (const answer of page.restyles.values()) answer({});
    for (const wait of page.waiting) wait.resolve();
    page.host.remove();
  }

  readonly #onMessage = (event: MessageEvent): void => {
    const data = event.data as {
      source?: unknown;
      ready?: unknown;
      shown?: unknown;
      error?: unknown;
      probe?: { id?: unknown; elements?: unknown; unit?: unknown };
      elements?: { id?: unknown; counts?: unknown };
    } | null;
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
      const elements = Array.isArray(data.probe.elements) ? (data.probe.elements as ProbedElement[]) : [];
      answer?.({ elements, ...(typeof data.probe.unit === "number" ? { unit: data.probe.unit } : {}) });
    } else if (data.elements && typeof data.elements.id === "number") {
      const answer = page.restyles.get(data.elements.id);
      page.restyles.delete(data.elements.id);
      const counts = data.elements.counts;
      answer?.(counts && typeof counts === "object" ? (counts as Record<string, number>) : {});
    } else if (typeof data.error === "string") {
      page.settleReady.reject(new Error(data.error));
      // A seek that failed shows nothing new: let waiters go on with what is there.
      for (const wait of page.waiting) wait.resolve();
      page.waiting = [];
    }
  };
}

/** The movable element of a `probeMovable` or `probeSelector` answer; null when the page found none. */
function movable(answer: ProbeAnswer): MovableElement | null {
  const element = answer.elements[0];
  const unit = answer.unit;
  return element ? { element, unit: typeof unit === "number" && Number.isFinite(unit) && unit > 0 ? unit : 1 } : null;
}
