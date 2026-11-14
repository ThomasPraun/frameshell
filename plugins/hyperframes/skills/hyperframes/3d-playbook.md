# 3D product shot playbook (three.js)

Read this when a shot needs a real 3D object in studio light: a product turning on a push-in, a hero prop for a story, a model the person already has. The page rules (one clock, assets before frame 0, software renderer) are in the [3D compositions](SKILL.md#3d-compositions-threejs) section of the skill; this page is how to make the shot look expensive. ADR 0042.

## Which route

| Shot | Route |
|---|---|
| A product, device or prop in studio light on a camera move, with a headline | The `product-shot` template: `frameshell hyperframes new hero --template product-shot`, then props (`model`, `label`, `finish`, `spin`, `orbit`, `shadows`, `size`) |
| A scene the template cannot say (several parts that open, a second object, a different set) | The same page edited by hand: copy `product-shot`'s studio (`studio()`, `ready()`) and keep the rules below |
| A lit set, an animated character, a Cycles-quality final | The `blender` skill with the person's own Blender when `frameshell doctor` lists it; never three.js |
| Extruded 3D text or a 3D logo | No template yet. Use DOM text over the canvas (the `big-word` and `kinetic-headline` templates), or a model the person supplies as a GLB |
| A product the person has no model or label for | No 3D. Show the real UI or photo |

## Studio defaults

The `product-shot` template builds this studio (`STUDIO_SCRIPT` in `plugins/hyperframes/src/templates/three-kit.ts`); start from these numbers and change one thing at a time.

- **Lights.** Warm key `#fff4e8`, intensity 3, high front-left (-3, 5, 4), the only shadow caster. Cool fill `#e8eef5`, 0.6, low right. White rim, 4, high back-right. Reflections come from `THREE.RoomEnvironment` through PMREM (size 256, intensity 0.8), a code-built studio: no HDRI file to ship.
- **Colour.** `THREE.NeutralToneMapping`, exposure 0.85, sRGB output. The clear colour is transparent, so the clip layers over footage; raise the `backdrop` prop toward 1 for a solid card.
- **Shadows.** VSM (three 0.187 has no soft PCF), 1024 map, radius 8, 8 blur samples. The ground is a `THREE.ShadowMaterial` (opacity 0.55) kept inside the shadow camera; past its edge VSM draws a dotted line. Never a 4096 map: it is what makes software frames slow.
- **Not in the template.** A vignette of about 8 % (a radial-gradient DOM layer over the canvas), seeded grain of about 2 % (the `scene-background` template paints one; seeded, never `Math.random`) and a dithered backdrop gradient (a radial gradient with a little grain, so it does not band in H.264). Add them in the page when the shot needs them.

## Materials

The `finish` prop of the template, as `THREE.MeshPhysicalMaterial` values:

| Finish | roughness | clearcoat | metalness | Use |
|---|---|---|---|---|
| `satin` | 0.38 | 0.35 (clearcoat roughness 0.2) | 0 | Ceramic, painted plastic: the default |
| `gloss` | 0.25 | 1 (clearcoat roughness 0.08) | 0 | Lacquer, glass-like shells; the first glint reads best here |
| `chrome` | 0.05 | 0 | 1 | Metal. It only shows what it reflects: give it things to reflect (dark flags, a white cyc, a horizon strip in the environment) or it turns into a grey blob |
| `matte` | 0.7 | 0 | 0 (specular intensity 0.3) | Rubber, soft-touch, accent panels |

A clearcoat roughness of about 0.08 gives a clean first glint; 0.2 smears it.

## The glint

A thin light sweeping once across the subject is the hook of the shot: the template sweeps a narrow spot light from left to right between 0.25 s and 0.95 s. Keep it early and short.

- Check what the glint touches: capture the same frame with the glint on and off (`frame_capture`, or `frameshell frame`) and compare. The changed area should be a band on the product, not its whole surface.
- A strip light that exists only in the reflection environment (a bright rectangle in the scene `environment`, not a real light) glints on gloss and chrome without flooding the diffuse colour. Use one when the spot light washes the label out.

## Camera

- **Lens.** Field of view about 30 for products, about 18 for a character or a prop with a face. A wider lens bends the product.
- **Never parked.** The template pushes in from 35 % farther with an ease-out (`M.ease("snap")`) settling at 1.2 s, then creeps in 4 % over the clip and orbits by the `orbit` prop (7 to 10° either side reads). A hold with a static camera looks like a freeze.
- **Landing.** A big landing (a hit on the beat) gets a 4 % punch-in on that frame, on the same spring as the rest.
- **Framing.** The product fills about 56 % of the frame height in 16:9, 50 % in 1:1 and 40 % in 9:16 (the width limits it there). `size` scales it; the layout per format is already in the template.

## Modelling

- **Units.** Pick one and keep it: 1 unit = 1 cm in a hand-written scene. The template stands the product 1.6 units high (1 unit = 10 cm) and refits any GLB to that size, so the scale of a GLB does not matter there.
- **Bevel every edge** (`THREE.RoundedBoxGeometry` radius 0.05 to 0.1 for the built-in shapes): a sharp edge catches no light and the shape looks cheap.
- **Hollow lids and cases** with a visible cavity, parts seated flush with a hairline gap, never intersecting.
- **A look sheet before a scene.** A hero prop gets six angles (front, back, both sides, top, three-quarter) in `frame` stills before it goes into a shot; fix the model, not the camera, when an angle fails.

## Beat sheet: a product in 6 s at 120 BPM

One beat is 0.5 s. This is the shape for a product that opens or has parts; the template implements the glint, the arrival, the hold and the headline, and a hand-written scene adds the rest.

| Time | Beat |
|---|---|
| 0 to 0.5 s | Glint sweeps across (template: 0.25 to 0.95 s) |
| 0.72 to 0.95 s | Anticipation: press down 1.5°, squash 2 % |
| 1.0 s | Open on a spring (ζ 0.6) |
| 1.0 to 2.0 s | Parts rise (ζ 0.7), one side 4 frames after the other |
| 2.0 s | Push-in (template: settles at 1.2 s) |
| 2.4 to 4.0 s | Hold, with the camera creeping |
| 4.0 to 5.0 s | Seat with a magnetic dip |
| 5.0 s | Close with a 3° bounce |

## Failure and fix

| What you see | Fix |
|---|---|
| A white product melts into the backdrop | Shrink the dome the product reflects, let the sides fall off to a darker value |
| Front and top have the same value | Move the key higher |
| Ceramic looks grey | Raise the exposure (0.85 to 0.95), a bigger key light |
| A dotted line on the ground | The ground is wider than the shadow camera: shrink the ground or widen the camera's `left`, `right`, `top`, `bottom` |
| A frame takes seconds | A 4096 shadow map, a PMREM above 256, or `shadows: soft` with a big radius: lower them (draft quality is about 1 s per 1080p frame) |
| The first frame is empty | The model or texture was not handed to `window.__hf.buildReady`: the render started before it loaded |
| The render fails naming a file | The path in `model` or `label` is wrong or outside the composition directory |
| A GLB loads in Blender but not here | It was exported with Draco, KTX2 or Meshopt compression: export again without |
| Two verify runs differ | State between frames: `setAnimationLoop`, `THREE.Clock`, `mixer.update(dt)`, unseeded noise. `check` names them |
| The clip is dark in the live preview only | The preview runs WebGL on the GPU: judge with `frame_capture` once the clip is `ready` |

## A GLB from Blender

The bridge between the `blender` skill and this one is a file, not a command.

1. In Blender: File > Export > glTF 2.0, format **glTF Binary (.glb)**, compression off, +Y up (the default), apply modifiers. Bake the materials the product needs (base colour, roughness, metalness): three.js shows what glTF holds, not what the node tree does.
2. Copy the `.glb` into the composition directory (`compositions/hyperframes/<name>/model.glb`). Never `node_modules`, never a path outside it: only files of that directory are cache inputs, so editing the model re-renders the clip.
3. `frameshell clip set <clip> --props '{"model":"model.glb"}'` (or write it when adding the clip). The template fits it to its stage, so the size does not matter.
4. `frameshell hyperframes check <name>`, then `frameshell clip verify <clip>`, then `frame_capture` stills. A model with a lot of triangles costs render time on the software renderer: decimate before exporting.

A lit set, a rigged character or an animation baked in Blender is not a GLB job: render it with the `blender` skill.

## Flat characters beside a 3D prop

For a story short (see the frameshell skill's story-shorts page) the hero prop is 3D with its own close-up and lighting, and the characters stay 2D: flat images on planes with a shadeless material (`THREE.MeshBasicMaterial`, so the light never changes their colour), a soft contact shadow under them, and faces as replacement sets of eyes and mouths (SVG parts) swapped per beat.

## Before you hand it over

1. `frameshell hyperframes check <name>` clean.
2. `frameshell clip verify <clip>` passes (12 probes, 2/255). A 3D shot is a composited layer: it needs this every time.
3. Stills at 0.5 s, mid-clip and the last second; the glint's frame, the hold and the exit.
4. Time one full render before you plan the film around it: 3D clips render serially and slower than 2D ones.
