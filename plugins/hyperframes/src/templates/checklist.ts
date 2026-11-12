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
 * Checklist (#466): the items spring in one after another, then tick one by
 * one on a steady beat (a filled box with a check, the text settling back).
 * Up to eight items, separated by `|` in one prop so a revision is one
 * `clip set`. Transparent unless `backdrop` is raised.
 */
export const checklist: Template = {
  id: "checklist",
  description: "Checklist: items spring in, then tick one by one; items are one `|`-separated prop; transparent unless a background is set",
  defaultDuration: 5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "title", type: "string", label: "Heading above the list; empty for none", default: "Before you publish", maxLength: 60 },
      {
        id: "items",
        type: "string",
        label: "Items separated by | (the first 8 are shown)",
        default: "Plan the shoot|Record the footage|Edit with an agent|Publish",
        maxLength: 400,
      },
      { id: "tickStart", type: "number", label: "Seconds until the first tick", default: 1, min: 0.3, max: 6, step: 0.1, unit: "s" },
      { id: "tickGap", type: "number", label: "Seconds between ticks", default: 0.7, min: 0.2, max: 3, step: 0.05, unit: "s" },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Tick colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
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
      #list { max-width: 86%; }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #title { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.1; letter-spacing: -0.01em; margin-bottom: 0.55em; }
      #items { list-style: none; display: flex; flex-direction: column; gap: 0.5em; }
      .item { display: flex; align-items: center; gap: 0.6em; font-family: ${fonts.ui}; font-weight: 600; line-height: 1.2; }
      .box { position: relative; flex: none; width: 1.15em; height: 1.15em; border-radius: 0.3em; border: 0.1em solid; }
      .fill { position: absolute; inset: -0.1em; border-radius: 0.3em; }
      .tick { position: absolute; inset: -0.1em; }
      .tick i { position: absolute; left: 34%; top: 13%; width: 27%; height: 53%; border: solid; border-width: 0 0.14em 0.14em 0; transform: rotate(45deg); }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="checklist-clip" class="clip">
        <div id="backdrop"></div>
        <div id="content">
          <div id="list">
            <div class="mask" id="title-mask"><h1 id="title"></h1></div>
            <ul id="items"></ul>
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
      var L = M.pick({ size: 0.07 }, { size: 0.066 }, { size: 0.062 });
      var texts = String(P.items).split("|").map(function (item) { return item.trim(); }).filter(Boolean).slice(0, 8);
      var n = texts.length;
      // More rows shrink the type so the list keeps inside the frame.
      var px = L.size * unit * P.size * Math.min(1, 6 / (n + (P.title ? 1.2 : 0)));

      var list = document.getElementById("list");
      list.style.fontSize = px + "px";
      list.style.color = P.ink;

      var title = document.getElementById("title");
      title.textContent = P.title;
      if (!P.title) document.getElementById("title-mask").style.display = "none";

      var rows = [];
      var holder = document.getElementById("items");
      texts.forEach(function (text) {
        var row = document.createElement("li");
        row.className = "item";
        row.innerHTML = '<span class="box"><i class="fill"></i><span class="tick"><i></i></span></span><span class="text"></span>';
        row.lastChild.textContent = text;
        var box = row.firstChild;
        box.style.borderColor = P.accent;
        var fill = box.firstChild;
        fill.style.background = P.accent;
        var tick = box.lastChild;
        tick.firstChild.style.borderColor = onColor(P.accent);
        holder.appendChild(row);
        rows.push({ row: row, fill: fill, tick: tick, text: row.lastChild });
      });

      var D = S.duration;
      var OUT = 0.3;
      var START = 0.15;  // the title is in; the first item follows
      var lead = P.title ? 0.2 : 0;
      var rise = px * 0.9;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        M.write(list, { scale: 1 + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });
        M.write(title, { y: (1 - M.spring("heavy", t - START)) * rise, opacity: M.ease("enter", (t - START) / 0.2) });
        for (var i = 0; i < n; i++) {
          var r = rows[i];
          var at = START + lead + M.stagger(i, n, M.STAGGER_STEPS.items);
          var s = M.spring("default", t - at);
          M.write(r.row, { x: (1 - s) * -px * 0.6, opacity: M.ease("enter", (t - at) / 0.2) });
          // The tick: the box fills, the check pops in, the text settles back.
          var tickAt = P.tickStart + i * P.tickGap;
          M.write(r.fill, { opacity: M.ease("enter", (t - tickAt) / 0.12) });
          M.write(r.tick, { scale: 0.4 + 0.6 * M.spring("snappy", t - tickAt), opacity: M.ease("enter", (t - tickAt) / 0.1) });
          M.write(r.text, { opacity: 1 - 0.35 * M.ease("enter", (t - tickAt - 0.1) / 0.3) });
        }
      });
    </script>
  </body>
</html>
`;
  },
};
