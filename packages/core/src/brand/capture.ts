// `brand.capture` (ADR 0044): open a public page in managed headless Chrome behind the capture proxy, measure its
// brand (logos, icons, share image, colours, fonts, :root variables, headings, buttons) in an isolated world, take
// the first screen and the whole page, and save what it found under assets/brand/<id>/ and assets/fonts/ with a
// `brand.json` entry and a credits entry per file. It never writes `style.json`: it returns `style set` suggestions.
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { ErrorCode, type MethodResult, RpcError } from "@frameshell/protocol";
import {
  BRAND_DIR,
  BRAND_FILE,
  type BrandCapture,
  type BrandImport,
  type BrandManifest,
  MAX_SOURCE_URL,
  createBrandManifest,
  parseBrandManifest,
} from "@frameshell/schema";
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from "../fs-util.js";
import { Chrome, ChromePage } from "../inspect/chrome.js";
import { pickAccent, rankColors, suggestStyle } from "./findings.js";
import { fitFrames, readFigmaFolder } from "./figma.js";
import { type DeclaredFace, bestSource, faceFor, firstFamily, fontExtension, isGenericFamily, isIconFamily, parseFontFaces, readFontNames } from "./fonts.js";
import { PAGE_SCRIPT, type PageFindings } from "./page-script.js";
import { CAPTURE_PORTS } from "./policy.js";
import { CaptureProxy, type Dial, PROXY_REFUSAL_HEADER, type Resolve, fetchThrough } from "./proxy.js";
import { LOGO_IMAGE_CHARS, sanitizeSvg, svgProblems } from "./svg.js";

/** Limits of one capture (ADR 0044 decision 8): starting points, not measured. */
export const CAPTURE_LIMITS = {
  /** Wall clock for the whole capture; Chrome is killed past it. */
  seconds: 120,
  /** Bytes through the proxy, page and fetched files together. */
  bytes: 150 * 1024 * 1024,
  /** Pages taller than this (CSS px) get no full-page shot. */
  pageHeight: 16_384,
  /** Viewport, CSS px, and device pixel ratio of the capture. */
  width: 1600,
  height: 1000,
  scale: 2,
  /** Quiet network this long counts as idle; waiting for it stops after `idleMaxMs`. */
  idleMs: 500,
  idleMaxMs: 15_000,
  /** Extra wait after the network is idle, for animations and late scripts. */
  settleMs: 2_500,
  /** Scroll step to wake lazy content, CSS px. */
  scrollStep: 700,
  /** Largest single file fetched (logo, icon, share image, font). */
  fileBytes: 20 * 1024 * 1024,
  /** Most font faces fetched to read their licence. */
  fontFaces: 12,
  /** Under this many characters of text, with no logo, icon, share image or font, the capture failed. */
  littleText: 200,
} as const;

/** Capture limits; tests shorten the waits. */
export type CaptureLimits = { -readonly [K in keyof typeof CAPTURE_LIMITS]: number };

/**
 * Flags that send every request of capture Chrome through the proxy (measured in
 * docs/research/brand-capture-proxy.md). Re-run that spike's UDP table on every Chrome pin bump.
 */
