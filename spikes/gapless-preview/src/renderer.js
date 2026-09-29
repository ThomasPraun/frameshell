// PROTOTYPE (spike #2). Plays a cut list from one CFR proxy with one technique and logs raw
// measurements. Analysis happens offline in scripts/analyze.mjs.
//   A1  two <video> elements swapped at cuts, element clock, element audio (via Web Audio gains)
//   A2  two <video> elements swapped at cuts, AudioContext clock, audio scheduled from PCM sidecar
//   B   WebCodecs VideoDecoder -> canvas, AudioContext clock, audio scheduled from PCM sidecar
// Every rAF the visible surface's burned-in barcode is decoded ("probe"): this is the frame the
// page shows at that vsync. All audio passes through a recorder worklet that dumps raw f32 to disk.
/* eslint-disable no-undef */
const fs = require('node:fs');
const path = require('node:path');
const { ipcRenderer } = require('electron');

const q = new URLSearchParams(location.search);
const TECH = q.get('technique');
const AUDIO = q.get('audio') || 'worklet';
const RUN = TECH + (TECH !== 'A1' && AUDIO !== 'worklet' ? '-' + AUDIO : '');
const CONTROL_S = 300; // C: audio-only control length
const OUT = q.get('out');
const MEDIA = q.get('media');
const SR = 48000;
const WARMUP = 2; // s before program start: lets window/decoder startup stalls settle.
const FADE = 96; // 2 ms edge fades, hides phase jumps at splices.
const log = (m) => { ipcRenderer.send('log', m); };
const hud = document.getElementById('hud');

const cutlist = JSON.parse(fs.readFileSync(path.join(MEDIA, 'cutlist.json'), 'utf8'));
const FPS = cutlist.fps;
const FD = 1 / FPS;
let segs = cutlist.segments;
if (q.get('cuts')) segs = segs.slice(0, Number(q.get('cuts')) + 1);
// Frame-exact program: segment k shows source frames [inF, outF) starting at program frame pF.
let acc = 0;
segs = segs.map((s, k) => {
  const inF = Math.round(s.in * FPS), outF = Math.round(s.out * FPS);
  const r = { k, inF, outF, pF: acc };
  acc += outF - inF;
  return r;
});
const TOTAL_FRAMES = acc;
const T = (k) => (k < segs.length ? segs[k].pF / FPS : TOTAL_FRAMES / FPS);
const proxyPath = path.join(MEDIA, 'proxy.mp4');
const proxyUrl = 'file://' + proxyPath;

const R = { technique: RUN, audio: TECH === 'A1' ? 'element' : AUDIO, fps: FPS, segs, probe: [], ots: [], cuts: [], notes: [], errors: [] };
window.addEventListener('error', (e) => { R.errors.push(String(e.message)); log('error ' + e.message); });

