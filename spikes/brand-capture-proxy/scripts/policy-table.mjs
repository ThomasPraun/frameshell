// Address policy table: every row is an address that must be refused or accepted. Exit 1 on any mismatch.
import { isPublicUnicast, portVerdict } from "../src/policy.mjs";

const refused = [
  ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback end"], ["0.0.0.0", "this-network (reaches localhost)"], ["0.1.2.3", "0/8"],
  ["10.0.0.1", "RFC1918"], ["10.255.255.255", "RFC1918 end"], ["172.16.0.1", "RFC1918"], ["172.31.255.255", "RFC1918 end"],
  ["192.168.1.1", "RFC1918"], ["169.254.169.254", "cloud metadata"], ["169.254.0.1", "link-local"], ["100.64.0.1", "CGNAT"],
  ["100.127.255.255", "CGNAT end"], ["192.0.0.1", "IETF"], ["192.0.2.1", "TEST-NET-1"], ["198.18.0.1", "benchmark"],
  ["198.51.100.1", "TEST-NET-2"], ["203.0.113.1", "TEST-NET-3"], ["224.0.0.1", "multicast"], ["239.255.255.250", "SSDP multicast"],
  ["240.0.0.1", "reserved"], ["255.255.255.255", "broadcast"],
  ["::", "unspecified"], ["::1", "loopback v6"], ["fc00::1", "ULA"], ["fd12:3456::1", "ULA"], ["fe80::1", "link-local v6"],
  ["fe80::1%en0", "link-local with zone"], ["ff02::1", "multicast v6"], ["::ffff:127.0.0.1", "mapped loopback"],
  ["::ffff:7f00:1", "mapped loopback, hex form"], ["::ffff:10.0.0.1", "mapped RFC1918"], ["::ffff:8.8.8.8", "mapped public (never from DNS; refused)"],
  ["::127.0.0.1", "v4-compatible loopback"], ["64:ff9b::7f00:1", "NAT64 of loopback"], ["64:ff9b::808:808", "NAT64 of public (refused)"],
  ["2002:7f00:1::", "6to4 of loopback"], ["2002:0808:0808::", "6to4 of public (refused)"], ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
  ["2001:db8::1", "documentation v6"], ["100::1", "discard-only"], ["not an ip", "garbage"], ["", "empty"],
];
const accepted = [
  ["8.8.8.8", "public"], ["1.1.1.1", "public"], ["93.184.216.34", "public"], ["172.15.255.255", "just below RFC1918 172.16/12"],
  ["172.32.0.1", "just above RFC1918 172.16/12"], ["100.63.255.255", "just below CGNAT"], ["100.128.0.1", "just above CGNAT"],
  ["11.0.0.1", "public"], ["223.255.255.255", "last unicast"], ["2606:4700:4700::1111", "public v6"], ["2a00:1450:4001:81b::200e", "public v6"],
  ["2001:4860:4860::8888", "public v6 (2001:4860, outside Teredo 2001::/32)"],
];

let bad = 0;
for (const [ip, why] of refused) if (isPublicUnicast(ip)) (bad++, console.log(`FAIL accepted ${ip} (${why})`));
for (const [ip, why] of accepted) if (!isPublicUnicast(ip)) (bad++, console.log(`FAIL refused ${ip} (${why})`));
for (const port of [22, 25, 3000, 5173, 8080, 8443, 9222, 0]) if (!portVerdict(port)) (bad++, console.log(`FAIL port ${port} allowed`));
for (const port of [80, 443]) if (portVerdict(port)) (bad++, console.log(`FAIL port ${port} refused`));
console.log(`${refused.length} refused rows, ${accepted.length} accepted rows, 8+2 port rows: ${bad === 0 ? "all as expected" : `${bad} FAILED`}`);
process.exit(bad ? 1 : 0);
