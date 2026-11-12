import { COLOR_HELPERS, PLACEHOLDER, type Template, type TemplateInput, type TemplateVariable, fontSetup, pageHead } from "./kit.js";

/**
 * End card with a call to action (#466): logo, name, a button-like CTA and the
 * address spring in one after the other on a solid radial background. It never
 * sits still: the whole card pushes in slowly and the CTA underline re-lights
 * on a steady beat.
 */
export const endCard: Template = {
  id: "end-card",
  description: "End card: logo, name, call to action and address on a solid background, never static",
  defaultDuration: 4,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "title", type: "string", label: "Name or line above the call to action", default: tokens.brand.product ?? "Your name", maxLength: 60 },
      { id: "cta", type: "string", label: "Call to action", default: tokens.brand.cta ?? "Try it today", maxLength: 40 },
      { id: "url", type: "string", label: "Address shown under the button", default: tokens.brand.url ?? "example.com", maxLength: 60 },
      {
        id: "logo",
        type: "image",
        label: "Logo",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. logo.png; empty shows no logo",
      },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "ink", type: "color", label: "Text colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Button colour", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "push", type: "number", label: "Slow push over the whole card, 0.08 = 8 percent", default: 0.08, min: 0, max: 0.2, step: 0.01 },
      { id: "beat", type: "number", label: "Seconds between underline re-lights", default: 1.2, min: 0.5, max: 4, step: 0.1, unit: "s" },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      #bg { position: absolute; inset: 0; }
      #content {
        position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
      }
      #logo { max-width: 60%; object-fit: contain; }
      #title { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; }
      #cta {
        position: relative; display: inline-block; font-family: ${fonts.ui}; font-weight: 700; line-height: 1.1;
        padding: 0.5em 1.2em 0.62em; border-radius: 999px;
      }
      #bar { position: absolute; left: 1.2em; right: 1.2em; bottom: 0.3em; height: 0.09em; border-radius: 999px; transform-origin: 0 50%; }
      #url { font-family: ${fonts.ui}; font-weight: 500; letter-spacing: 0.01em; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="end-card-clip" class="clip">
        <div id="bg"></div>
        <div id="content">
          <img id="logo" alt="" />
          <h1 id="title"></h1>
          <div id="cta"><span id="cta-text"></span><i id="bar"></i></div>
          <p id="url"></p>
        </div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}

      // Layout per format (fractions of the frame; sizes are fractions of the short side). wide, square, tall.
      var L = M.pick(
        { y: 0.5, w: 0.7, title: 0.1, cta: 0.042, url: 0.032, logo: 0.15, gap: 0.035 },
        { y: 0.5, w: 0.8, title: 0.095, cta: 0.045, url: 0.033, logo: 0.15, gap: 0.035 },
        { y: 0.46, w: 0.84, title: 0.085, cta: 0.05, url: 0.036, logo: 0.14, gap: 0.03 }
      );

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";

      var content = document.getElementById("content");
      content.style.left = (1 - L.w) / 2 * S.width + "px";
      content.style.width = L.w * S.width + "px";
      content.style.top = (L.y - 0.5) * S.height + "px";
      content.style.height = S.height + "px";
      content.style.gap = L.gap * unit + "px";
      content.style.color = P.ink;

      var logo = document.getElementById("logo");
      if (P.logo) logo.src = P.logo;
      else logo.style.display = "none";
      logo.style.height = L.logo * unit + "px";

      var title = document.getElementById("title");
      title.textContent = P.title;
      title.style.fontSize = L.title * unit + "px";

      var cta = document.getElementById("cta");
      document.getElementById("cta-text").textContent = P.cta;
      cta.style.fontSize = L.cta * unit + "px";
      cta.style.background = P.accent;
      cta.style.color = onColor(P.accent);
      var bar = document.getElementById("bar");
      bar.style.background = onColor(P.accent);

      var url = document.getElementById("url");
      url.textContent = P.url;
      url.style.fontSize = L.url * unit + "px";

      var D = S.duration;
      var lift = unit * 0.035;
      var CTA = 0.55;  // when the button springs in; the underline follows

      M.bind("${id}", function (t) {
        M.write(bg, { opacity: M.ease("enter", t / 0.3) });
        // Holds never stop: the card pushes in slowly over its whole length.
        M.write(content, { scale: 1 + P.push * Math.min(1, t / D) });
        var s = M.spring("heavy", t - 0.1);
        M.write(logo, { y: (1 - s) * lift, scale: 0.6 + 0.4 * s, opacity: M.ease("enter", (t - 0.1) / 0.3) });
        s = M.spring("heavy", t - 0.25);
        M.write(title, { y: (1 - s) * lift, opacity: M.ease("enter", (t - 0.25) / 0.3) });
        s = M.spring("snappy", t - CTA);
        M.write(cta, { scale: 0.8 + 0.2 * s, opacity: M.ease("enter", (t - CTA) / 0.2) });
        s = M.spring("default", t - 0.85);
        M.write(url, { y: (1 - s) * lift * 0.5, opacity: 0.75 * M.ease("enter", (t - 0.85) / 0.4) });
        // The underline draws once, then re-lights on every beat: a decaying glow that restarts, a function of t only.
        var since = t - (CTA + 0.2);
        var phase = ((since % P.beat) + P.beat) % P.beat;
        M.write(bar, { scaleX: Math.min(1, Math.max(0, M.spring("snappy", since))), opacity: since < 0 ? 0 : 0.4 + 0.6 * Math.exp(-phase * 5) });
      });
    </script>
  </body>
</html>
`;
  },
};
