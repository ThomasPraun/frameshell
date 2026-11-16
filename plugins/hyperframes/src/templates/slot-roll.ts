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
 * Slot-machine roll (#466): a reel of words or numbers spins upward past a
 * highlighted band, slows, and lands on one value, which flashes in the
 * accent colour and settles with a small pulse. The reel is one `|`-separated
 * prop and the landing value another (appended to the reel when it is not in
 * it), so a revision is one `clip set`. The position of the reel is a function
 * of the time alone; every item sits at its distance from the band, wrapping
 * round, so the reel never runs out. An optional lead text sits before it.
 * Transparent unless `backdrop` is raised.
 */
export const slotRoll: Template = {
  id: "slot-roll",
  description: "Slot-machine roll: a reel of words or numbers spins past a band and lands on a chosen value; reel and target are props; transparent unless a background is set",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "lead", type: "string", label: "Text before the reel, e.g. Made for; empty for none", default: "Made for", maxLength: 40 },
      { id: "items", type: "string", label: "The reel: items separated by | (the first 16 are used)", default: "creators|agencies|teams|founders|educators", maxLength: 300 },
      { id: "target", type: "string", label: "The item it lands on, as written in the reel (added to the reel when missing); empty lands on the last one", default: "founders", maxLength: 40 },
      { id: "rollAt", type: "number", label: "Seconds until the reel starts to spin", default: 0.5, min: 0.2, max: 4, step: 0.1, unit: "s" },
      { id: "rollTime", type: "number", label: "Seconds the reel takes to land (shortened on a short clip)", default: 1.8, min: 0.8, max: 4, step: 0.1, unit: "s" },
      { id: "laps", type: "number", label: "Full turns of the reel before it lands", default: 2, min: 1, max: 6, step: 1 },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Landed value and band outline colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Band colour", default: tokens.colors.card ?? "#1b2236" },
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
      #group { position: relative; display: flex; align-items: center; justify-content: center; }
      #lead { font-family: ${fonts.ui}; font-weight: 600; white-space: nowrap; }
      #machine { position: relative; flex: none; }
      #band { position: absolute; left: 0; right: 0; top: 50%; border-radius: 0.3em; border: 0.06em solid; }
      /* The viewport cuts the reel a little past the band, so the neighbours of the landed item show half-way; it cuts rows only, so a wide item is never clipped. */
      #view { position: absolute; left: 0; right: 0; top: 50%; clip-path: inset(0 -50%); }
      .item { position: absolute; left: 0; right: 0; top: 50%; text-align: center; white-space: nowrap; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="slot-roll-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="group">
            <span id="lead"></span>
            <div id="machine"><i id="band"></i><div id="view"></div></div>
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
      ${FLAT_HELPERS}
      ${BACKDROP_SETUP}

      // The reel: trimmed items, no empty ones, at most 16. The target is found by its text, or added as the last item.
      var items = String(P.items).split("|").map(function (item) { return item.trim(); }).filter(Boolean).slice(0, 16);
      var want = String(P.target).trim();
      var goal = want ? items.findIndex(function (item) { return item.toLowerCase() === want.toLowerCase(); }) : items.length - 1;
      if (goal < 0) goal = items.push(want || "...") - 1;
      // A reel needs three items: with fewer, an item would wrap round while still half in view. A lone item gets a filler in front, the rest one behind.
      if (items.length < 2) { items.unshift("..."); goal = 1; }
      if (items.length < 3) items.push("...");
      var n = items.length;

      // Layout per format (sizes are fractions of the short side). wide, square, tall; tall stacks the lead over the reel.
      var L = M.pick({ type: 0.11, stack: false }, { type: 0.1, stack: false }, { type: 0.085, stack: true });
      var longest = items.reduce(function (most, item) { return Math.max(most, item.length); }, 1);
      var lead = String(P.lead).trim();
      // Letters are about 0.58 em wide (digits 0.6): the type shrinks until the lead and the longest item fit on one line.
      var across = L.stack ? longest : longest + (lead ? lead.length + 1.5 : 0);
      var px = Math.min(L.type * unit * P.size, (0.86 * S.width) / ((across + 1.7) * 0.6));
      var rowH = Math.round(px * 1.3);

      var group = document.getElementById("group");
      group.style.fontSize = px + "px";
      group.style.flexDirection = L.stack ? "column" : "row";
      group.style.gap = px * (L.stack ? 0.5 : 0.4) + "px";
      var leadEl = document.getElementById("lead");
      leadEl.textContent = lead;
      leadEl.style.color = P.ink;
      if (!lead) leadEl.style.display = "none";
      var machine = document.getElementById("machine");
      machine.style.width = Math.round((longest * 0.6 + 1) * px) + "px";
      machine.style.height = rowH + "px";
      var band = document.getElementById("band");
      band.style.height = rowH + "px";
      band.style.marginTop = -rowH / 2 + "px";
      band.style.background = alpha(P.card, 0.85);
      band.style.borderColor = alpha(P.accent, 0.55);
      var view = document.getElementById("view");
      view.style.height = Math.round(rowH * 1.7) + "px";
      view.style.marginTop = -Math.round(rowH * 0.85) + "px";

      var els = items.map(function (text) {
        var el = document.createElement("div");
        el.className = "item";
        el.textContent = text;
        el.style.height = rowH + "px";
        el.style.lineHeight = rowH + "px";
        el.style.marginTop = -rowH / 2 + "px";
        view.appendChild(el);
        return el;
      });

      var D = S.duration;
      var OUT = 0.3;
      // The reel must land and hold a beat before the exit: a late start or a long roll is pulled in.
      var ROLL = Math.min(P.rollTime, Math.max(0.6, D - OUT - 0.5 - 0.3));
      var AT = Math.min(P.rollAt, Math.max(0.2, D - OUT - 0.5 - ROLL));
      var END = AT + ROLL;
      // Whole items travelled: laps (a whole number, whatever clip set wrote) full turns plus the way to the target. Ends exactly on it.
      var travel = Math.max(1, Math.round(P.laps)) * n + goal;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // The reel is faster than the eye in the middle and slow at both ends (in-out), so it reads as spinning.
        var pos = travel * M.ease("camera", (t - AT) / ROLL);
        var landed = M.spring("snappy", t - END, 1.08, 1);
        els.forEach(function (el, i) {
          // Signed distance in items from the band, wrapped into -n/2 .. n/2.
          var d = ((((i - pos) % n) + n + n / 2) % n) - n / 2;
          var near = Math.abs(d);
          put(el, { y: d * rowH, scale: (1 - 0.14 * Math.min(1, near)) * (i === goal && t >= END ? landed : 1), opacity: Math.max(0, 1 - 0.7 * Math.min(1, near)) * (near > 1.6 ? 0 : 1) });
          el.style.color = i === goal ? mix(P.ink, P.accent, M.ease("enter", (t - END) / 0.2)) : P.ink;
        });
        M.write(band, { opacity: M.ease("enter", (t - 0.1) / 0.3) });
        // The group comes up with a heavy spring and pushes in slowly; it never rests.
        var s = M.spring("heavy", t);
        put(group, { y: (1 - s) * px * 0.5, scale: 1 + 0.03 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", t / 0.25) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
