// Live preview of a Remotion clip (ADR 0010): the clip's bundle page, driven the way @remotion/renderer drives it.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RemotionComposition } from "./remotion.js";

/** How long `frameshellLive.ready`, and each seek, wait for the page before failing. */
export const LIVE_TIMEOUT_MS = 30_000;

/**
 * Bundle globals live preview calls. They are Remotion internals, not public
 * API (`make-page.js`, `seek-to-frame.js` in @remotion/renderer 4.0.527).
 */
export const LIVE_INTERNALS = ["remotion_setBundleMode", "remotion_setFrame", "remotion_renderReady"] as const;

/**
 * Throws unless the bundle's scripts mention every global in
 * {@link LIVE_INTERNALS}, so a Remotion release that renamed them fails in
 * the daemon with a clear message, and the preview keeps the slate.
 */
export async function checkLiveInternals(bundleDir: string, version: string | null): Promise<void> {
  const scripts = (await readdir(bundleDir)).filter((name) => name.endsWith(".js"));
  const found = new Set<string>();
  for (const name of scripts) {
    const text = await readFile(join(bundleDir, name), "utf8");
    for (const global of LIVE_INTERNALS) if (text.includes(global)) found.add(global);
    if (found.size === LIVE_INTERNALS.length) return;
  }
  const missing = LIVE_INTERNALS.filter((global) => !found.has(global));
  throw new Error(
    `Live preview drives Remotion bundles through internals this Remotion${version ? ` (${version})` : ""} lacks: ${missing.join(", ")}. ` +
      "Renders still work. Report it at https://github.com/ThomasPraun/frameshell/issues, with your Remotion version.",
  );
}

/** What the page needs to show one composition as a render of it would. */
export interface LiveComposition {
  /** The composition at the project's fps and length (and size, when its aspect differs), as `render` passes it. */
  composition: RemotionComposition;
  /** Scale from the composition's size to the project's, as `render` passes it. */
  scale: number;
  /** Clip `inputProps`, as `render` passes them. */
  inputProps: Record<string, unknown>;
  /** Props `selectComposition` resolved (`defaultProps`, input props, `calculateMetadata`). */
  props: Record<string, unknown>;
}

/**
 * `head` of a Remotion live page. Before the bundle loads, it sets the
 * globals @remotion/renderer sets before a render (`setPropsAndEnv`), so the
 * page runs in Remotion's rendering environment: media is driven frame by
 * frame and never plays sound. The page has an opaque origin, where reading
 * `localStorage` throws and Remotion reads it, so both storages become
 * in-memory ones. Once the bundle defines `remotion_setBundleMode`, the page
 * enters composition mode with the clip's composition (as `make-page.js`
 * does), and `ready` resolves at the first `remotion_renderReady`. `seek(t)`
 * shows frame `round(t × fps)` through `remotion_setFrame` and waits until it
 * is rendered. The body is transparent, as for a PNG frame of a render, and
 * the page is scaled to the project size when the render would be.
 */
export function liveHead(live: LiveComposition): string {
  const { composition, scale } = live;
  const config = {
    id: composition.id,
    fps: composition.fps,
    durationInFrames: composition.durationInFrames,
    width: composition.width,
    height: composition.height,
    scale,
    timeout: LIVE_TIMEOUT_MS,
    inputProps: JSON.stringify(live.inputProps),
    props: JSON.stringify(live.props),
    defaults: {
      compositionDefaultCodec: composition["defaultCodec"] ?? null,
      compositionDefaultOutName: composition["defaultOutName"] ?? null,
      compositionDefaultVideoImageFormat: composition["defaultVideoImageFormat"] ?? null,
      compositionDefaultPixelFormat: composition["defaultPixelFormat"] ?? null,
      compositionDefaultProResProfile: composition["defaultProResProfile"] ?? null,
      compositionDefaultSampleRate: composition["defaultSampleRate"] ?? null,
    },
  };
  return `(function () {
  var c = ${scriptJson(config)};
  var w = window;
  var memory = function () {
    var items = {};
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null; },
      setItem: function (key, value) { items[key] = String(value); },
      removeItem: function (key) { delete items[key]; },
      clear: function () { items = {}; },
      key: function (index) { var keys = Object.keys(items); return index < keys.length ? keys[index] : null; },
      get length() { return Object.keys(items).length; },
    };
  };
  ["localStorage", "sessionStorage"].forEach(function (name) {
    try { void w[name]; } catch (error) { Object.defineProperty(w, name, { value: memory(), configurable: true }); }
  });
  w.remotion_puppeteerTimeout = c.timeout;
  w.remotion_isMainTab = true;
  w.remotion_mediaCacheSizeInBytes = null;
  w.remotion_initialMemoryAvailable = null;
  w.remotion_sampleRate = 48000;
  if (w.process === undefined) w.process = {};
  if (w.process.env === undefined) w.process.env = {};
  w.process.env.NODE_ENV = "production";
  try { w.remotion_broadcastChannel = new BroadcastChannel("remotion-video-frame-extraction"); } catch (error) {}
  w.remotion_inputProps = c.inputProps;
  w.remotion_initialFrame = 0;
  w.remotion_attempt = 1;
  w.remotion_proxyPort = 0;
  w.remotion_audioEnabled = false;
  w.remotion_videoEnabled = true;
  w.remotion_logLevel = "error";
  var style = document.createElement("style");
  style.textContent = "html, body { background: transparent !important; overflow: hidden; }" +
    (c.scale !== 1 ? " body { transform: scale(" + c.scale + "); transform-origin: 0 0; }" : "");
  document.head.appendChild(style);
  document.addEventListener("play", function (event) { if (event.target && typeof event.target.muted === "boolean") event.target.muted = true; }, true);
  var setTimer = w.setTimeout.bind(w);
  var now = Date.now;
  var until = function (test, what) {
    var started = now();
    return new Promise(function (resolve, reject) {
      (function poll() {
        if (w.remotion_cancelledError !== undefined) return reject(new Error(String(w.remotion_cancelledError).split("\\n")[0]));
        if (test()) return resolve();
        if (now() - started > c.timeout) return reject(new Error("The Remotion page did not " + what + " in " + c.timeout / 1000 + " s."));
        setTimer(poll, 16);
      })();
    });
  };
  var attempt = 1;
  var ready = until(function () { return typeof w.remotion_setBundleMode === "function"; }, "load its bundle").then(function () {
    var mode = {
      type: "composition",
      compositionName: c.id,
      serializedResolvedPropsWithSchema: c.props,
      compositionDurationInFrames: c.durationInFrames,
      compositionFps: c.fps,
      compositionHeight: c.height,
      compositionWidth: c.width,
    };
    for (var key in c.defaults) mode[key] = c.defaults[key];
    w.remotion_setBundleMode(mode);
    return until(function () { return w.remotion_renderReady === true && typeof w.remotion_setFrame === "function"; }, "render composition " + c.id);
  });
  ready.catch(function () {});
  w.frameshellLive = {
    ready: ready,
    seek: function (seconds) {
      return ready
        .then(function () {
          var frame = Math.min(c.durationInFrames - 1, Math.max(0, Math.round((Number(seconds) || 0) * c.fps)));
          attempt += 1;
          w.remotion_setFrame(frame, c.id, attempt);
          return until(function () { return w.remotion_renderReady === true; }, "render frame " + frame);
        })
        .then(function () { return document.fonts.ready; })
        .then(function () {});
    },
  };
})();`;
}

/** JSON that is safe inside an inline `<script>`: `<` and the JS line separators are escaped. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
