// Colour grade, vignette and grain of a picture in the preview engine (ADR 0031, 0043): the WebGL2 twin of export's
// `lut3d` (`gradedChain` in packages/core/src/export/compiler.ts) and vignette plate (`export/vignette.ts`), and the
// grain model of `grain.ts`. Runs in the engine worker; grade numbers measured in docs/research/webgl2-grade.md.
import type { LayerRect } from "@frameshell/schema/composite";
import type { ResolvedVignette } from "@frameshell/schema/finish";
import type { GradeTable } from "@frameshell/schema/grade";
import type { PictureGrain } from "./grain.js";

/** Full-screen triangle; no vertex buffer. */
const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * ffmpeg 9 `lut3d=interp=trilinear` on 8-bit RGB, step for step (`applyGradeTable` in @frameshell/schema/grade): the
 * byte scaled to the lattice in single precision, 8 `texelFetch` taps mixed red, green, then blue, truncated to 8 bit.
 * Hardware filtering would round differently; truncation is what makes preview and export agree (ADR 0031).
 * Then the vignette: `vignetteGain` and `vignetteLevel` (@frameshell/schema/finish) on the crop that shows, multiplied
 * in as ffmpeg `blend` multiply does (`floor(byte * level / 255)`), in single precision. Then the grain: `grainDelta`
 * of `grain.ts` step for step (same hash, lattice and rounding), added to every channel and clamped (`grainmerge`).
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_source;
uniform sampler3D u_table;
uniform int u_size;
uniform int u_height;
uniform bool u_graded;
uniform bool u_vignetted;
// Strength, radius, softness.
uniform vec3 u_vignette;
// Left, top, width, height of the picture that shows, in texture pixels.
uniform vec4 u_crop;
uniform bool u_grained;
// Seed, phase, strength.
uniform uvec3 u_grain;
// Grain cells across the crop.
uniform vec2 u_plate;
out vec4 color;

vec3 tap(int r, int g, int b) {
  return texelFetch(u_table, ivec3(r, g, b), 0).rgb;
}

vec3 mixed(vec3 from, vec3 to, float t) {
  return from + (to - from) * t;
}

vec3 graded(vec3 bytes) {
  int last = u_size - 1;
  float lattice = float(last);
  vec3 s = clamp(bytes * (1.0 / 255.0) * lattice, 0.0, lattice);
  ivec3 lo = ivec3(s);
  ivec3 hi = min(lo + 1, ivec3(last));
  vec3 d = s - vec3(lo);
  vec3 c00 = mixed(tap(lo.r, lo.g, lo.b), tap(hi.r, lo.g, lo.b), d.r);
  vec3 c10 = mixed(tap(lo.r, hi.g, lo.b), tap(hi.r, hi.g, lo.b), d.r);
  vec3 c01 = mixed(tap(lo.r, lo.g, hi.b), tap(hi.r, lo.g, hi.b), d.r);
  vec3 c11 = mixed(tap(lo.r, hi.g, hi.b), tap(hi.r, hi.g, hi.b), d.r);
  vec3 value = mixed(mixed(c00, c10, d.g), mixed(c01, c11, d.g), d.b);
  return clamp(floor(value * 255.0), 0.0, 255.0);
}

float level(vec2 texel) {
  vec2 d = texel + 0.5 - u_crop.xy - u_crop.zw * 0.5;
  float far = 2.0 * sqrt(d.x * d.x + d.y * d.y) / sqrt(u_crop.z * u_crop.z + u_crop.w * u_crop.w);
  float strength = u_vignette.x;
  float radius = u_vignette.y;
  float softness = u_vignette.z;
  float t = softness > 0.0 ? clamp((far - radius + softness) / softness, 0.0, 1.0) : step(radius, far);
  return floor(255.0 * (1.0 - strength * (t * t * (3.0 - 2.0 * t))) + 0.5);
}

