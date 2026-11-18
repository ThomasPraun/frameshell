/** Mono 16-bit PCM WAV bytes for the stub server: a 220 Hz tone, 24 kHz like the API's. */
export function toneWavBytes(seconds = 0.2, sampleRate = 24_000): Buffer {
  return wavBytes(tone(seconds, sampleRate), { sampleRate });
}

/** The samples of a tone at about -6 dBFS. */
export function tone(seconds: number, sampleRate: number): Int16Array {
  const samples = new Int16Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(16_000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate));
  return samples;
}

/**
 * WAV writer with the header fields a test wants to bend: channel count, bit depth, and the sizes a streaming
 * encoder leaves as placeholders.
 */
export function wavBytes(
  samples: Int16Array,
  { sampleRate = 24_000, channels = 1, bits = 16, riffSize, dataSize }: { sampleRate?: number; channels?: number; bits?: number; riffSize?: number; dataSize?: number } = {},
): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(riffSize ?? 36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize ?? data.length, 40);
  return Buffer.concat([header, data]);
}
