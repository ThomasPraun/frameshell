import { CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cursorModeVariable, cursorVariables, hesitateVariable } from "./cursor-kit.js";
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
import { TYPING_MATH } from "./typing-kit.js";

/**
 * Comment box (#549, variant of `typing-field`): a card with an avatar and a
 * text area types a comment over a few lines (the same seeded rhythm and blinking
 * caret), then a cursor presses its button; on that same frame the button
 * presses, a progress line fills and the confirmation appears when it ends. With
 * the cursor off the press happens by itself after the comment is typed. The
 * timing guard is the one of `typing-field`. Transparent unless `backdrop` is raised.
 */
export const commentBox: Template = {
  id: "comment-box",
  description: "Comment box: a card with an avatar types a comment over a few lines, a cursor presses the button, progress fills and a confirmation appears; transparent unless a background is set",
  defaultDuration: 6,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "text", type: "string", label: "The comment that is typed", default: "Love the new timeline. The captions land right on the beat.", maxLength: 140 },
      { id: "placeholder", type: "string", label: "Grey text in the empty box", default: "Write a comment...", maxLength: 40 },
      { id: "author", type: "string", label: "Name of the commenter; its first letter is the avatar", default: "Ada", maxLength: 20 },
      { id: "button", type: "string", label: "Text of the button", default: "Comment", maxLength: 14 },
      { id: "result", type: "string", label: "Line that appears when the comment is posted; empty for none", default: "Comment posted", maxLength: 40 },
      { id: "speed", type: "number", label: "Characters typed per second", default: 20, min: 6, max: 40, step: 1 },
      { id: "typeAt", type: "number", label: "Seconds until the first character", default: 0.5, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "runTime", type: "number", label: "Seconds the progress line takes after the press", default: 0.9, min: 0.4, max: 3, step: 0.1, unit: "s" },
      cursorModeVariable(),
      hesitateVariable(0.25),
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Button, caret, avatar and progress colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Box colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
      ...cursorVariables(),
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #world { position: absolute; inset: 0; }
      #field { position: absolute; overflow: hidden; font-family: ${fonts.ui}; font-weight: 500; }
      .layer { position: absolute; inset: 0; border-radius: inherit; }
      #ring { border: 0.1em solid; }
      #avatar { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-weight: 700; }
      #body { position: absolute; overflow: hidden; line-height: 1.4; }
      #typed, #hint { white-space: pre-wrap; overflow-wrap: anywhere; }
      #hint { position: absolute; left: 0; top: 0; }
      #caret { display: inline-block; width: 0.1em; height: 1.1em; margin-left: 0.08em; vertical-align: text-bottom; }
      #go { position: absolute; display: flex; align-items: center; justify-content: center; white-space: nowrap; font-weight: 700; }
      #progress { position: absolute; left: 0; right: 0; bottom: 0; height: 0.2em; transform-origin: 0 50%; }
      #done { position: absolute; display: flex; align-items: center; justify-content: center; gap: 0.55em; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; }
      #done-check { position: relative; flex: none; width: 1.35em; height: 1.35em; border-radius: 50%; }
      #done-check b { position: absolute; left: 36%; top: 17%; width: 26%; height: 50%; border: solid; border-width: 0 0.14em 0.14em 0; transform: rotate(45deg); }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="comment-box-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="field">
            <i id="fill" class="layer"></i>
            <i id="ring" class="layer"></i>
            <div id="avatar"></div>
            <div id="body"><span id="hint"></span><span id="typed"></span><i id="caret"></i></div>
            <div id="go"></div>
            <i id="progress"></i>
          </div>
          <div id="done"><i id="done-check"><b></b></i><span id="done-text"></span></div>
          ${CURSOR_HTML}
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${BACKDROP_SETUP}
      ${CURSOR_MATH}
      ${TYPING_MATH}
      ${CURSOR_SCRIPT}

      // Layout per format: type size as a fraction of the short side, the box's width as a fraction of the frame width and its centre line. wide, square, tall.
      var L = M.pick({ size: 0.04, w: 0.52, y: 0.44 }, { size: 0.04, w: 0.8, y: 0.44 }, { size: 0.038, w: 0.88, y: 0.42 });
      var line = String(P.text);
      var label = String(P.button);
      var result = String(P.result);
      var who = String(P.author).trim();
      var fw = L.w * S.width;
      var chars = Array.from(line);
      // Text is about 0.55 em per character and takes at most 4 lines: the type is fitted to the frame without measuring text. The avatar and the gaps take 5 em of the width.
      var px = Math.min(L.size * unit * P.size, (4 * fw) / (chars.length * 0.55 + 20));
      var pad = 1.1 * px;
      var av = 2.4 * px;
      var textX = pad + av + 0.9 * px;
      var textW = fw - textX - pad;
      var lines = Math.min(5, Math.max(2, Math.ceil((chars.length * 0.55 * px * 1.2) / textW)));
      var textH = lines * 1.4 * px;
      var gw = (label.length * 0.6 + 3) * px;
      var gh = 2.3 * px;
      var fh = pad + textH + 0.8 * px + gh + 0.7 * px;
      var fx = (S.width - fw) / 2;
      var fy = L.y * S.height - fh / 2;

      var field = document.getElementById("field");
      field.style.cssText += "left:" + fx + "px;top:" + fy + "px;width:" + fw + "px;height:" + fh + "px;border-radius:" + px * 1.1 + "px;font-size:" + px + "px;color:" + P.ink;
      var fill = document.getElementById("fill");
      var ring = document.getElementById("ring");
      fill.style.background = P.card;
      fill.style.border = "1px solid " + alpha(P.ink, 0.16);
      ring.style.borderColor = P.accent;
      var avatar = document.getElementById("avatar");
      avatar.textContent = Array.from(who)[0] ? Array.from(who)[0].toUpperCase() : "";
      avatar.style.cssText += "left:" + pad + "px;top:" + pad + "px;width:" + av + "px;height:" + av + "px;font-size:" + px * 1.1 + "px;background:" + P.accent + ";color:" + onColor(P.accent);
      var body = document.getElementById("body");
      body.style.cssText += "left:" + textX + "px;top:" + (pad + 0.2 * px) + "px;width:" + textW + "px;height:" + textH + "px";
      var hint = document.getElementById("hint");
      hint.textContent = P.placeholder;
      hint.style.color = alpha(P.ink, 0.45);
      var typed = document.getElementById("typed");
      var caret = document.getElementById("caret");
      caret.style.background = P.accent;
      var go = document.getElementById("go");
      go.textContent = label;
      go.style.cssText += "left:" + (fw - gw - pad) + "px;top:" + (fh - gh - 0.7 * px) + "px;width:" + gw + "px;height:" + gh + "px;border-radius:" + gh / 2 + "px;background:" + P.accent + ";color:" + onColor(P.accent);
      var progress = document.getElementById("progress");
      progress.style.background = P.accent;

      var dw = (result.length * 0.58 + 4) * px * 0.85;
      var dh = px * 2.2;
      var dy = fy + fh + 0.7 * px;
      var done = document.getElementById("done");
      var doneCheck = document.getElementById("done-check");
      document.getElementById("done-text").textContent = result;
      done.style.cssText += "left:" + (S.width / 2 - dw / 2) + "px;top:" + dy + "px;width:" + dw + "px;height:" + dh + "px;border-radius:" + dh / 2 + "px;font-size:" + px * 0.85 + "px;background:" + P.card + ";color:" + P.ink + ";" + (result ? "" : "display:none;");
      doneCheck.style.background = P.accent;
      doneCheck.firstChild.style.borderColor = onColor(P.accent);

      var useCursor = P.cursor === "on";
      var target = { x: fx + fw - pad - gw * 0.42, y: fy + fh - 0.7 * px - gh * 0.4 };
      var rest = inFrame({ x: target.x + 0.06 * unit, y: dy + dh + 0.08 * unit }, 0.05);
      var stops = [
        { x: target.x, y: target.y, hesitate: P.hesitate, wait: 0.54 },
        { x: rest.x, y: rest.y, weight: "light", bend: 0.2 }
      ];
      var drift = { x: 0.004 * unit, y: 0.003 * unit };
      // The cursor leaves the frame's edge so that it arrives just after the last character. The press is the one moment the button, the progress line and the confirmation hang on.
      var made = fitFirst(typingTries(P.runTime), function (k, run) {
        var typing = rhythm(chars, P.typeAt, P.speed * k);
        var travel = journey(FROM, stops, 0, drift).legs[0].arrive;
        var trip = journey(FROM, stops, Math.max(START, typing.end + 0.15 - travel), drift);
        var clickAt = useCursor ? trip.legs[0].arrive + 0.04 : typing.end + 0.4;
        return { when: typing.when, trip: trip, clickAt: clickAt, run: run, ready: clickAt + run };
      }, latest(0.4));
      var when = made.when;
      var trip = made.trip;
      var clickAt = made.clickAt;
      var runTime = made.run;
      var finishAt = made.ready;

      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        put(world, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });

        var s = M.spring("heavy", t - 0.05);
        put(field, { y: (1 - s) * px * 1.2, scale: 0.94 + 0.06 * s, opacity: M.ease("enter", (t - 0.05) / 0.2) });
        put(avatar, { scale: 0.5 + 0.5 * M.spring("snappy", t - 0.15), opacity: M.ease("enter", (t - 0.15) / 0.12) });

        // Characters typed so far, and a caret that stays solid while typing and blinks at rest.
        var count = 0;
        while (count < chars.length && when[count] <= t) count++;
        typed.textContent = chars.slice(0, count).join("");
        hint.style.visibility = count === 0 ? "visible" : "hidden";
        var lastKey = count === 0 ? 0 : when[count - 1];
        var resting = count === chars.length || count === 0;
        var blink = resting ? Math.floor((t - lastKey) / 0.53) % 2 === 0 : true;
        caret.style.visibility = t >= clickAt || !blink ? "hidden" : "visible";
        put(ring, { opacity: M.ease("enter", t / 0.3) * (1 - 0.6 * M.ease("enter", (t - clickAt) / 0.25)) });

        // The press: the button, the progress line and (when it ends) the confirmation.
        var cp = press(t, clickAt, clickAt + 0.1);
        var hover = useCursor ? M.ease("enter", (t - (trip.legs[0].arrive - 0.2)) / 0.25) : 0;
        put(go, { scale: (1 + 0.04 * hover) * (1 - 0.375 * (1 - cp)) });
        put(progress, { scaleX: M.ease("progress", (t - clickAt) / runTime), opacity: t < clickAt ? 0 : 1 - M.ease("enter", (t - finishAt) / 0.25) });
        var r = M.spring("default", t - finishAt);
        put(done, { y: (1 - r) * dh * 0.7, scale: 0.9 + 0.1 * r, opacity: M.ease("enter", (t - finishAt) / 0.15) });
        put(doneCheck, { scale: 0.4 + 0.6 * M.spring("snappy", t - finishAt - 0.08), opacity: M.ease("enter", (t - finishAt - 0.08) / 0.1) });

        if (useCursor) {
          drawRipple(t, clickAt, target.x, target.y);
          drawCursor(trip.at(t), cp);
        } else {
          put(rippleEl, { opacity: 0 });
          put(cursorEl, { opacity: 0 });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
