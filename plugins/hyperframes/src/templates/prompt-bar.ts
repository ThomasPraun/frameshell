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
 * Prompt bar (#466): an input bar whose placeholder gives way to a prompt
 * that types out, then a Run button is pressed (it dips to 0.84 in 0.1 s and
 * springs back, a ring leaves it and an accent halo lights the bar on the same
 * frame) and a spinner takes the label. The text's room is reserved from the
 * first frame, and typing speeds up in a clip too short for it. Transparent
 * unless `backdrop` is raised.
 */
export const promptBar: Template = {
  id: "prompt-bar",
  description: "Prompt bar: the prompt types out, then the Run button is pressed and spins; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "prompt", type: "string", label: "Prompt that types out", default: "Make a 30 second reel from my interview", maxLength: 160 },
      { id: "placeholder", type: "string", label: "Grey text before typing starts; empty for none", default: "Ask anything", maxLength: 60 },
      { id: "button", type: "string", label: "Button label", default: "Run", maxLength: 16 },
      { id: "startAt", type: "number", label: "Seconds until typing starts", default: 0.7, min: 0.2, max: 3, step: 0.1, unit: "s" },
      { id: "typeSpeed", type: "number", label: "Characters typed per second", default: 26, min: 8, max: 80, step: 1 },
      { id: "pressGap", type: "number", label: "Pause between the last letter and the press", default: 0.5, min: 0.2, max: 2, step: 0.05, unit: "s" },
      { id: "card", type: "color", label: "Bar colour", default: tokens.colors.card ?? "#f4f5f9" },
      { id: "accent", type: "color", label: "Button, caret and halo colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
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
      #wrap { position: relative; font-family: ${fonts.ui}; font-weight: 500; line-height: 1.4; }
      #halo { position: absolute; inset: -0.18em; border-radius: 1.3em; }
      #bar { position: relative; display: flex; align-items: center; gap: 0.8em; padding: 0.55em 0.55em 0.55em 1.2em; border-radius: 1.1em; box-shadow: 0 0.5em 1.8em rgba(0, 0, 0, 0.3); }
      #field { position: relative; flex: 1; min-width: 0; }
      #ph { position: absolute; left: 0; right: 0; top: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #text { white-space: pre-wrap; word-break: break-all; min-height: 1.4em; }
      .cur { position: relative; display: inline-block; vertical-align: top; width: 0; height: 1.4em; }
      #caret { position: absolute; left: 0.04em; top: 0.17em; width: 0.1em; height: 1.05em; }
      #rest { visibility: hidden; }
      #go-wrap { position: relative; flex: none; }
      #pulse { position: absolute; inset: 0; border-radius: 0.85em; border: 0.12em solid; }
      #go { position: relative; padding: 0.65em 1.4em; border-radius: 0.85em; font-weight: 700; white-space: nowrap; }
      #go-label { display: inline-block; }
      #spin { position: absolute; left: 50%; top: 50%; width: 1em; height: 1em; margin: -0.5em 0 0 -0.5em; border-radius: 50%; border: 0.14em solid; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="prompt-bar-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="wrap">
            <i id="halo"></i>
            <div id="bar">
              <div id="field">
                <span id="ph"></span>
                <p id="text"><span id="typed"></span><span class="cur"><i id="caret"></i></span><span id="rest"></span></p>
              </div>
              <div id="go-wrap">
                <i id="pulse"></i>
                <div id="go"><span id="go-label"></span><i id="spin"></i></div>
              </div>
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

      // Layout per format: bar width as a fraction of the frame, type size as a fraction of the short side. wide, square, tall.
      var L = M.pick({ w: 0.62, fs: 0.036 }, { w: 0.84, fs: 0.036 }, { w: 0.9, fs: 0.04 });
      var text = String(P.prompt);
      var label = String(P.button);
      var barW = L.w * S.width;
      var fs = L.fs * unit * P.size;
      // Estimated lines of the prompt (a character is about 0.55 em wide); more than three shrink the type.
      function linesAt(px) {
        var room = barW - (1.75 + 0.8 + label.length * 0.62 + 2.8) * px;
        return Math.ceil(text.length / Math.max(6, Math.floor(room / (0.55 * px))));
      }
      for (var k = 0; k < 8 && linesAt(fs) > 3; k++) fs *= 0.9;

      var wrap = document.getElementById("wrap");
      wrap.style.width = barW + "px";
      wrap.style.fontSize = fs + "px";
      var onCard = onColor(P.card);
      var onAccent = onColor(P.accent);
      var bar = document.getElementById("bar");
      bar.style.background = P.card;
      bar.style.color = onCard;
      document.getElementById("halo").style.background = P.accent;

      var ph = document.getElementById("ph");
      ph.textContent = P.placeholder;
      ph.style.color = rgba(onCard, 0.5);
      var typed = document.getElementById("typed");
      var rest = document.getElementById("rest");
      rest.textContent = text;
      var caret = document.getElementById("caret");
      caret.style.background = P.accent;

      var go = document.getElementById("go");
      go.style.background = P.accent;
      go.style.color = onAccent;
      var goLabel = document.getElementById("go-label");
      goLabel.textContent = label;
      var pulse = document.getElementById("pulse");
      pulse.style.borderColor = P.accent;
      var spin = document.getElementById("spin");
      spin.style.borderColor = rgba(onAccent, 0.3);
      spin.style.borderTopColor = onAccent;
      var halo = document.getElementById("halo");

      var D = S.duration;
      var OUT = 0.3;
      // The press must land with a second of spinner after it: in a clip too short for the prompt, typing speeds up.
      var cps = Math.max(P.typeSpeed, text.length / Math.max(0.5, D - OUT - 1 - P.startAt - P.pressGap));
      var pressAt = P.startAt + text.length / cps + P.pressGap;
      var lift = unit * 0.04;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(wrap, { y: (1 - s) * lift, scale: 0.96 + 0.04 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });

        var count = typedCount(t, P.startAt, cps, text.length);
        typed.textContent = text.slice(0, count);
        rest.textContent = text.slice(count);
        M.write(ph, { opacity: 1 - M.ease("enter", (t - P.startAt) / 0.1) });
        var typing = t >= P.startAt && count < text.length;
        M.write(caret, { opacity: t < pressAt && caretOn(t, typing) ? 1 : 0 });

        // The press: down to 0.84 in 0.1 s, back on a snappy spring. The ring, the halo and the spinner start on the same frame.
        var d = t - pressAt;
        var dip = d < 0 ? 1 : d < 0.1 ? 1 - 0.16 * M.ease("snap", d / 0.1) : M.spring("snappy", d - 0.1, 0.84, 1);
        M.write(go, { scale: dip });
        var ring = M.ease("enter", d / 0.5);
        M.write(pulse, { scale: 1 + 0.5 * ring, opacity: d < 0 ? 0 : 0.7 * (1 - ring) });
        M.write(halo, { opacity: 0.55 * M.ease("enter", d / 0.25) });
        M.write(goLabel, { opacity: 1 - M.ease("enter", d / 0.15) });
        M.write(spin, { rotate: d * 540, opacity: M.ease("enter", d / 0.15) });
      });
    </script>
  </body>
</html>
`;
  },
};
