const { ipcRenderer } = require('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { console.log(...a); document.getElementById('log').textContent = a.join(' '); };

// ---- synthetic sources with ground truth ------------------------------------------------
// Canvas with a 24-bit barcode of performance.now() (ms) in the top row, 16 px per bit.
function barcodeCanvas(w = 640, h = 360) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  let flash = false;
  const draw = () => {
    const v = Math.round(performance.now()) & 0xffffff;
    g.fillStyle = '#444'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 24; i++) {
      g.fillStyle = (v >> (23 - i)) & 1 ? '#fff' : '#000';
      g.fillRect(i * 16, 0, 16, 16);
    }
    g.fillStyle = flash ? '#fff' : '#000'; g.fillRect(w - 120, h - 120, 100, 100);
    g.fillStyle = '#fff'; g.font = '40px monospace'; g.fillText(String(v), 20, 120);
    g.fillStyle = '#0f0'; g.fillRect((v / 5) % (w - 40), 200, 40, 40); // motion
  };
  const timer = setInterval(draw, 8); draw();
  return { canvas: c, setFlash: (f) => (flash = f), stop: () => clearInterval(timer) };
}

// Beep every `period` ms; flash lit for 100 ms at the same moment (A/V sync ground truth).
function beepSource(setFlash) {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const dest = ctx.createMediaStreamDestination();
  // A permanently connected silent source: without it the destination emits no samples until the first beep.
  const keep = ctx.createConstantSource(); keep.offset.value = 0; keep.connect(dest); keep.start();
  let next = performance.now() + 1500;
  const log = [];
  const t = setInterval(() => {
    const now = performance.now();
    if (now >= next) {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = 1000; gain.gain.value = 0.8;
      osc.connect(gain).connect(dest);
      osc.start(); osc.stop(ctx.currentTime + 0.1);
      setFlash(true); log.push(now); setTimeout(() => setFlash(false), 100);
      next += 1000;
    }
  }, 4);
  return { stream: dest.stream, beeps: log, stop: () => { clearInterval(t); ctx.close(); } };
}

async function makeStream(spec) {
  const cleanup = [];
  let stream, extra = {};
  if (spec.source === 'fake') {
    // getUserMedia({audio}) hangs on this machine even with fake devices (see research note Q1),
    // so the "microphone" is a WebAudio beep source; video is the real Chromium fake camera.
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });
    if (spec.realAudio) {
      (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks().forEach((t) => stream.addTrack(t));
    } else {
      const b = beepSource(() => {});
      b.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      cleanup.push(b.stop);
    }
  } else if (spec.source === 'sync' || spec.source === 'canvas') {
    const bc = barcodeCanvas(spec.w, spec.h);
    stream = bc.canvas.captureStream(spec.fps ?? 30);
    cleanup.push(bc.stop);
    if (spec.source === 'sync') {
      const b = beepSource(bc.setFlash);
      b.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      cleanup.push(b.stop); extra.beeps = b.beeps;
    } else if (spec.audio) {
      const a = await navigator.mediaDevices.getUserMedia({ audio: true });
      a.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
  } else if (spec.source === 'cam') {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 }, audio: !!spec.audio });
  } else if (spec.source === 'display' && spec.displayMode === 'legacy') {
    const id = await ipcRenderer.invoke('screen-id');
    const desktop = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxFrameRate: 30 } };
    stream = await navigator.mediaDevices.getUserMedia({ video: desktop, audio: spec.audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false });
    extra.displayTracks = stream.getTracks().map((t) => ({ kind: t.kind, readyState: t.readyState, label: t.label, settings: t.getSettings() }));
  } else if (spec.source === 'display') {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: !!spec.audio });
    extra.displayTracks = stream.getTracks().map((t) => ({ kind: t.kind, readyState: t.readyState, label: t.label, settings: t.getSettings() }));
    stream.getTracks().forEach((t) => t.addEventListener('ended', () => console.log('display track ended', t.kind)));
  } else throw new Error('source ' + spec.source);
  return { stream, cleanup, extra };
}

function extFor(mime) { return mime.startsWith('video/mp4') ? 'mp4' : mime.startsWith('audio/') ? 'weba' : 'webm'; }

