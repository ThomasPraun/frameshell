// Sound effects synthesized from nothing (ADR 0038): one recipe per kind and variant, layered noise and tones
// through envelopes and filters. Same spec, same samples. The anchor of a take is the instant that must land on the
// picture: the transient of a hit, the peak of a whoosh, the end of a riser.
import {
  SFX_JITTER,
  SFX_PEAK_DBFS,
  SFX_VARIANTS,
  type SfxKind,
} from "@frameshell/schema";
import { Biquad, type Rng, SR, TAU, frames, noise, peakOf, rngOf, saturate } from "./dsp.js";

/** Shortest take in seconds: a tick (35 ms) is padded with silence to it, so the engine, which keeps whole frames of a file, still has a frame to play at 20 fps and up. */
export const SFX_MIN_LENGTH = 0.05;

/** What makes one take; its {@link sfxKey} is its cache key. */
export interface SfxSpec {
  kind: SfxKind;
  /** `1` to {@link SFX_VARIANTS}. */
  variant: number;
  /** Unsigned 32-bit family seed: one seed gives a set of sounds with one timbre. */
  seed: number;
  /** Multiplier of every frequency; absent = a seeded value in the jitter range. */
  pitch?: number | undefined;
  /** Length in seconds, for the kinds that take one. */
  length?: number | undefined;
}

/** A synthesized take. */
export interface SfxRender {
  sampleRate: number;
  /** 16-bit samples, one array per channel (a whoosh is stereo, everything else mono). */
  channels: Int16Array[];
  /** Sample index of the anchor. */
  anchor: number;
  /** The pitch multiplier used. */
  pitch: number;
  /** Seeded level offset applied on top of the normalised peak, in dB. */
  levelDb: number;
  /** Sample peak and RMS over all channels, in dBFS. */
  peakDb: number;
  rmsDb: number;
}

/** What a recipe draws on. */
interface Voice {
  variant: number;
  pitch: number;
  /** Timbre of the family, 0.9 to 1.1: scales filter cut-offs. */
  bright: number;
  rng: Rng;
  length: number | undefined;
}

/** A recipe's output: channels of float samples in about [-1, 1] and the anchor in seconds. */
interface Layered {
  channels: Float64Array[];
  anchor: number;
}

/** Synthesize `spec`. Throws when the variant is out of range. */
export function synthesizeSfx(spec: SfxSpec): SfxRender {
  if (!Number.isInteger(spec.variant) || spec.variant < 1 || spec.variant > SFX_VARIANTS) throw new RangeError(`variant ${spec.variant} is not 1 to ${SFX_VARIANTS}`);
  const rng = rngOf("sfx", spec.seed, spec.kind, spec.variant);
  const pitchDraw = rng();
  const levelDraw = rng();
  const pitch = spec.pitch ?? SFX_JITTER.pitch.min + (SFX_JITTER.pitch.max - SFX_JITTER.pitch.min) * pitchDraw;
  const levelDb = (levelDraw * 2 - 1) * SFX_JITTER.levelDb;
  const bright = 0.9 + 0.2 * rngOf("family", spec.seed)();
  const layered = RECIPES[spec.kind]({ variant: spec.variant, pitch, bright, rng, length: spec.length });

  // Fade the last samples so a cut tail never clicks, then pad with silence so every take is a clip at 20 fps and up (a frame is 50 ms there).
  const fade = Math.min(frames(0.01), Math.floor((layered.channels[0]?.length ?? 0) / 4));
  for (const channel of layered.channels) {
    for (let i = 0; i < fade; i++) channel[channel.length - 1 - i]! *= i / fade;
  }
  const padded = Math.max(layered.channels[0]?.length ?? 0, frames(SFX_MIN_LENGTH));
  layered.channels = layered.channels.map((channel) => {
    if (channel.length >= padded) return channel;
    const out = new Float64Array(padded);
    out.set(channel);
    return out;
  });
  // Bring the peak to the fixed level plus the jitter.
  const peak = peakOf(layered.channels);
  const gain = peak > 0 ? Math.exp(((SFX_PEAK_DBFS + levelDb) / 20) * Math.LN10) / peak : 0;
  const channels = layered.channels.map((channel) => Int16Array.from(channel, (x) => Math.max(-32767, Math.min(32767, Math.round(x * gain * 32767)))));

  let squares = 0;
  for (const channel of channels) for (const x of channel) squares += x * x;
  const total = channels.reduce((sum, channel) => sum + channel.length, 0);
  const db = (value: number) => (value > 0 ? (20 * Math.log(value / 32767)) / Math.LN10 : Number.NEGATIVE_INFINITY);
  return {
    sampleRate: SR,
    channels,
    anchor: Math.min(channels[0]!.length, Math.round(layered.anchor * SR)),
    pitch,
    levelDb,
    peakDb: db(peakOf(channels)),
    rmsDb: db(Math.sqrt(squares / total)),
  };
}

