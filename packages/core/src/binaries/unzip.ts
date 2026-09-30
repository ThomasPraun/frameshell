import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
/** End record (22 bytes) plus the longest comment. */
const MAX_TAIL = 22 + 0xffff;

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
  /** Unix mode from the external attributes; null when the archive was not made on unix. */
  mode: number | null;
}

/**
 * Extract `members` of a zip archive into `dest`: each member is a file, or
 * a directory whose files all come along. Stored and deflated entries, unix
 * modes and symlinks; no zip64 (managed archives stay far below 4 GB).
 * The system `tar` reads zip on macOS and Windows only; Linux needs this.
 * Throws when a member is missing or an entry would land outside `dest`.
 * Integrity is the caller's: archives are SHA-256 verified before extraction.
 */
export async function extractZip(archive: string, dest: string, members: readonly string[]): Promise<void> {
  const entries = await readCentralDirectory(archive);
  const wanted = entries.filter(({ name }) => members.some((member) => name === member || name.startsWith(`${member.replace(/\/$/, "")}/`)));
  for (const member of members) {
    if (!wanted.some(({ name }) => name === member || name.startsWith(`${member.replace(/\/$/, "")}/`))) {
      throw new Error(`archive has no ${member}`);
    }
  }
  const root = resolve(dest);
  const handle = await open(archive, "r");
  try {
    for (const entry of wanted) {
      const target = resolve(root, ...entry.name.split("/"));
      const inside = relative(root, target);
      if (inside.startsWith("..") || isAbsolute(inside) || inside.split(sep).includes("..")) {
        throw new Error(`zip entry ${entry.name} would land outside ${dest}`);
      }
      if (entry.name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const header = Buffer.alloc(30);
      await handle.read(header, 0, 30, entry.localOffset);
      if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new Error(`zip entry ${entry.name} has no local header`);
      const start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      if (entry.compressedSize === 0) {
        await writeFile(target, "");
        continue;
      }
      if (entry.method !== 0 && entry.method !== 8) {
        throw new Error(`zip entry ${entry.name} uses compression method ${entry.method}; only stored and deflate are supported`);
      }
      const raw = createReadStream(archive, { start, end: start + entry.compressedSize - 1 });
      const data = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
      raw.on("error", (error) => data.destroy(error));
      if (entry.mode !== null && (entry.mode & 0o170000) === 0o120000) {
        const chunks: Buffer[] = [];
        for await (const chunk of data) chunks.push(chunk as Buffer);
        await symlink(Buffer.concat(chunks).toString("utf8"), target);
        continue;
      }
      await pipeline(data, createWriteStream(target));
      if (entry.mode !== null && process.platform !== "win32") await chmod(target, entry.mode & 0o777 || 0o644);
    }
  } finally {
    await handle.close();
  }
}

async function readCentralDirectory(archive: string): Promise<Entry[]> {
  const handle = await open(archive, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, MAX_TAIL);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let end = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error("not a zip archive (no end of central directory)");
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) throw new Error("zip64 archives are not supported");
    const directory = Buffer.alloc(length);
    await handle.read(directory, 0, length, offset);
    const entries: Entry[] = [];
    for (let at = 0, n = 0; n < count; n++) {
      if (directory.readUInt32LE(at) !== CENTRAL_ENTRY) throw new Error("corrupt zip central directory");
      const madeBy = directory.readUInt16LE(at + 4) >> 8;
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38);
      entries.push({
        name: directory.toString("utf8", at + 46, at + 46 + nameLength),
        method: directory.readUInt16LE(at + 10),
        compressedSize: directory.readUInt32LE(at + 20),
        localOffset: directory.readUInt32LE(at + 42),
        mode: madeBy === 3 ? external >>> 16 : null,
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** True when the file starts with a zip local header. */
export async function isZip(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && head.readUInt32LE(0) === LOCAL_HEADER;
  } finally {
    await handle.close();
  }
}