async function record(job, spec, ms) {
  console.log('makeStream', spec.name); const { stream, cleanup, extra } = await makeStream(spec); console.log('got stream');
  const mime = spec.mime;
  const opts = { mimeType: mime };
  if (spec.videoBitsPerSecond) opts.videoBitsPerSecond = spec.videoBitsPerSecond;
  const rec = new MediaRecorder(stream, opts);
  const file = `${job.outDir}/${spec.name}.${extFor(mime)}`;
  require('node:fs').rmSync(file, { force: true });
  const r = { name: spec.name, mime, file, chunks: 0, bytes: 0, tracks: stream.getTracks().map((t) => ({ kind: t.kind, settings: t.getSettings() })) };
  rec.ondataavailable = async (e) => {
    if (r.firstChunkMs === undefined) r.firstChunkMs = performance.now();
    r.chunks++; r.bytes += e.data.size;
    pending.push(ipcRenderer.invoke('chunk', file, await e.data.arrayBuffer()));
  };
  const pending = [];
  const started = new Promise((res) => (rec.onstart = () => { r.startEventMs = performance.now(); ipcRenderer.invoke('mark', `${job.outDir}/marks.log`, `${spec.name} start`); res(); }));
  const stopped = new Promise((res) => (rec.onstop = () => { r.stopEventMs = performance.now(); res(); }));
  return {
    r, extra,
    start() { r.startCallMs = performance.now(); rec.start(job.timeslice ?? 1000); return started; },
    async stop() { r.stopCallMs = performance.now(); rec.stop(); await stopped; await Promise.all(pending); cleanup.forEach((f) => f()); stream.getTracks().forEach((t) => t.stop()); r.beeps = extra.beeps; r.displayTracks = extra.displayTracks; return r; },
  };
}

async function main() {
  const cfg = await ipcRenderer.invoke('cfg'); const results0 = {};
  if (cfg.overlayBarcode) { // visible barcode so a captured screen carries ground truth (drawn top-left, 16 css px per bit)
    const bc = barcodeCanvas(640, 60); bc.canvas.style.cssText = 'position:fixed;left:0;top:0;z-index:9'; document.body.appendChild(bc.canvas);
  }
  if (cfg.playTone) { // 440 Hz through the system output, to be picked up by loopback capture
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain(); g.gain.value = 0.3; o.frequency.value = 440; o.connect(g).connect(ctx.destination); o.start();
  }
  results0.dpr = window.devicePixelRatio;
  if (cfg.listSources) {
    log('sources', JSON.stringify(await ipcRenderer.invoke('sources')));
  }
  if (cfg.gumTest) {
    for (const c of cfg.gumTest) {
      const t0 = performance.now();
      const r = await Promise.race([navigator.mediaDevices.getUserMedia(c).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'ok'; }, (e) => 'err ' + e), sleep(5000).then(() => 'TIMEOUT')]);
      console.log('gum', JSON.stringify(c), r, Math.round(performance.now() - t0) + 'ms');
    }
    const d = await navigator.mediaDevices.enumerateDevices();
    console.log('devices', JSON.stringify(d.map((x) => x.kind + ':' + x.label)));
  }
  if (cfg.audioCtxTest) {
    const ctx = new AudioContext({ sampleRate: 48000 });
    await sleep(1500);
    console.log('audioctx', ctx.state, ctx.currentTime, 'baseLatency', ctx.baseLatency);
  }
  const results = { support: {}, jobs: [], userAgent: navigator.userAgent, dpr: results0.dpr };
  for (const m of cfg.probeTypes ?? []) results.support[m] = MediaRecorder.isTypeSupported(m);
  for (const job of cfg.jobs ?? []) {
    log('job', job.id);
    try {
      await ipcRenderer.invoke('cpu-begin');
      const recs = [];
      for (const spec of job.streams) recs.push(await record(job, spec));
      // start all in the same tick to measure inter-recorder offsets
      await Promise.all(recs.map((x) => x.start()));
      await sleep(job.seconds * 1000);
      const out = [];
      for (const x of recs) out.push(await x.stop());
      const cpuStats = await ipcRenderer.invoke('cpu-end');
      const res = { id: job.id, streams: out, cpu: cpuStats, seconds: job.seconds };
      results.jobs.push(res);
      await ipcRenderer.invoke('write-json', `${job.outDir}/result.json`, res);
    } catch (e) {
      results.jobs.push({ id: job.id, error: String(e && e.stack || e) });
      log('job error', String(e));
      await ipcRenderer.invoke('cpu-end').catch(() => {});
    }
  }
  await ipcRenderer.invoke('write-json', cfg.resultFile, results);
  await ipcRenderer.invoke('quit');
}
main().catch(async (e) => { console.log('fatal', e && e.stack || e); await ipcRenderer.invoke('quit'); });
