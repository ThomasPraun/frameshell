/** Mono 16-bit PCM samples of the host's transcription WAV. */
export interface Pcm {
  sampleRate: number;
  samples: Int16Array;
}

/**
 * The samples of a mono 16-bit PCM WAV (what the host hands a transcription provider). Walks the chunks (ffmpeg
 * writes `LIST` before `data`); a `data` size past the end means "the rest of the file". Throws when it is not one.
 */
export function readPcm(bytes: Buffer): Pcm {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error("the audio is not a WAV file");
  }
  let sampleRate = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.length) break;
      const pcm = bytes.readUInt16LE(body) === 1 && bytes.readUInt16LE(body + 2) === 1 && bytes.readUInt16LE(body + 14) === 16;
      if (!pcm) throw new Error("the audio is not mono 16-bit PCM");
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (id === "data") {
      if (sampleRate === 0) break;
      const length = Math.floor(Math.min(size, bytes.length - body) / 2);
      const samples = new Int16Array(length);
      for (let i = 0; i < length; i++) samples[i] = bytes.readInt16LE(body + i * 2);
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("the audio WAV has no format or data");
}

/** `samples` as a mono 16-bit PCM WAV file. */
export function wavOf(samples: Int16Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2)]);
}

/** Where a long recording is cut: sample ranges `[from, to)` in order, covering it all. */
export interface PieceRange {
  from: number;
  to: number;
}

/** Length of the stretch whose loudness decides a cut, and the step between candidates, in seconds. */
const QUIET_FRAME_S = 0.1;
const QUIET_STEP_S = 0.01;

/**
 * Cut `pcm` into pieces of at most `pieceSeconds`, each cut moved to the quietest {@link QUIET_FRAME_S} of the
 * `searchSeconds` before the limit (a pause, so no word is split). One piece when it fits.
 */
export function pieceRanges(pcm: Pcm, pieceSeconds: number, searchSeconds: number): PieceRange[] {
  const { samples, sampleRate } = pcm;
  const longest = Math.max(1, Math.floor(pieceSeconds * sampleRate));
  const search = Math.min(Math.floor(searchSeconds * sampleRate), Math.floor(longest / 2));
  const frame = Math.max(1, Math.round(QUIET_FRAME_S * sampleRate));
  const step = Math.max(1, Math.round(QUIET_STEP_S * sampleRate));
  const ranges: PieceRange[] = [];
  let from = 0;
  while (samples.length - from > longest) {
    const limit = from + longest;
    let cut = limit;
    let quietest = Number.POSITIVE_INFINITY;
    for (let start = limit - search; start + frame <= limit; start += step) {
      let energy = 0;
      for (let i = start; i < start + frame; i++) energy += samples[i]! * samples[i]!;
      // `<=`: of equally quiet stretches the latest wins, so pieces stay as long as they may.
      if (energy <= quietest) {
        quietest = energy;
        cut = start + Math.floor(frame / 2);
      }
    }
    ranges.push({ from, to: cut });
    from = cut;
  }
  ranges.push({ from, to: samples.length });
  return ranges;
}