const RECIPES: Record<SfxKind, (voice: Voice) => Layered> = {
  click: (voice) => ({ channels: [click(voice, voice.pitch, 0.12)], anchor: 0 }),
  tick: (voice) => ({ channels: [click(voice, voice.pitch * 1.25, 0.035)], anchor: 0 }),
  pop,
  whoosh,
  riser,
  thump,
  impact,
  shutter,
};

/** Variant picks: `values[variant - 1]`. */
function pick<T>(voice: Voice, ...values: [T, T, T]): T {
  return values[voice.variant - 1]!;
}

/** Exponential decay at `t` with time constant `tau`. */
function decay(t: number, tau: number): number {
  return Math.exp(-t / tau);
}

/** A press: a high-passed noise burst, a blip and a body (variants 1 and 3), or two pings that fall to half pitch (variant 2). */
function click(voice: Voice, pitch: number, length: number): Float64Array {
  const { rng, variant, bright } = voice;
  const out = new Float64Array(frames(length));
  if (variant === 2) {
    const pings = [
      { at: 0, freq: 1450 },
      { at: 0.045, freq: 2180 },
    ];
    const phases = [0, 0];
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      let sum = 0;
      pings.forEach((ping, p) => {
        const local = t - ping.at;
        if (local < 0) return;
        const freq = ping.freq * pitch * Math.max(0.5, Math.exp(-(local / 0.035) * Math.LN2));
        phases[p]! += (TAU * freq) / SR;
        sum += Math.sin(phases[p]!) * (1 - decay(local, 0.0005)) * decay(local, 0.012);
      });
      out[i] = sum;
    }
    return out;
  }
  const burstLength = frames(variant === 1 ? 0.001 : 0.002);
  const hp = new Biquad().set("highpass", (variant === 1 ? 3500 : 5000) * pitch * bright, 0.7);
  const [blipFreq, blipTau, bodyFreq, bodyTau, bodyLevel] = variant === 1 ? [2300, 0.004, 520, 0.012, 0.5] : [3100, 0.003, 300, 0.02, 0.4];
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    const burst = i < burstLength ? hp.process(noise(rng)) * (1 - i / burstLength) : 0;
    out[i] = burst + 0.8 * Math.sin(TAU * blipFreq * pitch * t) * decay(t, blipTau) + bodyLevel * Math.sin(TAU * bodyFreq * pitch * t) * decay(t, bodyTau);
  }
  return out;
}

/** A bubble: a sine gliding up in a few milliseconds, a quick attack, an exponential decay and a noise tick. */
function pop(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const [from, to, glide, tau] = pick<[number, number, number, number]>(voice, [820, 1720, 0.017, 0.035], [700, 1450, 0.02, 0.045], [950, 2000, 0.014, 0.03]);
  const out = new Float64Array(frames(0.16));
  const bp = new Biquad().set("bandpass", 3000 * pitch * bright, 1);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += (TAU * (from + (to - from) * Math.min(1, t / glide)) * pitch) / SR;
    const env = t < 0.002 ? t / 0.002 : decay(t - 0.002, tau);
    out[i] = Math.sin(phase) * env + 0.3 * bp.process(noise(rng)) * decay(t, 0.002);
  }
  return { channels: [out], anchor: 0.002 };
}

/** A low hit: a saturated sine falling in pitch under a short low-passed noise sweep. */
function thump(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const [from, to, tau, length] = pick<[number, number, number, number]>(voice, [95, 42, 0.14, 0.5], [120, 45, 0.12, 0.45], [145, 32, 0.18, 0.6]);
  const out = new Float64Array(frames(length));
  const lp = new Biquad();
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += (TAU * (to + (from - to) * decay(t, 0.06)) * pitch) / SR;
    if (i % 16 === 0) lp.set("lowpass", (140 + 2060 * decay(t, 0.04)) * pitch * bright, 0.7);
    out[i] = saturate(Math.sin(phase) * decay(t, tau), 2.2) + 0.35 * lp.process(noise(rng)) * decay(t, 0.03);
  }
  return { channels: [out], anchor: 0 };
}

