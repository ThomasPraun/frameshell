import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";

/**
 * Stretching tab indicator (#466): a row of tabs and a pill or an underline
 * that moves between them by stretching: the edge it moves toward leaves
 * first, the other follows a beat later, then both settle. The tabs are one
 * `|`-separated prop and the sequence another (`2@1.2|4@2.4`: tab number or
 * name, at second), so a revision is one `clip set`. Edges are springs
 * retargeted at each time (superposition of steps, as `track`), measured on
 * the machine that renders, so a font that loads late still lines up. A tab
 * reads as active in proportion to how much of it the indicator covers.
 * Transparent unless `backdrop` is raised.
 */
export const tabIndicator: Template = {
  id: "tab-indicator",
  description: "Tab indicator: a pill or underline stretches from tab to tab on a timed sequence; tabs and sequence are props; transparent unless a background is set",
  defaultDuration: 5.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "tabs", type: "string", label: "Tab names separated by | (the first 6 are used)", default: "Overview|Timeline|Assets|Export", maxLength: 200 },
      { id: "plan", type: "string", label: "Which tab is active when: tab number or name, @, second; separated by | (a first entry at 0 is where it starts, else it starts on tab 1)", default: "1@0|2@1.2|4@2.4|3@3.6", maxLength: 200 },
      {
        id: "look",
        type: "enum",
        label: "Indicator",
        default: "pill",
        options: [
          { value: "pill", label: "Pill behind the active tab" },
          { value: "underline", label: "Underline below the tabs" },
        ],
      },
      { id: "stretch", type: "number", label: "How far the indicator stretches while it moves, 0 = moves as one piece", default: 0.6, min: 0, max: 1, step: 0.05 },
      { id: "ink", type: "color", label: "Tab text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Indicator colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Tab bar colour (pill look)", default: tokens.colors.card ?? "#1b2236" },
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
      #nav { position: relative; display: flex; gap: 0.2em; padding: 0.3em; font-family: ${fonts.ui}; font-weight: 600; }
      #bar { position: absolute; inset: 0; }
      #ind { position: absolute; }
      .tab { position: relative; padding: 0.65em 1.3em; white-space: nowrap; line-height: 1.2; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="tab-indicator-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="nav"><i id="bar"></i><i id="ind"></i></div>
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format (sizes are fractions of the short side). wide, square, tall.
      var L = M.pick({ type: 0.05 }, { type: 0.05 }, { type: 0.045 });

      var names = String(P.tabs).split("|").map(function (tab) { return tab.trim(); }).filter(Boolean).slice(0, 6);
      if (!names.length) names = ["Overview", "Timeline", "Assets", "Export"];
      var D = S.duration;
      var OUT = 0.3;
      // The sequence: tab number (from 1) or name, at a second. An entry that names no tab or has no time is skipped; one that
      // comes too late for the move to show before the exit is pulled in. An entry at 0 is where the indicator starts.
      var moves = [];
      String(P.plan).split("|").forEach(function (entry) {
        var parts = entry.split("@");
        var key = parts[0].trim();
        var index = /^\\d+$/.test(key) ? Number(key) - 1 : names.findIndex(function (name) { return name.toLowerCase() === key.toLowerCase(); });
        var at = parts.length > 1 && parts[1].trim() !== "" ? Number(parts[1]) : NaN;
        if (index >= 0 && index < names.length && at >= 0) moves.push({ index: index, at: Math.min(at, Math.max(0.3, D - OUT - 0.7)) });
      });
      moves.sort(function (a, b) { return a.at - b.at; });
      var home = 0;
      if (moves.length && moves[0].at <= 0.05) home = moves.shift().index;

      var chars = names.reduce(function (sum, name) { return sum + name.length; }, 0);
      var px = Math.min(L.type * unit * P.size, (0.9 * S.width) / (chars * 0.58 + names.length * 2.8 + 0.6));

      var nav = document.getElementById("nav");
      nav.style.fontSize = px + "px";
      var bar = document.getElementById("bar");
      var pill = P.look !== "underline";
      bar.style.borderRadius = "999px";
      bar.style.background = pill ? P.card : "transparent";
      if (!pill) bar.style.cssText += "inset:auto 0 0 0;height:0.08em;border-radius:999px;background:" + alpha(P.ink, 0.18) + ";";
      var ind = document.getElementById("ind");
      ind.style.background = P.accent;
      ind.style.borderRadius = "999px";
      var activeInk = pill ? onColor(P.accent) : P.ink;
      var tabs = names.map(function (name) {
        var el = document.createElement("span");
        el.className = "tab";
        el.textContent = name;
        nav.appendChild(el);
        return el;
      });

      // Edge of the indicator, 0 = left, 1 = right: a spring step per move toward the new tab's edge. The edge ahead of the move
      // goes at once and fast; the one behind lags by up to 0.1 s on a slower spring, which is the stretch.
      var lead = { response: 0.22, damping: 0.8 };
      var trail = { response: 0.22 + 0.3 * P.stretch, damping: 0.8 + 0.2 * P.stretch };
      var lag = 0.1 * P.stretch;
      function edge(side, t) {
        var at = tabs[home];
        var value = side ? at.offsetLeft + at.offsetWidth : at.offsetLeft;
        var from = at;
        moves.forEach(function (move) {
          var to = tabs[move.index];
          var target = side ? to.offsetLeft + to.offsetWidth : to.offsetLeft;
          var now = side ? from.offsetLeft + from.offsetWidth : from.offsetLeft;
          var ahead = (side === 1) === (move.index >= tabs.indexOf(from));
          value += (target - now) * M.spring(ahead ? lead : trail, t - move.at - (ahead ? 0 : lag));
          from = to;
        });
        return value;
      }
      var stamp = function (v) { return String(Math.round(v * 100) / 100); };

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        var left = edge(0, t);
        var right = Math.max(left + 2, edge(1, t));
        var first = tabs[0];
        ind.style.left = stamp(left) + "px";
        ind.style.width = stamp(right - left) + "px";
        ind.style.top = stamp(pill ? first.offsetTop : nav.offsetHeight - px * 0.1) + "px";
        ind.style.height = stamp(pill ? first.offsetHeight : px * 0.1) + "px";
        // A tab reads as active by how much of it the indicator covers.
        tabs.forEach(function (el) {
          var cover = Math.max(0, Math.min(right, el.offsetLeft + el.offsetWidth) - Math.max(left, el.offsetLeft)) / el.offsetWidth;
          el.style.color = mix(P.ink, activeInk, cover);
          el.style.opacity = stamp(0.62 + 0.38 * cover);
        });
        M.write(bar, { opacity: M.ease("enter", t / 0.3) });
        M.write(ind, { opacity: M.ease("enter", (t - 0.15) / 0.3) });
        // The row comes up with a heavy spring and pushes in slowly; it never rests.
        var s = M.spring("heavy", t);
        put(nav, { y: (1 - s) * px * 0.9, scale: 1 + 0.03 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
