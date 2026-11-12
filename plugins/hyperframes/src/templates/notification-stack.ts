import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";
import { UI_HELPERS } from "./ui-parts.js";

/**
 * Notification stack (#466): cards drop in from the top one after another,
 * each new one pushing the older ones down, smaller and fainter, until they
 * fade out. `notification` shows OS-style cards, `chat` message bubbles with
 * an avatar. Items are one `|`-separated prop of `Sender: message`. Transparent
 * unless `backdrop` is raised.
 */
export const notificationStack: Template = {
  id: "notification-stack",
  description: "Notification or chat stack: cards drop in one after another, pushing the older ones down; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "items",
        type: "string",
        label: "Items separated by |, each as Sender: message (the first 6 are shown)",
        default: "Maya: The new cut looks great|Dev: Export finished in 4 minutes|Frameshell: 3 reels are ready to post",
        maxLength: 500,
      },
      { id: "app", type: "string", label: "Sender shown when an item names none", default: tokens.brand.product ?? "Frameshell", maxLength: 30 },
      { id: "stamp", type: "string", label: "Time label on a notification, e.g. now; empty for none", default: "now", maxLength: 12 },
      {
        id: "mode",
        type: "enum",
        label: "Look",
        default: "notification",
        options: [
          { value: "notification", label: "Notification cards" },
          { value: "chat", label: "Chat bubbles" },
        ],
      },
      {
        id: "align",
        type: "enum",
        label: "Where the stack sits",
        default: "auto",
        options: [
          { value: "auto", label: "Right on 16:9, centred on the others" },
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
          { value: "right", label: "Right" },
        ],
      },
      { id: "startAt", type: "number", label: "Seconds until the first card", default: 0.4, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "gap", type: "number", label: "Seconds between cards", default: 0.9, min: 0.3, max: 3, step: 0.05, unit: "s" },
      { id: "card", type: "color", label: "Card colour", default: tokens.colors.card ?? "#f1f3f9" },
      { id: "accent", type: "color", label: "Icon and avatar colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
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
      /* Every card is as tall as the others and stacked on the same spot; the script moves them. */
      .card { position: absolute; left: 0; right: 0; top: 0; height: 4.6em; display: flex; align-items: center; gap: 0.9em; padding: 0 1.1em; border-radius: 1.1em; box-shadow: 0 0.4em 1.4em rgba(0, 0, 0, 0.28); transform-origin: 50% 0%; }
      .icon { flex: none; display: flex; align-items: center; justify-content: center; width: 2.6em; height: 2.6em; border-radius: 0.7em; font-weight: 800; font-size: 1.05em; }
      .text { min-width: 0; flex: 1; }
      .head { display: flex; justify-content: space-between; gap: 0.6em; font-weight: 700; font-size: 0.95em; }
      .who { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .when { flex: none; font-weight: 500; font-size: 0.8em; opacity: 0.55; }
      .body { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; margin-top: 0.15em; font-weight: 500; font-size: 0.88em; opacity: 0.85; }
      #stack.chat .card { height: 5.2em; padding: 0 1.1em 0 0.8em; border-radius: 1.4em; }
      #stack.chat .icon { width: 2em; height: 2em; border-radius: 50%; font-size: 0.95em; }
      #stack.chat .when { display: none; }
      #stack.chat .head { font-size: 0.78em; opacity: 0.6; }
      #stack.chat .body { font-size: 1em; opacity: 1; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="notification-stack-clip" class="clip">
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
      ${BACKDROP_SETUP}

      // Layout per format: stack width as a fraction of the frame, type size and top edge as fractions of the short side / height. wide, square, tall.
      var L = M.pick({ w: 0.36, fs: 0.032, top: 0.07, right: true }, { w: 0.86, fs: 0.036, top: 0.07, right: false }, { w: 0.9, fs: 0.038, top: 0.07, right: false });
      var chat = P.mode === "chat";
      var entries = parts(P.items, 6).map(function (item) {
        var at = item.indexOf(":");
        if (at > 0 && at <= 24) return { who: item.slice(0, at).trim(), body: item.slice(at + 1).trim() };
        return { who: String(P.app), body: item };
      });
      var n = entries.length;

      // At most four cards show at once, so the stack is four card heights plus steps; shrink the type if that would leave the frame.
      var STEP = 1.12;
      var CARD = chat ? 5.2 : 4.6;
      var shown = Math.min(Math.max(n, 1), 4);
      var fs = L.fs * unit * P.size;
      var extent = CARD * (1 + (shown - 1) * STEP);
      var topPx = L.top * S.height;
      if (topPx + extent * fs > 0.93 * S.height) fs = (0.93 * S.height - topPx) / extent;
      var cardW = L.w * S.width;
      var align = P.align === "auto" ? (L.right ? "right" : "center") : P.align;
      var edge = 0.04 * S.width;
      var left = align === "left" ? edge : align === "right" ? S.width - cardW - edge : (S.width - cardW) / 2;

      var stack = document.getElementById("stack");
      stack.className = chat ? "chat" : "";
      stack.style.left = left + "px";
      stack.style.top = topPx + "px";
      stack.style.width = cardW + "px";
      stack.style.fontSize = fs + "px";

      var onCard = onColor(P.card);
      var cards = entries.map(function (entry) {
        var el = document.createElement("div");
        el.className = "card";
        el.innerHTML = '<span class="icon"></span><span class="text"><span class="head"><span class="who"></span><span class="when"></span></span><span class="body"></span></span>';
        el.style.background = P.card;
        el.style.color = onCard;
        var icon = el.firstChild;
        icon.textContent = (Array.from(entry.who)[0] || "?").toUpperCase();
        icon.style.background = P.accent;
        icon.style.color = onColor(P.accent);
        var text = el.lastChild;
        text.firstChild.firstChild.textContent = entry.who;
        text.firstChild.lastChild.textContent = P.stamp;
        text.lastChild.textContent = entry.body;
        stack.appendChild(el);
        return el;
      });

      var D = S.duration;
      var OUT = 0.3;
      var step = CARD * STEP * fs;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(stack, { scale: 1 + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        for (var i = 0; i < n; i++) {
          var at = P.startAt + i * P.gap;
          // Rank: how many cards have arrived after this one, each counted as it settles; 0 is the newest.
          var rank = 0;
          for (var j = i + 1; j < n; j++) rank += M.spring("default", t - (P.startAt + j * P.gap));
          var s = M.spring("default", t - at);
          var older = Math.max(0, 1 - 0.2 * rank) * Math.min(1, Math.max(0, 3.2 - rank));
          M.write(cards[i], {
            y: (1 - s) * -step * 0.9 + rank * step,
            scale: 1 - 0.05 * Math.min(rank, 3),
            opacity: M.ease("enter", (t - at) / 0.2) * older,
          });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
