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
 * Chat bubble (#466): an optional question bubble springs in on one side,
 * three typing dots bounce on the other, then the dots give way to the reply.
 * The reply's slot is as big as the reply from the first frame, so nothing
 * shifts when it lands. Transparent unless `backdrop` is raised.
 */
export const chatBubble: Template = {
  id: "chat-bubble",
  description: "Chat bubble: a question, typing dots, then the reply springs in; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "question", type: "string", label: "Bubble that comes first, on the other side; empty for none", default: "Can you cut this into three reels?", maxLength: 160 },
      { id: "message", type: "string", label: "Reply that follows the typing dots", default: "Done. Three reels are rendering now.", maxLength: 200 },
      { id: "sender", type: "string", label: "Name above the reply; empty for none", default: tokens.brand.product ?? "Frameshell", maxLength: 30 },
      {
        id: "side",
        type: "enum",
        label: "Side of the reply",
        default: "left",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      { id: "delay", type: "number", label: "Seconds until the first bubble", default: 0.4, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "dotsTime", type: "number", label: "Seconds the dots bounce before the reply", default: 1.3, min: 0.4, max: 3, step: 0.1, unit: "s" },
      { id: "card", type: "color", label: "Reply bubble colour", default: tokens.colors.card ?? "#f1f3f9" },
      { id: "accent", type: "color", label: "Question bubble colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #thread { display: flex; flex-direction: column; font-family: ${fonts.ui}; font-weight: 500; line-height: 1.35; }
      .bubble { padding: 0.7em 1em; max-width: 100%; box-shadow: 0 0.3em 1.2em rgba(0, 0, 0, 0.25); }
      #slot { display: grid; }
      #slot > * { grid-area: 1 / 1; align-self: start; }
      #dots { display: flex; align-items: center; gap: 0.35em; padding: 0.95em 1.1em; }
      #dots i { display: block; width: 0.6em; height: 0.6em; border-radius: 50%; }
      #who { display: block; margin-bottom: 0.15em; font-size: 0.78em; font-weight: 700; opacity: 0.6; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="chat-bubble-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="thread">
            <div id="ask" class="bubble"></div>
            <div id="slot">
              <div id="dots" class="bubble"><i></i><i></i><i></i></div>
              <div id="reply" class="bubble"><b id="who"></b><span id="reply-text"></span></div>
            </div>
          </div>
        </div>
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

      // Layout per format: thread width as a fraction of the frame, type size as a fraction of the short side. wide, square, tall.
      var L = M.pick({ w: 0.46, fs: 0.042 }, { w: 0.74, fs: 0.04 }, { w: 0.82, fs: 0.042 });
      var asked = String(P.question);
      var reply = String(P.message);
      var threadW = L.w * S.width;
      var fs = L.fs * unit * P.size;
      // Estimated height (a character is about 0.55 em wide): shrink the type so long texts keep the thread inside the frame.
      var cpl = Math.max(6, Math.floor((threadW - 2 * fs) / (0.55 * fs)));
      var lines = Math.ceil(asked.length / cpl) + Math.ceil(Math.max(reply.length, 1) / cpl);
      var tall = lines * 1.35 + 5.5;
      if (tall * fs > 0.8 * S.height) fs = (0.8 * S.height) / tall;

      var right = P.side === "right";
      var onCard = onColor(P.card);
      var onAccent = onColor(P.accent);

      var thread = document.getElementById("thread");
      thread.style.width = threadW + "px";
      thread.style.fontSize = fs + "px";
      thread.style.gap = fs * 0.55 + "px";
      var ask = document.getElementById("ask");
      var slot = document.getElementById("slot");
      var dots = document.getElementById("dots");
      var bubble = document.getElementById("reply");

      // The reply sits on its side with its corner toward the speaker; the question takes the other side.
      ask.textContent = asked;
      ask.style.background = P.accent;
      ask.style.color = onAccent;
      ask.style.alignSelf = right ? "flex-start" : "flex-end";
      ask.style.borderRadius = right ? "1.1em 1.1em 1.1em 0.3em" : "1.1em 1.1em 0.3em 1.1em";
      ask.style.transformOrigin = right ? "0% 100%" : "100% 100%";
      if (!asked) ask.style.display = "none";

      slot.style.justifyItems = right ? "end" : "start";
      var corner = right ? "1.1em 1.1em 0.3em 1.1em" : "1.1em 1.1em 1.1em 0.3em";
      var pivot = right ? "100% 100%" : "0% 100%";
      [dots, bubble].forEach(function (el) {
        el.style.background = P.card;
        el.style.color = onCard;
        el.style.borderRadius = corner;
        el.style.transformOrigin = pivot;
      });
      var who = document.getElementById("who");
      who.textContent = P.sender;
      if (!P.sender) who.style.display = "none";
      document.getElementById("reply-text").textContent = reply;
      var dotList = Array.prototype.slice.call(dots.children);
      dotList.forEach(function (dot) { dot.style.background = rgba(onCard, 0.55); });

      var D = S.duration;
      var OUT = 0.3;
      var askAt = P.delay;
      var dotsAt = asked ? askAt + 0.55 : askAt;
      var replyAt = dotsAt + P.dotsTime;
      var lift = fs * 0.7;

      // A bubble fades through the alpha of its own colours, not through opacity: a rounded box under a partial-opacity
      // group rasterizes differently after a seek than on a cold load, so frames would differ by more than 2/255.
      // Scale of a bubble popping in. A scale a hair under 1 is rasterized differently depending on what was drawn before
      // it (a seek, a cold load), so the last 1.2 % snaps to exactly 1.
      function pop(s) {
        var v = 0.5 + 0.5 * s;
        return v > 0.988 ? 1 : v;
      }
      function paint(el, fill, ink, a) {
        el.style.background = rgba(fill, a);
        el.style.color = rgba(ink, a);
        el.style.boxShadow = "0 0.3em 1.2em " + rgba("#000000", 0.25 * a);
      }

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(thread, { scale: 1 + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });

        var s = M.spring("default", t - askAt);
        M.write(ask, { y: Math.round((1 - s) * lift), scale: pop(s) });
        paint(ask, P.accent, onAccent, M.ease("enter", (t - askAt) / 0.2));

        // The dots bounce one after another and shrink away as the reply lands.
        var gone = M.ease("exit", (t - replyAt + 0.1) / 0.1);
        s = M.spring("snappy", t - dotsAt);
        M.write(dots, { scale: Math.max(0.001, pop(s) * (1 - gone)) });
        var dotsFade = M.ease("enter", (t - dotsAt) / 0.15) * (1 - gone);
        paint(dots, P.card, onCard, dotsFade);
        // The dots are children with their own colour: they follow the bubble's fade and stay still before it is due.
        dotList.forEach(function (dot, i) {
          var wave = t < dotsAt ? 0 : Math.max(0, Math.sin((t - dotsAt) * 8 - i * 0.9));
          M.write(dot, { y: -wave * fs * 0.28, opacity: (0.55 + 0.45 * wave) * dotsFade });
        });

        s = M.spring("default", t - replyAt);
        M.write(bubble, { scale: pop(s) });
        paint(bubble, P.card, onCard, M.ease("enter", (t - replyAt) / 0.15));
      });
    </script>
  </body>
</html>
`;
  },
};
