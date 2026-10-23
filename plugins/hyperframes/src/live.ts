/** How long `frameshellLive.ready` waits for the HyperFrames runtime to bind the composition's timeline. */
export const LIVE_READY_TIMEOUT_MS = 30_000;

/**
 * Glue between the host and the HyperFrames runtime, inserted before the
 * runtime so it keeps the page's real `setTimeout` and `Date.now` (the
 * runtime may replace timers while it renders). `ready` resolves once the
 * runtime has bound the timeline (`__renderReady`) and exposes
 * `__player.renderSeek`, the render-accurate seek the producer uses, and
 * rejects after {@link LIVE_READY_TIMEOUT_MS}. Media is kept muted: renders
 * carry no audio (ADR 0002). `describe(element)` (ADR 0011) names the file an
 * element comes from: the `data-composition-src` of its nearest host (a
 * sub-composition the runtime inlined), else the entry, project-relative
 * through `ROOT`, the page's root.
 */
const GLUE = `(function () {
  var setTimer = window.setTimeout.bind(window);
  var now = Date.now;
  var mute = function (el) { if (el && typeof el.muted === "boolean") el.muted = true; };
  document.addEventListener("play", function (event) { mute(event.target); }, true);
  var ready = new Promise(function (resolve, reject) {
    var started = now();
    (function poll() {
      var player = window.__player;
      if (window.__renderReady === true && player && typeof player.renderSeek === "function") return resolve();
      if (now() - started > ${LIVE_READY_TIMEOUT_MS}) {
        return reject(new Error("The HyperFrames runtime did not get ready in ${LIVE_READY_TIMEOUT_MS / 1000} s: check the composition for script errors and a [data-composition-id] root."));
      }
      setTimer(poll, 16);
    })();
  });
  ready.catch(function () {});
  window.frameshellLive = {
    ready: ready,
    seek: function (seconds) {
      return ready.then(function () {
        window.__player.renderSeek(Math.max(0, Number(seconds) || 0));
        document.querySelectorAll("audio, video").forEach(mute);
      });
    },
    describe: function (element) {
      var host = element && element.closest ? element.closest("[data-composition-src]") : null;
      var path = location.pathname;
      if (host) {
        try {
          path = new URL(host.getAttribute("data-composition-src"), location.href).pathname;
        } catch (error) {
          path = location.pathname;
        }
      }
      var inRoot = decodeURIComponent(path.replace(/^\\/+/, ""));
      return { source: ROOT === "." ? inRoot : ROOT + "/" + inRoot };
    },
  };
})();`;

/**
 * `head` of a HyperFrames live page (ADR 0010): the clip's variables, the
 * glue, then the HyperFrames runtime the producer injects when rendering.
 * Variables are set only when there are some, as the producer does, so the
 * page sees exactly what a render sees. `root` is the page's root,
 * project-relative (`.` for the project), for `describe`. The host wraps the
 * text in a `<script>` element, so nothing in it may close one.
 */
export function liveHead(variables: Record<string, unknown>, runtime: string, root = ".", elementCss = ""): string {
  if (/<\/script/i.test(runtime)) throw new Error("The HyperFrames runtime script contains `</script`, so it cannot be inlined into a live page.");
  const parts: string[] = [];
  if (Object.keys(variables).length > 0) parts.push(`window.__hfVariables = ${scriptJson(variables)};`);
  parts.push(GLUE.replace("(function () {", `(function () {\n  var ROOT = ${scriptJson(root)};`), runtime);
  // SPIKE (#291): the element sheet goes last in <head> once parsed, so it follows the composition's own styles.
  // `frameshellElements(css)` swaps it without a reload (what a drag would post through the host bridge).
  if (elementCss !== "") parts.push(`(function () {
  var sheet = document.createElement("style");
  sheet.setAttribute("data-frameshell-elements", "");
  sheet.textContent = ${scriptJson(elementCss)};
  window.frameshellElements = function (css) { sheet.textContent = String(css); };
  var place = function () { document.head.appendChild(sheet); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place); else place();
})();`);
  return parts.join("\n");
}

/** JSON that is safe inside an inline `<script>`: `<` and the JS line separators are escaped. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
