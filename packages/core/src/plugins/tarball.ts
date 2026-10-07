import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

/**
 * `name` from the `package.json` at the top folder of an `npm pack` tarball
 * (`package/package.json`; any single top folder is accepted). Read before npm
 * runs, so an install knows which pin it replaces. Throws when the file is not
 * a gzipped tar or holds no such manifest with a string `name`.
 */
export async function tarballPackageName(file: string): Promise<string> {
  const tar = gunzipSync(await readFile(file));
  let longName: string | null = null;
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      // pax header: `<len> path=<value>\n` overrides the next entry's name.
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
      continue;
    }
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    if ((type !== "0" && type !== "\0") || !/^[^/]+\/package\.json$/.test(name)) continue;
    const pkg = JSON.parse(body.toString("utf8")) as { name?: unknown };
    if (typeof pkg.name !== "string" || !pkg.name) break;
    return pkg.name;
  }
  throw new Error("no package.json with a name at the tarball's top folder");
}

/** NUL-terminated ASCII field of a tar header. */
function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("utf8");
}
