// Address policy of the guarded proxy: public unicast only, ports 80/443. Node built-ins only.
import { BlockList, isIP } from "node:net";

export const ALLOWED_PORTS = [80, 443];

/** IPv4 ranges that are not public unicast: IANA special-purpose registry plus multicast and reserved. */
const V4 = [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches the local host on Linux and macOS
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

/** IPv6 ranges inside 2000::/3 that are still not public, besides the allowlist 2000::/3 itself. */
const V6 = [
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embedded IPv4 also checked)
  ["3fff::", 20], // documentation
];

const blocked = new BlockList();
for (const [a, p] of V4) blocked.addSubnet(a, p, "ipv4");
for (const [a, p] of V6) blocked.addSubnet(a, p, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** The IPv4 address embedded in a mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 or 6to4 IPv6 address, else null. */
export function embeddedV4(ip) {
  const groups = expandV6(ip);
  if (!groups) return null;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return null;
}

function expandV6(ip) {
  if (isIP(ip) !== 6) return null;
  let text = ip.split("%")[0];
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split(".").map(Number);
    text = text.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  const all = [...h, ...fill, ...t].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g)) ? all : null;
}

/** True when `ip` (a literal, as dns.lookup returns it) is a public unicast address. Anything unparsable is not. */
export function isPublicUnicast(ip) {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family !== 6) return false;
  const bare = ip.split("%")[0];
  const v4 = embeddedV4(bare);
  if (v4 && !isPublicUnicast(v4)) return false;
  // Allowlist: only 2000::/3. Loopback, ULA, link-local, multicast, mapped, compatible and NAT64 forms are all outside it.
  if (!globalV6.check(bare, "ipv6")) return false;
  return !blocked.check(bare, "ipv6");
}

/** Why `port` is refused, or null. */
export function portVerdict(port, allowed = ALLOWED_PORTS) {
  return allowed.includes(port) ? null : `port ${port} not allowed`;
}
