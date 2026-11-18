import { TITLE_TYPEFACE, TITLE_TYPEFACE_FILE } from "../title-typeface.js";
import {
  BACKDROP_CSS,
  BACKDROP_SETUP,
  COLOR_HELPERS,
  PLACEHOLDER,
  type TemplateInput,
  type TemplateVariable,
  backdropVariables,
  fontSetup,
  trimScript,
} from "./kit.js";
import { FINISH_PRESETS, SHADOWS_VARIABLE, STUDIO_SCRIPT, type ThreeTemplate, finishVariable, loadScript, threePageHead } from "./three-kit.js";

/**
 * 3D title (#473, ADR 0042): a short text of extruded Archivo Black letters (the typeface JSON the plugin ships,
 * `pnpm gen:typeface`), lit in the shared studio. The text is laid out in at most three lines that shrink to the
 * format's width, and the letters arrive together (the depth rises out of the flat text) or one by one on a spring
 * stagger (swing in, or drop in) before a slow turn, a glint sweep and an optional headline. A character the typeface
 * lacks fails the render naming it. Every pose is a function of t on the motion runtime's clock. Transparent unless
 * `backdrop` is raised.
 */
export const title3d: ThreeTemplate = {
  id: "title-3d",
  three: true,
  assets: [{ file: TITLE_TYPEFACE_FILE, text: TITLE_TYPEFACE }],
  description: "3D title: extruded letters of Archivo Black in studio light, arriving together or letter by letter, with glint and slow turn; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "text",
        type: "string",
        label: "The title: up to 3 lines (a line break is \\n; long lines wrap and shrink to fit). Printable Latin only: ASCII, Latin-1 accents, common punctuation and the euro sign",
        default: tokens.brand.product ?? "Big idea",
        maxLength: 60,
      },
      { id: "subtitle", type: "string", label: "Headline under the title, empty shows none", default: "", maxLength: 60 },
      { id: "depth", type: "number", label: "Depth of the letters, as a fraction of their size", default: 0.3, min: 0.05, max: 1, step: 0.05 },
      { id: "bevel", type: "number", label: "Edge rounding, 0 = sharp edges", default: 0.5, min: 0, max: 1, step: 0.05 },
      {
        id: "colors",
        type: "enum",
        label: "Colours: one for every letter, or a blend from the first colour to the second across the title",
        default: "single",
        options: [
          { value: "single", label: "One colour" },
          { value: "blend", label: "Blend of two colours" },
        ],
      },
      { id: "color", type: "color", label: "Letter colour (first colour of a blend)", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "color2", type: "color", label: "Last colour of a blend", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      finishVariable("Surface of the letters", "gloss"),
      {
        id: "reveal",
        type: "enum",
        label: "How the title arrives",
        default: "letters",
        options: [
          { value: "letters", label: "Letters swing in one after another" },
          { value: "rise", label: "Depth rises out of the flat text" },
          { value: "drop", label: "Letters drop in one after another" },
        ],
      },
      { id: "spin", type: "number", label: "How far the title turns over the clip, degrees", default: 16, min: 0, max: 60, step: 2, unit: "°" },
      { id: "ink", type: "color", label: "Headline colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      { id: "size", type: "number", label: "Size, 1 = the format's default", default: 1, min: 0.5, max: 1.4, step: 0.05 },
      SHADOWS_VARIABLE,
      ...backdropVariables(tokens),
    ];
  },
  render(input: TemplateInput): string {
    const { id, width, height, duration } = input;
    const fonts = fontSetup(input.tokens);
    const css = `
      ${BACKDROP_CSS}
      #scene { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
      #caption { position: absolute; left: 6%; right: 6%; display: flex; justify-content: center; }
      .mask { overflow: hidden; padding: 0.08em 0.04em 0.14em; margin: -0.08em -0.04em -0.14em; }
      #subtitle { font-family: ${fonts.ui}; font-weight: 600; line-height: 1.1; letter-spacing: 0.01em; text-align: center; }`;
    return trimScript(`${threePageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one; __hf.buildReady holds it until the typeface has loaded and the letters are built. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="title-3d-clip" class="clip">
        <div id="backdrop"></div>
        <canvas id="scene"></canvas>
        <div id="caption"><div class="mask"><h2 id="subtitle"></h2></div></div>
      </div>
    </div>
    <script>
      var M = window.FrameshellMotion;
      var P = M.props();
      var S = M.stage();
      var unit = Math.min(S.width, S.height);
      ${COLOR_HELPERS}
      ${BACKDROP_SETUP}
      ${STUDIO_SCRIPT}

      // Per format (wide, square, tall): the share of the frame width the title may fill, the letter size as a share
      // of the frame height, headline size and gap from the bottom edge (fractions of the short side), and how far
      // the title sits above the frame centre when there is a headline.
      var L = M.pick(
        { fillW: 0.8, size: 0.28, sub: 0.06, bottom: 0.09, raise: 0.07 },
        { fillW: 0.84, size: 0.22, sub: 0.065, bottom: 0.1, raise: 0.07 },
        { fillW: 0.88, size: 0.11, sub: 0.07, bottom: 0.16, raise: 0.05 }
      );
      var canvas = document.getElementById("scene");
      var room = studio(canvas, S.width, S.height, P.shadows);
      var scene = room.scene, camera = room.camera, renderer = room.renderer;
      var shadowed = P.shadows !== "off";
      var rad = THREE.MathUtils.degToRad;

      // World units: the title is at most AVAIL wide, whatever the format; the camera frames that width as the
      // format's share, so the shadow wall and the shadow camera of the studio always cover it.
      var AVAIL = 3.6, MAX_LINES = 3, MIN_SCALE = 0.4;
      var tan = Math.tan(rad(camera.fov / 2));
      var baseH = AVAIL / L.fillW / (S.width / S.height);
      var SIZE = L.size * baseH;
      var frameH = baseH / P.size;
      var dist = frameH / (2 * tan);
      var aimY = P.subtitle ? -L.raise * frameH : 0;
      room.ground.rotation.x = 0;
      room.ground.visible = shadowed;
      var FINISH = ${FINISH_PRESETS}[P.finish] || {};
      var hero = new THREE.Group();
      scene.add(hero);
      var letters = [];
      var DEPTH = P.depth;

      // The typeface's own numbers in em (1 = the letter size): advance, and the ink edges of a glyph.
      var font, glyphs, RES;
      function glyph(ch) { return glyphs[ch]; }
      function advance(ch) { return glyph(ch).ha / RES; }
      function inkWidth(line) {
        var chars = Array.from(line);
        var total = 0;
        chars.forEach(function (ch) { total += advance(ch); });
        var first = glyph(chars[0]), last = glyph(chars[chars.length - 1]);
        return total - (first.o ? first.x_min / RES : 0) - (last.o ? (last.ha - last.x_max) / RES : 0);
      }
      function wrap(line, cap) {
        var lines = [], current = "";
        line.split(" ").filter(Boolean).forEach(function (word) {
          var next = current ? current + " " + word : word;
          if (current && inkWidth(next) > cap) { lines.push(current); current = word; } else current = next;
        });
        if (current) lines.push(current);
        return lines;
      }
      // At most MAX_LINES lines at the largest scale (1 down to MIN_SCALE) where the widest line fits AVAIL.
      function layout(text) {
        var given = text.split("\\n").map(function (line) { return line.trim(); }).filter(Boolean);
        if (given.length === 0) throw new Error("title-3d needs a text: the title prop is empty");
        if (given.length > MAX_LINES) throw new Error("title-3d shows at most " + MAX_LINES + " lines, the text has " + given.length + " (join some with spaces)");
        var avail = AVAIL / SIZE, lines = [];
        for (var s = 1; s > MIN_SCALE - 1e-6; s -= 0.1) {
          lines = [];
          given.forEach(function (line) { wrap(line, avail / s).forEach(function (part) { lines.push(part); }); });
          var widest = Math.max.apply(null, lines.map(inkWidth));
          if (lines.length <= MAX_LINES && widest * s <= avail + 1e-6) return { lines: lines, scale: s };
        }
        if (lines.length > MAX_LINES) throw new Error("title-3d: the text does not fit in " + MAX_LINES + " lines even at " + MIN_SCALE * 100 + " % size, shorten it");
        return { lines: lines, scale: Math.min(MIN_SCALE, avail / widest) };
      }

      // Builds one extruded mesh per drawn letter, centred on its own middle so it can turn and drop in place.
      function build(face) {
        font = face;
        glyphs = face.data.glyphs;
        RES = face.data.resolution;
        Array.from(P.text).forEach(function (ch) {
          if (ch === "\\n") return;
          if (!glyphs[ch]) {
            var code = ch.codePointAt(0).toString(16).toUpperCase();
            throw new Error("title-3d: the title typeface (${TITLE_TYPEFACE_FILE}) has no glyph for " + JSON.stringify(ch) + " (U+" + ("0000" + code).slice(-Math.max(4, code.length)) + "); it covers ASCII, Latin-1 and common punctuation, so use another character");
          }
        });
        var plan = layout(P.text);
        var scale = SIZE * plan.scale;
        var edge = P.bevel * Math.min(DEPTH * 0.25, 0.02);
        var cache = {};
        function shape(ch) {
          if (cache[ch]) return cache[ch];
          var geometry = new THREE.TextGeometry(ch, { font: font, size: 1, depth: DEPTH, curveSegments: 6, bevelEnabled: edge > 0, bevelThickness: edge, bevelSize: edge, bevelOffset: -edge, bevelSegments: 2 });
          geometry.computeBoundingBox();
          var centre = geometry.boundingBox.getCenter(new THREE.Vector3());
          geometry.translate(-centre.x, -centre.y, -centre.z);
          return (cache[ch] = { geometry: geometry, centre: centre });
        }
        var cap = shape("H").geometry.boundingBox;
        var capH = cap.max.y - cap.min.y;
        var lineH = 1.05 * scale;
        var drawn = [];
        plan.lines.forEach(function (line, row) {
          var chars = Array.from(line);
          var first = glyph(chars[0]);
          var x = -(inkWidth(line) / 2) - (first.o ? first.x_min / RES : 0);
          var base = ((plan.lines.length - 1) / 2 - row) * lineH - (capH * scale) / 2;
          chars.forEach(function (ch) {
            if (glyph(ch).o) drawn.push({ ch: ch, x: x * scale, y: base });
            x += advance(ch);
          });
        });
        var shared = new THREE.MeshPhysicalMaterial(Object.assign({ color: P.color }, FINISH));
        drawn.forEach(function (item, i) {
          var part = shape(item.ch);
          var material = shared;
          if (P.colors === "blend") material = new THREE.MeshPhysicalMaterial(Object.assign({ color: mix(P.color, P.color2, drawn.length > 1 ? i / (drawn.length - 1) : 0) }, FINISH));
          var mesh = new THREE.Mesh(part.geometry, material);
          mesh.castShadow = shadowed;
          hero.add(mesh);
          letters.push({ mesh: mesh, x: item.x + part.centre.x * scale, y: item.y + part.centre.y * scale, index: i });
        });
        room.ground.position.z = -(DEPTH * scale) / 2 - 0.12;
        unitScale = scale;
        count = drawn.length;
      }
      var unitScale = SIZE, count = 0;

      // A narrow glint light sweeps across the face once, early.
      var glint = new THREE.SpotLight(0xffffff, 0, 0, 0.09, 0.9, 2);
      glint.target = hero;
      scene.add(glint);

      var subtitleEl = document.getElementById("subtitle");
      var caption = document.getElementById("caption");
      subtitleEl.textContent = P.subtitle;
      subtitleEl.style.color = P.ink;
      subtitleEl.style.fontSize = L.sub * unit * P.size + "px";
      caption.style.bottom = L.bottom * unit + "px";
      if (!P.subtitle) caption.style.display = "none";
      var rise = L.sub * unit * 1.3;

      var D = S.duration;
      var OUT = 0.4;
      var last = 0;
      function paint(t) {
        last = t;
        var out = M.ease("exit", (t - (D - OUT)) / OUT);
        var u = Math.min(1, Math.max(0, t / D));
        M.write(backdrop, { opacity: P.backdrop * M.ease("enter", t / 0.3) * (1 - out) });
        M.write(canvas, { opacity: M.ease("enter", t / 0.25) * (1 - out) });
        var push = 1 + 0.3 * (1 - M.ease("snap", t / 1.2)) - 0.04 * u;
        camera.position.set(0, aimY + dist * push * 0.1, dist * push);
        camera.lookAt(0, aimY, 0);
        // One arrival for the whole title (rise), or one spring per letter, each a stagger step after the last.
        var arrive = M.spring("heavy", t - 0.1);
        var whole = P.reveal === "rise";
        hero.rotation.y = (whole ? rad(-32) * (1 - arrive) : 0) + rad(P.spin) * (u - 0.5);
        letters.forEach(function (letter) {
          var mesh = letter.mesh;
          var a = whole ? 1 : M.spring(P.reveal === "drop" ? "default" : "snappy", t - 0.1 - M.stagger(letter.index, count, M.STAGGER_STEPS.letters));
          var tilt = 0, lift = 0, turn = 0;
          if (P.reveal === "letters") { turn = rad(-90) * (1 - a); lift = -0.35 * unitScale * (1 - a); }
          else if (P.reveal === "drop") { lift = frameH * 0.6 * (1 - a); tilt = rad(letter.index % 2 ? 14 : -14) * (1 - a); }
          mesh.visible = a > 0.01;
          mesh.position.set(letter.x, letter.y + lift, 0);
          mesh.rotation.set(turn, 0, tilt);
          mesh.scale.set(unitScale * Math.max(a, 0.001), unitScale * Math.max(a, 0.001), unitScale * (whole ? 0.03 + 0.97 * arrive : Math.max(a, 0.001)));
        });
        var g = Math.min(1, Math.max(0, (t - 0.6) / 0.7));
        glint.intensity = 250 * Math.sin(Math.PI * g);
        glint.position.set(-3 + 6 * M.ease("camera", g), 2.4, 4);
        var s = M.spring("heavy", t - 0.9);
        M.write(subtitleEl, { y: (1 - s) * rise, opacity: M.ease("enter", (t - 0.9) / 0.3) * (1 - out) });
        renderer.render(scene, camera);
      }
      // The typeface loads before frame 0 (ready) and the page repaints once it has: the live page gets no new seek.
      // A missing or broken typeface, or a character it lacks, is reported by the runtime under the buildReady key.
      ${loadScript("title-3d")}
      var loaded = load(new THREE.FileLoader(), "${TITLE_TYPEFACE_FILE}", function (text) {
        var data;
        try { data = JSON.parse(text); } catch (error) { throw new Error("title-3d: ${TITLE_TYPEFACE_FILE} is not valid JSON (" + error.message + "): restore it with \`frameshell hyperframes update --force\`"); }
        if (!data || !data.glyphs || !data.resolution) throw new Error("title-3d: ${TITLE_TYPEFACE_FILE} is not a typeface (no glyphs or resolution): restore it with \`frameshell hyperframes update --force\`");
        build(new THREE.Font(data));
      });
      ready("title-3d", loaded).then(function () { paint(last); }, function () {});
      M.bind("${id}", paint);
    </script>
  </body>
</html>
`);
  },
};
