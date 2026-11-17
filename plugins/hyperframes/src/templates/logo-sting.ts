import {
  COLOR_HELPERS,
  FLAT_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  fontSetup,
  pageHead,
} from "./kit.js";

/**
 * Logo sting (#466): a short brand hit. The logo lands with a playful spring
 * while a ring leaves it, a soft light band sweeps across the frame, and the
 * name rises through a mask under it. With no logo file a monogram of the
 * name's first letter stands in. Opaque from the first frame, so it can open
 * or close a cut; for a logo over footage use `logo-lockup`, which is
 * transparent. Paints its own background.
 */
export const logoSting: Template = {
  id: "logo-sting",
  description: "Logo sting: the logo lands with a spring and a ring, a light band sweeps across, the name rises; a short brand hit on its own background",
  defaultDuration: 2.2,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "logo",
        type: "image",
        label: "Logo",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. logo.png; empty shows a monogram of the name's first letter",
      },
      { id: "name", type: "string", label: "Name under the logo; empty for none", default: tokens.brand.product ?? "Your brand", maxLength: 40 },
      { id: "popAt", type: "number", label: "Seconds until the logo lands (pulled in on a short clip)", default: 0.25, min: 0.05, max: 2, step: 0.05, unit: "s" },
      { id: "sweep", type: "number", label: "Light band across the frame, 0 = none", default: 0.6, min: 0, max: 1, step: 0.05 },
      { id: "ring", type: "number", label: "Ring that leaves the logo, 0 = none", default: 0.7, min: 0, max: 1, step: 0.05 },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "ink", type: "color", label: "Name colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Ring and monogram colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Size, 1 = the format's default", default: 1, min: 0.5, max: 1.5, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #bg { position: absolute; inset: 0; }
      #sweep { position: absolute; left: 50%; top: 50%; opacity: 0; }
      #content { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
      #mark { position: relative; flex: none; display: flex; align-items: center; justify-content: center; }
      #logo { object-fit: contain; }
      #mono { display: flex; align-items: center; justify-content: center; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1; }
      #ring { position: absolute; left: 50%; top: 50%; border-radius: 50%; opacity: 0; }
      /* The mask clips the name while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #name { white-space: nowrap; font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="logo-sting-clip" class="clip">
        <div id="bg"></div>
        <div id="content">
          <div id="mark"><i id="ring"></i><img id="logo" alt="" /><div id="mono"></div></div>
          <div class="mask"><h1 id="name"></h1></div>
        </div>
        <i id="sweep"></i>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${FLAT_HELPERS}

      // Layout per format: logo box, name size and the gap between them, as fractions of the short side. wide, square, tall.
      var L = M.pick({ logo: 0.34, name: 0.085, gap: 0.05 }, { logo: 0.32, name: 0.085, gap: 0.05 }, { logo: 0.3, name: 0.08, gap: 0.05 });
      var box = L.logo * unit * P.size;

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 42%, " + mix(P.bg, "#ffffff", 0.1) + " 0%, " + P.bg + " 72%)";

      var content = document.getElementById("content");
      content.style.gap = L.gap * unit * P.size + "px";
      content.style.color = P.ink;

      var text = String(P.name).trim();
      var logo = document.getElementById("logo");
      var mono = document.getElementById("mono");
      if (P.logo) {
        logo.src = P.logo;
        logo.style.height = box + "px";
        logo.style.maxWidth = box * 1.8 + "px";
        mono.style.display = "none";
      } else {
        // No logo file: the first letter of the name on an accent tile.
        logo.style.display = "none";
        mono.textContent = (Array.from(text)[0] || "\\u2022").toUpperCase();
        mono.style.width = box + "px";
        mono.style.height = box + "px";
        mono.style.borderRadius = box * 0.22 + "px";
        mono.style.fontSize = box * 0.55 + "px";
        mono.style.background = P.accent;
        mono.style.color = onColor(P.accent);
      }
      var mark = document.getElementById("mark");
      mark.style.height = box + "px";

      var ring = document.getElementById("ring");
      var ringSize = box * 1.15;
      ring.style.width = ringSize + "px";
      ring.style.height = ringSize + "px";
      ring.style.marginLeft = -ringSize / 2 + "px";
      ring.style.marginTop = -ringSize / 2 + "px";
      ring.style.border = Math.max(2, unit * 0.008) + "px solid " + P.accent;

      var nameEl = document.getElementById("name");
      nameEl.textContent = text;
      if (!text) nameEl.parentNode.style.display = "none";
      // Letters are about 0.6 em wide: the name shrinks until it fits inside the frame without measuring text.
      var px = Math.min(L.name * unit * P.size, (0.86 * S.width) / (Math.max(1, text.length) * 0.6));
      nameEl.style.fontSize = px + "px";

      // The light band: a soft white stripe, tilted, wider than it is bright; plain alpha, no blend mode.
      var sweep = document.getElementById("sweep");
      var bandW = Math.max(S.width, S.height) * 0.26;
      var bandH = Math.hypot(S.width, S.height) * 1.6;
      sweep.style.width = bandW + "px";
      sweep.style.height = bandH + "px";
      sweep.style.marginLeft = -bandW / 2 + "px";
      sweep.style.marginTop = -bandH / 2 + "px";
      sweep.style.background = "linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, " + 0.2 * P.sweep + ") 50%, rgba(255, 255, 255, 0) 100%)";

      // Centre travel from clear of the frame to clear on the other side: half the width, half the tilted band, the corner the tilt swings in, and 3 % of the width of margin.
      var travel = S.width / 2 + bandW / 2 / Math.cos(Math.PI * 16 / 180) + (S.height / 2) * Math.tan(Math.PI * 16 / 180) + 0.03 * S.width;
      var D = S.duration;
      var OUT = 0.3;
      // After the logo lands the ring, the name and the sweep need about 1.2 s: a late landing is pulled in so they all finish before the exit.
      var POP = Math.min(P.popAt, Math.max(0.05, D - OUT - 1.2));
      var rise = px * 1.3;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        // The background is there from the first frame, so the sting can open a cut; only the content leaves.
        M.write(content, { scale: 1 + 0.03 * Math.min(1, t / D) - 0.03 * out, opacity: 1 - out });
        var s = M.spring("playful", t - POP);
        put(mark, { scale: 0.55 + 0.45 * s, opacity: M.ease("enter", (t - POP) / 0.15) });
        // The ring leaves the logo as it lands: it grows and fades, so it is gone well before the exit.
        var f = Math.min(1, Math.max(0, (t - POP) / 0.7));
        put(ring, { scale: 0.8 + 1.4 * M.ease("progress", f), opacity: P.ring * 0.7 * (1 - f) * (f > 0 ? 1 : 0) });
        s = M.spring("heavy", t - POP - 0.25);
        M.write(nameEl, { y: (1 - s) * rise, opacity: M.ease("enter", (t - POP - 0.25) / 0.2) });
        // The band crosses the frame once, tilted 16 degrees: it starts and ends fully outside the frame in every format, and fades over its first and last stretch.
        var g = (t - POP - 0.5) / 0.6;
        // It also fades in and out over the first and last 15 % of its way, so no frame shows an edge of it appearing.
        var fade = Math.max(0, Math.min(1, g / 0.15, (1 - g) / 0.15));
        // On a clip shorter than the sting needs the exit starts before the band is across: it leaves with everything else.
        put(sweep, { x: (2 * M.ease("progress", Math.min(1, Math.max(0, g))) - 1) * travel, rotate: 16, opacity: fade * fade * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
