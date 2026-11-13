import {
  COLOR_HELPERS,
  PLACEHOLDER,
  type Template,
  type TemplateInput,
  type TemplateVariable,
  fontSetup,
  pageHead,
} from "./kit.js";
import { WINDOW_DOTS_CSS, WINDOW_DOTS_HTML } from "./ui-parts.js";

/**
 * Device frame (#466): a browser window or a phone around a real screenshot,
 * on a solid radial background with a soft accent glow. The device springs in
 * and the screenshot inside it pushes in slowly toward a point of interest.
 * Without a screenshot (or when its file is missing) a plain app skeleton
 * fills the screen. Paints its own background.
 */
export const deviceFrame: Template = {
  id: "device-frame",
  description: "Browser or phone frame around a screenshot with a slow push, on a solid background",
  defaultDuration: 5,
  overlay: false,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "screenshot",
        type: "image",
        label: "Screenshot",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. shot.png; empty shows a plain app skeleton",
      },
      {
        id: "frame",
        type: "enum",
        label: "Device",
        default: "browser",
        options: [
          { value: "browser", label: "Browser window" },
          { value: "phone", label: "Phone" },
        ],
      },
      { id: "url", type: "string", label: "Address shown in the browser bar; empty for none", default: tokens.brand.url ?? "frameshell.dev", maxLength: 60 },
      { id: "push", type: "number", label: "Slow push into the screenshot, percent", default: 8, min: 0, max: 25, step: 1, unit: "%" },
      { id: "focusX", type: "number", label: "Where the push heads, from the left, 0 to 1", default: 0.5, min: 0, max: 1, step: 0.05 },
      { id: "focusY", type: "number", label: "Where the push heads, from the top, 0 to 1", default: 0.35, min: 0, max: 1, step: 0.05 },
      { id: "bg", type: "color", label: "Background colour", default: tokens.colors.bg ?? PLACEHOLDER.bg },
      { id: "card", type: "color", label: "Frame colour", default: tokens.colors.card ?? "#1b2236" },
      { id: "accent", type: "color", label: "Glow behind the device", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "size", type: "number", label: "Device size, 1 = the format's default", default: 1, min: 0.6, max: 1.1, step: 0.05 },
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${WINDOW_DOTS_CSS}
      #bg { position: absolute; inset: 0; }
      #glow { position: absolute; left: 50%; top: 50%; border-radius: 50%; }
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #device { position: relative; flex: none; overflow: hidden; box-shadow: 0 2.2em 5em rgba(0, 0, 0, 0.45); font-family: ${fonts.ui}; }
      #bar { position: relative; display: flex; align-items: center; gap: 1em; padding: 0 1em; }
      #address { flex: 1; max-width: 46%; margin: 0 auto; padding: 0.25em 1em; border-radius: 999px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.85em; }
      #screen { position: relative; overflow: hidden; }
      #skeleton, #shot { position: absolute; inset: 0; width: 100%; height: 100%; }
      #shot { object-fit: cover; }
      #skeleton i { position: absolute; display: block; border-radius: 0.5em; }
      #island { position: absolute; left: 50%; top: 2.2%; width: 28%; height: 3.2%; margin-left: -14%; border-radius: 999px; background: #05060a; }`;
    return `${pageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="device-frame-clip" class="clip">
        <div id="bg"></div>
        <i id="glow"></i>
        <div id="content">
          <div id="device">
            <div id="bar">${WINDOW_DOTS_HTML}<span id="address"></span></div>
            <div id="screen">
              <div id="skeleton"><i></i><i></i><i></i><i></i><i></i></div>
              <img id="shot" alt="" />
              <div id="island"></div>
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

      // Layout per format: the box the device may fill, as fractions of the frame. wide, square, tall.
      var L = M.pick({ w: 0.74, h: 0.8 }, { w: 0.8, h: 0.78 }, { w: 0.84, h: 0.76 });
      var phone = P.frame === "phone";
      // Width / height of the whole device: a browser is 16:10 with its bar, a phone 9:19.5.
      var aspect = phone ? 9 / 19.5 : 1.6;
      var devW = Math.min(L.w * S.width * P.size, L.h * S.height * P.size * aspect);
      var devH = devW / aspect;

      var bg = document.getElementById("bg");
      bg.style.background = "radial-gradient(ellipse at 50% 40%, " + mix(P.bg, "#ffffff", 0.09) + " 0%, " + P.bg + " 72%)";
      var glow = document.getElementById("glow");
      glow.style.width = devW * 1.5 + "px";
      glow.style.height = devH * 1.3 + "px";
      glow.style.marginLeft = -devW * 0.75 + "px";
      glow.style.marginTop = -devH * 0.65 + "px";
      glow.style.background = "radial-gradient(ellipse at center, " + P.accent + " 0%, rgba(0, 0, 0, 0) 66%)";

      var ink = onColor(P.card);
      var device = document.getElementById("device");
      var bar = document.getElementById("bar");
      var screenBox = document.getElementById("screen");
      device.style.width = devW + "px";
      device.style.height = devH + "px";
      device.style.background = P.card;
      device.style.color = ink;
      if (phone) {
        // A phone: a dark bezel around the screen, an island at the top, no bar.
        bar.style.display = "none";
        var bezel = devW * 0.035;
        device.style.padding = bezel + "px";
        device.style.background = "#0a0c12";
        device.style.borderRadius = devW * 0.14 + "px";
        screenBox.style.height = devH - 2 * bezel + "px";
        screenBox.style.borderRadius = devW * 0.11 + "px";
      } else {
        // A browser: a bar of 5 % of the width with the dots and the address, the screen below it.
        var barH = Math.max(18, devW * 0.05);
        device.style.borderRadius = devW * 0.012 + "px";
        device.style.fontSize = barH * 0.42 + "px";
        bar.style.height = barH + "px";
        bar.style.background = P.card;
        screenBox.style.height = devH - barH + "px";
        document.getElementById("island").style.display = "none";
        var address = document.getElementById("address");
        address.textContent = P.url;
        address.style.background = mix(P.card, ink, 0.1);
        if (!P.url) address.style.display = "none";
      }

      // The screenshot, or a plain app skeleton (light page, accent header, grey blocks) when there is none.
      var shot = document.getElementById("shot");
      var skeleton = document.getElementById("skeleton");
      skeleton.style.background = "#eef1f7";
      var blocks = [
        [0, 0, 100, 13, P.accent],
        [6, 20, 40, 30, "#d9deea"],
        [54, 20, 40, 30, "#d9deea"],
        [6, 58, 88, 5, "#d9deea"],
        [6, 68, 60, 5, "#d9deea"],
      ];
      Array.prototype.forEach.call(skeleton.children, function (el, i) {
        el.style.left = blocks[i][0] + "%";
        el.style.top = blocks[i][1] + "%";
        el.style.width = blocks[i][2] + "%";
        el.style.height = blocks[i][3] + "%";
        el.style.background = blocks[i][4];
        if (i === 0) el.style.borderRadius = "0";
      });
      skeleton.style.transformOrigin = P.focusX * 100 + "% " + P.focusY * 100 + "%";
      if (P.screenshot) {
        shot.src = P.screenshot;
        shot.style.objectPosition = P.focusX * 100 + "% " + P.focusY * 100 + "%";
        shot.style.transformOrigin = P.focusX * 100 + "% " + P.focusY * 100 + "%";
      } else {
        shot.style.display = "none";
      }

      var D = S.duration;
      var OUT = 0.3;
      var content = document.getElementById("content");

      M.bind("${id}", function (t) {
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        M.write(bg, { opacity: M.ease("enter", t / 0.3) });
        M.write(glow, { opacity: 0.4 * M.ease("enter", (t - 0.1) / 0.5) * (1 - out) });
        // The device comes up from below with a heavy spring; holds never stop, so it also pushes in slowly.
        var s = M.spring("heavy", t - 0.1);
        M.write(content, { y: (1 - s) * unit * 0.05, scale: 0.92 + 0.08 * s + 0.02 * Math.min(1, t / D) - 0.02 * out, opacity: M.ease("enter", (t - 0.1) / 0.3) * (1 - out) });
        // The push inside the screen, toward the point of interest.
        M.write(shot, { scale: 1 + (P.push / 100) * Math.min(1, t / D) });
        M.write(skeleton, { scale: 1 + (P.push / 100) * Math.min(1, t / D) });
      });
    </script>
  </body>
</html>
`;
  },
};
