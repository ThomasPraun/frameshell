import { CURSOR_CSS, CURSOR_HTML, CURSOR_MATH, CURSOR_SCRIPT, cursorVariables, hesitateVariable } from "./cursor-kit.js";
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
 * Cursor marquee select (#466, UI demo): a cursor presses on empty space beside a
 * grid of tiles and drags a rectangle across it; each tile lights up on the frame
 * the rectangle reaches it, and on release a count badge springs in. Transparent
 * unless `backdrop` is raised.
 */
export const cursorMarquee: Template = {
  id: "cursor-marquee",
  description: "Cursor marquee select: a cursor drags a rectangle over a grid of tiles, each lights up as it is reached, a count appears on release; transparent unless a background is set",
  defaultDuration: 4.5,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "tiles", type: "number", label: "Number of tiles in the grid", default: 8, min: 4, max: 12, step: 1 },
      { id: "corner", type: "number", label: "Tile (counted along the rows) the rectangle ends on; every tile it covers is selected", default: 6, min: 1, max: 12, step: 1 },
      { id: "label", type: "string", label: "Text on each tile, followed by its number", default: "Clip", maxLength: 16 },
      { id: "selectedLabel", type: "string", label: "Word after the count in the badge", default: "selected", maxLength: 20 },
      hesitateVariable(0.25),
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Selection colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "card", type: "color", label: "Tile colour", default: tokens.colors.card ?? PLACEHOLDER.bg },
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
      .tile { position: absolute; border-radius: 0.6em; overflow: visible; font-family: ${fonts.ui}; font-weight: 600; }
      .tile > i { position: absolute; }
      .thumb { left: 0.6em; right: 0.6em; top: 0.6em; border-radius: 0.35em; }
      .tag { position: absolute; left: 0.8em; bottom: 0.55em; white-space: nowrap; }
      .sel { inset: 0; border-radius: 0.6em; border: 0.12em solid; }
      .tick { right: -0.5em; top: -0.5em; width: 1.3em; height: 1.3em; border-radius: 50%; }
      .tick b { position: absolute; left: 36%; top: 17%; width: 26%; height: 50%; border: solid; border-width: 0 0.14em 0.14em 0; transform: rotate(45deg); }
      #marquee { position: absolute; left: 0; top: 0; width: 0; height: 0; }
      #marquee i { position: absolute; inset: 0; }
      #badge { position: absolute; display: flex; align-items: center; justify-content: center; gap: 0.5em; white-space: nowrap; font-family: ${fonts.ui}; font-weight: 600; }
      #badge-dot { flex: none; width: 0.9em; height: 0.9em; border-radius: 50%; }
      ${CURSOR_CSS}`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="cursor-marquee-clip" class="clip">
        <div id="backdrop"></div>
        <div id="world">
          <div id="grid"></div>
          <div id="marquee"><i id="marquee-fill"></i><i id="marquee-line"></i></div>
          <div id="badge"><i id="badge-dot"></i><span id="badge-text"></span></div>
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
      ${CURSOR_SCRIPT}

      // Layout per format: columns, the grid's width as a fraction of the frame width, the tile's height over its width and the most of the frame height the grid may take.
      var L = M.pick({ cols: 4, w: 0.66, ratio: 0.62, maxH: 0.55 }, { cols: 3, w: 0.8, ratio: 0.7, maxH: 0.5 }, { cols: 3, w: 0.84, ratio: 0.8, maxH: 0.46 });
      var n = Math.round(P.tiles);
      var cols = L.cols;
      var rows = Math.ceil(n / cols);
      var gap = 0.025 * unit;
      var tw = (L.w * S.width - (cols - 1) * gap) / cols;
      var th = Math.min(tw * L.ratio, (L.maxH * S.height - (rows - 1) * gap) / rows);
      var gw = cols * tw + (cols - 1) * gap;
      var gh = rows * th + (rows - 1) * gap;
      var px = Math.min(th * 0.16, tw * 0.13) * P.size;
      var bh = px * 2.6;
      var gx = (S.width - gw) / 2;
      var gy = (S.height - (gh + 0.045 * unit + bh)) / 2;

      var tileFill = mix(P.card, onColor(P.card), 0.1);
      var thumbFill = mix(P.card, onColor(P.card), 0.22);
      var grid = document.getElementById("grid");
      var tiles = [];
      for (var i = 0; i < n; i++) {
        var col = i % cols;
        var row = Math.floor(i / cols);
        var r = { x: gx + col * (tw + gap), y: gy + row * (th + gap), w: tw, h: th };
        var el = document.createElement("div");
        el.className = "tile";
        el.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + tw + "px;height:" + th + "px;font-size:" + px + "px;color:" + P.ink + ";background:" + tileFill;
        el.innerHTML = '<i class="thumb"></i><span class="tag"></span><i class="sel"></i><i class="tick"><b></b></i>';
        el.children[0].style.height = th - 0.6 * px - 2.7 * px + "px";
        el.children[0].style.background = thumbFill;
        el.children[1].textContent = P.label + " " + (i + 1);
        el.children[2].style.borderColor = P.accent;
        el.children[2].style.background = "rgba(0, 0, 0, 0)";
        el.children[3].style.background = P.accent;
        el.children[3].firstChild.style.borderColor = onColor(P.accent);
        grid.appendChild(el);
        tiles.push({ box: r, el: el, sel: el.children[2], tick: el.children[3], fill: null, hit: Infinity });
      }
      // The rectangle's fill is the accent at 18 %: a layer under the tile text, drawn with the selection ring.
      tiles.forEach(function (tile) {
        var wash = document.createElement("i");
        wash.style.cssText = "position:absolute;inset:0;border-radius:0.6em;background:" + P.accent;
        tile.el.insertBefore(wash, tile.el.children[1]);
        tile.fill = wash;
      });

      // The rectangle runs from empty space above and left of the grid to inside the corner tile.
      var corner = Math.min(n, Math.max(1, Math.round(P.corner))) - 1;
      var last = tiles[corner].box;
      var from = { x: gx - 0.03 * unit, y: gy - 0.03 * unit };
      var to = { x: last.x + last.w * 0.88, y: last.y + last.h * 0.88 };
      // The cursor rests beside the badge, not on it (the badge is as wide as its longest possible text).
      var badgeMax = ((String(n) + " " + P.selectedLabel).length * 0.58 + 3.6) * px;
      var rest = inFrame({ x: S.width / 2 + badgeMax / 2 + 0.05 * unit, y: gy + gh + 0.045 * unit + bh * 0.8 }, 0.05);
      var made = fitFirst(CURSOR_TRIES, function (hesitate, rate) {
        var trip = journey(FROM, [
          { x: from.x, y: from.y, hesitate: P.hesitate * hesitate, wait: 0.14 },
          { x: to.x, y: to.y, weight: "heavy", bend: 0.03, wait: 0.55 },
          { x: rest.x, y: rest.y, weight: "light", bend: 0.2 }
        ], START, { x: 0.004 * unit, y: 0.003 * unit }, rate);
        return { trip: trip, ready: trip.legs[1].arrive + 0.08 };
      }, latest(0.5));
      var trip = made.trip;
      var downAt = trip.legs[0].arrive + 0.04;
      var upAt = made.ready;

      // The rectangle between the press point and the cursor at time t.
      function marqueeAt(t) {
        var c = trip.at(t);
        return { l: Math.min(from.x, c.x), r: Math.max(from.x, c.x), t: Math.min(from.y, c.y), b: Math.max(from.y, c.y) };
      }
      // A tile lights up on the first frame (sampled at 240 per second) the rectangle touches it.
      var selected = 0;
      for (var s = trip.legs[1].start; s <= trip.legs[1].arrive + 0.001; s += 1 / 240) {
        var m = marqueeAt(s);
        tiles.forEach(function (tile) {
          var b = tile.box;
          if (tile.hit === Infinity && m.l < b.x + b.w && m.r > b.x && m.t < b.y + b.h && m.b > b.y) {
            tile.hit = s;
            selected++;
          }
        });
      }

      var marquee = document.getElementById("marquee");
      var marqueeFill = document.getElementById("marquee-fill");
      var marqueeLine = document.getElementById("marquee-line");
      marqueeFill.style.background = P.accent;
      marqueeLine.style.border = "0.12em solid " + P.accent;
      marquee.style.fontSize = px + "px";

      var badge = document.getElementById("badge");
      var badgeText = document.getElementById("badge-text");
      var label = selected + " " + P.selectedLabel;
      var bw = label.length * 0.58 * px + 3.6 * px;
      badgeText.textContent = label;
      badge.style.cssText += "left:" + (S.width / 2 - bw / 2) + "px;top:" + (gy + gh + 0.045 * unit) + "px;width:" + bw + "px;height:" + bh + "px;border-radius:" + bh / 2 + "px;font-size:" + px + "px;background:" + P.card + ";color:" + P.ink;
      document.getElementById("badge-dot").style.background = P.accent;

      var world = document.getElementById("world");
      var D = S.duration;
      var OUT = 0.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        put(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        // Holds never stop: a slow push over the whole clip.
        put(world, { scale: 1 + 0.025 * Math.min(1, t / D) - 0.02 * out, opacity: 1 - out });

        for (var k = 0; k < n; k++) {
          var tile = tiles[k];
          var at = 0.05 + M.stagger(k, n, M.STAGGER_STEPS.items);
          var s = M.spring("default", t - at);
          // A tile pops 5 % on the frame the rectangle reaches it, then settles.
          var pop = t < tile.hit ? 0 : M.spring("snappy", t - tile.hit, 1, 0);
          var on = M.ease("snap", (t - tile.hit) / 0.12);
          put(tile.el, { y: (1 - s) * px * 1.2, scale: (0.92 + 0.08 * s) * (1 + 0.05 * pop), opacity: M.ease("enter", (t - at) / 0.2) });
          put(tile.fill, { opacity: 0.18 * on });
          put(tile.sel, { opacity: on });
          put(tile.tick, { scale: 0.4 + 0.6 * M.spring("snappy", t - tile.hit - 0.04), opacity: M.ease("enter", (t - tile.hit - 0.04) / 0.1) });
        }

        // The rectangle exists from the press to the release, then fades.
        var cur = trip.at(t);
        var m = marqueeAt(t);
        marquee.style.left = m.l + "px";
        marquee.style.top = m.t + "px";
        marquee.style.width = m.r - m.l + "px";
        marquee.style.height = m.b - m.t + "px";
        var shown = t < downAt ? 0 : 1 - M.ease("enter", (t - upAt) / 0.15);
        put(marquee, { opacity: shown });
        put(marqueeFill, { opacity: 0.16 });

        // The release is the next beat: the count springs in on the same frame.
        var b = M.spring("default", t - upAt);
        put(badge, { y: (1 - b) * bh * 0.7, scale: 0.9 + 0.1 * b, opacity: M.ease("enter", (t - upAt) / 0.15) });

        drawRipple(t, downAt, from.x, from.y);
        drawCursor(cur, press(t, downAt, upAt));
      });
    </script>
  </body>
</html>
`;
  },
};
