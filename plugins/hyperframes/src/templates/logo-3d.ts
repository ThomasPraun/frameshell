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
 * 3D logo (#473, ADR 0042): an SVG logo from the composition directory (or a built-in mark) is extruded with
 * three.js `SVGLoader` and `ExtrudeGeometry`, lit in the shared studio, and reveals itself (the depth rises out of
 * the flat logo, the logo swings in, or it drops in) before a slow turn, a glint sweep and an optional headline.
 * Filled paths only: strokes, text, images, gradients and `<use>` are not extruded (outline them first). Every pose
 * is a function of t on the motion runtime's clock. Transparent unless `backdrop` is raised.
 */
export const logo3d: ThreeTemplate = {
  id: "logo-3d",
  three: true,
  description: "3D logo: your SVG logo extruded in studio light with a short reveal (rise, swing or drop), glint and slow turn; transparent unless a background is set",
  defaultDuration: 4,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      {
        id: "logo",
        type: "image",
        label: "Logo to extrude",
        default: "",
        description: "Path of an SVG inside this composition's directory, e.g. brand/logo.svg (filled paths only: outline strokes and text first); empty shows a built-in mark",
      },
      { id: "title", type: "string", label: "Headline under the logo, empty shows none", default: tokens.brand.product ?? "", maxLength: 40 },
      { id: "depth", type: "number", label: "Depth of the extrusion, as a fraction of the logo's longer side", default: 0.12, min: 0.02, max: 0.5, step: 0.01 },
      { id: "bevel", type: "number", label: "Edge rounding, 0 = sharp edges", default: 0.5, min: 0, max: 1, step: 0.05 },
      {
        id: "colors",
        type: "enum",
        label: "Colours: one for the whole logo, or the fill of each path in the SVG",
        default: "single",
        options: [
          { value: "single", label: "One colour" },
          { value: "svg", label: "The SVG's own fills" },
        ],
      },
      { id: "color", type: "color", label: "Logo colour when one colour is used", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      finishVariable("Surface of the logo"),
      {
        id: "reveal",
        type: "enum",
        label: "How the logo arrives",
        default: "rise",
        options: [
          { value: "rise", label: "Depth rises out of the flat logo" },
          { value: "turn", label: "Swings in from the side" },
          { value: "drop", label: "Drops in and settles" },
        ],
      },
      { id: "spin", type: "number", label: "How far the logo turns over the clip, degrees", default: 24, min: 0, max: 90, step: 2, unit: "°" },
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
      #title { font-family: ${fonts.display}; font-weight: ${fonts.displayWeight}; line-height: 1.05; letter-spacing: -0.01em; text-align: center; }`;
    return trimScript(`${threePageHead(input, this.variables(input), css)}
  <body>
    <!-- Root: size and length of the render. FrameshellMotion.bind below registers its timeline, so the render
         does not wait for one; __hf.buildReady holds it until the SVG has loaded and been extruded. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="logo-3d-clip" class="clip">
        <div id="backdrop"></div>
        <canvas id="scene"></canvas>
        <div id="caption"><div class="mask"><h1 id="title"></h1></div></div>
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

      // Per format: how much of the frame height and width the logo fills, headline size and gap from the bottom
      // edge (fractions of the short side), and how far the logo sits above the frame centre when there is a headline.
      var L = M.pick(
        { fillH: 0.5, fillW: 0.42, title: 0.07, bottom: 0.09, raise: 0.07 },
        { fillH: 0.5, fillW: 0.6, title: 0.08, bottom: 0.1, raise: 0.07 },
        { fillH: 0.36, fillW: 0.68, title: 0.085, bottom: 0.16, raise: 0.05 }
      );
      var canvas = document.getElementById("scene");
      var room = studio(canvas, S.width, S.height, P.shadows);
      var scene = room.scene, camera = room.camera, renderer = room.renderer;
      var shadowed = P.shadows !== "off";

      // The logo's longer side is SPAN world units; it hangs 0.12 in front of a wall that only catches its shadow.
      var SPAN = 2;
      room.ground.rotation.x = 0;
      room.ground.position.set(0, 0, -0.12);
      var FINISH = ${FINISH_PRESETS}[P.finish] || {};
      var hero = new THREE.Group();
      var turn = new THREE.Group();
      // SVG y runs down: the flip is a negative y scale, which three.js handles by mirroring the face winding.
      var flip = new THREE.Group();
      hero.add(turn);
      turn.add(flip);
      scene.add(hero);

      // Built-in mark: a hexagon with a hexagonal hole, so the default shows holes extruding correctly.
      var MARK = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><path fill='#4f46e5' fill-rule='evenodd' d='M50 4 L92 28 L92 72 L50 96 L8 72 L8 28 Z M50 28 L72 40 L72 60 L50 72 L28 60 L28 40 Z'/></svg>";
      var worldW = SPAN, worldH = SPAN;
      var unitScale = 1;

      // Extrudes every filled path of the SVG text into flip, centred on the origin and SPAN units on its longer side.
      function build(text) {
        var parts = [];
        new THREE.SVGLoader().parse(text).paths.forEach(function (path) {
          var style = path.userData && path.userData.style;
          if (!style || !style.fill || style.fill === "none" || style.fill.indexOf("url") === 0) return;
          var shapes = THREE.SVGLoader.createShapes(path);
          if (shapes.length > 0) parts.push({ shapes: shapes, color: path.color });
        });
        if (parts.length === 0) throw new Error("logo-3d: " + (P.logo || "the built-in mark") + " has no filled paths (strokes, text, images and gradients are not extruded: outline strokes and text, use flat fills)");
        var flat = new THREE.Box3();
        parts.forEach(function (part) {
          var geometry = new THREE.ShapeGeometry(part.shapes, 4);
          geometry.computeBoundingBox();
          flat.union(geometry.boundingBox);
          geometry.dispose();
        });
        var size = flat.getSize(new THREE.Vector3());
        var span = Math.max(size.x, size.y, 1e-6);
        var depth = P.depth * span;
        var edge = P.bevel * Math.min(depth * 0.25, span * 0.01);
        var solid = new THREE.Box3();
        var meshes = parts.map(function (part) {
          var geometry = new THREE.ExtrudeGeometry(part.shapes, {
            depth: depth,
            curveSegments: 12,
            bevelEnabled: edge > 0,
            bevelThickness: edge,
            bevelSize: edge,
            bevelSegments: 3,
          });
          geometry.computeBoundingBox();
          solid.union(geometry.boundingBox);
          var material = new THREE.MeshPhysicalMaterial(Object.assign({ color: P.colors === "svg" ? part.color : new THREE.Color(P.color) }, FINISH));
          var mesh = new THREE.Mesh(geometry, material);
          mesh.castShadow = shadowed;
          return mesh;
        });
        var centre = solid.getCenter(new THREE.Vector3());
        meshes.forEach(function (mesh) {
          mesh.geometry.translate(-centre.x, -centre.y, -centre.z);
          flip.add(mesh);
        });
        var whole = solid.getSize(new THREE.Vector3());
        unitScale = SPAN / Math.max(whole.x, whole.y, 1e-6);
        worldW = whole.x * unitScale;
        worldH = whole.y * unitScale;
        flip.scale.set(unitScale, -unitScale, unitScale);
        room.ground.position.z = -(whole.z * unitScale) / 2 - 0.12;
        frameCamera();
      }

      // Camera distance that fits the logo to the format's share of the frame, height and width.
      var tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      var dist = 1, aimY = 0;
      function frameCamera() {
        dist = Math.max(worldH / (2 * tan * L.fillH * P.size), worldW / (2 * tan * (S.width / S.height) * L.fillW * P.size));
        aimY = P.title ? -2 * dist * tan * L.raise : 0;
      }
      room.ground.visible = shadowed;
      frameCamera();

      // A narrow glint light sweeps across the face once, early.
      var glint = new THREE.SpotLight(0xffffff, 0, 0, 0.09, 0.9, 2);
      glint.target = hero;
      scene.add(glint);

      var titleEl = document.getElementById("title");
      var caption = document.getElementById("caption");
      titleEl.textContent = P.title;
      titleEl.style.color = P.ink;
      titleEl.style.fontSize = L.title * unit * P.size + "px";
      caption.style.bottom = L.bottom * unit + "px";
      if (!P.title) caption.style.display = "none";
      var rise = L.title * unit * 1.3;

      var D = S.duration;
      var OUT = 0.4;
      var rad = THREE.MathUtils.degToRad;
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
        // The reveal, then a slow turn by the spin prop that never parks.
        var arrive = M.spring("heavy", t - 0.1);
        var depthK = 1, yaw = 0, drop = 0, tilt = 0;
        if (P.reveal === "rise") {
          depthK = 0.03 + 0.97 * arrive;
          yaw = rad(-32) * (1 - arrive);
        } else if (P.reveal === "turn") {
          yaw = rad(-110) * (1 - arrive);
        } else {
          var fall = M.spring("default", t - 0.05);
          drop = 1.4 * (1 - fall);
          tilt = rad(9) * (1 - fall);
        }
        turn.rotation.set(0, yaw + rad(P.spin) * (u - 0.5), tilt);
        hero.position.y = drop;
        flip.scale.set(unitScale, -unitScale, unitScale * depthK);
        var g = Math.min(1, Math.max(0, (t - 0.45) / 0.7));
        glint.intensity = 250 * Math.sin(Math.PI * g);
        glint.position.set(-3 + 6 * M.ease("camera", g), 2.4, 4);
        var s = M.spring("heavy", t - 0.9);
        M.write(titleEl, { y: (1 - s) * rise, opacity: M.ease("enter", (t - 0.9) / 0.3) * (1 - out) });
        renderer.render(scene, camera);
      }
      // The built-in mark is there from the first frame; a supplied SVG loads before frame 0 (ready) and the page
      // repaints once it has: the live page gets no new seek. A failed load or an SVG with nothing to extrude is
      // reported by the runtime under the buildReady key.
      ${loadScript("logo-3d")}
      var loaded;
      if (P.logo) {
        if (P.logo.toLowerCase().split("?")[0].split("#")[0].slice(-4) !== ".svg") loaded = Promise.reject(new Error("logo-3d extrudes an SVG, got " + P.logo + " (a PNG or JPG has no outline to extrude: use the logo's SVG)"));
        else loaded = load(new THREE.FileLoader(), P.logo, build);
      } else {
        build(MARK);
        loaded = Promise.resolve();
      }
      ready("logo-3d", loaded).then(function () { paint(last); }, function () {});
      M.bind("${id}", paint);
    </script>
  </body>
</html>
`);
  },
};
