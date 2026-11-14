// Network rules of brand capture (ADR 0044): which URLs a capture may open and which addresses its proxy may dial.
// Measured in docs/research/brand-capture-proxy.md; Node built-ins only.
import { BlockList, isIP } from "node:net";
import { MAX_SOURCE_URL } from "@frameshell/schema";

/** The only ports capture traffic may reach. */
export const CAPTURE_PORTS: readonly number[] = [80, 443];

/** IPv4 ranges that are not public unicast: the IANA special-purpose registry plus multicast and reserved. */
const V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches the local host on Linux and macOS
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

/** Ranges inside the IPv6 allowlist 2000::/3 that are still not public: Teredo, documentation, 6to4. */
const V6: readonly (readonly [string, number])[] = [
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
];

const blocked = new BlockList();
for (const [address, prefix] of V4) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of V6) blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

/** The 8 groups of an IPv6 literal (a trailing dotted IPv4 part and a `%zone` allowed), or null. */
function expandV6(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let text = ip.split("%")[0]!;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  const groups = [...front, ...fill, ...back].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group)) ? groups : null;
}

/** The IPv4 address inside a mapped (`::ffff:a.b.c.d`), compatible, NAT64 or 6to4 IPv6 address, else null. */
export function embeddedV4(ip: string): string | null {
  const groups = expandV6(ip);
  if (!groups) return null;
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return v4(groups[6]!, groups[7]!);
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

/**
 * True when `ip` (a literal, as `dns.lookup` returns it) is a public unicast address. IPv6 is an allowlist
 * (2000::/3 minus the ranges above), so loopback, ULA, link-local, multicast and every embedded-IPv4 form stay
 * out; an embedded IPv4 address is checked too, because `BlockList` reads `::ffff:127.0.0.1` as 127.0.0.1.
 */
export function isPublicUnicast(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family !== 6) return false;
  const bare = ip.split("%")[0]!;
  const v4 = embeddedV4(bare);
  if (v4 && !isPublicUnicast(v4)) return false;
  if (!globalV6.check(bare, "ipv6")) return false;
  return !blocked.check(bare, "ipv6");
}

/** Why a capture URL is refused, as `reason` of the InvalidOperation error. */
export type CaptureUrlProblem = { reason: "url" | "scheme" | "credentials" | "port"; message: string };

/**
 * The URL a capture may open, or why not. Only `http:` and `https:` (the page itself is opened with
 * `Page.navigate`, which loads `file:` URLs without asking the proxy), no user name or password, and port 80 or
 * 443 (any other port is refused by the proxy anyway).
 */
export function checkCaptureUrl(input: string): { ok: true; url: URL } | { ok: false; problem: CaptureUrlProblem } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, problem: { reason: "url", message: `${JSON.stringify(input)} is not a URL; give the full address, e.g. https://example.com` } };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, problem: { reason: "scheme", message: `only http and https pages can be captured, not ${url.protocol}` } };
  }
  if (url.username || url.password) {
    return { ok: false, problem: { reason: "credentials", message: "the URL carries a user name or password; capture opens public pages only, without signing in" } };
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!CAPTURE_PORTS.includes(port)) {
    return { ok: false, problem: { reason: "port", message: `port ${port} is not allowed; capture reaches ports 80 and 443 only` } };
  }
  url.hash = "";
  if (url.href.length > MAX_SOURCE_URL) {
    return { ok: false, problem: { reason: "url", message: `the URL is longer than ${MAX_SOURCE_URL} characters, more than credits.json records` } };
  }
  return { ok: true, url };
}