// ---------- audio graph + recorder ----------
const ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
const master = ctx.createGain();
let recStream, recFirstFrame = -1, recNextFrame = -1, recGaps = 0;
async function setupRecorder() {
  const src = `class Rec extends AudioWorkletProcessor {
    constructor(){super();this.buf=new Float32Array(128*64);this.n=0;this.start=0;}
    process(inputs,outputs){const i=inputs[0],o=outputs[0];
      for(let c=0;c<o.length;c++){const s=i[c]||i[0];if(s)o[c].set(s);}
      if(this.n===0)this.start=currentFrame;
      if(i[0])this.buf.set(i[0],this.n);else this.buf.fill(0,this.n,this.n+128);
      this.n+=128;if(this.n===this.buf.length){this.port.postMessage({start:this.start,data:this.buf},[this.buf.buffer]);this.buf=new Float32Array(128*64);this.n=0;}
      return true;}}
    registerProcessor('rec',Rec);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
  const rec = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  master.connect(rec).connect(ctx.destination);
  recStream = fs.createWriteStream(path.join(OUT, `${RUN}.f32`));
  rec.port.onmessage = ({ data }) => {
    if (recFirstFrame < 0) recFirstFrame = data.start;
    else if (data.start !== recNextFrame) recGaps++;
    recNextFrame = data.start + data.data.length;
    recStream.write(Buffer.from(data.data.buffer));
  };
}
setInterval(() => {
  const o = ctx.getOutputTimestamp();
  R.ots.push({ c: o.contextTime, p: o.performanceTime, now: performance.now(), cur: ctx.currentTime });
}, 250);
// Context time currently reaching the speakers, from the latest output timestamp.
function heardCtxTime(now) {
  const o = ctx.getOutputTimestamp();
  return o.contextTime + (now - o.performanceTime) / 1000;
}

// ---------- PCM sidecar scheduling (A2, B) ----------
let pcmFd;
function segmentBuffer(s) {
  const n = (s.outF - s.inF) * (SR / FPS);
  const raw = Buffer.alloc(n * 2);
  fs.readSync(pcmFd, raw, 0, n * 2, s.inF * (SR / FPS) * 2);
  const buf = ctx.createBuffer(1, n, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = raw.readInt16LE(i * 2) / 32768;
  const f = Math.min(FADE, n >> 1);
  for (let i = 0; i < f; i++) { d[i] *= i / f; d[n - 1 - i] *= i / f; }
  return buf;
}
let startCtx = 0, startFrame = 0, nextAudio = 0, player = null;
// Program start on an integer sample frame: every splice then lands on an exact sample.
function setStart(delayS) {
  startFrame = Math.ceil((ctx.currentTime + delayS) * SR / 128) * 128;
  startCtx = startFrame / SR;
}
// AUDIO=worklet: one AudioWorklet plays pre-faded segment PCM at exact frames (no node churn).
// AUDIO=bufsrc: one AudioBufferSourceNode per segment, start(t) at the splice time.
async function setupPlayer() {
  if (AUDIO === 'bufsrc') return;
  // Chunks carry either pre-faded f32 (AUDIO=worklet) or raw s16 plus segment edges (AUDIO=chunked,
  // fades applied here, so the main thread never loops over samples).
  const src = `class Prog extends AudioWorkletProcessor {
    constructor(o){super();this.q=[];this.self=o.processorOptions.self;this.n=-1;this.bad=0;this.ex=[];
      this.port.onmessage=(e)=>this.q.push(e.data);}
    process(_i,outputs){const o=outputs[0][0];
      // Diagnostic: global currentFrame vs own quantum counter.
      if(this.n<0)this.n=currentFrame;else this.n+=128;
      if(currentFrame!==this.n){this.bad++;if(this.ex.length<10)this.ex.push([this.n,currentFrame]);this.port.postMessage({bad:this.bad,ex:this.ex});}
      const f0=this.self?this.n:currentFrame;
      while(this.q.length&&this.q[0].at+this.q[0].data.length<=f0)this.q.shift();
      for(const s of this.q){if(s.at>=f0+128)break;
        const a=Math.max(f0,s.at),b=Math.min(f0+128,s.at+s.data.length);
        if(s.s16){for(let f=a;f<b;f++){const g=Math.min(1,(f-s.segA)/${FADE},(s.segB-1-f)/${FADE});o[f-f0]+=s.data[f-s.at]/32768*g;}}
        else for(let f=a;f<b;f++)o[f-f0]+=s.data[f-s.at];}
      return true;}}
    registerProcessor('prog',Prog);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
  player = new AudioWorkletNode(ctx, 'prog', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { self: AUDIO === 'chunkedself' } });
  player.port.onmessage = ({ data }) => { R.frameClockMismatches = data; };
  player.connect(master);
}
function scheduleAudio(horizon = 2) {
  while (nextAudio < segs.length && startCtx + T(nextAudio) < ctx.currentTime + horizon) {
    const s = segs[nextAudio];
    const at = startFrame + s.pF * (SR / FPS);
    if (AUDIO === 'chunked' || AUDIO === 'chunkedself') {
      const n = (s.outF - s.inF) * (SR / FPS), CH = SR / 2;
      for (let i = 0; i < n; i += CH) {
        const m = Math.min(CH, n - i);
        const data = new Int16Array(m);
        fs.readSync(pcmFd, new Uint8Array(data.buffer), 0, m * 2, (s.inF * (SR / FPS) + i) * 2);
        player.port.postMessage({ at: at + i, data, s16: true, segA: at, segB: at + n }, [data.buffer]);
      }
      nextAudio++;
      continue;
    }
    const buf = segmentBuffer(s);
    if (player) {
      const data = buf.getChannelData(0).slice();
      player.port.postMessage({ at, data }, [data.buffer]);
    } else {
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(master);
      node.start(at / SR);
    }
    nextAudio++;
  }
}
const programTime = (now) => heardCtxTime(now) - startCtx;

