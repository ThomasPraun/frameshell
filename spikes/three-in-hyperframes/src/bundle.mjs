// Bundles three.js (+ candidate addons) into classic IIFEs that set window.THREE, and measures raw/gzip/brotli size.
// Usage: node src/bundle.mjs   -> out/bundles/*.js and out/bundles/sizes.json
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "out", "bundles");
mkdirSync(out, { recursive: true });
mkdirSync(join(root, "out", "entries"), { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, "node_modules/three/package.json"), "utf8"));
const banner = `/*! three.js r${pkg.version.split(".")[1]} (${pkg.version}) MIT License, Copyright 2010-2026 three.js authors. https://github.com/mrdoob/three.js */`;

// Names the product-shot scene (src/scene.js) uses from the core: the curated, tree-shakeable surface.
const CURATED_CORE = [
  "WebGLRenderer", "Scene", "PerspectiveCamera", "Group", "Mesh", "Color", "Vector2", "Vector3", "Quaternion", "Euler", "MathUtils",
  "PMREMGenerator", "DirectionalLight", "SpotLight", "HemisphereLight", "AmbientLight",
  "MeshPhysicalMaterial", "MeshStandardMaterial", "ShadowMaterial", "MeshBasicMaterial",
  "PlaneGeometry", "CylinderGeometry", "SphereGeometry", "TorusGeometry", "BoxGeometry", "ExtrudeGeometry", "Shape",
  "TextureLoader", "LoadingManager", "DefaultLoadingManager", "FileLoader", "ImageBitmapLoader", "Cache",
  "SRGBColorSpace", "LinearSRGBColorSpace", "ACESFilmicToneMapping", "NeutralToneMapping", "AgXToneMapping",
  "PCFSoftShadowMap", "VSMShadowMap", "NoToneMapping", "RepeatWrapping", "LinearMipmapLinearFilter", "LinearFilter",
  "WebGLRenderTarget", "AnimationMixer", "AnimationClip", "Object3D", "BufferGeometry", "BufferAttribute", "Float32BufferAttribute",
  "DoubleSide", "FrontSide", "Texture", "CanvasTexture", "Box3", "Clock",
];

const variants = {
  // The whole `three` namespace on window.THREE, nothing tree-shaken: the simple, robust option.
  "core-full": `import * as THREE from "three"; globalThis.THREE = THREE;`,
  // Only the names the scene uses. Smaller, but every template must stay inside the list.
  "core-curated": `import { ${CURATED_CORE.join(", ")} } from "three"; globalThis.THREE = { ${CURATED_CORE.join(", ")} };`,
  // Full namespace + the addons from the owner's list (RoomEnvironment, RoundedBoxGeometry, GLTFLoader, TextGeometry + FontLoader).
  "full-addons": `import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader, Font } from "three/addons/loaders/FontLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
globalThis.THREE = Object.assign({}, THREE, { RoomEnvironment, RoundedBoxGeometry, TextGeometry, FontLoader, Font, GLTFLoader });`,
  // Curated core + the same addons.
  "curated-addons": `import { ${CURATED_CORE.join(", ")} } from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader, Font } from "three/addons/loaders/FontLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, RoomEnvironment, RoundedBoxGeometry, TextGeometry, FontLoader, Font, GLTFLoader };`,
  // Individual addons on top of the curated core, to price each.
  "curated+RoomEnvironment": `import { ${CURATED_CORE.join(", ")} } from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, RoomEnvironment };`,
  "curated+RoundedBoxGeometry": `import { ${CURATED_CORE.join(", ")} } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, RoundedBoxGeometry };`,
  "curated+GLTFLoader": `import { ${CURATED_CORE.join(", ")} } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, GLTFLoader };`,
  "curated+TextGeometry+FontLoader": `import { ${CURATED_CORE.join(", ")} } from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader, Font } from "three/addons/loaders/FontLoader.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, TextGeometry, FontLoader, Font };`,
  // TTFLoader is left out on purpose: in 0.187 it does `import opentype from "https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/+esm"`,
  // which esbuild keeps as a runtime require of a CDN URL. Fonts must be converted to typeface JSON at build time instead.
  "curated+SVGLoader": `import { ${CURATED_CORE.join(", ")} } from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
globalThis.THREE = { ${CURATED_CORE.join(", ")}, SVGLoader };`,
};

const kb = (n) => Math.round((n / 1024) * 10) / 10;
const sizes = {};
for (const [name, source] of Object.entries(variants)) {
  const entry = join(root, "out", "entries", `${name.replace(/[^\w+-]/g, "_")}.js`);
  writeFileSync(entry, source);
  const file = join(out, `${name.replace(/[^\w+-]/g, "_")}.js`);
  const built = await build({
    metafile: true,
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    target: "chrome120",
    outfile: file,
    banner: { js: banner },
    legalComments: "none",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    alias: { "three/addons": join(root, "node_modules/three/examples/jsm") },
    logLevel: "error",
  });
  const buf = readFileSync(file);
  sizes[name] = { rawKB: kb(buf.length), gzipKB: kb(gzipSync(buf, { level: 9 }).length), brotliKB: kb(brotliCompressSync(buf).length) };
  // Which source files end up in the bundle: all must be inside the MIT `three` package (no third-party lib, no remote import).
  const inputs = Object.keys(built.metafile.inputs);
  sizes[name].inputs = inputs.length;
  sizes[name].outsideThree = inputs.filter((f) => !f.includes("node_modules/three/") && !f.includes("/out/entries/"));
  console.log(name.padEnd(36), JSON.stringify(sizes[name]));
}
const upstream = {};
for (const f of ["three.core.js", "three.module.js"]) upstream[f] = kb(statSync(join(root, "node_modules/three/build", f)).size);
console.log("upstream unminified", JSON.stringify(upstream));
writeFileSync(join(out, "sizes.json"), JSON.stringify({ three: pkg.version, sizes, upstream }, null, 2));