/** A hit: a deep sub that settles over seconds, a crack of band-passed noise and a dark tail. */
function impact(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const [crackFreq, sub, tailCut, length] = pick<[number, number, number, number]>(voice, [1800, 145, 600, 1.5], [2600, 120, 600, 1.2], [1800, 145, 900, 1.9]);
  const out = new Float64Array(frames(length));
  const crack = new Biquad().set("bandpass", crackFreq * pitch * bright, 0.8);
  const tail = new Biquad().set("lowpass", tailCut * pitch * bright, 0.7);
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    phase += (TAU * (22 + (sub - 22) * decay(t, 0.075)) * pitch) / SR;
    const body = saturate(Math.sin(phase) * decay(t, 0.45), 2.5);
    const smack = 0.7 * crack.process(noise(rng)) * decay(t, 0.015);
    const air = 0.25 * tail.process(noise(rng)) * decay(t, 0.5) * (1 - decay(t, 0.02));
    out[i] = body + smack + air;
  }
  return { channels: [out], anchor: 0 };
}

/** A camera: two band-passed noise clacks a few tens of milliseconds apart over a faint low knock. */
function shutter(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const gap = pick(voice, 0.035, 0.03, 0.04);
  const clacks = [
    { at: 0, freq: 2400, tau: 0.006, level: 1 },
    { at: gap, freq: 1700, tau: 0.008, level: 0.8 },
  ].map((clack) => ({ ...clack, filter: new Biquad().set("bandpass", clack.freq * pitch * bright, 1.5) }));
  const out = new Float64Array(frames(0.16));
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let sum = 0;
    for (const clack of clacks) {
      const local = t - clack.at;
      if (local < 0) continue;
      sum += clack.level * (clack.filter.process(noise(rng)) * decay(local, clack.tau) + 0.3 * Math.sin(TAU * 180 * pitch * local) * decay(local, 0.015));
    }
    out[i] = sum;
  }
  return { channels: [out], anchor: 0 };
}

/** Sweep of `from` to `to` over progress `u` in [0, 1], equal ratios per step. */
function sweep(from: number, to: number, u: number): number {
  return from * Math.exp(Math.log(to / from) * u);
}

/** Air moving past: band-passed noise sweeping up, swelling to a peak at 45 % of its length, panned left to right. */
function whoosh(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const length = voice.length ?? pick(voice, 0.85, 0.7, 1.0);
  const [from, to] = pick<[number, number]>(voice, [250, 5000], [160, 3400], [350, 6850]);
  const left = new Float64Array(frames(length));
  const right = new Float64Array(left.length);
  const bp = new Biquad();
  const peak = 0.45;
  for (let i = 0; i < left.length; i++) {
    const u = i / left.length;
    if (i % 16 === 0) bp.set("bandpass", sweep(from, to, u) * pitch * bright, 1.4);
    const rise = u < peak ? Math.sin((Math.PI / 2) * (u / peak)) : Math.cos((Math.PI / 2) * ((u - peak) / (1 - peak)));
    const sample = bp.process(noise(rng)) * rise * rise;
    const pan = (Math.PI / 2) * (0.1 + 0.8 * u);
    left[i] = sample * Math.cos(pan);
    right[i] = sample * Math.sin(pan);
  }
  return { channels: [left, right], anchor: length * peak };
}

/** A build: noise sweeping up with a rising saw, gain growing exponentially, cut at the peak, which is the anchor. */
function riser(voice: Voice): Layered {
  const { rng, pitch, bright } = voice;
  const length = voice.length ?? pick(voice, 2.2, 2.0, 2.4);
  const [from, to] = pick<[number, number]>(voice, [250, 6500], [200, 5800], [300, 7300]);
  const out = new Float64Array(frames(length));
  const bp = new Biquad();
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    if (i % 16 === 0) bp.set("bandpass", sweep(from, to, u) * pitch * bright, 1);
    const base = 110 * pitch * Math.exp(u * Math.log(8));
    phase += (TAU * base) / SR;
    // Six partials of a saw, none above 12 kHz.
    let saw = 0;
    for (let k = 1; k <= 6 && base * k < 12000; k++) saw += Math.sin(k * phase) / k;
    out[i] = (0.8 * bp.process(noise(rng)) + 0.35 * saw) * Math.exp(5 * (u - 1));
  }
  return { channels: [out], anchor: length };
}