export function guardedChromeFlags(proxyPort: number): string[] {
  return [
    `--proxy-server=http://127.0.0.1:${proxyPort}`,
    // Chrome sends localhost, 127.0.0.0/8 and [::1] around any proxy unless this implicit rule is removed.
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    // WebRTC may use UDP only through a proxy, so none: without it a page sent STUN to 127.0.0.1.
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}

/** Flags that keep the throwaway profile quiet; not part of the guard. */
const QUIET_FLAGS = ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--disable-domain-reliability", "--no-pings"];

/** Options of {@link BrandService}. */
export interface BrandServiceOptions {
  /** Path of managed `chrome-headless-shell` for the project. */
  chrome(root: string): Promise<string>;
  /** Record provenance of files under `assets/` (`CreditsService.record`). */
  credits(root: string, assets: string[], provenance: { sourceUrl?: string; licence?: string; author?: string; title?: string }): Promise<unknown>;
  /** Tests only: fake DNS and dial for the proxy, so a local fixture site stands for a public one. */
  network?: { resolve?: Resolve; dial?: Dial };
  /** Tests only: shorter waits. */
  limits?: Partial<CaptureLimits>;
}

/** Hooks of one capture run. */
export interface CaptureHooks {
  signal?: AbortSignal;
  progress?: (fraction: number) => void;
  stage?: (message: string) => void;
}

/** One file to write, before it has a path. */
interface Pending {
  name: string;
  role: BrandCapture["files"][number]["role"];
  kind: BrandCapture["files"][number]["kind"];
  sourceUrl: string;
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/** Largest SVG file a capture saves: a logo or icon, not a drawing. */
const MAX_SVG_BYTES = 2 * 1024 * 1024;

/** Sanitiser limits of a fetched logo or icon. */
const SVG_FILE_LIMITS = { imageChars: LOGO_IMAGE_CHARS, elements: 20_000, depth: 100 };

const RASTER = [
  { ext: "png", test: (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: "jpg", test: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", test: (b: Uint8Array) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { ext: "webp", test: (b: Uint8Array) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
] as const;

/** Captures brands and imports Figma frames into projects; the only writer of `brand.json`. */
export class BrandService {
  readonly #options: BrandServiceOptions;
  readonly #limits: CaptureLimits;
  /** Last manifest change of each project: the next one waits for it. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: BrandServiceOptions) {
    this.#options = options;
    this.#limits = { ...CAPTURE_LIMITS, ...options.limits };
  }

  /**
   * Capture `url` (already checked by `checkCaptureUrl`) into project `root`. Throws InvalidOperation with reason
   * `address` when the host is not public, `load` when the page did not load, `timeout` past the time limit.
   */
  async capture(root: string, url: URL, hooks: CaptureHooks = {}): Promise<MethodResult<"brand.capture">> {
    const limits = this.#limits;
    const invalid = (reason: string, message: string) => new RpcError(ErrorCode.InvalidOperation, `brand.capture: ${message}`, { op: "brand.capture", reason, field: "url" });
    const proxy = await CaptureProxy.start({ maxBytes: limits.bytes, ...(this.#options.network ?? {}) });
    const deadline = Date.now() + limits.seconds * 1000;
    // Set once the project write starts: from then a timeout or cancel waits for it, so the answer matches the disk.
    const commit = { started: false };
    let chrome: Chrome | null = null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(invalid("timeout", `${url.href} was not captured within ${limits.seconds} s`)), limits.seconds * 1000);
    const cancel = () => stop.abort(new Error("brand.capture: canceled"));
    hooks.signal?.addEventListener("abort", cancel);
    const aborted = new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason)));
    aborted.catch(() => {});
    if (hooks.signal?.aborted) cancel();
    try {
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const first = await proxy.check(url.hostname, port);
      if (!first.ok) throw invalid("address", `${url.host} cannot be captured: ${first.reason}. Capture reaches public addresses on ports ${CAPTURE_PORTS.join(" and ")} only; for a local or staging page, use a screenshot.`);
      const work = (async () => {
        const launched = await Chrome.launch(await this.#options.chrome(root), [...guardedChromeFlags(proxy.port), ...QUIET_FLAGS]);
        // Stopped while Chrome was starting: `finally` below already ran without it, so close it here.
        if (stop.signal.aborted) {
          await launched.close();
          throw stop.signal.reason;
        }
        chrome = launched;
        return this.#run(root, url, launched, proxy, { signal: stop.signal, deadline, commit }, hooks, invalid);
      })();
      work.catch(() => {});
      return await Promise.race([work, aborted.catch((error: unknown) => (commit.started ? work : Promise.reject(error)))]);
    } finally {
      clearTimeout(timer);
      hooks.signal?.removeEventListener("abort", cancel);
      await (chrome as Chrome | null)?.close();
      await proxy.close();
    }
  }

  async #run(
    root: string,
    url: URL,
    chrome: Chrome,
    proxy: CaptureProxy,
    { signal, deadline, commit }: { signal: AbortSignal; deadline: number; commit: { started: boolean } },
    hooks: CaptureHooks,
    invalid: (reason: string, message: string) => RpcError,
  ): Promise<MethodResult<"brand.capture">> {
    const limits = this.#limits;
    const live = () => {
      if (signal.aborted) throw signal.reason;
    };
    const stage = (message: string, fraction: number) => {
      hooks.stage?.(message);
      hooks.progress?.(fraction);
    };
    const warnings: string[] = [];
    stage(`loading ${url.href}`, 0.05);
    const { targetId } = (await chrome.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await chrome.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    const inflight = new Set<string>();
    const sheets: { id: string; url: string }[] = [];
    let mainFrame = "";
    let document: { status: number; refused: boolean; url: string } | null = null;
    const off = chrome.on((method, params, session) => {
      if (session !== sessionId) return;
      if (method === "Network.requestWillBeSent") inflight.add(params["requestId"] as string);
      else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") inflight.delete(params["requestId"] as string);
      else if (method === "Network.responseReceived" && params["type"] === "Document" && params["frameId"] === mainFrame) {
        const response = params["response"] as { status: number; url: string; headers: Record<string, string> };
        const refused = Object.keys(response.headers).some((name) => name.toLowerCase() === PROXY_REFUSAL_HEADER);
        document = { status: response.status, refused, url: response.url };
      } else if (method === "CSS.styleSheetAdded") {
        const header = params["header"] as { styleSheetId: string; sourceURL?: string };
        sheets.push({ id: header.styleSheetId, url: header.sourceURL ?? "" });
      }
    });
    try {
      for (const domain of ["Page", "Runtime", "Network", "DOM", "CSS"]) await chrome.send(`${domain}.enable`, {}, sessionId);
      const tree = (await chrome.send("Page.getFrameTree", {}, sessionId)) as { frameTree: { frame: { id: string } } };
      mainFrame = tree.frameTree.frame.id;
      await chrome.send("Emulation.setDeviceMetricsOverride", { width: limits.width, height: limits.height, deviceScaleFactor: limits.scale, mobile: false }, sessionId);
      const page = new ChromePage(chrome, sessionId, targetId, () => {});
      const refusals = () => proxy.events.filter((event) => !event.allowed).map((event) => `${event.host}:${event.port} (${event.reason})`);
      try {
        await page.navigate(url.href, limits.seconds * 1000);
      } catch (error) {
        const refused = refusals();
        const message = (error as Error).message.replace("could not load the live page", "the page did not load").replace("the live page", "the page");
        throw invalid(refused.length > 0 ? "address" : "load", `${message}${refused.length > 0 ? `; refused by the capture proxy: ${refused.slice(0, 3).join(", ")}` : ""}`);
      }
      const loaded = document as { status: number; refused: boolean; url: string } | null;
      if (loaded?.refused) {
        throw invalid("address", `the page redirected where capture may not go; refused by the capture proxy: ${refusals().slice(-3).join(", ")}`);
      }
      if (loaded && loaded.status >= 400) warnings.push(`The page answered HTTP ${loaded.status}: what was captured may be an error page.`);
      live();
      const waitIdle = async () => {
        const start = Date.now();
        let quietSince: number | null = null;
        while (Date.now() - start < limits.idleMaxMs) {
          live();
          if (inflight.size === 0) {
            quietSince ??= Date.now();
            if (Date.now() - quietSince >= limits.idleMs) return;
          } else quietSince = null;
          await sleep(100);
        }
      };
      await waitIdle();
      await sleep(limits.settleMs);
      live();
      const { frameTree } = (await chrome.send("Page.getFrameTree", {}, sessionId)) as { frameTree: { frame: { id: string; url: string } } };
      const finalUrl = /^https?:/.test(frameTree.frame.url) && frameTree.frame.url.length <= MAX_SOURCE_URL ? frameTree.frame.url : url.href;
      const world = (await chrome.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "frameshell-brand" }, sessionId)) as { executionContextId: number };
      const evaluate = <T>(expression: string) => page.evaluate<T>(expression, 30_000, world.executionContextId);
      await evaluate(PAGE_SCRIPT);

      stage("scrolling to load lazy content", 0.25);
      const height = await evaluate<number>("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)");
      for (let y = limits.scrollStep; y < Math.min(height, limits.pageHeight); y += limits.scrollStep) {
        live();
        await evaluate(`scrollTo(0, ${y})`);
        await sleep(120);
      }
      await evaluate("scrollTo(0, 0)");
      await waitIdle();
      await sleep(300);

      stage("measuring colours, fonts and logos", 0.4);
      const hero = await screenshot(chrome, sessionId, null);
      const found = await evaluate<PageFindings>("__frameshellBrand.measure()");
      let full: Buffer | null = null;
      if (found.scrollHeight <= limits.pageHeight) {
        await evaluate("__frameshellBrand.flatten()");
        full = await screenshot(chrome, sessionId, { width: limits.width, height: found.scrollHeight, scale: 1 / limits.scale });
      } else warnings.push(`The page is ${found.scrollHeight} px tall, over ${limits.pageHeight}: no full-page shot.`);
      const declared: DeclaredFace[] = [];
      for (const sheet of sheets) {
        const text = await chrome.send("CSS.getStyleSheetText", { styleSheetId: sheet.id }, sessionId).catch(() => null);
        if (text) declared.push(...parseFontFaces((text as { text: string }).text, /^https?:/.test(sheet.url) ? sheet.url : finalUrl));
      }

      stage("fetching logos, icons and fonts", 0.55);
      // Fetches stop a tenth of the time limit (at most 10 s) before it, so what was found is still saved.
      const fetchEnd = deadline - Math.min(10_000, limits.seconds * 100);
      const fetchFile = async (target: string) => {
        live();
        const left = fetchEnd - Date.now();
        if (left <= 0) throw new Error(`no time left to fetch it within the ${limits.seconds} s limit`);
        const file = await fetchThrough(proxy, target, { maxBytes: limits.fileBytes, timeoutMs: Math.min(30_000, left), referer: finalUrl });
        if (file.url.length > MAX_SOURCE_URL) throw new Error(`its URL is longer than ${MAX_SOURCE_URL} characters, more than credits.json records`);
        return file;
      };
      const pending: Pending[] = [];
      let logoNumber = 0;
      for (const logo of found.logos) {
        const name = `logo-${++logoNumber}`;
        if (logo.kind === "svg") {
          const problem = svgProblems(logo.markup);
          if (problem) warnings.push(`An inline SVG logo was not saved: it ${problem}.`);
          else pending.push({ name: `${name}.svg`, role: "logo", kind: "svg", sourceUrl: finalUrl, bytes: Buffer.from(logo.markup), width: logo.width, height: logo.height });
          continue;
        }
        const file = await this.#picture(logo.url, name, "logo", fetchFile, warnings);
        if (file) pending.push({ ...file, width: file.width ?? logo.width, height: file.height ?? logo.height });
      }
      let iconNumber = 0;
      for (const icon of found.icons) {
        const file = await this.#picture(icon.url, `icon-${iconNumber + 1}`, "icon", fetchFile, warnings);
        if (file) {
          iconNumber++;
          pending.push(file);
        }
      }
      if (found.og) {
        const file = await this.#picture(found.og, "og", "og", fetchFile, warnings);
        if (file) pending.push(file);
      }
      pending.push({ name: "hero.png", role: "hero", kind: "raster", sourceUrl: finalUrl, bytes: hero, width: limits.width * limits.scale, height: limits.height * limits.scale });
      if (full) pending.push({ name: "page.png", role: "page", kind: "raster", sourceUrl: finalUrl, bytes: full, width: limits.width, height: found.scrollHeight });

      const fonts = await this.#fonts(found, declared, fetchFile, finalUrl);
      live();

      stage("saving into the project", 0.85);
      const colors = rankColors(found.colors.map((color) => ({ hex: color.hex, roles: color.roles })));
      const refused = proxy.events.filter((event) => !event.allowed).length;
      if (refused > 0) warnings.push(`${refused} request${refused === 1 ? " was" : "s were"} refused by the capture proxy (private addresses or ports other than 80 and 443).`);
      if (proxy.capped) warnings.push(`The capture stopped at ${Math.round(limits.bytes / 1_048_576)} MB transferred: what was found is partial.`);
      if (found.videos.length > 0) warnings.push(`${found.videos.length} video URL${found.videos.length === 1 ? " was" : "s were"} recorded, not downloaded.`);
      const result = await this.#change(root, async () => {
        live();
        const manifest = await readManifest(root);
        const id = await freeId(root, manifest, url.hostname);
        const files: BrandCapture["files"] = [];
        for (const file of pending) {
          files.push({ path: `${BRAND_DIR}/${id}/${file.name}`, role: file.role, kind: file.kind, origin: "captured", sourceUrl: file.sourceUrl, width: positive(file.width), height: positive(file.height) });
        }
        const planned = new Map<string, Uint8Array>();
        for (const font of fonts.files) {
          font.path = await freeFontPath(root, font.path, font.bytes, planned);
          font.face.file = font.path;
          planned.set(font.path, font.bytes);
          files.push({ path: font.path, role: "font", kind: "font", origin: "captured", sourceUrl: font.sourceUrl, width: null, height: null });
        }
        const assets = files.filter((file) => file.role !== "hero" && file.role !== "page" && file.role !== "font").length + fonts.files.length;
        const little = found.textLength < limits.littleText && assets === 0;
        if (little) warnings.push(`Very little text (${found.textLength} characters) and no logo, icon, share image or font: the page is likely a login wall, a bot check or an empty app shell. Look at hero.png, then ask the person for the logo files or a screenshot.`);
        const capture: BrandCapture = {
          id,
          url: url.href,
          finalUrl,
          capturedAt: new Date().toISOString(),
          title: found.title,
          ok: !little,
          reason: little ? "little-text" : null,
          textLength: found.textLength,
          files,
          colors: colors.slice(0, 24),
          accent: pickAccent(colors),
          fonts: fonts.found,
          variables: found.variables,
          headings: found.headings,
          buttons: found.buttons,
          videos: found.videos,
          warnings,
        };
        const others = manifest.captures.filter((one) => one.id !== id);
        // Page-derived values are checked before anything is written: a manifest that fails its own schema would
        // make every later capture of the project fail.
        const next = parseBrandManifest({ ...manifest, captures: [...others, capture] } satisfies BrandManifest);
        if (!next.ok) throw new Error(`brand.capture: what the page yielded does not fit ${BRAND_FILE}: ${next.error}`);
        live();
        commit.started = true;
        for (const file of pending) await writeTextAtomic(join(root, ...BRAND_DIR.split("/"), id, file.name), file.bytes);
        for (const [path, bytes] of planned) await writeTextAtomic(join(root, ...path.split("/")), bytes);
        await writeJsonAtomic(join(root, BRAND_FILE), next.value);
        return capture;
      });
      // Provenance after the files exist: a source URL and no licence, so `credits check` fails until the person
      // confirms (ADR 0026); fonts carry the licence their own name table names.
      const bySource = new Map<string, string[]>();
      for (const file of result.files.filter((one) => one.role !== "font")) bySource.set(file.sourceUrl, [...(bySource.get(file.sourceUrl) ?? []), file.path]);
      for (const [sourceUrl, assets] of bySource) await this.#options.credits(root, assets, { sourceUrl });
      for (const font of fonts.files) {
        // Name-table text is the file's own: cut to what credits.json takes (300 characters).
        const author = font.maker?.trim().slice(0, 300);
        await this.#options.credits(root, [font.path], { sourceUrl: font.sourceUrl, licence: font.licence, ...(author ? { author } : {}), title: font.family.trim().slice(0, 300) });
      }
      hooks.progress?.(1);
      return { dir: root, manifest: BRAND_FILE, capture: result, style: suggestStyle(result, found.siteName, found.pageBackground), bytes: proxy.bytes };
    } finally {
      off();
    }
  }

  /** A picture by URL as a file to save: sanitised SVG or a known raster; null (with a warning) otherwise. */
  async #picture(
    target: string,
    name: string,
    role: Pending["role"],
    fetchFile: (url: string) => ReturnType<typeof fetchThrough>,
    warnings: string[],
  ): Promise<Pending | null> {
    let fetched: Awaited<ReturnType<typeof fetchThrough>>;
    try {
      fetched = await fetchFile(target);
    } catch (error) {
      warnings.push(`${role === "og" ? "The share image" : `A ${role}`} was not fetched: ${(error as Error).message}`);
      return null;
    }
    const head = fetched.body.subarray(0, 512).toString("utf8").trimStart();
    if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head) || /svg/i.test(fetched.contentType ?? "")) {
      if (fetched.body.length > MAX_SVG_BYTES) {
        warnings.push(`${target} was not saved: an SVG over ${MAX_SVG_BYTES / 1_048_576} MB is not a logo.`);
        return null;
      }
      const clean = sanitizeSvg(fetched.body.toString("utf8"), SVG_FILE_LIMITS);
      if (!clean.ok) {
        warnings.push(`${target} was not saved: it ${clean.problem}.`);
        return null;
      }
      return { name: `${name}.svg`, role, kind: "svg", sourceUrl: fetched.url, bytes: Buffer.from(clean.value.svg), width: null, height: null };
    }
    const raster = RASTER.find((one) => one.test(fetched.body));
    if (!raster) {
      warnings.push(`${target} was not saved: not a PNG, JPEG, GIF, WebP or SVG file${/\.ico(?:[?#]|$)/i.test(target) ? " (.ico)" : ""}.`);
      return null;
    }
    const size = raster.ext === "png" ? { width: fetched.body.readUInt32BE(16), height: fetched.body.readUInt32BE(20) } : { width: null, height: null };
    return { name: `${name}.${raster.ext}`, role, kind: "raster", sourceUrl: fetched.url, bytes: fetched.body, ...size };
  }

  /**
   * Fonts by use and their faces; the faces whose own name table names an open licence come back as files to
   * write under assets/fonts/ (a font embedded as a data: URL is credited to the page, `pageUrl`).
   */
  async #fonts(found: PageFindings, declared: DeclaredFace[], fetchFile: (url: string) => ReturnType<typeof fetchThrough>, pageUrl: string): Promise<{ found: BrandCapture["fonts"]; files: FontFile[] }> {
    const byFamily = new Map<string, { family: string; uses: number; weights: Map<number, number> }>();
    for (const stack of found.fonts) {
      const family = firstFamily(stack.stack);
      if (!family) continue;
      const entry = byFamily.get(family.toLowerCase()) ?? { family, uses: 0, weights: new Map<number, number>() };
      entry.uses += stack.uses;
      for (const [raw, count] of Object.entries(stack.weights)) {
        // Computed weights of a variable face may be fractional (`350.5`); brand.json keeps integers 1-1000.
        const weight = Math.min(1000, Math.max(1, Math.round(Number(raw))));
        if (Number.isFinite(weight)) entry.weights.set(weight, (entry.weights.get(weight) ?? 0) + count);
      }
      byFamily.set(family.toLowerCase(), entry);
    }
    const out: BrandCapture["fonts"] = [];
    const files: FontFile[] = [];
    let fetched = 0;
    for (const entry of [...byFamily.values()].sort((a, b) => b.uses - a.uses).slice(0, 8)) {
      const weights = [...entry.weights].sort((a, b) => b[1] - a[1]).map(([weight]) => weight);
      const generic = isGenericFamily(entry.family);
      const icon = isIconFamily(entry.family);
      const faces: BrandCapture["fonts"][number]["faces"] = [];
      if (!generic && !icon) {
        const chosen = new Set<DeclaredFace>();
        for (const weight of weights.slice(0, 3)) {
          const face = faceFor(declared, entry.family, weight);
          if (face && !isIconFamily(face.family, face.unicodeRange)) chosen.add(face);
        }
        for (const face of chosen) {
          const source = bestSource(face);
          const base = { weight: face.weight, style: face.style, unicodeRange: face.unicodeRange, url: source };
          if (!source) {
            faces.push({ ...base, file: null, licence: null, note: "not copied: only local() sources" });
            continue;
          }
          if (fetched >= this.#limits.fontFaces) {
            faces.push({ ...base, file: null, licence: null, note: `not copied: more than ${this.#limits.fontFaces} faces` });
            continue;
          }
          fetched++;
          let bytes: Uint8Array;
          let sourceUrl = pageUrl;
          try {
            if (source.startsWith("data:")) {
              // base64 decodes to 3/4 of its length: the same per-file cap as a fetched face.
              if ((source.length - source.indexOf(",")) * 0.75 > this.#limits.fileBytes) throw new Error(`larger than ${Math.round(this.#limits.fileBytes / 1_048_576)} MB`);
              bytes = Buffer.from(source.slice(source.indexOf(",") + 1), "base64");
            } else {
              const file = await fetchFile(source);
              bytes = file.body;
              sourceUrl = file.url;
            }
          } catch (error) {
            faces.push({ ...base, file: null, licence: null, note: `not copied: ${(error as Error).message}` });
            continue;
          }
          const ext = fontExtension(bytes);
          let names: ReturnType<typeof readFontNames> | null;
          try {
            names = ext ? readFontNames(bytes) : null;
          } catch {
            names = null;
          }
          if (!ext || !names) {
            faces.push({ ...base, file: null, licence: null, note: "not copied: not a font file Frameshell can read" });
            continue;
          }
          if (!names.licence) {
            const gstatic = /^https?:\/\/fonts\.gstatic\.com\//i.test(sourceUrl);
            faces.push({
              ...base,
              file: null,
              licence: null,
              note: gstatic
                ? "not copied: Google Fonts subsets carry no licence text; fetch the family from github.com/google/fonts and import it with its licence"
                : `not copied: the file's name table names no open licence (OFL-1.1, Apache-2.0, UFL)${names.licenceText ? `; it says: ${names.licenceText.slice(0, 160)}` : ""}`,
            });
            continue;
          }
          const path = `assets/fonts/${entry.family.replace(/[^A-Za-z0-9]+/g, "") || "Font"}-${face.weight.replace(/\s+/g, "-")}${/italic|oblique/i.test(face.style) ? "-italic" : ""}.${ext}`;
          const saved = { ...base, file: path, licence: names.licence, note: `copied: the file names ${names.licence}${sourceUrl === pageUrl ? " (embedded in a stylesheet; credited to the page)" : ""}` };
          faces.push(saved);
          files.push({ path, bytes, sourceUrl, licence: names.licence, maker: names.maker, family: entry.family, face: saved });
        }
        if (chosen.size === 0) faces.push({ weight: String(weights[0] ?? 400), style: "normal", unicodeRange: null, url: null, file: null, licence: null, note: "not copied: no @font-face found for it (a system font, or declared in a stylesheet the capture could not read)" });
      }
      out.push({ family: entry.family, uses: entry.uses, weights, generic, icon, faces });
    }
    return { found: out, files };
  }

  /** `brand.json` of project `root`; empty lists when it has none. Throws InvalidProjectFile when it is broken. */
  async show(root: string): Promise<MethodResult<"brand.show">> {
    const manifest = await readManifest(root);
    const exists = (await stat(join(root, BRAND_FILE)).catch(() => null))?.isFile() ?? false;
    return { dir: root, manifest: BRAND_FILE, exists, captures: manifest.captures, imports: manifest.imports };
  }

  /**
   * Import the SVG frames of folder `dir` (absolute) into project `root`, fitted to `canvas` with one scale
   * (ADR 0044 decision 10). Throws AssetNotFound when `dir` is not a folder, InvalidOperation (`no-frames`) when no
   * frame could be kept.
   */
  async importFigma(root: string, dir: string, canvas: { width: number; height: number }): Promise<MethodResult<"brand.importFigma">> {
    if (!(await stat(dir).catch(() => null))?.isDirectory()) {
      throw new RpcError(ErrorCode.AssetNotFound, `brand.importFigma: ${dir} is not a folder. Export the Figma frames as SVG into one folder first.`, { path: dir });
    }
    const { frames, warnings } = await readFigmaFolder(dir);
    if (frames.length === 0) {
      const why = warnings.length > 0 ? `: ${warnings.slice(0, 5).join(" ")}` : ": it holds no .svg file.";
      throw new RpcError(ErrorCode.InvalidOperation, `brand.importFigma: no frame of ${dir} could be imported${why}`, { op: "brand.importFigma", reason: "no-frames", field: "dir" });
    }
    const fit = fitFrames(frames, canvas);
    const inside = relative(root, dir);
    const source = inside === "" ? "." : inside.startsWith("..") || isAbsolute(inside) ? dir : inside.split(sep).join("/");
    const entry = await this.#change(root, async () => {
      const manifest = await readManifest(root);
      const id = await freeId(root, manifest, basename(dir));
      const entry: BrandImport = {
        id,
        kind: "figma",
        source,
        importedAt: new Date().toISOString(),
        canvas: { width: canvas.width, height: canvas.height },
        reference: fit.reference,
        scale: fit.scale,
        frames: frames.map((frame, index) => ({
          path: `${BRAND_DIR}/${id}/${frame.file}`,
          name: frame.name,
          origin: "imported",
          width: frame.width,
          height: frame.height,
          ...fit.places[index]!,
          removed: frame.removed,
        })),
        warnings,
      };
      const next = parseBrandManifest({ ...manifest, imports: [...manifest.imports, entry] } satisfies BrandManifest);
      if (!next.ok) throw new Error(`brand.importFigma: the import does not fit ${BRAND_FILE}: ${next.error}`);
      const folder = join(root, ...BRAND_DIR.split("/"), id);
      try {
        for (const frame of frames) await writeTextAtomic(join(folder, frame.file), frame.svg);
        await writeJsonAtomic(join(root, BRAND_FILE), next.value);
      } catch (error) {
        // freeId gave a folder that did not exist: remove it, so a failed import leaves no files brand.json misses.
        await rm(folder, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      return entry;
    });
    // No licence: `credits check` fails on a placed frame until the person confirms it is theirs (ADR 0026).
    for (const frame of entry.frames) await this.#options.credits(root, [frame.path], { title: frame.name.replace(/\.svg$/i, "").slice(0, 300) || frame.name });
    return { dir: root, manifest: BRAND_FILE, import: entry };
  }

  /** Run `change` after the project's previous manifest change. */
  #change<T>(root: string, change: () => Promise<T>): Promise<T> {
    const run = (this.#tails.get(root) ?? Promise.resolve()).catch(() => {}).then(change);
    this.#tails.set(root, run);
    return run;
  }
}

