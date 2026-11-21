import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  STEP_TIMES,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  onBeatsVariable,
  pageHead,
} from "./kit.js";
import { UI_HELPERS } from "./ui-parts.js";

/**
 * Work cards (owner decision, ADR 0033): a column of task cards, one
 * line each (`title:status`), that come in staggered, pulse when they start
 * and fill one shared progress bar together. No icons: a title, a status chip
 * and the bar. The progress is one curve for the whole clip (`progressAt`,
 * `progressTime`); a card's bar joins it when the card starts, so the cards
 * never show different amounts of work. Transparent unless `backdrop` is
 * raised. With `onBeats` each card starts (pulses) on a beat of the
 * timeline's music, landing a moment before it.
 */
export const workCards: Template = {
  id: "work-cards",
  description: "Work cards: task cards come in one after another, pulse when they start and fill one shared progress bar; title:status per line, no icons; transparent unless a background is set",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "items",
        type: "string",
        label: "Cards separated by |, each as title:status (the first 5 are shown; the status is optional)",
        default: "Trim the pauses:Running|Add captions:Queued|Export the reel:Queued",
        maxLength: 400,
      },
      {
        id: "align",
        type: "enum",
        label: "Where the column sits",
        default: "auto",
        options: [
          { value: "auto", label: "Right on 16:9, centred on the others" },
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
          { value: "right", label: "Right" },
        ],
      },
      { id: "startAt", type: "number", label: "Seconds until the first card (pulled in on a short clip)", default: 0.3, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "gap", type: "number", label: "Seconds between cards (shortened on a short clip)", default: 0.5, min: 0.1, max: 2, step: 0.05, unit: "s" },
      onBeatsVariable("each card's start (its pulse)", "startAt"),
      { id: "progressAt", type: "number", label: "Seconds until the shared progress starts filling", default: 1.2, min: 0.3, max: 6, step: 0.1, unit: "s" },
      { id: "progressTime", type: "number", label: "Seconds the shared progress takes to fill", default: 2, min: 0.5, max: 6, step: 0.1, unit: "s" },
      { id: "pulse", type: "number", label: "Pulse of a card when it starts, 0 = none", default: 0.7, min: 0, max: 1, step: 0.05 },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? "#f1f3f9" },
      { id: "accent", type: "color", label: "Progress, status and pulse colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #stack { position: absolute; font-family: ${fonts.ui}; line-height: 1.25; }
      /* Every card is as tall as the others; the script puts it in its row. */
      .card { position: absolute; left: 0; right: 0; height: 3.8em; padding: 0.75em 1.1em; border-radius: 0.9em; box-shadow: 0 0.4em 1.4em rgba(0, 0, 0, 0.28); }
      .ring { position: absolute; inset: 0; border-radius: 0.9em; border: 0.16em solid; opacity: 0; }
      .row { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 0.8em; }
      .title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700; font-size: 1em; }
      .status { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.15em 0.7em 0.2em; border-radius: 999px; font-weight: 700; font-size: 0.72em; }
      .track { position: absolute; left: 1.1em; right: 1.1em; bottom: 0.8em; height: 0.4em; border-radius: 999px; overflow: hidden; }
      .fill { position: absolute; inset: 0; border-radius: 999px; transform-origin: 0% 50%; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="work-cards-clip" class="clip">
        <div id="backdrop"></div>
        <div id="stack"></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${UI_HELPERS}
      ${FLAT_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format: column width as a fraction of the frame, type size as a fraction of the short side, where the column's middle is as a fraction of the height. wide, square, tall.
      var L = M.pick({ w: 0.34, fs: 0.032, y: 0.5, right: true }, { w: 0.8, fs: 0.036, y: 0.4, right: false }, { w: 0.86, fs: 0.038, y: 0.34, right: false });
      var entries = parts(P.items, 5).map(function (item) {
        var at = item.indexOf(":");
        return at > 0 ? { title: item.slice(0, at).trim(), status: item.slice(at + 1).trim() } : { title: item, status: "" };
      });
      // Nothing to show is never an empty picture: one placeholder card stands in.
      if (!entries.length) entries = [{ title: "Task", status: "" }];
      var n = entries.length;

      // Cards are 3.8 em tall with 0.7 em between: the type shrinks if the column would use more than 80 % of the frame's height.
      var CARD = 3.8;
      var GAP = 0.7;
      var extent = n * CARD + (n - 1) * GAP;
      var fs = L.fs * unit * P.size;
      if (extent * fs > 0.8 * S.height) fs = (0.8 * S.height) / extent;
      var cardW = L.w * S.width;
      var align = P.align === "auto" ? (L.right ? "right" : "center") : P.align;
      var edge = 0.04 * S.width;
      var left = align === "left" ? edge : align === "right" ? S.width - cardW - edge : (S.width - cardW) / 2;

      var stack = document.getElementById("stack");
      stack.style.left = left + "px";
      stack.style.top = Math.max(0.04 * S.height, L.y * S.height - (extent * fs) / 2) + "px";
      stack.style.width = cardW + "px";
      stack.style.fontSize = fs + "px";

      var ink = onColor(P.card);
      var cards = entries.map(function (entry, i) {
        var el = document.createElement("div");
        el.className = "card";
        el.innerHTML = '<i class="ring"></i><div class="row"><span class="title"></span><span class="status"></span></div><div class="track"><i class="fill"></i></div>';
        el.style.top = i * (CARD + GAP) + "em";
        el.style.background = P.card;
        el.style.color = ink;
        el.style.transformOrigin = "50% 50%";
        var ring = el.firstChild;
        ring.style.borderColor = P.accent;
        var row = el.childNodes[1];
        row.firstChild.textContent = entry.title;
        var chipEl = row.lastChild;
        chipEl.textContent = entry.status;
        chipEl.style.background = P.accent;
        chipEl.style.color = onColor(P.accent);
        if (!entry.status) chipEl.style.display = "none";
        var track = el.lastChild;
        track.style.background = alpha(ink, 0.14);
        track.firstChild.style.background = P.accent;
        stack.appendChild(el);
        return { el: el, ring: ring, status: chipEl, fill: track.firstChild };
      });

      var D = S.duration;
      var OUT = 0.3;
      // Everything is pulled in so the last card has started and the progress has filled before the exit: a late first card comes sooner, the gap shortens, the progress starts and runs sooner.
      var room = D - OUT - 0.5;
      var start = Math.min(P.startAt, Math.max(0.1, room * 0.4));
      var gap = n > 1 ? Math.min(P.gap, Math.max(0.08, (room * 0.6 - start) / (n - 1))) : P.gap;
      var progAt = Math.min(P.progressAt, Math.max(0.3, room - 0.6));
      var progTime = Math.min(P.progressTime, Math.max(0.4, D - OUT - 0.2 - progAt));
      var LEAD = 0.25; // seconds from a card landing to its start (the pulse and the bar joining)
      ${STEP_TIMES}
      // The starts are the steps, or the beats: a card lands LEAD before its beat and pulses on it. On a short clip the beats are held to the room too.
      var starts = stepTimes(start + LEAD, gap, n, P.onBeats, room - LEAD, 0.08);

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(stack, { scale: 1 + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        // One progress for every card.
        var shared = M.ease("progress", (t - progAt) / progTime);
        for (var i = 0; i < n; i++) {
          var began = starts[i];
          var at = began - LEAD;
          var s = M.spring("default", t - at);
          // The pulse: a swell and a ring that fade within half a second of the card starting.
          var f = (t - began) / 0.5;
          var bump = f > 0 && f < 1 ? Math.sin(Math.PI * f) : 0;
          var on = M.ease("enter", (t - began) / 0.25);
          var c = cards[i];
          put(c.el, { y: (1 - s) * fs * 2.2, scale: 1 + 0.04 * P.pulse * bump, opacity: M.ease("enter", (t - at) / 0.2) });
          put(c.ring, { scale: 1 + 0.06 * P.pulse * bump, opacity: 0.85 * P.pulse * bump });
          M.write(c.status, { opacity: 0.4 + 0.6 * on });
          // A bar fills only once its card has started, to the one shared amount.
          M.write(c.fill, { scaleX: shared * on });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