// ---------- probe: decode burned-in barcode of what is on screen ----------
const probeCanvas = document.createElement('canvas');
probeCanvas.width = 640; probeCanvas.height = 40;
const pctx = probeCanvas.getContext('2d', { willReadFrequently: true });
function readFrameNumber(surface) {
  // Barcode: 16 cells of 40x20 px at 960x540 (row 0 bits, row 1 complement).
  pctx.drawImage(surface, 0, 0, 640, 40, 0, 0, 640, 40);
  const px = pctx.getImageData(0, 0, 640, 40).data;
  let a = 0, b = 0;
  for (let i = 0; i < 16; i++) {
    const x = 20 + 40 * i;
    if (px[(10 * 640 + x) * 4] > 128) a |= 1 << i;
    if (px[(30 * 640 + x) * 4] > 128) b |= 1 << i;
  }
  return (a ^ b) === 0xffff ? a : -1;
}
let surface = null;
let lastRaf = 0, rafMax = 0;
function probe(now) {
  if (!surface) return;
  const t0 = performance.now();
  const f = readFrameNumber(surface);
  R.probe.push([Math.round(now * 100) / 100, f, Math.round((performance.now() - t0) * 100) / 100]);
  if (lastRaf) rafMax = Math.max(rafMax, now - lastRaf);
  lastRaf = now;
}

let finished = false;
async function finish(reason) {
  if (finished) return;
  finished = true;
  R.reason = reason;
  R.recFirstFrame = recFirstFrame; R.recGaps = recGaps; R.sampleRate = ctx.sampleRate;
  R.startCtx = startCtx; R.baseLatency = ctx.baseLatency; R.outputLatency = ctx.outputLatency;
  R.rafMaxMs = rafMax;
  await new Promise((r) => setTimeout(r, 400));
  await ctx.suspend();
  await new Promise((r) => recStream.end(r));
  fs.writeFileSync(path.join(OUT, `${RUN}.json`), JSON.stringify(R));
  log(`done (${reason}); probes=${R.probe.length} cuts=${R.cuts.length} errors=${R.errors.length}`);
  ipcRenderer.send('done', 0);
}
function status(k) {
  hud.textContent = `${TECH}  segment ${k + 1}/${segs.length}  program ${(segs[Math.min(k, segs.length - 1)].pF / FPS).toFixed(1)}/${(TOTAL_FRAMES / FPS).toFixed(1)} s  rAF max ${rafMax.toFixed(1)} ms`;
}

// ---------- A: double-buffered <video> ----------
const v = [document.getElementById('v0'), document.getElementById('v1')];
function seekTo(el, s) {
  return new Promise((res) => {
    el.pause();
    const t = (s.inF + 0.5) / FPS; // mid-frame: avoids landing on the previous frame
    if (Math.abs(el.currentTime - t) < 1e-4) return res();
    el.addEventListener('seeked', () => res(), { once: true });
    el.currentTime = t;
  });
}
function show(el) {
  for (const x of v) x.classList.toggle('on', x === el);
  surface = el;
}
async function loadVideos() {
  for (const el of v) {
    el.src = proxyUrl;
    await new Promise((r) => el.addEventListener('loadeddata', r, { once: true }));
  }
}

