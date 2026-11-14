// Colour grade of a picture in the preview engine (ADR 0031): the WebGL2 twin of export's `lut3d` (`gradedChain` in
// packages/core/src/export/compiler.ts). Runs in the engine worker; numbers measured in docs/research/webgl2-grade.md.
import type { GradeTable } from "@frameshell/schema/grade";

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
 */
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_source;
uniform sampler3D u_table;
uniform int u_size;
uniform int u_height;
out vec4 color;

vec3 tap(int r, int g, int b) {
  return texelFetch(u_table, ivec3(r, g, b), 0).rgb;
}

vec3 mixed(vec3 from, vec3 to, float t) {
  return from + (to - from) * t;
}

void main() {
  ivec2 at = ivec2(gl_FragCoord.xy);
  // Row 0 of the texture is the picture's top; row 0 of the drawing buffer its bottom.
  vec4 source = texelFetch(u_source, ivec2(at.x, u_height - 1 - at.y), 0);
  int last = u_size - 1;
  float lattice = float(last);
  vec3 bytes = floor(source.rgb * 255.0 + 0.5);
  vec3 s = clamp(bytes * (1.0 / 255.0) * lattice, 0.0, lattice);
  ivec3 lo = ivec3(s);
  ivec3 hi = min(lo + 1, ivec3(last));
  vec3 d = s - vec3(lo);
  vec3 c00 = mixed(tap(lo.r, lo.g, lo.b), tap(hi.r, lo.g, lo.b), d.r);
  vec3 c10 = mixed(tap(lo.r, hi.g, lo.b), tap(hi.r, hi.g, lo.b), d.r);
  vec3 c01 = mixed(tap(lo.r, lo.g, hi.b), tap(hi.r, lo.g, hi.b), d.r);
  vec3 c11 = mixed(tap(lo.r, hi.g, hi.b), tap(hi.r, hi.g, hi.b), d.r);
  vec3 graded = mixed(mixed(c00, c10, d.g), mixed(c01, c11, d.g), d.b);
  color = vec4(clamp(floor(graded * 255.0), 0.0, 255.0) / 255.0, source.a);
}`;

/** A picture the pass reads: a decoded frame or a still. */
export type GradeSource = VideoFrame | ImageBitmap;

/**
 * One WebGL2 context per engine, made when the first program with a grade arrives (not on the first graded frame:
 * context and shader take up to 0.4 s cold). Tables are uploaded once per `gradeKey`. Pictures without a grade never
 * reach it. `apply` returns null when WebGL2 is unavailable or the context is lost: the caller draws the picture as it
 * is, and `onUnavailable` is told once.
 */
export class GradePass {
  readonly #onUnavailable: (reason: string) => void;
  #canvas: OffscreenCanvas | null = null;
  #gl: WebGL2RenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #source: WebGLTexture | null = null;
  #uniforms: { size: WebGLUniformLocation | null; height: WebGLUniformLocation | null } | null = null;
  readonly #tables = new Map<string, WebGLTexture>();
  #lost = false;
  #failed = false;
  #told = false;
  /** Pictures graded so far (diagnostics: a timeline without grades keeps it at 0). */
  passes = 0;

  constructor(onUnavailable: (reason: string) => void) {
    this.#onUnavailable = onUnavailable;
  }

  /** Make the context and upload `tables`; drop the uploaded tables not among them. False when the pass cannot run. */
  prepare(tables: Readonly<Record<string, GradeTable>>): boolean {
    // Nothing to grade and no context yet: none is made.
    if (Object.keys(tables).length === 0 && !this.#gl) return true;
    if (!this.#ready()) return false;
    const gl = this.#gl!;
    for (const [key, texture] of this.#tables) {
      if (key in tables) continue;
      gl.deleteTexture(texture);
      this.#tables.delete(key);
    }
    for (const [key, table] of Object.entries(tables)) if (!this.#tables.has(key)) this.#tables.set(key, this.#upload(table));
    return true;
  }

  /**
   * `image` (`width` x `height`, its intrinsic size) through the table of `key`, as a new bitmap the caller draws and
   * closes; null when the pass cannot run or `key` was not prepared.
   */
  apply(image: GradeSource, width: number, height: number, key: string, size: number): ImageBitmap | null {
    if (!this.#ready()) return null;
    const table = this.#tables.get(key);
    if (!table) return null;
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
    gl.bindTexture(gl.TEXTURE_3D, table);
    gl.uniform1i(this.#uniforms!.size, size);
    gl.uniform1i(this.#uniforms!.height, height);
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
      // Every object of the old context is gone: build again on the next frame.
      this.#gl = null;
      this.#tables.clear();
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
    this.#uniforms = { size: gl.getUniformLocation(program, "u_size"), height: gl.getUniformLocation(program, "u_height") };
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