uint mixBits(uint value) {
  uint x = value;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float grainCell(ivec2 cell) {
  ivec2 c = clamp(cell, ivec2(0), ivec2(u_plate) - 1);
  uint hash = mixBits(uint(c.x) ^ mixBits(uint(c.y) ^ mixBits(u_grain.y ^ mixBits(u_grain.x))));
  return float(int(((hash >> 16u) * u_grain.z) >> 16u) - int(u_grain.z / 2u));
}

float grainDelta(vec2 texel) {
  vec2 p = (texel + 0.5 - u_crop.xy) * u_plate / u_crop.zw - 0.5;
  vec2 lo = floor(p);
  vec2 f = p - lo;
  ivec2 c = ivec2(lo);
  float top = grainCell(c) + (grainCell(c + ivec2(1, 0)) - grainCell(c)) * f.x;
  float bottom = grainCell(c + ivec2(0, 1)) + (grainCell(c + ivec2(1, 1)) - grainCell(c + ivec2(0, 1))) * f.x;
  return floor(top + (bottom - top) * f.y + 0.5);
}

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  // Row 0 of the texture is the picture's top; row 0 of the drawing buffer its bottom.
  ivec2 texel = ivec2(at.x, u_height - 1 - at.y);
  vec4 source = texelFetch(u_source, texel, 0);
  vec3 bytes = floor(source.rgb * 255.0 + 0.5);
  if (u_graded) bytes = graded(bytes);
  if (u_vignetted) bytes = floor(bytes * level(vec2(texel)) / 255.0);
  if (u_grained) bytes = clamp(bytes + grainDelta(vec2(texel)), 0.0, 255.0);
  color = vec4(bytes / 255.0, source.a);
}`;

/** A picture the pass reads: a decoded frame or a still. */
export type GradeSource = VideoFrame | ImageBitmap;

/** What the pass does to one picture: a grade, a vignette, grain, or several, in that order. */
export interface PictureLook {
  /** Key of a prepared grade table; an unknown key is left out. */
  grade?: string;
  /** The clip's vignette on `crop`, the pixels of the picture that show (all of it, or a format's cover crop). */
  vignette?: { vignette: ResolvedVignette; crop: LayerRect };
  /** The clip's grain at this frame; its crop is the vignette's when both are given. */
  grain?: PictureGrain;
}

/**
 * One WebGL2 context per engine, made when the first program with a grade, a vignette or grain arrives (not on the
 * first frame: context and shader take up to 0.4 s cold). Tables are uploaded once per key, and again after a restored
 * context; a vignette or grain needs no upload. Pictures with none of them never reach it. `apply` returns null when WebGL2 is
 * unavailable or the context is lost: the caller draws the picture as it is, and `onUnavailable` is told once.
 */
export class GradePass {
  readonly #onUnavailable: (reason: string) => void;
  #canvas: OffscreenCanvas | null = null;
  #gl: WebGL2RenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #source: WebGLTexture | null = null;
  #uniforms: Record<"size" | "height" | "graded" | "vignetted" | "vignette" | "crop" | "grained" | "grain" | "plate", WebGLUniformLocation | null> | null = null;
  /** The tables of the last {@link prepare}, kept to upload again into a restored context. */
  #wanted: ReadonlyMap<string, GradeTable> = new Map();
  readonly #textures = new Map<string, WebGLTexture>();
  #lost = false;
  #failed = false;
  #told = false;
  /** Pictures through the pass so far (diagnostics: a timeline without grades, vignettes or grain keeps it at 0). */
  passes = 0;

  constructor(onUnavailable: (reason: string) => void) {
    this.#onUnavailable = onUnavailable;
  }

  /**
   * Make the context and upload `tables` (by key: one key, one table, never changed); drop the uploaded tables not
   * among them. `looks`: some picture has a vignette or grain, so the context is made without a table too. False when
   * the pass cannot run.
   */
  prepare(tables: ReadonlyMap<string, GradeTable>, looks = false): boolean {
    this.#wanted = tables;
    // Nothing to grade, vignette or grain and no context yet: none is made.
    if (tables.size === 0 && !looks && !this.#gl) return true;
    if (!this.#ready()) return false;
    const gl = this.#gl!;
    for (const [key, texture] of this.#textures) {
      if (tables.has(key)) continue;
      gl.deleteTexture(texture);
      this.#textures.delete(key);
    }
    for (const [key, table] of tables) if (!this.#textures.has(key)) this.#textures.set(key, this.#upload(table));
    return true;
  }

  /**
   * `image` (`width` x `height`, its intrinsic size) through `look`, as a new bitmap the caller draws and closes; null
   * when the pass cannot run, or `look` asks only for a grade that was not prepared.
   */
  apply(image: GradeSource, width: number, height: number, look: PictureLook): ImageBitmap | null {
    if (!this.#ready()) return null;
    const key = look.grade;
    const wanted = key !== undefined ? this.#wanted.get(key) : undefined;
    if (!wanted && !look.vignette && !look.grain) return null;
    let table = key !== undefined ? this.#textures.get(key) : undefined;
    if (wanted && !table) {
      // A restored context starts without textures.
      table = this.#upload(wanted);
      this.#textures.set(key!, table);
    }
    const gl = this.#gl!;
    const canvas = this.#canvas!;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.#program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#source);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, wanted ? table! : null);
    const uniforms = this.#uniforms!;
    gl.uniform1i(uniforms.graded, wanted ? 1 : 0);
    gl.uniform1i(uniforms.size, wanted?.size ?? 2);
    gl.uniform1i(uniforms.height, height);
    gl.uniform1i(uniforms.vignetted, look.vignette ? 1 : 0);
    gl.uniform1i(uniforms.grained, look.grain ? 1 : 0);
    const crop = look.vignette?.crop ?? look.grain?.crop;
    if (crop) gl.uniform4f(uniforms.crop, crop.left, crop.top, crop.width, crop.height);
    if (look.vignette) {
      const { strength, radius, softness } = look.vignette.vignette;
      gl.uniform3f(uniforms.vignette, strength, radius, softness);
    }
    if (look.grain) {
      const { grain, phase, plate } = look.grain;
      gl.uniform3ui(uniforms.grain, grain.seed, phase, grain.strength);
      gl.uniform2f(uniforms.plate, plate.width, plate.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passes++;
    return canvas.transferToImageBitmap();
  }

  #ready(): boolean {
    if (this.#failed || this.#lost) return false;
    if (this.#gl) return true;
    try {
      this.#create();
      return true;
    } catch (error) {
      this.#failed = true;
      this.#tell((error as Error).message);
      return false;
    }
  }

  #create(): void {
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available");
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.#lost = true;
      this.#tell("the WebGL2 context was lost");
    });
    canvas.addEventListener("webglcontextrestored", () => {
      // Every object of the old context is gone: context and textures are built again on the next graded frame.
      this.#gl = null;
      this.#textures.clear();
      this.#lost = false;
    });
    const program = gl.createProgram();
    for (const [type, text] of [
      [gl.VERTEX_SHADER, VERTEX],
      [gl.FRAGMENT_SHADER, FRAGMENT],
    ] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`grade shader: ${gl.getShaderInfoLog(shader) ?? "does not compile"}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`grade shader: ${gl.getProgramInfoLog(program) ?? "does not link"}`);
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_source"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "u_table"), 1);
    // The picture's bytes as decoded: no premultiplying, flipping or colour management on upload.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const source = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, source);
    nearest(gl, gl.TEXTURE_2D);
    this.#canvas = canvas;
    this.#gl = gl;
    this.#program = program;
    this.#source = source;
    const at = (name: string) => gl.getUniformLocation(program, name);
    this.#uniforms = {
      size: at("u_size"),
      height: at("u_height"),
      graded: at("u_graded"),
      vignetted: at("u_vignetted"),
      vignette: at("u_vignette"),
      crop: at("u_crop"),
      grained: at("u_grained"),
      grain: at("u_grain"),
      plate: at("u_plate"),
    };
  }

  #upload(table: GradeTable): WebGLTexture {
    const gl = this.#gl!;
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    nearest(gl, gl.TEXTURE_3D);
    // Red fastest, as in the table: texel (x, y, z) = (red, green, blue). 32-bit floats: the numbers ffmpeg parses.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, table.size, table.size, table.size, 0, gl.RGB, gl.FLOAT, table.data);
    return texture;
  }

  #tell(reason: string): void {
    if (this.#told) return;
    this.#told = true;
    this.#onUnavailable(reason);
  }
}

function nearest(gl: WebGL2RenderingContext, target: number): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
}
