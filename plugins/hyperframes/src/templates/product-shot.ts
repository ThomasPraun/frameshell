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
import { SHADOWS_VARIABLE, STUDIO_SCRIPT, type ThreeTemplate, threePageHead } from "./three-kit.js";

/**
 * 3D product shot (#473, ADR 0042): a product in studio light (the built-in rounded box, or a GLB from the
 * composition directory) arrives on a camera push-in, a glint light sweeps across it, it turns slowly while the
 * camera creeps and orbits, and a headline rises under it. three.js on the motion runtime's clock: every pose
 * is a function of t. Transparent unless `backdrop` is raised.
 */
export const productShot: ThreeTemplate = {
  id: "product-shot",
  three: true,
  description: "3D product shot: a product (built-in box or your GLB) in studio light with a glint, slow turn and headline; transparent unless a background is set",
  defaultDuration: 6,
  overlay: true,
  variables({ tokens }: TemplateInput): TemplateVariable[] {
    return [
      { id: "title", type: "string", label: "Headline under the product, empty shows none", default: tokens.brand.product ?? "Your product", maxLength: 40 },
      {
        id: "model",
        type: "string",
        label: "GLB model inside this composition's directory (e.g. product.glb, uncompressed); empty shows the built-in box",
        default: "",
        maxLength: 200,
      },
      {
        id: "label",
        type: "image",
        label: "Picture on the front of the built-in box",
        default: "",
        description: "Path of an image inside this composition's directory, e.g. label.png; empty shows a plain accent panel",
      },
      { id: "color", type: "color", label: "Body colour of the built-in box", default: "#e9e6e1" },
      { id: "accent", type: "color", label: "Front panel colour of the built-in box", default: tokens.colors.accent ?? PLACEHOLDER.accent },
      { id: "ink", type: "color", label: "Headline colour", default: tokens.colors.ink ?? PLACEHOLDER.ink },
      {
        id: "finish",
        type: "enum",
        label: "Surface of the built-in box",
        default: "satin",
        options: [
          { value: "satin", label: "Satin ceramic" },
          { value: "gloss", label: "Gloss with clearcoat" },
          { value: "chrome", label: "Chrome" },
          { value: "matte", label: "Matte" },
        ],
      },
      { id: "spin", type: "number", label: "How far the product turns over the clip, degrees", default: 40, min: 0, max: 360, step: 5, unit: "°" },
      { id: "orbit", type: "number", label: "Camera orbit over the clip, degrees", default: 8, min: 0, max: 20, step: 1, unit: "°" },
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
         does not wait for one; __hf.buildReady holds it until the model and label have loaded. -->
    <div id="stage" data-composition-id="${id}" data-width="${width}" data-height="${height}" data-duration="${duration}">
      <div id="product-shot-clip" class="clip">
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

      // Per format: how much of the frame height and width the product fills, headline size and gap from the
      // bottom edge (fractions of the short side), and how far the product sits above the frame centre. wide, square, tall.
      var L = M.pick(
        { fillH: 0.56, fillW: 0.4, title: 0.075, bottom: 0.08, raise: 0.06 },
        { fillH: 0.5, fillW: 0.5, title: 0.08, bottom: 0.09, raise: 0.07 },
        { fillH: 0.4, fillW: 0.62, title: 0.085, bottom: 0.14, raise: 0.06 }
      );
      var canvas = document.getElementById("scene");
      var room = studio(canvas, S.width, S.height, P.shadows);
      var scene = room.scene, camera = room.camera, renderer = room.renderer;

      // The product: 1 unit = 10 cm, standing on the ground (y = 0), 1.6 high.
      var HIGH = 1.6, WIDE = 1.0, DEEP = 0.36;
      var FINISH = {
        satin: { roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.2, metalness: 0 },
        gloss: { roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, metalness: 0 },
        chrome: { roughness: 0.05, clearcoat: 0, clearcoatRoughness: 0, metalness: 1 },
        matte: { roughness: 0.7, clearcoat: 0, clearcoatRoughness: 0, metalness: 0, specularIntensity: 0.3 },
      }[P.finish] || {};
      var hero = new THREE.Group();
      var turn = new THREE.Group();
      hero.add(turn);
      scene.add(hero);
      function shadowed(object) {
        object.traverse(function (o) { if (o.isMesh) { o.castShadow = P.shadows !== "off"; o.receiveShadow = P.shadows !== "off"; } });
        return object;
      }
      var box = new THREE.Group();
      var body = new THREE.Mesh(new THREE.RoundedBoxGeometry(WIDE, HIGH, DEEP, 5, 0.07), new THREE.MeshPhysicalMaterial(Object.assign({ color: P.color }, FINISH)));
      body.position.y = HIGH / 2;
      var panel = new THREE.Mesh(
        new THREE.RoundedBoxGeometry(WIDE * 0.72, HIGH * 0.5, 0.02, 3, 0.008),
        new THREE.MeshPhysicalMaterial({ color: P.accent, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.1 })
      );
      panel.position.set(0, HIGH * 0.55, DEEP / 2 + 0.006);
      box.add(body, panel);

      // The render waits for these loads (ready); a missing file fails the render with its path.
      function load(loader, path, use) {
        return loader.loadAsync(path).then(use, function (error) {
          throw new Error("product-shot cannot load " + path + ": " + (error && error.message ? error.message : error));
        });
      }
      var loads = [];
      if (P.model) {
        loads.push(load(new THREE.GLTFLoader(), P.model, function (gltf) {
          var model = gltf.scene;
          var bounds = new THREE.Box3().setFromObject(model);
          var size = bounds.getSize(new THREE.Vector3());
          var fit = 1 / Math.max(size.y / HIGH, size.x / WIDE / 1.1, size.z / WIDE / 1.1, 1e-6);
          model.scale.setScalar(fit);
          model.position.set(-(bounds.min.x + size.x / 2) * fit, -bounds.min.y * fit, -(bounds.min.z + size.z / 2) * fit);
          turn.add(shadowed(model));
        }));
      } else turn.add(shadowed(box));
      if (P.label && !P.model) {
        loads.push(load(new THREE.TextureLoader(), P.label, function (texture) {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
          panel.material.color.set("#ffffff");
          panel.material.map = texture;
          panel.material.needsUpdate = true;
        }));
      }

      // A narrow glint light sweeps across the front once, early (the hook).
      var glint = new THREE.SpotLight(0xffffff, 0, 0, 0.09, 0.9, 2);
      glint.target = hero;
      scene.add(glint);

      // Camera distance that fits the product to the format's share of the frame, height and width.
      var tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      var dist = Math.max(HIGH / (2 * tan * L.fillH * P.size), (WIDE * 1.15) / (2 * tan * (S.width / S.height) * L.fillW * P.size));
      var aimY = HIGH / 2 - 2 * dist * tan * L.raise;

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
        // Arrival: a push-in from 35 % farther that settles at 1.2 s, then a slow creep in that never parks.
        var push = 1 + 0.35 * (1 - M.ease("snap", t / 1.2)) - 0.04 * u;
        var a = rad(P.orbit) * (u - 0.5);
        camera.position.set(Math.sin(a) * dist * push, aimY + dist * push * 0.18, Math.cos(a) * dist * push);
        camera.lookAt(0, aimY, 0);
        // The product turns into place on a heavy spring, then keeps turning slowly by the spin prop, a three-quarter
        // view in the middle of the clip.
        turn.rotation.y = rad(-28) * (1 - M.spring("heavy", t - 0.1)) + rad(-25) + rad(P.spin) * (u - 0.5);
        hero.position.y = -0.04 * (1 - M.spring("heavy", t - 0.1));
        var g = Math.min(1, Math.max(0, (t - 0.25) / 0.7));
        glint.intensity = 250 * Math.sin(Math.PI * g);
        glint.position.set(-3 + 6 * M.ease("camera", g), 2.4, 4);
        var s = M.spring("heavy", t - 0.9);
        M.write(titleEl, { y: (1 - s) * rise, opacity: M.ease("enter", (t - 0.9) / 0.3) * (1 - out) });
        renderer.render(scene, camera);
      }
      // Loads finish after the first paint; the live page gets no new seek, so paint the last frame again.
      // A failed load is reported by the runtime under the buildReady key.
      ready("product-shot", Promise.all(loads)).then(function () { paint(last); }, function () {});
      M.bind("${id}", paint);
    </script>
  </body>
</html>
`);
  },
};
