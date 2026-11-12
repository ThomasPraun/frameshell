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

/**
 * Animated counter (#466): a number counts from one value to another (up or
 * down) in about a second and then holds, in tabular figures so the digits
 * never jitter, with an optional soft glow while it climbs. Transparent
 * unless `backdrop` is raised.
 */
export const counter: Template = {
  id: "counter",
  description: "Animated counter: counts from a value to another (up or down) in about a second, optional glow while it climbs; transparent unless a background is set",
  defaultDuration: 3.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "from", type: "number", label: "Value it starts at", default: 0, min: -1000000000, max: 1000000000, step: 1 },
      { id: "to", type: "number", label: "Value it counts to (lower than the start counts down)", default: 12840, min: -1000000000, max: 1000000000, step: 1 },
      { id: "decimals", type: "number", label: "Decimal places", default: 0, min: 0, max: 3, step: 1 },
      { id: "prefix", type: "string", label: "Text before the number, e.g. $", default: "", maxLength: 8 },
      { id: "suffix", type: "string", label: "Text after the number, e.g. % or +", default: "+", maxLength: 12 },
      { id: "label", type: "string", label: "Caption under the number; empty for none", default: "videos edited", maxLength: 60 },
      {
        id: "grouping",
        type: "enum",
        label: "Thousands separator",
        default: "comma",
        options: [
          { value: "comma", label: "Comma: 12,840" },
          { value: "space", label: "Space: 12 840" },
          { value: "none", label: "None: 12840" },
        ],
      },
      { id: "countTime", type: "number", label: "Seconds the count takes", default: 1.2, min: 0.4, max: 3, step: 0.1, unit: "s" },
      { id: "glow", type: "number", label: "Soft glow while it climbs, 0 = none", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "ink", type: "color", label: "Number colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Prefix, suffix and glow colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Number size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #group { position: relative; display: flex; flex-direction: column; align-items: center; }
      #glow { position: absolute; left: 50%; top: 50%; border-radius: 50%; }
      #line { position: relative; display: flex; align-items: baseline; justify-content: center; white-space: nowrap; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
      /* The widest of the two end values holds the width, so the digits count in place; the live number is right-aligned over it. */
      #slot { position: relative; display: inline-block; }
      #ghost { visibility: hidden; }
      #live { position: absolute; right: 0; top: 0; }
      #label { position: relative; font-family: ${fonts.ui}; font-weight: 500; line-height: 1.2; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="counter-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="group">
            <i id="glow"></i>
            <div id="line"><span id="prefix"></span><span id="slot"><span id="ghost"></span><span id="live"></span></span><span id="suffix"></span></div>
            <p id="label"></p>
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
      ${BACKDROP_SETUP}

      // Layout per format (sizes are fractions of the short side). wide, square, tall.
      var L = M.pick({ num: 0.22, label: 0.045, gap: 0.02 }, { num: 0.22, label: 0.045, gap: 0.02 }, { num: 0.19, label: 0.042, gap: 0.02 });

      // Same text for the same value everywhere: fixed decimals, then a separator every three digits.
      var SEP = P.grouping === "comma" ? "," : P.grouping === "space" ? String.fromCharCode(160) : "";
      function format(value) {
        var fixed = Math.abs(value).toFixed(P.decimals).split(".");
        var whole = SEP ? fixed[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, SEP) : fixed[0];
        var negative = value < 0 && Number(fixed.join(".")) !== 0;
        return (negative ? "-" : "") + whole + (fixed[1] ? "." + fixed[1] : "");
      }
      var first = format(P.from);
      var last = format(P.to);
      var widest = first.length > last.length ? first : last;

      // Digits are about 0.6 em wide, so this keeps a long number inside the frame without measuring text.
      var chars = widest.length + String(P.prefix).length + String(P.suffix).length;
      var px = Math.min(L.num * unit * P.size, (0.88 * S.width) / (chars * 0.6));

      var line = document.getElementById("line");
      line.style.fontSize = px + "px";
      line.style.color = P.ink;
      var prefix = document.getElementById("prefix");
      var suffix = document.getElementById("suffix");
      prefix.textContent = P.prefix;
      suffix.textContent = P.suffix;
      prefix.style.color = P.accent;
      suffix.style.color = P.accent;
      document.getElementById("ghost").textContent = widest;
      var live = document.getElementById("live");
      live.textContent = first;

      var label = document.getElementById("label");
      label.textContent = P.label;
      label.style.fontSize = Math.min(L.label * unit * P.size, px * 0.4) + "px";
      label.style.color = P.ink;
      label.style.marginTop = L.gap * unit + "px";
      if (!P.label) label.style.display = "none";

      var glow = document.getElementById("glow");
      glow.style.width = px * 4 + "px";
      glow.style.height = px * 2.4 + "px";
      glow.style.marginLeft = -px * 2 + "px";
      glow.style.marginTop = -px * 1.2 + "px";
      glow.style.background = "radial-gradient(ellipse at center, " + P.accent + " 0%, rgba(0, 0, 0, 0) 68%)";

      var group = document.getElementById("group");
      var D = S.duration;
      var OUT = 0.3;
      var START = 0.35;  // the count starts once the number has come in
      var END = START + P.countTime;
      var lift = px * 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // The count is a function of t alone; "enter" is out-quint: fast first, settling on the final value.
        var done = M.ease("enter", (t - START) / P.countTime);
        live.textContent = format(P.from + (P.to - P.from) * done);
        // Holds never stop: a slow push over the whole clip, and a small pulse when the count lands.
        var pulse = t < END ? 1 : M.spring("snappy", t - END, 1.05, 1);
        M.write(group, { scale: (1 + 0.03 * Math.min(1, t / D) - 0.02 * out) * pulse, opacity: 1 - out });
        M.write(line, { y: (1 - M.spring("heavy", t)) * lift, opacity: M.ease("enter", t / 0.25) });
        M.write(label, { y: (1 - M.spring("default", t - 0.2)) * lift * 0.6, opacity: 0.8 * M.ease("enter", (t - 0.2) / 0.3) });
        M.write(glow, { opacity: P.glow * 0.55 * M.ease("enter", (t - 0.1) / 0.2) * (1 - M.ease("camera", (t - START) / (P.countTime + 0.5))) });
      });
    </script>
  </body>
</html>
`;
  },
};
