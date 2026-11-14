// PROTOTYPE (#384 G0). Worker like the preview engine: WebCodecs decode, 2D OffscreenCanvas
// composite, plus a WebGL2 OffscreenCanvas that applies a 3D LUT before the 2D draw.
const log = (s) => postMessage({ log: s });
const raw = (name, bytes) => postMessage({ raw: name, bytes: bytes.buffer }, [bytes.buffer]);

// ---------- Annex B -> access units (AUD = NAL 9 starts one) ----------
function accessUnits(buffer) {
  const b = new Uint8Array(buffer);
  const starts = [];
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) { starts.push([i, i + 3]); i += 2; }
    else if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1) { starts.push([i, i + 4]); i += 3; }
  }
  const aus = [];
  let cur = null;
  for (let k = 0; k < starts.length; k++) {
    const [s, p] = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1][0] : b.length;
    const type = b[p] & 0x1f;
    if (type === 9) { if (cur) aus.push(cur); cur = { start: s, end, key: false }; }
    else if (cur) { cur.end = end; if (type === 5) cur.key = true; }
  }
  if (cur) aus.push(cur);
  return aus.map((a) => ({ data: b.slice(a.start, a.end), key: a.key }));
}

class Source {
  constructor(aus) {
    this.aus = aus; this.next = 0; this.out = 0; this.taken = 0; this.frames = []; this.waiters = [];
    this.decoder = new VideoDecoder({
      output: (f) => { this.out++; this.frames.push(f); this.#wake(); },
      error: (e) => log('decoder error ' + e.message),
    });
    this.decoder.configure({ codec: 'avc1.640028', optimizeForLatency: true });
  }
  #wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  #pump() {
    while (this.next < this.aus.length && this.next - this.taken < 6) {
      const au = this.aus[this.next];
      this.decoder.decode(new EncodedVideoChunk({ type: au.key ? 'key' : 'delta', timestamp: this.next * 33333, data: au.data }));
      this.next++;
    }
    if (this.next >= this.aus.length && !this.flushed) { this.flushed = true; this.decoder.flush().catch(() => {}); }
  }
  async take() {
    this.#pump();
    while (!this.frames.length) { await new Promise((r) => this.waiters.push(r)); this.#pump(); }
    this.taken++;
    const f = this.frames.shift();
    this.#pump();
    return f;
  }
  close() { this.frames.forEach((f) => f.close()); if (this.decoder.state !== 'closed') this.decoder.close(); }
}

// ---------- the grade pass ----------
const VS = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); // row 0 of the source at the top of the canvas
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D src;
uniform sampler3D lutH; // RGBA16F, LINEAR: hardware trilinear
uniform sampler3D lutM; // RGBA32F, NEAREST: 8 texelFetch taps, trilinear in the shader
uniform float n;
uniform int mode;       // 0 identity, 1 hardware trilinear, 2 shader trilinear
uniform bool trunc;     // floor to 8 bit like ffmpeg lut3d does, instead of the GPU's rounding
in vec2 uv;
out vec4 o;
vec3 tap(ivec3 i) { return texelFetch(lutM, i, 0).rgb; }
void main() {
  vec3 c = texture(src, uv).rgb;
  if (mode == 1) {
    c = texture(lutH, (c * (n - 1.0) + 0.5) / n).rgb;
  } else if (mode == 2) {
    vec3 p = c * (n - 1.0);
    ivec3 i = min(ivec3(p), ivec3(int(n) - 2));
    vec3 f = p - vec3(i);
    vec3 x00 = mix(tap(i), tap(i + ivec3(1, 0, 0)), f.r);
    vec3 x10 = mix(tap(i + ivec3(0, 1, 0)), tap(i + ivec3(1, 1, 0)), f.r);
    vec3 x01 = mix(tap(i + ivec3(0, 0, 1)), tap(i + ivec3(1, 0, 1)), f.r);
    vec3 x11 = mix(tap(i + ivec3(0, 1, 1)), tap(i + ivec3(1, 1, 1)), f.r);
    c = mix(mix(x00, x10, f.g), mix(x01, x11, f.g), f.b);
  }
  if (trunc) c = floor(c * 255.0) / 255.0;
  o = vec4(c, 1.0);
}`;

class Grader {
  constructor() {
    this.canvas = new OffscreenCanvas(16, 16);
    const gl = (this.gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    }));
    if (!gl) throw new Error('no webgl2 in worker');
    const sh = (type, text) => {
      const s = gl.createShader(type); gl.shaderSource(s, text); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = (this.program = gl.createProgram());
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    gl.useProgram(p);
    this.u = Object.fromEntries(['src', 'lutH', 'lutM', 'n', 'mode', 'trunc'].map((k) => [k, gl.getUniformLocation(p, k)]));
    gl.uniform1i(this.u.src, 0); gl.uniform1i(this.u.lutH, 1); gl.uniform1i(this.u.lutM, 2);
    this.src = this.#tex(gl.TEXTURE0, gl.TEXTURE_2D, gl.NEAREST);
    this.lutH = this.#tex(gl.TEXTURE1, gl.TEXTURE_3D, gl.LINEAR);
    this.lutM = this.#tex(gl.TEXTURE2, gl.TEXTURE_3D, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.info = { version: gl.getParameter(gl.VERSION), renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) };
  }
  #tex(unit, target, filter) {
    const gl = this.gl; const t = gl.createTexture();
    gl.activeTexture(unit); gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, filter);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(target, w, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** `table`: n^3 RGB floats in .cube order (red fastest) = texture x, y, z. */
  setLut(n, table) {
    const gl = this.gl;
    const rgba = new Float32Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) rgba.set([table[i * 3], table[i * 3 + 1], table[i * 3 + 2], 1], i * 4);
    gl.activeTexture(gl.TEXTURE1); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.activeTexture(gl.TEXTURE2); gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, n, n, n, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(this.u.n, n);
  }
  grade(image, width, height, mode, convert = false) {
    const gl = this.gl;
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, convert ? gl.BROWSER_DEFAULT_WEBGL : gl.NONE);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1i(this.u.mode, mode);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  /** RGB rows top first. */
  read(width, height) {
    const gl = this.gl;
    const px = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const s = ((height - 1 - y) * width + x) * 4, d = (y * width + x) * 3;
      rgb[d] = px[s]; rgb[d + 1] = px[s + 1]; rgb[d + 2] = px[s + 2];
    }
    return rgb;
  }
}

function parseCube(text) {
  let n = 0; const v = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('LUT_3D_SIZE')) n = +t.split(/\s+/)[1];
    else if (/^[-\d.]/.test(t)) for (const x of t.split(/\s+/)) v.push(+x);
  }
  return { n, table: new Float32Array(v) };
}

function rgbOf(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return rgb;
}

async function parity(files, grader, luts) {
  const W = 1920, H = 1080;
  const scratch = new OffscreenCanvas(W, H);
  const sctx = scratch.getContext('2d', { alpha: false, willReadFrequently: true });
  // 1. RGB still: pure LUT parity.
  const bmp = await createImageBitmap(new Blob([files['random.png']], { type: 'image/png' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  grader.grade(bmp, W, H, 0); raw('random.gl0.rgb', grader.read(W, H));
  for (const [n, lut] of luts) {
    grader.setLut(n, lut);
    for (const mode of [1, 2]) {
      grader.grade(bmp, W, H, mode); raw(`random.gl${mode}.lut${n}.rgb`, grader.read(W, H));
      grader.gl.uniform1i(grader.u.trunc, 1);
      grader.grade(bmp, W, H, mode); raw(`random.gl${mode}t.lut${n}.rgb`, grader.read(W, H));
      grader.gl.uniform1i(grader.u.trunc, 0);
      // Same pass through the hand-off the engine would use: GL canvas -> ImageBitmap -> 2D drawImage.
      grader.grade(bmp, W, H, mode);
      const out = grader.canvas.transferToImageBitmap();
      sctx.drawImage(out, 0, 0); out.close();
      raw(`random.2d${mode}.lut${n}.rgb`, rgbOf(sctx, W, H));
    }
  }
  bmp.close();
  // 2. Video: decoded bt709 limited H.264 (hardware decoder), tagged and untagged.
  for (const tag of ['tagged', 'untagged']) {
    const src = new Source(accessUnits(files[`blocks.${tag}.h264`]));
    const frame = await src.take();
    log(`blocks.${tag}: format=${frame.format} coded=${frame.codedWidth}x${frame.codedHeight} colorSpace=${JSON.stringify(frame.colorSpace.toJSON())}`);
    sctx.drawImage(frame, 0, 0, W, H); raw(`blocks.${tag}.2d.rgb`, rgbOf(sctx, W, H));
    grader.grade(frame, W, H, 0); raw(`blocks.${tag}.gl0.rgb`, grader.read(W, H));
    grader.grade(frame, W, H, 0, true); raw(`blocks.${tag}.gl0conv.rgb`, grader.read(W, H));
    for (const [n, lut] of luts) {
      grader.setLut(n, lut);
      for (const mode of [1, 2]) { grader.grade(frame, W, H, mode); raw(`blocks.${tag}.gl${mode}.lut${n}.rgb`, grader.read(W, H)); }
    }
    frame.close(); src.close();
  }
}

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = (a) => ({ mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p50: +pct(a, 0.5).toFixed(3), p95: +pct(a, 0.95).toFixed(3), max: +Math.max(...a).toFixed(3) });

/**
 * One configuration: `layers` decoders on the same stream, every frame composited full size
 * on the visible canvas. `sync`: a 1-pixel getImageData after each frame waits for the GPU.
 * `paced`: one composite per worker rAF tick on a 30 fps clock, as playback does.
 */
async function bench(view, ctx, grader, aus, size, { layers, path, sync, paced, frames, mode = 1, lut = 33 }) {
  const [W, H] = size;
  view.width = W; view.height = H;
  const sources = Array.from({ length: layers }, () => new Source(aus));
  const submit = [], total = [], ticks = [];
  let start = 0, last = 0, drawn = 0;
  // Warm up: first frames include shader compile, texture allocation and decoder start.
  for (let k = 0; k < frames + 10; k++) {
    const fr = await Promise.all(sources.map((s) => s.take()));
    if (paced) {
      if (k === 10) start = performance.now();
      if (k >= 10) {
        // Wait for the tick when frame (k-10) is due at 30 fps.
        for (;;) {
          const now = await new Promise((r) => requestAnimationFrame(r));
          if (last) ticks.push(now - last);
          last = now;
          if ((performance.now() - start) * 0.03 >= k - 10) break;
        }
      }
    }
    const t0 = performance.now();
    ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    fr.forEach((f, i) => {
      ctx.globalAlpha = i ? 0.8 : 1;
      if (path === '2d') ctx.drawImage(f, 0, 0, W, H);
      else {
        grader.grade(f, f.displayWidth, f.displayHeight, mode);
        if (path === 'gl-only') { if (i === fr.length - 1 && sync) grader.gl.readPixels(0, 0, 1, 1, grader.gl.RGBA, grader.gl.UNSIGNED_BYTE, new Uint8Array(4)); }
        else if (path === 'gl-bitmap') { const b = grader.canvas.transferToImageBitmap(); ctx.drawImage(b, 0, 0, W, H); b.close(); }
        else ctx.drawImage(grader.canvas, 0, 0, W, H);
      }
    });
    const t1 = performance.now();
    if (sync && path !== 'gl-only') ctx.getImageData(0, 0, 1, 1);
    const t2 = performance.now();
    fr.forEach((f) => f.close());
    if (k >= 10) { submit.push(t1 - t0); total.push(t2 - t0); drawn++; }
  }
  const wall = performance.now() - start;
  sources.forEach((s) => s.close());
  const r = { size: `${W}x${H}`, layers, path, mode, lut, sync, paced, frames: drawn, submitMs: stats(submit) };
  if (sync) r.syncedMs = stats(total);
  if (paced) {
    const med = pct(ticks, 0.5);
    r.ticks = { ...stats(ticks), over1_5x: ticks.filter((t) => t > 1.5 * med).length, n: ticks.length, longAt: ticks.flatMap((t, i) => (t > 1.5 * med ? [i] : [])) };
    r.wallMs = +wall.toFixed(1); r.expectedMs = +(((drawn - 1) / 30) * 1000).toFixed(1);
  }
  return r;
}

onmessage = async ({ data: { view, files, only } }) => {
  try {
    const t0 = performance.now();
    const grader = new Grader();
    const tInit = performance.now() - t0;
    log('webgl2 in worker: ' + JSON.stringify(grader.info) + ` init ${tInit.toFixed(1)} ms`);
    const luts = new Map();
    const setup = {};
    for (const n of [33, 65]) {
      const p0 = performance.now();
      const { table } = parseCube(files[`look${n}.cube`]);
      const p1 = performance.now();
      grader.setLut(n, table);
      grader.gl.finish();
      setup[n] = { parseMs: +(p1 - p0).toFixed(1), uploadMs: +(performance.now() - p1).toFixed(1) };
      luts.set(n, table);
    }
    log('lut setup ' + JSON.stringify(setup));
    if (only !== 'bench') { await parity(files, grader, luts); log('parity written'); }
    if (only === 'paced4') {
      // Long-run check of the 4-layer 1080p playback hitches: 300 frames (10 s) per path.
      const ctx = view.getContext('2d', { alpha: false });
      const aus = accessUnits(files['bench1080.h264']);
      const results = [];
      for (const path of ['2d', 'gl-bitmap', 'gl-canvas', '2d', 'gl-bitmap', 'gl-canvas']) {
        const r = await bench(view, ctx, grader, aus, [1920, 1080], { layers: 4, path, frames: 280, sync: false, paced: true });
        log(JSON.stringify(r)); results.push(r);
      }
      postMessage({ json: 'paced4.json', data: { info: grader.info, results } });
    } else if (only !== 'parity') {
      grader.setLut(33, luts.get(33));
      const ctx = view.getContext('2d', { alpha: false });
      const results = [];
      for (const [name, size] of [['bench1080.h264', [1920, 1080]], ['bench540.h264', [960, 540]]]) {
        const aus = accessUnits(files[name]);
        for (const layers of [1, 4])
          for (const path of ['2d', 'gl-bitmap', 'gl-canvas'])
            for (const mode of [{ sync: true, paced: false }, { sync: false, paced: true }]) {
              const r = await bench(view, ctx, grader, aus, size, { layers, path, frames: 150, ...mode });
              log(JSON.stringify(r)); results.push(r);
            }
      }
      // Extra: table size, shader trilinear, and the GL pass alone (readPixels sync, no 2D hand-off).
      const aus = accessUnits(files['bench1080.h264']);
      for (const extra of [
        { layers: 4, path: 'gl-bitmap', lut: 65, mode: 1 }, { layers: 4, path: 'gl-bitmap', lut: 65, mode: 2 },
        { layers: 1, path: 'gl-only', lut: 33, mode: 1 }, { layers: 4, path: 'gl-only', lut: 33, mode: 1 },
        { layers: 4, path: 'gl-only', lut: 65, mode: 2 }, { layers: 4, path: 'gl-only', lut: 33, mode: 0 },
      ]) {
        grader.setLut(extra.lut, luts.get(extra.lut));
        const r = await bench(view, ctx, grader, aus, [1920, 1080], { ...extra, frames: 150, sync: true, paced: false });
        log(JSON.stringify(r)); results.push(r);
      }
      postMessage({ json: 'bench.json', data: { info: grader.info, setup, results } });
    }
    postMessage({ done: 0 });
  } catch (e) {
    log('FAILED ' + (e.stack || e)); postMessage({ done: 1 });
  }
};
