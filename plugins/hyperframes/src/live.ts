/** How long `frameshellLive.ready` waits for the HyperFrames runtime to bind the composition's timeline. */
export const LIVE_READY_TIMEOUT_MS = 30_000;

/**
 * Glue between the host and the HyperFrames runtime, inserted before the
 * runtime so it keeps the page's real `setTimeout` and `Date.now` (the
 * runtime may replace timers while it renders). `ready` resolves once the
 * runtime has bound the timeline (`__renderReady`) and exposes
 * `__player.renderSeek`, the render-accurate seek the producer uses, and
 * rejects after {@link LIVE_READY_TIMEOUT_MS}. Media is kept muted: renders
 * carry no audio (ADR 0002).
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
  };
})();`;

/**
 * `head` of a HyperFrames live page (ADR 0010): the clip's variables, the
 * glue, then the HyperFrames runtime the producer injects when rendering.
 * Variables are set only when there are some, as the producer does, so the
 * page sees exactly what a render sees. The host wraps the text in a
 * `<script>` element, so nothing in it may close one.
 */
export function liveHead(variables: Record<string, unknown>, runtime: string): string {
  if (/<\/script/i.test(runtime)) throw new Error("The HyperFrames runtime script contains `</script`, so it cannot be inlined into a live page.");
  const parts: string[] = [];
  if (Object.keys(variables).length > 0) parts.push(`window.__hfVariables = ${scriptJson(variables)};`);
  parts.push(GLUE, runtime);
  return parts.join("\n");
}

/** JSON that is safe inside an inline `<script>`: `<` and the JS line separators are escaped. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
