import { crc32, gzipSync } from "node:zlib";

/** One archive member: content and unix mode. */
export interface ArchiveEntry {
  content: string | Buffer;
  mode?: number;
}

/** Minimal ustar + gzip writer: builds fixtures without depending on the platform's `tar`. */
export function tarGz(entries: Record<string, ArchiveEntry>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, { content, mode = 0o755 }] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(octal(mode, 7), 100);
    header.write(octal(0, 7), 108);
    header.write(octal(0, 7), 116);
    header.write(octal(data.length, 11), 124);
    header.write(octal(0, 11), 136);
    header.write("        ", 148); // Checksum is computed with its own field as spaces.
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${octal(sum, 6)}\u0000 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Minimal stored (uncompressed) zip writer with unix modes, like real ffmpeg zips. */
export function zip(entries: Record<string, ArchiveEntry>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, { content, mode = 0o755 }] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Made by unix: external attrs carry the mode.
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDir, end]);
}

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, "0");
}