/** A face to copy into assets/fonts/; `face` is its entry in the result, whose `file` follows a renamed path. */
interface FontFile {
  path: string;
  bytes: Uint8Array;
  sourceUrl: string;
  licence: string;
  maker: string | null;
  family: string;
  face: BrandCapture["fonts"][number]["faces"][number];
}

/**
 * `wanted`, or the same name with `-2`, `-3`… when another file holds it, on disk or `planned` by this capture;
 * a file with the same bytes is reused.
 */
async function freeFontPath(root: string, wanted: string, bytes: Uint8Array, planned: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const dot = wanted.lastIndexOf(".");
  for (let n = 1; ; n++) {
    const path = n === 1 ? wanted : `${wanted.slice(0, dot)}-${n}${wanted.slice(dot)}`;
    const mine = planned.get(path);
    if (mine) {
      if (Buffer.from(mine).equals(Buffer.from(bytes))) return path;
      continue;
    }
    const full = join(root, ...path.split("/"));
    if (!(await stat(full).catch(() => null)) || (await sameFile(full, bytes))) return path;
  }
}

async function screenshot(chrome: Chrome, session: string, clip: { width: number; height: number; scale: number } | null): Promise<Buffer> {
  const params = clip
    ? { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: clip.width, height: clip.height, scale: clip.scale } }
    : { format: "png" };
  const shot = (await chrome.send("Page.captureScreenshot", params, session)) as { data: string };
  return Buffer.from(shot.data, "base64");
}

