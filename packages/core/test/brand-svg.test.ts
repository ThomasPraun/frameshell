import { describe, expect, it } from "vitest";
import { PAGE_SCRIPT } from "../src/brand/page-script.js";
import { EXTERNAL_CSS, SVG_ELEMENTS, sanitizeSvg, svgProblems } from "../src/brand/svg.js";

// Seam under test: the Node SVG allowlist of ADR 0044 decision 5, fed hostile files the way a Figma folder or a
// fetched logo could carry them.

const LIMITS = { imageChars: 1_000, elements: 500, depth: 32 };

function clean(svg: string) {
  const result = sanitizeSvg(svg, LIMITS);
  if (!result.ok) throw new Error(`refused: ${result.problem}`);
  expect(svgProblems(result.value.svg)).toBeNull();
  return result.value;
}

function refused(svg: string): string {
  const result = sanitizeSvg(svg, LIMITS);
  expect(result.ok).toBe(false);
  return (result as { problem: string }).problem;
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("sanitizeSvg", () => {
  it("keeps a Figma-shaped frame intact: gradients, clip paths, filters, patterns of an embedded raster", () => {
    const figma = `<svg width="1440" height="1024" viewBox="0 0 1440 1024" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<g clip-path="url(#clip0_1_2)"><rect width="1440" height="1024" fill="url(#paint0_linear_1_2)"/>
<rect x="40" y="40" width="200" height="60" rx="8" fill="url(#pattern0)" filter="url(#filter0_d)"/>
<text fill="#1A1A2E" font-family="Inter" font-size="24" font-weight="600" xml:space="preserve"><tspan x="60" y="80">Fish &amp; Chips &lt;3</tspan></text></g>
<defs><pattern id="pattern0" patternContentUnits="objectBoundingBox" width="1" height="1"><use xlink:href="#image0" transform="scale(0.01)"/></pattern>
<filter id="filter0_d" x="0" y="0" width="1" height="1" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feGaussianBlur stdDeviation="2"/></filter>
<linearGradient id="paint0_linear_1_2" x1="0" y1="0" x2="1440" y2="1024" gradientUnits="userSpaceOnUse"><stop stop-color="#FF5A1F"/><stop offset="1" stop-color="#1A1A2E"/></linearGradient>
<clipPath id="clip0_1_2"><rect width="1440" height="1024" fill="white"/></clipPath>
<image id="image0" width="100" height="100" xlink:href="${PNG}"/></defs></svg>`;
    const out = clean(figma);
    expect(out.removed).toEqual([]);
    expect([out.width, out.height]).toEqual([1440, 1024]);
    expect(out.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink" width="1440"/);
    for (const kept of ["<linearGradient", "<clipPath", "<feGaussianBlur", "<pattern", `xlink:href="${PNG}"`, 'xlink:href="#image0"', "Fish &amp; Chips &lt;3", 'xml:space="preserve"']) {
      expect(out.svg).toContain(kept);
    }
  });

  it.each([
    ["a script element", `<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="1" height="1"/></svg>`, "1 script element"],
    ["a script in CDATA", `<svg viewBox="0 0 10 10"><script><![CDATA[alert(1)]]></script></svg>`, "1 script element"],
    ["foreignObject with HTML", `<svg viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject></svg>`, "1 foreignObject element"],
    ["a style element", `<svg viewBox="0 0 10 10"><style>@import url(https://evil.test/a.css);</style></svg>`, "1 style element"],
    ["an animate that rewrites href", `<svg viewBox="0 0 10 10"><a><animate attributeName="href" to="javascript:alert(1)"/><rect width="1" height="1"/></a></svg>`, "1 animate element"],
    ["an event handler", `<svg viewBox="0 0 10 10" onload="alert(1)"><rect width="1" height="1" onclick="x()"/></svg>`, "2 event handlers"],
    ["an external image", `<svg viewBox="0 0 10 10"><image href="https://evil.test/track.png" width="1" height="1"/></svg>`, "1 external reference"],
    ["a file image", `<svg viewBox="0 0 10 10"><image xlink:href="file:///etc/passwd" width="1" height="1"/></svg>`, "1 external reference"],
    ["an SVG data image (could carry script)", `<svg viewBox="0 0 10 10"><image href="data:image/svg+xml;base64,PHN2Zz4=" width="1" height="1"/></svg>`, "1 external reference"],
    ["an external use", `<svg viewBox="0 0 10 10"><use href="https://evil.test/sprite.svg#a"/></svg>`, "1 external reference"],
    ["an entity-encoded javascript href", `<svg viewBox="0 0 10 10"><a href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a><use href="&#x6A;avascript:x"/></svg>`, "1 script URL"],
    ["a javascript URL split by a tab", `<svg viewBox="0 0 10 10"><use href="java&#9;script:alert(1)"/></svg>`, "1 script URL"],
    ["an external url() in a style attribute", `<svg viewBox="0 0 10 10"><rect width="1" height="1" style="fill: url( 'https://evil.test/p.svg#x' )"/></svg>`, "1 external url()"],
    ["a quoted URL in image-set()", `<svg viewBox="0 0 10 10"><rect width="1" height="1" style="mask-image:image-set('https://evil.test/x.png' 1x)"/></svg>`, "1 external url()"],
    ["a quoted URL in -webkit-image-set()", `<svg viewBox="0 0 10 10"><rect width="1" height="1" style="mask-image: -webkit-image-set(&quot;https://evil.test/x.png&quot; 1x)"/></svg>`, "1 external url()"],
    ["a quoted URL in image(), cross-fade() and src()", `<svg viewBox="0 0 10 10"><rect width="1" height="1" style="mask-image:image('https://evil.test/a.png')"/><rect width="1" height="1" style="mask-image:cross-fade('https://evil.test/b.png' 50%, red)"/><rect width="1" height="1" style="mask-image:src('https://evil.test/c.png')"/></svg>`, "3 external url()s"],
    ["a CSS escape hiding url(",`<svg viewBox="0 0 10 10"><rect width="1" height="1" style="fill: \\75 rl(https://evil.test/x)"/></svg>`, "1 CSS escape"],
    ["an embedded raster over the cap", `<svg viewBox="0 0 10 10"><image href="data:image/png;base64,${"A".repeat(2_000)}" width="1" height="1"/></svg>`, "1 oversized embedded image"],
  ])("removes %s", (_name, svg, removed) => {
    const out = clean(svg);
    expect(out.removed).toContain(removed);
    expect(out.svg).not.toMatch(/script|foreignObject|onload|onclick|onerror|evil\.test|file:|animate|<style|svg\+xml/i);
  });

  it("unwraps links, drops editor namespaces and forces the SVG namespace on the root", () => {
    const out = clean(
      `<svg xmlns="http://www.w3.org/1999/xhtml" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1" viewBox="0 0 10 10"><inkscape:grid/><a href="#top"><circle r="2"/></a></svg>`,
    );
    expect(out.svg).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="2"/></svg>');
    expect(out.removed).toEqual(["1 inkscape:grid element"]);
  });

  it.each([
    ["a DOCTYPE with entities (billion laughs)", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg viewBox="0 0 1 1"><text>&b;</text></svg>`, "has a DTD"],
    ["an ENTITY declaration without a DOCTYPE", `<!ENTITY a "aaaa"><svg viewBox="0 0 1 1"/>`, "has a DTD"],
    ["a DOCTYPE after the root", `<svg viewBox="0 0 1 1"/><!DOCTYPE svg>`, "has a DTD"],
    ["an external entity",`<svg viewBox="0 0 1 1"><text>&xxe;</text></svg>`, "uses an undeclared entity &xxe;"],
    ["a bare ampersand", `<svg viewBox="0 0 1 1"><text>Fish & Chips</text></svg>`, "is not well-formed XML"],
    ["mismatched tags", `<svg viewBox="0 0 1 1"><g></svg>`, "is not well-formed XML"],
    ["an unclosed root", `<svg viewBox="0 0 1 1"><g/>`, "is not well-formed XML"],
    ["two roots", `<svg viewBox="0 0 1 1"/><svg viewBox="0 0 1 1"/>`, "is not well-formed XML"],
    ["a duplicate attribute", `<svg viewBox="0 0 1 1" viewBox="0 0 2 2"/>`, "is not well-formed XML"],
    ["a non-SVG root", `<html><body/></html>`, "is not an SVG document"],
    ["deep nesting", `<svg viewBox="0 0 1 1">${"<g>".repeat(40)}${"</g>".repeat(40)}</svg>`, "nests elements more than 32 deep"],
    ["too many elements", `<svg viewBox="0 0 1 1">${"<rect/>".repeat(600)}</svg>`, "has more than 500 elements"],
  ])("refuses %s", (_name, svg, problem) => {
    expect(refused(svg)).toBe(problem);
  });

  it("keeps a logo with the Illustrator header: a DOCTYPE naming the external SVG 1.1 DTD, which is never read", () => {
    const out = clean(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 50" style="enable-background:new 0 0 100 50;" xml:space="preserve">
<rect width="100" height="50" fill="#FF5A1F"/>
</svg>`);
    expect(out.svg).not.toMatch(/DOCTYPE|svg11\.dtd/);
    expect(out.svg).toContain('<rect width="100" height="50" fill="#FF5A1F"/>');
    expect([out.width, out.height]).toEqual([100, 50]);
  });

  it("keeps text that talks about script URLs, handlers and url(): only markup is checked", () => {
    const out = clean(`<svg viewBox="0 0 1 1"><text>see javascript: docs, url(x) and onload= href="http://a"</text><title>image-set('a')</title></svg>`);
    expect(out.svg).toContain("see javascript: docs");
  });

  it("reads the size from width and height in px, else from the viewBox", () => {
    expect(clean(`<svg width="375px" height="812" viewBox="0 0 1 1"/>`)).toMatchObject({ width: 375, height: 812 });
    expect(clean(`<svg width="100%" height="100%" viewBox="0, 0, 1440, 900.5"/>`)).toMatchObject({ width: 1440, height: 900.5 });
    expect(clean(`<svg/>`)).toMatchObject({ width: null, height: null });
  });

  it("escapes what it writes back, so decoded text cannot open a tag", () => {
    const out = clean(`<svg viewBox="0 0 1 1"><text>&lt;script&gt;alert(1)&lt;/script&gt;</text><desc><![CDATA[<b>bold</b>]]></desc></svg>`);
    expect(out.svg).toContain("<text>&lt;script&gt;alert(1)&lt;/script&gt;</text>");
    expect(out.svg).toContain("<desc>&lt;b&gt;bold&lt;/b&gt;</desc>");
  });
});

describe("svgProblems", () => {
  it.each([
    ["image-set() with a quoted URL", `<svg><rect style="mask-image:image-set('https://evil.test/x.png' 1x)"/></svg>`, "has an external url()"],
    ["-webkit-image-set()", `<svg><rect style="mask-image:-webkit-image-set(&quot;https://evil.test/x.png&quot; 1x)"/></svg>`, "has an external url()"],
    ["cross-fade()", `<svg><rect style="mask-image:cross-fade('https://evil.test/x.png' 50%, red)"/></svg>`, "has an external url()"],
    ["an event handler", `<svg><rect onclick="x()"/></svg>`, "has an event handler"],
    ["a handler hidden in a comment", `<svg><!-- --!><img src=x onerror=alert(1)> --><rect/></svg>`, "has an event handler"],
  ])("refuses %s", (_name, svg, problem) => {
    expect(svgProblems(svg)).toBe(problem);
  });
});

describe("page script", () => {
  it("parses with the shared allowlist written into it", () => {
    expect(() => new Function(PAGE_SCRIPT)).not.toThrow();
    expect(PAGE_SCRIPT).toContain(JSON.stringify(SVG_ELEMENTS));
    expect(PAGE_SCRIPT).toContain(JSON.stringify(EXTERNAL_CSS.source));
  });
});