async function runA1() {
  await loadVideos();
  const gains = v.map((el) => { const g = ctx.createGain(); ctx.createMediaElementSource(el).connect(g).connect(master); g.gain.value = 0; return g; });
  let k = 0, cur = 0;
  await seekTo(v[0], segs[0]);
  if (segs[1]) await seekTo(v[1], segs[1]);
  show(v[0]); gains[0].gain.value = 1;
  const onFrame = (now, md) => {
    if (finished) return;
    const s = segs[k];
    const el = v[cur];
    // Last frame of the segment is being presented: freeze on it for one frame duration, then
    // reveal the other element (already paused on the in-frame) and start it.
    if (md.mediaTime >= (s.outF - 1) / FPS - 1e-3) {
      el.pause();
      const cut = { k, trigger: now, triggerCtx: ctx.currentTime, lastMedia: md.mediaTime };
      R.cuts.push(cut);
      if (k + 1 >= segs.length) { setTimeout(() => finish('end'), 500); return; }
      const nx = 1 - cur, nel = v[nx];
      const wait = Math.max(0, md.expectedDisplayTime + FD * 1000 - performance.now() - 2);
      setTimeout(() => {
        show(nel);
        const c = ctx.currentTime;
        gains[nx].gain.setValueAtTime(1, c); gains[cur].gain.setValueAtTime(0, c);
        cut.swap = performance.now(); cut.swapCtx = c;
        nel.play();
        const old = cur;
        cur = nx; k++;
        status(k);
        if (segs[k + 1]) seekTo(v[old], segs[k + 1]);
        nel.requestVideoFrameCallback(onFrame);
      }, wait);
      return;
    }
    el.requestVideoFrameCallback(onFrame);
  };
  v[0].requestVideoFrameCallback(onFrame);
  const loop = (now) => { if (finished) return; probe(now); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  await new Promise((r) => setTimeout(r, WARMUP * 1000));
  await v[0].play();
}

// A2: audio clock is master. The idle element is pre-seeked LEAD frames before the next in-point
// and started hidden LEAD frames early, so its startup latency is absorbed before the reveal.
// The reveal waits until it actually presents the in-frame; the outgoing element pauses on its
// last frame, so a late start shows as a freeze, never as foreign frames.
const LEAD = 5;
async function runA2() {
  await loadVideos();
  for (const el of v) el.muted = true;
  pcmFd = fs.openSync(path.join(MEDIA, 'proxy.pcm'), 'r');
  const track = (el) => {
    const cb = (t, m) => {
      el._md = { frame: Math.round(m.mediaTime * FPS), t: m.expectedDisplayTime, mediaTime: m.mediaTime };
      if (el._stopAt !== undefined && el._md.frame >= el._stopAt) el.pause();
      if (!finished) el.requestVideoFrameCallback(cb);
    };
    el.requestVideoFrameCallback(cb);
  };
  v.forEach(track);
  const prep = (el, s) => { el._md = null; el._stopAt = undefined; el._armed = false; el.playbackRate = 1; return seekTo(el, { inF: Math.max(0, s.inF - LEAD) }); };
  let k = 0, cur = 0, pending = null;
  await seekTo(v[0], segs[0]);
  v[0]._stopAt = segs[0].outF - 1;
  if (segs[1]) await prep(v[1], segs[1]);
  show(v[0]);
  await setupPlayer();
  setStart(WARMUP);
  scheduleAudio();
  let started = false, maxDrift = 0, rateChanges = 0, lateReveals = 0, seekNotReady = 0;
  const loop = (now) => {
    if (finished) return;
    scheduleAudio();
    const pt = programTime(now);
    if (!started && pt >= 0) { started = true; v[0].play(); }
    if (started) {
      const nx = 1 - cur, nel = v[nx];
      if (k + 1 < segs.length) {
        const s1 = segs[k + 1];
        if (!nel._armed && pt >= T(k + 1) - LEAD * FD) {
          if (pending) seekNotReady++;
          else { nel._armed = true; nel._stopAt = s1.outF - 1; nel.play(); }
        }
        if (pt >= T(k + 1) && nel._armed && nel._md && nel._md.frame >= s1.inF) {
          if (pt - T(k + 1) > FD) lateReveals++;
          show(nel);
          v[cur].pause();
          R.cuts.push({ k, swap: now, pt, sched: T(k + 1), revealFrame: nel._md.frame });
          const old = cur;
          cur = nx; k++;
          status(k);
          if (segs[k + 1]) { pending = prep(v[old], segs[k + 1]).then(() => { pending = null; }); }
        }
      } else if (pt >= T(segs.length)) {
        v[cur].pause(); finish('end'); return;
      }
      // Rate nudges with hysteresis keep the visible element on the audio clock (seeks stutter).
      const el = v[cur], md = el._md;
      if (md && pt - T(k) > 0.1 && !el.paused) {
        const want = segs[k].inF / FPS + (pt - T(k));
        const have = md.mediaTime + ((now - md.t) / 1000) * el.playbackRate;
        const err = want - have;
        maxDrift = Math.max(maxDrift, Math.abs(err));
        let rate = el.playbackRate;
        if (Math.abs(err) > 1.5 * FD) rate = err > 0 ? 1.03 : 0.97;
        else if (Math.abs(err) < 0.25 * FD) rate = 1;
        if (el.playbackRate !== rate) { el.playbackRate = rate; rateChanges++; }
      }
      Object.assign(R, { maxDrift, rateChanges, lateReveals, seekNotReady });
    }
    probe(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------- B: WebCodecs ----------
async function demux() {
  const { createFile, DataStream, Endianness, MP4BoxBuffer } = require('mp4box');
  const file = createFile();
  let info;
  file.onReady = (i) => { info = i; };
  const fd = fs.openSync(proxyPath, 'r');
  let pos = 0;
  while (!info) {
    const b = Buffer.alloc(1 << 22);
    const n = fs.readSync(fd, b, 0, b.length, pos);
    if (!n) throw new Error('moov not found');
    const ab = MP4BoxBuffer.fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + n), pos);
    pos = file.appendBuffer(ab);
  }
  const vt = info.videoTracks[0];
  const trak = file.getTrackById(vt.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const ds = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
  entry.avcC.write(ds);
  const description = new Uint8Array(ds.buffer, 8);
  const samples = file.getTrackSamplesInfo(vt.id);
  return { fd, config: { codec: vt.codec, codedWidth: vt.video.width, codedHeight: vt.video.height, description, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true }, samples };
}

async function runB() {
  pcmFd = fs.openSync(path.join(MEDIA, 'proxy.pcm'), 'r');
  const { fd, config, samples } = await demux();
  const sup = await VideoDecoder.isConfigSupported(config);
  R.notes.push({ decoderConfig: { codec: config.codec, supported: sup.supported, hw: config.hardwareAcceleration } });
  // CFR, no B-frames: sample i == source frame i in both decode and display order.
  const syncBefore = new Int32Array(samples.length);
  for (let i = 0, last = 0; i < samples.length; i++) { if (samples[i].is_sync) last = i; syncBefore[i] = last; }
  const canvas = document.getElementById('c');
  const c2d = canvas.getContext('2d');
  show(canvas);
  const ready = []; // { pf, frame }
  const expect = []; // FIFO of { pf | -1 } per fed chunk (output order == input order)
  let feedSeg = 0, feedIdx = -1, preroll = 0, starved = 0, decodedCount = 0;
  const dec = new VideoDecoder({
    output: (frame) => {
      const e = expect.shift();
      decodedCount++;
      if (e < 0) { frame.close(); return; }
      ready.push({ pf: e, frame });
    },
    error: (e) => { R.errors.push('decoder: ' + e.message); log('decoder error ' + e.message); },
  });
  dec.configure(config);
  const MAX_READY = 12;
  function feed() {
    while (feedSeg < segs.length && ready.length + dec.decodeQueueSize < MAX_READY) {
      const s = segs[feedSeg];
      if (feedIdx < 0) feedIdx = syncBefore[s.inF];
      const smp = samples[feedIdx];
      const data = Buffer.alloc(smp.size);
      fs.readSync(fd, data, 0, smp.size, smp.offset);
      const keep = feedIdx >= s.inF;
      if (!keep) preroll++;
      expect.push(keep ? s.pF + (feedIdx - s.inF) : -1);
      dec.decode(new EncodedVideoChunk({ type: feedIdx === syncBefore[s.inF] || smp.is_sync ? 'key' : 'delta', timestamp: Math.round(feedIdx * 1e6 / FPS), data }));
      feedIdx++;
      if (feedIdx >= s.outF) { feedSeg++; feedIdx = -1; }
    }
  }
  feed();
  await setupPlayer();
  setStart(WARMUP);
  scheduleAudio();
  let shownPf = -1, k = 0;
  const loop = (now) => {
    if (finished) return;
    scheduleAudio();
    feed();
    const pt = programTime(now);
    if (pt >= TOTAL_FRAMES / FPS) { finish('end'); return; }
    if (pt >= 0) {
      const want = Math.floor(pt * FPS + 1e-6);
      let pick = null;
      while (ready.length && ready[0].pf <= want) {
        if (pick) pick.frame.close();
        pick = ready.shift();
      }
      if (pick) { c2d.drawImage(pick.frame, 0, 0, 960, 540); pick.frame.close(); shownPf = pick.pf; }
      else if (shownPf < want) starved++;
      while (k + 1 < segs.length && want >= segs[k + 1].pF) { k++; R.cuts.push({ k: k - 1, swap: now, pt }); status(k); }
      R.starvedRafs = starved; R.prerollFrames = preroll; R.decoded = decodedCount;
    }
    probe(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// C: audio-only control, no video, no messages. Isolates repeated render quanta to the graph.
//   C-osc    native OscillatorNode 220 Hz -> recorder
//   C-wsine  AudioWorklet computing the same sine -> recorder
async function runC() {
  let node;
  if (AUDIO === 'wsine') {
    const src = `class Sine extends AudioWorkletProcessor { process(_i,o){const c=o[0][0];for(let i=0;i<c.length;i++)c[i]=0.354*Math.sin(2*Math.PI*220*(currentFrame+i)/sampleRate);return true;} } registerProcessor('sine',Sine);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    node = new AudioWorkletNode(ctx, 'sine', { numberOfInputs: 0, outputChannelCount: [1] });
  } else {
    node = ctx.createOscillator(); node.frequency.value = 220;
    const g = ctx.createGain(); g.gain.value = 0.354; node.connect(g); node.start(); node = g;
  }
  node.connect(master);
  const t0 = performance.now();
  const loop = () => { if (finished) return; hud.textContent = `C-${AUDIO} ${((performance.now() - t0) / 1000).toFixed(0)}/${CONTROL_S} s`; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setTimeout(() => finish('end'), CONTROL_S * 1000);
}

(async () => {
  try {
    await setupRecorder();
    await ctx.resume();
    log(`start ${TECH}: ${segs.length} segments, ${segs.length - 1} cuts, program ${(TOTAL_FRAMES / FPS).toFixed(1)} s`);
    status(0);
    if (TECH === 'A1') await runA1();
    else if (TECH === 'A2') await runA2();
    else if (TECH === 'B') await runB();
    else if (TECH === 'C') await runC();
    else throw new Error('unknown technique ' + TECH);
    // Watchdog: program length + 60 s.
    setTimeout(() => finish('watchdog'), (TOTAL_FRAMES / FPS + 60) * 1000);
  } catch (e) {
    R.errors.push(String(e.stack || e));
    log('fatal ' + (e.stack || e));
    finish('fatal');
  }
})();
