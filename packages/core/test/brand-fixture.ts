// Fixtures for brand capture tests: synthetic font files with a chosen name table, and a fake public network
// (fake DNS answers and a dial that maps one fake public IP to a local server) for the capture proxy.
import net from "node:net";
import { brotliCompressSync, constants, deflateSync } from "node:zlib";

/** A `name` table with Windows Unicode records for `names` (id → text). */
export function nameTable(names: Record<number, string>): Buffer {
  const entries = Object.entries(names).map(([id, text]) => ({ id: Number(id), bytes: Buffer.from(text, "utf16le").swap16() }));
  const header = Buffer.alloc(6 + entries.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  entries.forEach((entry, i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(3, at);
    header.writeUInt16BE(1, at + 2);
    header.writeUInt16BE(0x409, at + 4);
    header.writeUInt16BE(entry.id, at + 6);
    header.writeUInt16BE(entry.bytes.length, at + 8);
    header.writeUInt16BE(offset, at + 10);
    offset += entry.bytes.length;
  });
  return Buffer.concat([header, ...entries.map((entry) => entry.bytes)]);
}

/** A TrueType file holding only `tables` (enough for the name reader; not a font Chrome would render). */
export function sfnt(tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables);
  const header = Buffer.alloc(12 + tags.length * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(tags.length, 4);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tags.forEach((tag, i) => {
    const at = 12 + i * 16;
    header.write(tag.padEnd(4, " "), at, "latin1");
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(tables[tag]!.length, at + 12);
    const padded = Buffer.concat([tables[tag]!, Buffer.alloc((4 - (tables[tag]!.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  return Buffer.concat([header, ...bodies]);
}

/** The same tables as a WOFF file, each zlib-compressed. */
export function woff(tables: Record<string, Buffer>): Buffer {
  const tags = Object.keys(tables);
  const header = Buffer.alloc(44 + tags.length * 20);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(tags.length, 12);
  let offset = header.length;
  const bodies: Buffer[] = [];
  tags.forEach((tag, i) => {
    const compressed = deflateSync(tables[tag]!);
    const at = 44 + i * 20;
    header.write(tag.padEnd(4, " "), at, "latin1");
    header.writeUInt32BE(offset, at + 4);
    header.writeUInt32BE(compressed.length, at + 8);
    header.writeUInt32BE(tables[tag]!.length, at + 12);
    const padded = Buffer.concat([compressed, Buffer.alloc((4 - (compressed.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  header.writeUInt32BE(offset, 8);
  return Buffer.concat([header, ...bodies]);
}

function base128(value: number): Buffer {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 128); rest > 0; rest = Math.floor(rest / 128)) bytes.unshift((rest & 0x7f) | 0x80);
  return Buffer.from(bytes);
}

/**
 * A WOFF2 file: a transformed `glyf` (stored at `transformed` bytes, not its original length) before `name`, so
 * the reader must use the transform length to find `name` in the brotli stream.
 */
export function woff2(name: Buffer, transformed = Buffer.from("TRANSFORMED")): Buffer {
  const directory = Buffer.concat([
    Buffer.from([10]), // glyf, transform version 0 = transformed
    base128(4000),
    base128(transformed.length),
    Buffer.from([5]), // name, never transformed
    base128(name.length),
  ]);
  const stream = brotliCompressSync(Buffer.concat([transformed, name]), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + directory.length + stream.length, 8);
  header.writeUInt16BE(2, 12);
  header.writeUInt32BE(stream.length, 20);
  return Buffer.concat([header, directory, stream]);
}

/** The fake public address the fixture site answers on. */
export const FAKE_PUBLIC_IP = "34.1.1.1";

/**
 * A fake public network: `names` answer from DNS (anything else is ENOTFOUND), and only `FAKE_PUBLIC_IP` on port
 * 80 connects, to `127.0.0.1:<sitePort>`; every other dial fails. `lookups` and `dials` record what happened.
 */
export function fakeNetwork(sitePort: number, names: Record<string, string[]>) {
  const lookups: string[] = [];
  const dials: string[] = [];
  return {
    lookups,
    dials,
    resolve: async (host: string) => {
      lookups.push(host);
      const answers = names[host];
      if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
      return answers;
    },
    dial: (ip: string, port: number) => {
      dials.push(`${ip}:${port}`);
      if (ip === FAKE_PUBLIC_IP && port === 80) return net.connect({ host: "127.0.0.1", port: sitePort });
      const socket = new net.Socket();
      process.nextTick(() => socket.destroy(new Error(`unreachable ${ip}:${port}`)));
      return socket;
    },
  };
}

/** A TCP listener on 127.0.0.1 counting connections: what a capture must never reach. */
export async function secretListener(): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    hits++;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nSECRET");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
