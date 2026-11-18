const PCM = 1;
const EXTENSIBLE = 0xfffe;
/** Placeholder a streaming encoder writes for a size it does not know yet. */
const UNKNOWN_SIZE = 0xffffffff;

/**
 * Check that `bytes` is a mono 16-bit PCM WAV (any sample rate), the only thing the host accepts, and return it
 * with chunk sizes that match the bytes: a streamed WAV may carry a placeholder size in `RIFF` and `data`.
 * Throws an error that says what the bytes are instead, without quoting them.
 */
export function checkWav(bytes: Buffer): Buffer {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "RIFF" || bytes.toString("latin1", 8, 12) !== "WAVE") {
    throw new Error(`the response is not a WAV file (${bytes.length} bytes)`);
  }
  let format: { tag: number; channels: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      let tag = bytes.readUInt16LE(body);
      if (tag === EXTENSIBLE && size >= 26 && body + 26 <= bytes.length) tag = bytes.readUInt16LE(body + 24);
      format = { tag, channels: bytes.readUInt16LE(body + 2), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format) throw new Error("the WAV has no fmt chunk before its audio");
      if (format.tag !== PCM || format.channels !== 1 || format.bits !== 16) {
        throw new Error(`the WAV is not mono 16-bit PCM (format ${format.tag}, ${format.channels} channels, ${format.bits} bits)`);
      }
      const available = bytes.length - body;
      if (size !== UNKNOWN_SIZE && size <= available && bytes.readUInt32LE(4) === bytes.length - 8) return bytes;
      const length = Math.min(size === UNKNOWN_SIZE ? available : size, available) & ~1;
      const fixed = Buffer.from(bytes.subarray(0, body + length));
      fixed.writeUInt32LE(length, offset + 4);
      fixed.writeUInt32LE(fixed.length - 8, 4);
      return fixed;
    }
    offset = body + size + (size % 2);
  }
  throw new Error(format ? "the WAV has no audio data" : "the WAV has no fmt chunk");
}