async function readManifest(root: string): Promise<BrandManifest> {
  const raw = await readJsonIfExists(join(root, BRAND_FILE));
  if (raw === undefined || raw === null) return createBrandManifest();
  const parsed = parseBrandManifest(raw);
  if (!parsed.ok) throw new RpcError(ErrorCode.InvalidProjectFile, `${BRAND_FILE} is invalid: ${parsed.error}`, { file: BRAND_FILE, issues: parsed.error.split("\n") });
  return parsed.value;
}

/**
 * A brand id from a host (`www.example.com` → `example-com`) or a folder name (`Acme Figma` → `acme-figma`), with
 * `-2`, `-3`… when taken by a manifest entry or a folder.
 */
async function freeId(root: string, manifest: BrandManifest, name: string): Promise<string> {
  const base = name.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  const taken = new Set([...manifest.captures, ...manifest.imports].map((entry) => entry.id));
  const folders = await readdir(join(root, ...BRAND_DIR.split("/"))).catch(() => [] as string[]);
  for (const folder of folders) taken.add(folder);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function positive(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value > 0 ? value : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `path` holds exactly `bytes`. */
async function sameFile(path: string, bytes: Uint8Array): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size !== bytes.byteLength) return false;
  return Buffer.from(await readFile(path)).equals(Buffer.from(bytes));
}
