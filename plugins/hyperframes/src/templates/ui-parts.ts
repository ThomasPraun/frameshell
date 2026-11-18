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

/** The five `<i>` blocks `paintSkeleton` (in {@link SCREEN_HELPERS}) draws, as the children of a screen-sized element. */
export const SKELETON_HTML = "<i></i><i></i><i></i><i></i><i></i>";

/**
 * Page-script helpers of a device screen, shared by `device-frame` and `phone-fan`:
 * `paintSkeleton(el, accent)` fills an element holding {@link SKELETON_HTML} with a plain app screen (light page,
 * accent header, grey blocks), the stand-in for a missing screenshot; `dressPhone(device, screen, w, h)` gives a
 * device box of `w` x `h` the dark bezel and rounded corners of a phone and sets its screen's height.
 */
export const SCREEN_HELPERS = String.raw`
      // Placeholder screen: a light page, an accent header, grey blocks.
      function paintSkeleton(el, accent) {
        el.style.background = "#eef1f7";
        var blocks = [[0, 0, 100, 13, accent], [6, 20, 40, 30, "#d9deea"], [54, 20, 40, 30, "#d9deea"], [6, 58, 88, 5, "#d9deea"], [6, 68, 60, 5, "#d9deea"]];
        Array.prototype.forEach.call(el.children, function (block, i) {
          block.style.left = blocks[i][0] + "%";
          block.style.top = blocks[i][1] + "%";
          block.style.width = blocks[i][2] + "%";
          block.style.height = blocks[i][3] + "%";
          block.style.background = blocks[i][4];
          if (i === 0) block.style.borderRadius = "0";
        });
      }
      // A phone: a dark bezel around the screen and rounded corners.
      function dressPhone(device, screen, w, h) {
        var bezel = w * 0.035;
        device.style.padding = bezel + "px";
        device.style.background = "#0a0c12";
        device.style.borderRadius = w * 0.14 + "px";
        screen.style.height = h - 2 * bezel + "px";
        screen.style.borderRadius = w * 0.11 + "px";
      }`;
