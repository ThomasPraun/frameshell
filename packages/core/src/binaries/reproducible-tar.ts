/** One regular file of a {@link packTar} archive. */
export interface TarEntry {
  /** `/`-separated path, at most 100 bytes (no ustar prefix field used). */
  name: string;
  data: Uint8Array;
  /** Unix permission bits, e.g. `0o755` for executables. */
  mode: number;
}

const BLOCK = 512;

/**
 * Uncompressed POSIX ustar archive whose bytes depend only on the entries:
 * mtime 0, uid/gid 0, no owner names, no extended attributes. System tar
 * archivers add timestamps, owners or macOS metadata, and gzip output varies
 * with the zlib build, so Frameshell's reproducible release assets are packed
 * with this instead. Readable by GNU tar and bsdtar.
 */
export function packTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    blocks.push(entry.data);
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(2 * BLOCK));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return out;
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const name = new TextEncoder().encode(entry.name);
  if (name.length === 0 || name.length > 100) throw new Error(`tar entry name must be 1-100 bytes: ${entry.name}`);
  block.set(name, 0);
  writeOctal(block, 100, 8, entry.mode & 0o7777);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, entry.data.length);
  writeOctal(block, 136, 12, 0); // mtime
  block.fill(0x20, 148, 156); // checksum is computed with its own field as spaces
  block[156] = 0x30; // '0': regular file
  block.set(new TextEncoder().encode("ustar\u000000"), 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  writeOctal(block, 148, 7, sum);
  block[155] = 0x20;
  return block;
}

/** Zero-padded octal digits in `width - 1` bytes, then NUL. */
function writeOctal(block: Uint8Array, offset: number, width: number, value: number): void {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) throw new Error(`tar field overflow: ${value}`);
  block.set(new TextEncoder().encode(digits), offset);
  block[offset + width - 1] = 0;
}
