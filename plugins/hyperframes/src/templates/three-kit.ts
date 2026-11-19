import { THREE_RUNTIME_FILE } from "../three-runtime.js";
import { type Template, type TemplateInput, type TemplateVariable, pageHead } from "./kit.js";

/** A file a 3D template needs beside its page, frozen per composition like the bundles (`hyperframes update` refreshes it). */
export interface ThreeAsset {
  /** Name at the composition root, never under `node_modules` (the cache key skips that directory). */
  readonly file: string;
  /** Contents; its first bytes name a Frameshell version so `update` can tell an older copy from an edited one. */
  readonly text: string;
}

/** A template whose page paints a three.js scene: scaffolding copies the three.js bundle next to it (ADR 0042). */
export interface ThreeTemplate extends Template {
  /** Marks the template as 3D. */
  readonly three: true;
  /** Files besides the bundle that scaffolding copies next to the page, e.g. the typeface of `title-3d`. */
  readonly assets?: readonly ThreeAsset[];
}

/** True when scaffolding `template` must copy {@link THREE_RUNTIME_FILE} next to the composition. */
export function usesThree(template: Template): template is ThreeTemplate {
  return (template as Partial<ThreeTemplate>).three === true;
}

/** {@link pageHead} plus the three.js bundle, which loads after the motion runtime and before the page script. */
export function threePageHead(input: TemplateInput, variables: readonly TemplateVariable[], css: string): string {
  return pageHead(input, variables, css).replace(/\n {2}<\/head>$/, `\n    <script src="${THREE_RUNTIME_FILE}"></script>\n  </head>`);
}

/** The `shadows` prop of a 3D template: soft (VSM), hard (PCF) or none. */
export const SHADOWS_VARIABLE: TemplateVariable = {
  id: "shadows",
  type: "enum",
  label: "Shadows: soft costs about twice a hard one per frame on the software renderer",
  default: "soft",
  options: [
    { value: "soft", label: "Soft" },
    { value: "hard", label: "Hard edges" },
    { value: "off", label: "None" },
  ],
};

/**
 * Page script of the studio every 3D template shares (studio defaults, ADR 0042). `studio(canvas, width,
 * height, shadows)` returns the renderer, scene, camera, key light and ground; `ready(key, promise)` holds the
 * render until the promise settles. `THREE.DefaultLoadingManager` gates nothing in three 0.187.
 */
export const STUDIO_SCRIPT = String.raw`
      function studio(canvas, width, height, shadows) {
        canvas.width = width;
        canvas.height = height;
        // Transparent clear with premultiplied alpha: the producer's screenshot keeps straight alpha.
        var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, premultipliedAlpha: true });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NeutralToneMapping;
        renderer.toneMappingExposure = 0.85;
        renderer.shadowMap.enabled = shadows !== "off";
        // three r187 has no soft PCF: soft edges need VSM, whose blur is the main cost (1024 map, radius 8, 8 taps).
        renderer.shadowMap.type = shadows === "hard" ? THREE.PCFShadowMap : THREE.VSMShadowMap;
        var scene = new THREE.Scene();
        var pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04, 0.1, 100, { size: 256 }).texture;
        scene.environmentIntensity = 0.8;
        pmrem.dispose();
        var key = new THREE.DirectionalLight(0xfff4e8, 3);
        key.position.set(-3, 5, 4);
        key.castShadow = shadows !== "off";
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.left = -2.5; key.shadow.camera.right = 2.5; key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -2.5;
        key.shadow.camera.near = 0.5; key.shadow.camera.far = 14;
        key.shadow.radius = 8; key.shadow.blurSamples = 8; key.shadow.bias = -0.0004;
        var fill = new THREE.DirectionalLight(0xe8eef5, 0.6);
        fill.position.set(4, 1, 3);
        var rim = new THREE.DirectionalLight(0xffffff, 4);
        rim.position.set(3, 4, -4);
        // The ground stays inside the shadow camera: past its edge VSM leaves a dotted line on the ground.
        var ground = new THREE.Mesh(new THREE.CircleGeometry(2.4, 64), new THREE.ShadowMaterial({ opacity: 0.55 }));
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(key, key.target, fill, rim, ground);
        var camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
        return { renderer: renderer, scene: scene, camera: camera, key: key, ground: ground };
      }
      // HyperFrames holds __renderReady until every promise in __hf.buildReady settles; a rejection names the key.
      function ready(key, promise) {
        window.__hf = window.__hf || {};
        window.__hf.buildReady = window.__hf.buildReady || {};
        window.__hf.buildReady[key] = promise;
        return promise;
      }`;

/**
 * Page script source of the surface presets: an object of `MeshPhysicalMaterial` values per `finish` id
 * (`satin`, `gloss`, `chrome`, `matte`), used as `FINISH_PRESETS[P.finish] || {}`. Shared by the 3D templates.
 */
export const FINISH_PRESETS = `{
        satin: { roughness: 0.38, clearcoat: 0.35, clearcoatRoughness: 0.2, metalness: 0 },
        gloss: { roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, metalness: 0 },
        chrome: { roughness: 0.05, clearcoat: 0, clearcoatRoughness: 0, metalness: 1 },
        matte: { roughness: 0.7, clearcoat: 0, clearcoatRoughness: 0, metalness: 0, specularIntensity: 0.3 },
      }`;

/** The `finish` prop of a 3D template: one of {@link FINISH_PRESETS}; `label` says what the surface belongs to. */
export function finishVariable(label: string, initial: "satin" | "gloss" | "chrome" | "matte" = "satin"): TemplateVariable {
  return {
    id: "finish",
    type: "enum",
    label,
    default: initial,
    options: [
      { value: "satin", label: "Satin ceramic" },
      { value: "gloss", label: "Gloss with clearcoat" },
      { value: "chrome", label: "Chrome" },
      { value: "matte", label: "Matte" },
    ],
  };
}

/**
 * Page script of `load(loader, path, use)` for the template called `name`: loads one asset of the composition
 * directory and fails the render, naming the file, when it is missing. The promise goes to `ready`.
 */
export function loadScript(name: string): string {
  return String.raw`
      function load(loader, path, use) {
        return loader.loadAsync(path).then(use, function (error) {
          throw new Error("${name} cannot load " + path + ": " + (error && error.message ? error.message : error));
        });
      }`;
}
