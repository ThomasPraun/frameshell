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
import { WINDOW_DOTS_CSS, WINDOW_DOTS_HTML } from "./ui-parts.js";

/**
 * Camera pull-back reveal: the clip opens tight on one detail of a
 * picture (a button, a number, a corner of the screen), holds it for a beat
 * and pulls back to show the whole screen, then a title rises under it. The
 * camera is one scale about the detail plus the shift that centres it, both
 * functions of the time. The picture is an image of the composition directory
 * or, when empty, a plain app skeleton. Paints its own background.
 */
export const pullBackReveal: Template = {
  id: "pull-back-reveal",
  description: "Camera pull-back reveal: opens tight on a detail of a screen, pulls back to the whole picture, then a title rises; paints its own background",
  defaultDuration: 5,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "picture", type: "image", label: "Picture", default: "", description: "Path of an image inside this composition's directory, e.g. screen.png; empty shows a plain app skeleton" },
      { id: "title", type: "string", label: "Title that rises under the picture once the camera has pulled back; empty for none", default: tokens.brand.product ?? "Everything in one place", maxLength: 60 },
      { id: "caption", type: "string", label: "Line under the title; empty for none", default: "", maxLength: 80 },
      { id: "focusX", type: "number", label: "Where the detail is, from the left, 0 to 1", default: 0.79, min: 0, max: 1, step: 0.02 },
      { id: "focusY", type: "number", label: "Where the detail is, from the top, 0 to 1", default: 0.35, min: 0, max: 1, step: 0.02 },
      { id: "zoom", type: "number", label: "How tight the opening is, 1 = no zoom", default: 2.8, min: 1.2, max: 5, step: 0.1 },
      { id: "pullAt", type: "number", label: "Seconds the camera holds on the detail before pulling back (pulled in on a short clip)", default: 0.9, min: 0.1, max: 3, step: 0.1, unit: "s" },
      { id: "pullTime", type: "number", label: "Seconds the pull-back takes", default: 1.4, min: 0.6, max: 2.5, step: 0.1, unit: "s" },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "card", type: "color", label: "Window frame colour", default: tokens.colors.card ?? "#1b2236" },
      { id: "ink", type: "color", label: "Title colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "accent", type: "color", label: "Accent colour of the glow and the skeleton", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Window size, 1 = the format's default", default: 1, min: 0.6, max: 1.1, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${WINDOW_DOTS_CSS}
      #bg { position: absolute; inset: 0; }
      #glow { position: absolute; left: 50%; top: 50%; border-radius: 50%; }
      #world { position: absolute; inset: 0; }
      #window { position: absolute; overflow: hidden; box-shadow: 0 2.2em 5em rgba(0, 0, 0, 0.45); font-family: ${fonts.ui}; }
      #bar { display: flex; align-items: center; gap: 1em; padding: 0 1em; }
      #screen { position: relative; overflow: hidden; }
      #skeleton, #shot { position: absolute; inset: 0; width: 100%; height: 100%; }
      #shot { object-fit: cover; }
      #skeleton i { position: absolute; display: block; border-radius: 0.5em; }
      #words { position: absolute; left: 0; width: 100%; display: flex; flex-direction: column; align-items: center; text-align: center; }
      #title { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.1; letter-spacing: -0.01em; }
      #caption { font-family: ${fonts.ui}; font-weight: 500; line-height: 1.25; }
      /* The mask clips a line while it travels; the padding keeps accents and descenders inside it. */
      .mask { overflow: hidden; padding: 0.1em 0.04em 0.16em; margin: -0.1em -0.04em -0.16em; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="pull-back-reveal-clip" class="clip">
        <div id="bg"></div>
        <i id="glow"></i>
        <div id="world">
          <div id="window">
            <div id="bar">${WINDOW_DOTS_HTML}</div>
            <div id="screen">
              <div id="skeleton"><i></i><i></i><i></i><i></i><i></i><i></i></div>
              <img id="shot" alt="" />
            </div>
          </div>
        </div>
        <div id="words">
          <div class="mask"><div id="title"></div></div>
          <div class="mask"><div id="caption"></div></div>
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

      // Layout per format: the window's box as fractions of the frame, and the title's size (a fraction of the short side).
      // The window is 16:10 with its bar; the title goes in the room under it. wide, square, tall.
      var L = M.pick({ w: 0.66, h: 0.66, y: 0.43, title: 0.06 }, { w: 0.78, h: 0.62, y: 0.4, title: 0.06 }, { w: 0.86, h: 0.5, y: 0.38, title: 0.058 });
      var aspect = 1.6;
      var winW = Math.min(L.w * S.width * P.size, L.h * S.height * P.size * aspect);
      var winH = winW / aspect;
      var winX = (S.width - winW) / 2;
      var winY = L.y * S.height - winH / 2;

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";
      var glow = document.getElementById("glow");
      glow.style.width = winW * 1.5 + "px";
      glow.style.height = winH * 1.3 + "px";
      glow.style.marginLeft = -winW * 0.75 + "px";
      glow.style.marginTop = -winH * 0.65 + "px";
      glow.style.top = L.y * 100 + "%";
      glow.style.background = "radial-gradient(ellipse at center, " + P.accent + " 0%, rgba(0, 0, 0, 0) 66%)";

      var barH = Math.max(18, winW * 0.05);
      var win = document.getElementById("window");
      win.style.cssText += "left:" + winX + "px;top:" + winY + "px;width:" + winW + "px;height:" + winH + "px;border-radius:" + winW * 0.012 + "px;background:" + P.card + ";color:" + onColor(P.card) + ";font-size:" + barH * 0.42 + "px;";
      document.getElementById("bar").style.height = barH + "px";
      document.getElementById("screen").style.height = winH - barH + "px";

      // The picture, or a plain app skeleton: a light page, an accent header, a stat tile in the upper right (where the default
      // detail is), grey blocks.
      var shot = document.getElementById("shot");
      var skeleton = document.getElementById("skeleton");
      skeleton.style.background = "#eef1f7";
      var blocks = [[0, 0, 100, 13, P.accent], [6, 20, 52, 30, "#d9deea"], [64, 20, 30, 30, mix(P.accent, "#ffffff", 0.62)], [6, 58, 88, 5, "#d9deea"], [6, 68, 60, 5, "#d9deea"], [6, 78, 74, 5, "#d9deea"]];
      Array.prototype.forEach.call(skeleton.children, function (el, i) {
        el.style.left = blocks[i][0] + "%";
        el.style.top = blocks[i][1] + "%";
        el.style.width = blocks[i][2] + "%";
        el.style.height = blocks[i][3] + "%";
        el.style.background = blocks[i][4];
        if (i === 0) el.style.borderRadius = "0";
      });
      if (P.picture) shot.src = P.picture;
      else shot.style.display = "none";

      // The detail in frame coordinates, and the camera: a scale about it, with the shift that brings it to the frame's centre.
      var fx = winX + P.focusX * winW;
      var fy = winY + barH + P.focusY * (winH - barH);
      var world = document.getElementById("world");
      world.style.transformOrigin = fx + "px " + fy + "px";

      var words = document.getElementById("words");
      var title = document.getElementById("title");
      var caption = document.getElementById("caption");
      var titlePx = L.title * unit;
      var below = winY + winH;
      words.style.top = below + (S.height - below) * 0.2 + "px";
      title.textContent = P.title;
      title.style.fontSize = Math.min(titlePx, (0.9 * S.width) / (Math.max(1, String(P.title).length) * 0.55)) + "px";
      title.style.color = P.ink;
      caption.textContent = P.caption;
      caption.style.fontSize = titlePx * 0.5 + "px";
      caption.style.color = mix(P.ink, P.bg, 0.3);
      caption.style.marginTop = titlePx * 0.25 + "px";
      var rise = titlePx * 1.2;

      var D = S.duration;
      var OUT = 0.3;
      // The pull-back must finish, and the title show for a beat, before the exit: a late start is pulled in.
      var PULL = Math.min(P.pullTime, Math.max(0.4, D - OUT - 1.2));
      var AT = Math.min(P.pullAt, Math.max(0.1, D - OUT - 0.9 - PULL));
      var TITLE_AT = AT + PULL * 0.75;

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(bg, { opacity: M.ease("enter", t / 0.3) });
        // k is how far the camera is still in, 1 at the start and 0 once pulled back; the held opening creeps in a little.
        var k = 1 - M.ease("camera", (t - AT) / PULL);
        var creep = 1 + 0.04 * Math.min(1, t / AT) * k;
        var zoom = 1 + (P.zoom - 1) * k;
        var settle = 1 + 0.02 * Math.min(1, Math.max(0, (t - AT - PULL) / (D - AT - PULL)));
        put(world, { x: (S.width / 2 - fx) * k, y: (S.height / 2 - fy) * k, scale: zoom * creep * settle * (1 - 0.02 * out), opacity: M.ease("enter", t / 0.3) * (1 - out) });
        M.write(glow, { opacity: 0.4 * M.ease("enter", (t - 0.1) / 0.5) * (1 - k) * (1 - out) });
        var s = M.spring("heavy", t - TITLE_AT);
        put(title, { y: (1 - s) * rise, opacity: M.ease("enter", (t - TITLE_AT) / 0.25) * (1 - out) });
        put(caption, { y: (1 - M.spring("heavy", t - TITLE_AT - 0.12)) * rise, opacity: 0.85 * M.ease("enter", (t - TITLE_AT - 0.12) / 0.25) * (1 - out) });
      });
    </script>
  </body>
</html>
`;
  },
};
