/** CSS of the three window dots (red, yellow, green) in a title bar: `<span class="dots"><i></i><i></i><i></i></span>`. Sized in `em`. */
export const WINDOW_DOTS_CSS = `
      .dots { display: flex; flex: none; gap: 0.5em; }
      .dots i { display: block; width: 0.8em; height: 0.8em; border-radius: 50%; background: #ff5f57; }
      .dots i:nth-child(2) { background: #febc2e; }
      .dots i:nth-child(3) { background: #28c840; }`;

/** The dots element for {@link WINDOW_DOTS_CSS}. */
export const WINDOW_DOTS_HTML = '<span class="dots"><i></i><i></i><i></i></span>';

/**
 * Page-script helpers of the screen-style templates (terminal, prompt bar,
 * notification stack, chat bubble, scene background); needs `COLOR_HELPERS` first.
 */
export const UI_HELPERS = String.raw`
      // Hex colour as rgba(), alpha 0..1.
      function rgba(hex, a) {
        var c = rgb(hex);
        return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
      }
      // How many of n characters are typed by time t when typing starts at startAt, cps characters a second.
      function typedCount(t, startAt, cps, n) {
        return Math.max(0, Math.min(n, Math.floor((t - startAt) * cps)));
      }
      // A caret that stays solid while typing and blinks twice a second otherwise: a function of t alone.
      function caretOn(t, typing) {
        return typing || Math.floor(t * 2) % 2 === 0;
      }
      // Splits "a|b|c" into trimmed, non-empty parts, at most max of them.
      function parts(text, max) {
        return String(text).split("|").map(function (part) { return part.trim(); }).filter(Boolean).slice(0, max);
      }`;
