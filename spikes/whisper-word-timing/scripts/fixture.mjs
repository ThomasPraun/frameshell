// PROTOTYPE. Builds media/original.wav (public-domain LibriVox chapter) and
// media/variant.wav: same audio plus long room-tone silences and one repeated
// phrase, to mimic a raw talking-head take. The edit map (media/variant.json)
// lets analyze.mjs map variant times back to original times.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MEDIA, SR, ffmpeg, readWav, writeWav, energyDb, speechThreshold, silences, HOP } from './lib.mjs';

// LibriVox, "Estudio sobre el arte de hablar en público" (Louis Bautain), ch. 9, read by Tux.
// Public Domain Mark 1.0. 9:47.
const SOURCE_URL = 'https://archive.org/download/hablarenpublico_1803_librivox/hablarenpublico_09_bautain.mp3';

mkdirSync(MEDIA, { recursive: true });
const mp3 = join(MEDIA, 'source.mp3');
if (!existsSync(mp3)) {
  const r = spawnSync('curl', ['-fSL', '-o', mp3, SOURCE_URL], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('download failed');
}
const origWav = join(MEDIA, 'original.wav');
ffmpeg(['-i', mp3, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', origWav]);

const { pcm } = readWav(origWav);
const dur = pcm.length / SR;
const db = energyDb(pcm);
const { floor, thr } = speechThreshold(db);
const pauses = silences(db, thr, 0.25);

/** Pause whose midpoint is nearest to t seconds. */
const pauseNear = (t) => pauses.reduce((b, p) => (Math.abs((p.start + p.end) / 2 - t) < Math.abs((b.start + b.end) / 2 - t) ? p : b));

// LibriVox audio is noise-gated (floor near digital zero). A raw take is not: inserts are
// silent here and the whole variant later gets constant room noise at ROOM_DB.
const ROOM_DB = -60;
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const roomAmp = 32768 * Math.pow(10, ROOM_DB / 20) * Math.sqrt(3); // uniform noise RMS = amp/sqrt(3)
const roomTone = (sec) => new Int16Array(Math.round(sec * SR));

// Inserts, in original time. Silences land mid-pause; repeat copies the phrase between
// two pauses and replays it after a short gap (a "retake").
const inserts = [];
for (const [t, sec] of [[75, 2.5], [200, 4.0], [330, 6.0], [480, 3.0]]) {
  const p = pauseNear(t);
  inserts.push({ kind: 'silence', at: +((p.start + p.end) / 2).toFixed(2), dur: sec });
}
{
  const a = pauseNear(260);
  // Next pause at least 2 s later ends the phrase.
  const b = pauses.find((p) => p.start > a.end + 2.0);
  const from = (a.start + a.end) / 2;
  const to = (b.start + b.end) / 2;
  inserts.push({ kind: 'repeat', at: +to.toFixed(2), src: [+from.toFixed(2), +to.toFixed(2)], gap: 0.8 });
}
inserts.sort((x, y) => x.at - y.at);

const parts = [];
let cursor = 0;
let shift = 0;
const map = [];
for (const ins of inserts) {
  const at = Math.round(ins.at * SR);
  parts.push(pcm.subarray(cursor, at));
  cursor = at;
  let added;
  if (ins.kind === 'silence') {
    added = roomTone(ins.dur);
  } else {
    const src = pcm.subarray(Math.round(ins.src[0] * SR), Math.round(ins.src[1] * SR));
    added = new Int16Array(Math.round(ins.gap * SR) + src.length);
    added.set(roomTone(ins.gap));
    added.set(src, Math.round(ins.gap * SR));
  }
  parts.push(added);
  const len = added.length / SR;
  map.push({ ...ins, variantStart: +(ins.at + shift).toFixed(3), variantEnd: +(ins.at + shift + len).toFixed(3), len: +len.toFixed(3) });
  shift += len;
}
parts.push(pcm.subarray(cursor));
const total = parts.reduce((n, p) => n + p.length, 0);
const out = new Int16Array(total);
let o = 0;
for (const p of parts) { out.set(p, o); o += p.length; }
for (let i = 0; i < out.length; i++) out[i] = Math.max(-32768, Math.min(32767, out[i] + Math.round(rnd() * roomAmp)));
writeWav(join(MEDIA, 'variant.wav'), out);

const meta = { sourceUrl: SOURCE_URL, roomNoiseDb: ROOM_DB, originalDuration: dur, variantDuration: total / SR, floorDb: floor, thrDb: thr, hop: HOP, inserts: map };
writeFileSync(join(MEDIA, 'variant.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
