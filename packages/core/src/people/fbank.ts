// Log mel filterbank features as sherpa-onnx computes them for its speaker embedding models:
// kaldi-native-fbank v1.22.3 with sherpa-onnx v1.13.8's `FeatureExtractorConfig` defaults, then the
// per-utterance mean subtraction its embedding extractor applies (model metadata
// `feature_normalize_type: global-mean`). Checked against kaldi-native-fbank built from source
// (`test/fixtures/fbank-reference.json`) and sherpa-onnx's own embeddings (`docs/binaries.md`).

/** Sample rate the features are defined for (CAM++ metadata `sample_rate`). */
export const FBANK_SAMPLE_RATE = 16_000;
/** Mel bins per frame: the model input is `[N, T, 80]`. */
export const FBANK_BINS = 80;
/** 25 ms frames every 10 ms. */
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
/** Frame length rounded up to a power of two for the FFT. */
const PADDED = 512;
const PREEMPHASIS = 0.97;
/** Lowest mel band edge in Hz; the highest is 400 Hz below Nyquist (`high_freq = -400`). */
const LOW_FREQ = 20;
const HIGH_FREQ = FBANK_SAMPLE_RATE / 2 - 400;
/** `std::numeric_limits<float>::epsilon()`: the floor kaldi takes the log of. */
const FLOAT_EPSILON = 1.1920928955078125e-7;

/** Feature frames of one piece of audio: `frames` rows of {@link FBANK_BINS} values, row-major. */
export interface Fbank {
  frames: number;
  data: Float32Array;
}

/**
 * Log mel energies of mono 16 kHz samples in [-1, 1] (sherpa-onnx metadata
 * `normalize_samples: 1`), as kaldi's `snip_edges=false` framing gives them:
 * `round(samples / 160)` frames centred on every 10 ms, edges reflected; per
 * frame DC removed, pre-emphasis 0.97, Povey window, 512-point power
 * spectrum, 80 triangular mel bands (20 Hz to 7600 Hz), natural log. No dither.
 */
export function fbank(samples: Float32Array): Fbank {
  const frames = Math.floor((samples.length + FRAME_SHIFT / 2) / FRAME_SHIFT);
  const data = new Float32Array(frames * FBANK_BINS);
  if (samples.length === 0) return { frames: 0, data };
  const { window, banks, cos, sin, reversed } = tables();
  const re = new Float64Array(PADDED);
  const im = new Float64Array(PADDED);
  const power = new Float64Array(PADDED / 2 + 1);
  for (let frame = 0; frame < frames; frame++) {
    // Kaldi centres frame f on sample f * shift + shift / 2.
    const start = frame * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      const value = samples[reflect(start + i, samples.length)]!;
      re[i] = value;
      mean += value;
    }
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) re[i]! -= mean;
    for (let i = FRAME_LENGTH - 1; i > 0; i--) re[i]! -= PREEMPHASIS * re[i - 1]!;
    re[0]! -= PREEMPHASIS * re[0]!;
    for (let i = 0; i < FRAME_LENGTH; i++) re[i]! *= window[i]!;
    re.fill(0, FRAME_LENGTH);
    im.fill(0);
    fft(re, im, cos, sin, reversed);
    for (let k = 0; k <= PADDED / 2; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    const row = frame * FBANK_BINS;
    for (let bin = 0; bin < FBANK_BINS; bin++) {
      const { first, weights } = banks[bin]!;
      let energy = 0;
      for (let i = 0; i < weights.length; i++) energy += weights[i]! * power[first + i]!;
      data[row + bin] = Math.log(Math.max(energy, FLOAT_EPSILON));
    }
  }
  return { frames, data };
}

/** Subtract each bin's mean over all frames, in place: sherpa-onnx's `global-mean` normalization, per utterance. */
export function subtractMean(features: Fbank): Fbank {
  const { frames, data } = features;
  if (frames === 0) return features;
  for (let bin = 0; bin < FBANK_BINS; bin++) {
    let sum = 0;
    for (let frame = 0; frame < frames; frame++) sum += data[frame * FBANK_BINS + bin]!;
    const mean = sum / frames;
    for (let frame = 0; frame < frames; frame++) data[frame * FBANK_BINS + bin]! -= mean;
  }
  return features;
}

/** Index of sample `s` with reflection around both ends (`-1` -> `0`, `n` -> `n - 1`), as kaldi's `ExtractWindow`. */
function reflect(s: number, n: number): number {
  let index = s;
  while (index < 0 || index >= n) index = index < 0 ? -index - 1 : 2 * n - 1 - index;
  return index;
}

interface Tables {
  window: Float64Array;
  banks: { first: number; weights: Float64Array }[];
  cos: Float64Array;
  sin: Float64Array;
  reversed: Uint16Array;
}

let cached: Tables | undefined;

function tables(): Tables {
  if (cached) return cached;
  const window = new Float64Array(FRAME_LENGTH);
  const a = (2 * Math.PI) / (FRAME_LENGTH - 1);
  for (let i = 0; i < FRAME_LENGTH; i++) window[i] = (0.5 - 0.5 * Math.cos(a * i)) ** 0.85;

  // Kaldi's mel banks: equal spacing on the 1127 ln(1 + f / 700) scale over the FFT bins below Nyquist.
  const mel = (freq: number) => 1127 * Math.log(1 + freq / 700);
  const binWidth = FBANK_SAMPLE_RATE / PADDED;
  const low = mel(LOW_FREQ);
  const delta = (mel(HIGH_FREQ) - low) / (FBANK_BINS + 1);
  const banks: Tables["banks"] = [];
  for (let bin = 0; bin < FBANK_BINS; bin++) {
    const left = low + bin * delta;
    const center = low + (bin + 1) * delta;
    const right = low + (bin + 2) * delta;
    const weights: number[] = [];
    let first = -1;
    for (let i = 0; i < PADDED / 2; i++) {
      const m = mel(binWidth * i);
      if (m <= left || m >= right) continue;
      if (first === -1) first = i;
      // Bins between `first` and `i` that fell outside are zero weights.
      while (first + weights.length < i) weights.push(0);
      weights.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
    }
    banks.push({ first, weights: Float64Array.from(weights) });
  }

  const cos = new Float64Array(PADDED / 2);
  const sin = new Float64Array(PADDED / 2);
  for (let k = 0; k < PADDED / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / PADDED);
    sin[k] = Math.sin((-2 * Math.PI * k) / PADDED);
  }
  const bits = Math.log2(PADDED);
  const reversed = new Uint16Array(PADDED);
  for (let i = 0; i < PADDED; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  cached = { window, banks, cos, sin, reversed };
  return cached;
}

/** In-place radix-2 complex FFT of length {@link PADDED}. */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array, reversed: Uint16Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) {
    const j = reversed[i]!;
    if (j > i) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
      }
    }
  }
}
