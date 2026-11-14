import { describe, expect, it } from "vitest";
import { checkCaptureUrl, embeddedV4, isPublicUnicast } from "../src/brand/policy.js";

// Seam under test: the capture's network rules (ADR 0044): which URLs may be opened and which addresses dialed.

describe("isPublicUnicast", () => {
  it.each([
    "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.2.10", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250",
    "255.255.255.255", "::", "::1", "fc00::1", "fd00::5", "fe80::1", "fe80::1%en0", "ff02::1", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2001::1", "2001:db8::1", "2002:7f00:1::1",
    "2002:0808:0808::1", "3fff::1", "localhost", "", "not-an-ip",
  ])("refuses %s", (ip) => {
    expect(isPublicUnicast(ip)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "34.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001::200e"])("accepts %s", (ip) => {
    expect(isPublicUnicast(ip)).toBe(true);
  });

  it("finds the IPv4 address inside mapped, compatible, NAT64 and 6to4 forms", () => {
    expect(embeddedV4("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(embeddedV4("::ffff:a01:203")).toBe("10.1.2.3");
    expect(embeddedV4("64:ff9b::8.8.8.8")).toBe("8.8.8.8");
    expect(embeddedV4("2002:c0a8:101::1")).toBe("192.168.1.1");
    expect(embeddedV4("2606:4700::1")).toBeNull();
  });
});

describe("checkCaptureUrl", () => {
  it.each([
    ["file:///etc/hosts", "scheme"],
    ["data:text/html,<h1>x</h1>", "scheme"],
    ["chrome://version", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["view-source:http://example.com", "scheme"],
    ["ftp://example.com/logo.svg", "scheme"],
    ["ws://example.com/", "scheme"],
    ["https://user:secret@example.com/", "credentials"],
    ["http://example.com:8080/", "port"],
    ["https://example.com:8443/", "port"],
    ["example.com", "url"],
    ["", "url"],
  ])("refuses %s (%s)", (input, reason) => {
    const checked = checkCaptureUrl(input);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.problem.reason).toBe(reason);
  });

  it("accepts http and https on 80 and 443 and drops the fragment", () => {
    const checked = checkCaptureUrl(" https://Example.com:443/pricing?plan=pro#teams ");
    expect(checked.ok && checked.url.href).toBe("https://example.com/pricing?plan=pro");
    expect(checkCaptureUrl("http://example.com:80/").ok).toBe(true);
  });

  it("refuses a URL longer than credits.json records", () => {
    const checked = checkCaptureUrl(`https://example.com/?q=${"a".repeat(2048)}`);
    expect(!checked.ok && checked.problem.reason).toBe("url");
  });
});
