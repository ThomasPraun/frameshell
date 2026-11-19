import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  FLAT_HELPERS,
  GROUPING_VARIABLE,
  NUMBER_FORMAT,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  pageHead,
} from "./kit.js";

/**
 * Number wheel: an odometer. Every digit is a column that rolls to its
 * final digit, the left columns landing first and the right ones last, then the
 * number holds. A column is a fixed slot as wide as the widest tabular digit
 * (measured on the machine that renders: `1ch` is the width of the 0 alone) and
 * one line high, never sized by the strip that moves in it, so the number never
 * shifts while it rolls. The wheel ends on exactly the text `counter` would
 * print: a start with more digits than `to` lays the wheels out, and the left
 * columns (and any separator left of the first digit) the end does not use fade
 * out as they land. They stay as empty room, so the number never moves.
 * Transparent unless `backdrop` is raised.
 */
export const numberWheel: Template = {
  id: "number-wheel",
  description: "Number wheel: odometer digits roll one column each to a value (up or down) in about 1.4 s, then hold, in fixed slots so the number never shifts; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "from", type: "number", label: "Value the wheels start at", default: 0, min: 0, max: 1000000000, step: 1 },
      { id: "to", type: "number", label: "Value they roll to (lower than the start rolls the other way)", default: 12840, min: 0, max: 1000000000, step: 1 },
      { id: "decimals", type: "number", label: "Decimal places", default: 0, min: 0, max: 3, step: 1 },
      { id: "prefix", type: "string", label: "Text before the number, e.g. $", default: "", maxLength: 8 },
      { id: "suffix", type: "string", label: "Text after the number, e.g. % or +", default: "+", maxLength: 12 },
      { id: "label", type: "string", label: "Caption under the number; empty for none", default: "videos edited", maxLength: 60 },
      GROUPING_VARIABLE,
      { id: "countTime", type: "number", label: "Seconds the wheels take (the last column lands then)", default: 1.4, min: 0.6, max: 3, step: 0.1, unit: "s" },
      { id: "cells", type: "number", label: "Card behind each digit, 0 = none", default: 0, min: 0, max: 1, step: 0.05 },
      { id: "ink", type: "color", label: "Number colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Prefix and suffix colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Digit card colour", default: tokens.colors.card ?? "#1b2236" },
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
      #line { position: relative; display: flex; align-items: center; justify-content: center; white-space: pre; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
      #digits { display: flex; align-items: center; }
      /* A slot is as wide as the widest digit and one row high whatever moves inside it; the clip cuts the rows above and below only. */
      .slot { position: relative; flex: none; margin: 0 0.02em; border-radius: 0.14em; clip-path: inset(0 -0.4em); }
      .strip { position: absolute; left: 0; top: 0; width: 100%; display: block; }
      .strip i { display: block; font-style: normal; text-align: center; }
      .probe { position: absolute; left: 0; top: 0; visibility: hidden; white-space: nowrap; }
      #label { position: relative; font-family: ${fonts.ui}; font-weight: 500; line-height: 1.2; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="number-wheel-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="group">
            <div id="line"><span id="prefix"></span><span id="digits"></span><span id="suffix"></span></div>
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
      ${FLAT_HELPERS}
      ${BACKDROP_SETUP}

      // Layout per format (sizes are fractions of the short side). wide, square, tall.
      var L = M.pick({ num: 0.22, label: 0.045, gap: 0.02 }, { num: 0.22, label: 0.045, gap: 0.02 }, { num: 0.19, label: 0.042, gap: 0.02 });

      ${NUMBER_FORMAT}

      // The text with more digits lays the wheels out; the other end is padded with zeros on the left, as a real odometer shows it.
      var first = format(P.from);
      var last = format(P.to);
      function digitsOf(text) { return text.replace(/\\D/g, ""); }
      var layout = digitsOf(first).length > digitsOf(last).length ? first : last;
      var count = digitsOf(layout).length;
      function padded(text) { var d = digitsOf(text); while (d.length < count) d = "0" + d; return d; }
      var fromDigits = padded(first);
      var toDigits = padded(last);
      // Columns left of the digits of the end text (a lower end value with fewer digits) end blank, not as zeros.
      var pad = count - digitsOf(last).length;

      // A slot is about 0.78 em (a digit, the overhang margin and the gap), a separator 0.4 em, a prefix or suffix letter 0.65 em:
      // the size shrinks until the whole line fits inside the frame without measuring text.
      var ems = count * 0.78 + (layout.length - count) * 0.4 + (String(P.prefix).length + String(P.suffix).length) * 0.65;
      var px = Math.min(L.num * unit * P.size, (0.88 * S.width) / ems);
      var row = Math.round(px * 1.1);

      var line = document.getElementById("line");
      line.style.fontSize = px + "px";
      line.style.color = P.ink;
      line.style.lineHeight = row + "px";
      var prefix = document.getElementById("prefix");
      var suffix = document.getElementById("suffix");
      prefix.textContent = P.prefix;
      suffix.textContent = P.suffix;
      prefix.style.color = P.accent;
      suffix.style.color = P.accent;

      // One strip per digit: 0 to 9 three times, so the window always has a neighbour above and below whichever digit it shows.
      var host = document.getElementById("digits");
      var cols = [];
      var seps = [];
      layout.split("").forEach(function (ch) {
        var cell = document.createElement("span");
        if (/\\d/.test(ch)) {
          var strip = document.createElement("span");
          strip.className = "strip";
          for (var k = 0; k < 30; k++) {
            var digit = document.createElement("i");
            digit.textContent = String(k % 10);
            digit.style.height = row + "px";
            strip.appendChild(digit);
          }
          cell.className = "slot";
          cell.style.height = row + "px";
          cell.style.background = alpha(P.card, P.cells);
          cell.appendChild(strip);
          cols.push({ slot: cell, strip: strip, from: Number(fromDigits[cols.length]), to: Number(toDigits[cols.length]), blank: cols.length < pad });
        } else {
          cell.textContent = ch;
          // A separator with only blank columns to its left goes with the last of them.
          if (cols.length <= pad) seps.push({ cell: cell, col: cols.length - 1 });
        }
        host.appendChild(cell);
      });

      // The slot width is the widest digit of the face as laid out here (tabular figures), measured on 50-digit probes because
      // offsetWidth rounds; it is read again on every paint, so a font that loads late still gets slots that fit its glyphs.
      var probes = [];
      for (var d = 0; d < 10; d++) {
        var probe = document.createElement("span");
        probe.className = "probe";
        probe.textContent = new Array(51).join(String(d));
        line.appendChild(probe);
        probes.push(probe);
      }
      var slotW = -1;
      function fit() {
        var w = 0;
        probes.forEach(function (p) { w = Math.max(w, p.offsetWidth / 50); });
        w += px * 0.08;  // heavy faces overhang their advance a little
        if (Math.abs(w - slotW) < 0.001) return;
        slotW = w;
        cols.forEach(function (c) { c.slot.style.width = w + "px"; });
      }
      fit();

      var label = document.getElementById("label");
      label.textContent = P.label;
      label.style.fontSize = Math.min(L.label * unit * P.size, px * 0.4) + "px";
      label.style.color = P.ink;
      label.style.marginTop = L.gap * unit + "px";
      if (!P.label) label.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      var START = 0.35;  // the wheels start once the number has come in
      // The last column must land and the number hold a beat before the exit: a long count is pulled in.
      var TIME = Math.min(P.countTime, Math.max(0.5, D - OUT - START - 0.6));
      var END = START + TIME;
      // Each column rolls at least one full turn (two for the two lowest), to the digit it must show; the right ones land last.
      var up = P.to >= P.from;
      cols.forEach(function (c, i) {
        var steps = up ? (c.to - c.from + 10) % 10 : (c.from - c.to + 10) % 10;
        c.travel = (up ? 1 : -1) * (steps + 10 * (i >= cols.length - 2 ? 2 : 1));
        c.time = TIME * (0.7 + 0.3 * (cols.length > 1 ? i / (cols.length - 1) : 1));
      });
      var group = document.getElementById("group");
      var lift = px * 0.3;

      M.bind("${id}", function (t) {
        fit();
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Each strip is a function of t alone: the position in digits, folded into the middle copy of 0 to 9.
        cols.forEach(function (c) {
          var at = c.from + c.travel * M.ease("enter", (t - START) / c.time);
          M.write(c.strip, { y: -(10 + (((at % 10) + 10) % 10)) * row });
          c.gone = c.blank ? M.ease("enter", (t - (START + c.time - 0.25)) / 0.25) : 0;
          if (c.blank) M.write(c.slot, { opacity: 1 - c.gone });
        });
        seps.forEach(function (s) { if (s.col >= 0) M.write(s.cell, { opacity: 1 - cols[s.col].gone }); });
        // Holds never stop: a slow push over the whole clip, and a small pulse when the last column lands.
        var pulse = t < END ? 1 : M.spring("snappy", t - END, 1.04, 1);
        put(group, { y: (1 - M.spring("heavy", t)) * lift, scale: (1 + 0.03 * Math.min(1, t / D) - 0.02 * out) * pulse, opacity: M.ease("enter", t / 0.25) * (1 - out) });
        M.write(label, { y: (1 - M.spring("default", t - 0.2)) * lift * 0.6, opacity: 0.8 * M.ease("enter", (t - 0.2) / 0.3) });
      });
    </script>
  </body>
</html>
`;
  },
};
