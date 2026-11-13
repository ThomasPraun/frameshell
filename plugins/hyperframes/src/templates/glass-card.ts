import { COLOR_HELPERS, PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead } from "./kit.js";
import { UI_HELPERS } from "./ui-parts.js";

/**
 * Glass card (#462, #466): a translucent card with a hairline border, a light
 * edge along its top and a skewed shine band that crosses once after the card
 * springs in (and again every `shineEvery` seconds if asked). The card only
 * paints the glass look; the blur, saturation and dark scrim under it come
 * from the clip's backdrop (`clip set --glass`, ADR 0031), which the export
 * and the preview apply wherever this render's alpha is above about 3 %. So the
 * fill never drops under that, and the shadow is off unless asked for (it would
 * get glass too). Without a backdrop on the clip it is a pale pane over the
 * footage.
 */
export const glassCard: Template = {
  id: "glass-card",
  description: "Glass card: kicker, title and text on a translucent card with a shine pass; pair it with clip set --glass; transparent over footage",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "label", type: "string", label: "Small line above the title; empty for none", default: tokens.brand.product ?? "New", maxLength: 40 },
      { id: "title", type: "string", label: "Title", default: "Cut the dead air", maxLength: 80 },
      { id: "body", type: "string", label: "Text under the title; empty for none", default: "Remove silences and filler words from a talking-head take in one pass.", maxLength: 200 },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Kicker dot and shine colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "tint", type: "color", label: "Glass tint (border, edge light and fill)", default: "#ffffff" },
      { id: "tintOpacity", type: "number", label: "Fill of the glass, kept above the backdrop's 3 % mask threshold", default: 0.16, min: 0.06, max: 0.4, step: 0.02 },
      { id: "shine", type: "number", label: "Strength of the shine band, 0 = off", default: 1, min: 0, max: 1, step: 0.05 },
      { id: "shineEvery", type: "number", label: "Seconds between shine passes, 0 = once after the entry", default: 0, min: 0, max: 10, step: 0.5, unit: "s" },
      { id: "shadow", type: "number", label: "Drop shadow, 0 = none (the backdrop glass covers a shadow too)", default: 0, min: 0, max: 1, step: 0.05 },
      { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.6, max: 1.6, step: 0.05 },
      {
        id: "place",
        type: "enum",
        label: "Where the card sits in the frame",
        default: "center",
        options: [
          { value: "center", label: "Centre" },
          { value: "lower", label: "Lower" },
          { value: "upper", label: "Upper" },
        ],
      },
      {
        id: "align",
        type: "enum",
        label: "Text alignment",
        default: "left",
        options: [
          { value: "left", label: "Left" },
          { value: "center", label: "Centre" },
        ],
      },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #content { position: absolute; inset: 0; display: flex; justify-content: center; }
      #wrap { position: relative; }
      #card { position: absolute; inset: 0; }
      #edge { position: absolute; left: 8%; right: 8%; top: 0; height: 2px; border-radius: 2px; }
      #shine-box { position: absolute; inset: 0; overflow: hidden; }
      #shine-move { position: absolute; top: -20%; bottom: -20%; left: 0; }
      #shine { position: absolute; inset: 0; transform: skewX(-20deg); }
      #text { position: relative; text-shadow: 0 0.05em 0.45em rgba(0, 0, 0, 0.25); }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #label { display: flex; align-items: center; font-family: ${fonts.ui}; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; line-height: 1.2; }
      #dot { flex: none; width: 0.55em; height: 0.55em; border-radius: 50%; margin-right: 0.7em; }
      #title { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.1; letter-spacing: -0.01em; overflow-wrap: anywhere; }
      #body { font-family: ${fonts.ui}; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="glass-card-clip" class="clip">
        <div id="content">
          <div id="wrap">
            <div id="card">
              <div id="shine-box"><div id="shine-move"><i id="shine"></i></div></div>
              <i id="edge"></i>
            </div>
            <div id="text">
              <div class="mask"><div id="label"><i id="dot"></i><span id="label-text"></span></div></div>
              <div class="mask"><div id="title"></div></div>
              <div class="mask"><div id="body"></div></div>
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

      // Layout per format: card width as a fraction of the frame width, type sizes as fractions of the short side,
      // the gap kept below a lower card (the tall frames leave room for the platform's own controls). wide, square, tall.
      var L = M.pick(
        { w: 0.44, title: 0.056, body: 0.03, label: 0.022, pad: 0.04, bottom: 0.1 },
        { w: 0.78, title: 0.062, body: 0.034, label: 0.024, pad: 0.05, bottom: 0.1 },
        { w: 0.86, title: 0.064, body: 0.036, label: 0.025, pad: 0.055, bottom: 0.2 }
      );
      var cardW = L.w * S.width;
      var pad = L.pad * unit;
      var scaleUp = unit / 1080;
      var line = Math.max(1.5, 3 * scaleUp);
      var radius = Math.min(pad * 1.1, cardW / 6);
      var label = String(P.label);
      var title = String(P.title);
      var body = String(P.body);

      // Estimated height of the text block at a size factor (a character is about 0.55 em wide); too tall for the
      // frame shrinks the type, so a long text never runs out of it.
      function heightAt(f) {
        var room = Math.max(1, cardW - 2 * pad);
        function lines(text, px) { return text ? Math.ceil(text.length / Math.max(4, Math.floor(room / (0.55 * px)))) : 0; }
        var tfs = L.title * unit * f, bfs = L.body * unit * f, lfs = L.label * unit * f;
        return 2 * pad + (label ? 1.4 * lfs + 0.5 * lfs : 0) + lines(title, tfs) * 1.1 * tfs + (title ? 0.3 * tfs : 0) + lines(body, bfs) * 1.4 * bfs;
      }
      var f = P.size;
      for (var k = 0; k < 10 && heightAt(f) > 0.72 * S.height; k++) f *= 0.92;
      var tfs = L.title * unit * f, bfs = L.body * unit * f, lfs = L.label * unit * f;

      var wrap = document.getElementById("wrap");
      wrap.style.width = cardW + "px";
      wrap.style.padding = pad + "px";
      wrap.style.color = P.ink;
      wrap.style.textAlign = P.align;
      var content = document.getElementById("content");
      content.style.alignItems = P.place === "lower" ? "flex-end" : P.place === "upper" ? "flex-start" : "center";
      if (P.place === "lower") content.style.paddingBottom = L.bottom * S.height + "px";
      if (P.place === "upper") content.style.paddingTop = 0.1 * S.height + "px";

      // A card with no text at all keeps a body of its own, so the pane never collapses to a sliver.
      if (!label && !title && !body) wrap.style.minHeight = 0.3 * cardW + "px";

      var card = document.getElementById("card");
      var shadow = P.shadow > 0 ? ", 0 " + 0.5 * pad + "px " + 2 * pad + "px " + rgba("#000000", 0.45 * P.shadow) : "";
      card.style.borderRadius = radius + "px";
      card.style.border = line + "px solid " + rgba(P.tint, 0.38);
      card.style.background = "linear-gradient(160deg, " + rgba(P.tint, Math.min(1, 1.4 * P.tintOpacity)) + ", " + rgba(P.tint, 0.7 * P.tintOpacity) + ")";
      card.style.boxShadow = "inset 0 " + line + "px 0 " + rgba(P.tint, 0.5) + shadow;

      var edge = document.getElementById("edge");
      edge.style.top = -line + "px";
      edge.style.height = Math.max(1, line * 0.7) + "px";
      edge.style.background = "linear-gradient(90deg, transparent, " + rgba(P.tint, 0.85) + ", transparent)";

      // The shine: a 220 px band at 1080 p, tinted by the accent toward white.
      var bandW = 220 * scaleUp;
      var shineMove = document.getElementById("shine-move");
      shineMove.style.width = bandW + "px";
      document.getElementById("shine").style.background = "linear-gradient(90deg, transparent, " + rgba(mix(P.accent, "#ffffff", 0.6), 0.34) + ", transparent)";
      document.getElementById("shine-box").style.borderRadius = radius + "px";

      var labelBox = document.getElementById("label");
      var labelText = document.getElementById("label-text");
      var titleEl = document.getElementById("title");
      var bodyEl = document.getElementById("body");
      labelText.textContent = label;
      titleEl.textContent = title;
      bodyEl.textContent = body;
      labelBox.style.fontSize = lfs + "px";
      labelBox.style.color = rgba(P.ink, 0.78);
      labelBox.style.justifyContent = P.align === "center" ? "center" : "flex-start";
      labelBox.style.marginBottom = 0.5 * lfs + "px";
      document.getElementById("dot").style.background = P.accent;
      titleEl.style.fontSize = tfs + "px";
      titleEl.style.marginBottom = 0.3 * tfs + "px";
      bodyEl.style.fontSize = bfs + "px";
      bodyEl.style.color = rgba(P.ink, 0.82);
      if (!label) labelBox.parentNode.style.display = "none";
      if (!title) titleEl.parentNode.style.display = "none";
      if (!body) bodyEl.parentNode.style.display = "none";

      var D = S.duration;
      var OUT = 0.3;
      var rise = unit * 0.05;
      var textRise = tfs * 1.4;
      // One shine pass takes 0.9 s and starts 0.3 s after the card is in; a repeat never starts before the last ended.
      var PASS = 0.9;
      var FIRST = 0.35;
      var every = P.shineEvery > 0 ? Math.max(PASS + 0.3, P.shineEvery) : 0;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // Holds never stop: a slow push over the whole clip.
        var s = M.spring("heavy", t - 0.05);
        M.write(wrap, {
          y: (1 - s) * rise + out * unit * 0.015,
          scale: 0.94 + 0.06 * s + 0.025 * Math.min(1, t / D) - 0.02 * out,
          opacity: M.ease("enter", (t - 0.05) / 0.25) * (1 - out),
        });

        var local = t - FIRST;
        if (every > 0 && local > 0) local -= Math.floor(local / every) * every;
        var f01 = local / PASS;
        var inPass = P.shine > 0 && f01 > 0 && f01 < 1;
        var travel = M.ease("camera", f01);
        M.write(shineMove, { x: -bandW * 1.5 + (cardW + bandW * 2) * travel, opacity: inPass ? P.shine : 0 });

        M.write(labelBox, { y: (1 - M.spring("default", t - 0.18)) * textRise * 0.6, opacity: M.ease("enter", (t - 0.18) / 0.2) });
        M.write(titleEl, { y: (1 - M.spring("heavy", t - 0.24)) * textRise, opacity: M.ease("enter", (t - 0.24) / 0.2) });
        M.write(bodyEl, { y: (1 - M.spring("default", t - 0.36)) * textRise * 0.7, opacity: M.ease("enter", (t - 0.36) / 0.25) });
      });
    </script>
  </body>
</html>
`;
  },
};
