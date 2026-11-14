// Script the capture installs in an isolated world of the page (`Page.createIsolatedWorld`): it shares the DOM
// but not the page's globals, so the site's own scripts cannot replace getComputedStyle, DOMParser or
// XMLSerializer under it. Everything it returns is data; SVG it serialises is checked again by `svgProblems`.

/** Logo or icon candidate as the script reports it. */
export type PageLogo =
  | { kind: "svg"; markup: string; width: number; height: number }
  | { kind: "img"; url: string; width: number; height: number };

/** A heading or button as the script reports it. */
export interface PageText {
  tag: string;
  text: string;
  family: string;
  size: number;
  weight: number;
  tracking: number;
  color: string | null;
  background: string | null;
}

/** What `__frameshellBrand.measure()` returns. */
export interface PageFindings {
  title: string | null;
  siteName: string | null;
  pageBackground: string | null;
  textLength: number;
  colors: { hex: string; roles: Record<string, number> }[];
  fonts: { stack: string; uses: number; weights: Record<string, number> }[];
  variables: Record<string, string>;
  headings: PageText[];
  buttons: PageText[];
  logos: PageLogo[];
  icons: { url: string; rel: string; sizes: string | null }[];
  og: string | null;
  videos: string[];
  scrollHeight: number;
}

/** Installs `globalThis.__frameshellBrand` with `measure()`, `sanitizeSvg(text)` and `flatten()`. */
export const PAGE_SCRIPT = String.raw`(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const memo = new Map();
  // Any CSS colour (rgb, oklch, color(), named) to #rrggbb; null when mostly transparent.
  const hex = (value) => {
    if (!value) return null;
    if (memo.has(value)) return memo.get(value);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000000";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const out = a < 128 ? null : "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
    memo.set(value, out);
    return out;
  };
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
  const absolute = (url) => { try { return new URL(url, document.baseURI).href; } catch { return null; } };
  const web = (url) => typeof url === "string" && /^https?:/i.test(url);
  const firstFamily = (stack) => (stack.split(",")[0] || "").trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  const tracking = (s) => { const px = parseFloat(s.letterSpacing); const size = parseFloat(s.fontSize) || 16; return Number.isFinite(px) ? Math.round((px / size) * 1000) / 1000 : 0; };
  const textStyle = (el) => {
    const s = getComputedStyle(el);
    return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80), family: firstFamily(s.fontFamily), size: Math.round(parseFloat(s.fontSize) * 10) / 10, weight: Number(s.fontWeight) || 400, tracking: tracking(s), color: hex(s.color), background: hex(s.backgroundColor) };
  };

  const ALLOWED = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "image", "filter", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feflood", "fegaussianblur", "feoffset", "femerge", "femergenode", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fedropshadow", "femorphology"]);
  const UNWRAP = new Set(["a", "switch"]);
  const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;
  const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan"]);
  // Bake computed fill and stroke into a fresh clone, so classes and currentColor survive without the page's
  // stylesheets. Runs before anything changes the clone's structure: nodes are paired by document order.
  const bake = (copy, live) => {
    const sources = [...live.querySelectorAll("*")];
    [...copy.querySelectorAll("*")].forEach((node, i) => {
      const source = sources[i];
      if (!source || !SHAPES.has(node.localName.toLowerCase())) return;
      const s = getComputedStyle(source);
      if (!node.hasAttribute("fill") || node.getAttribute("fill") === "currentColor") node.setAttribute("fill", s.fill.startsWith("url(") ? "currentColor" : s.fill);
      if (s.stroke && s.stroke !== "none" && (!node.hasAttribute("stroke") || node.getAttribute("stroke") === "currentColor")) node.setAttribute("stroke", s.stroke);
    });
  };
  // Allowlist pass over an SVG element (a clone, or a parsed file): unknown elements dropped, <a> unwrapped, no
  // event handlers, no external references (href or url() not starting with #), small data rasters kept.
  const clean = (root) => {
    if (!ALLOWED.has(root.localName.toLowerCase())) return null;
    const walk = (node) => {
      for (const child of [...node.children]) {
        const name = child.localName.toLowerCase();
        if (UNWRAP.has(name)) { walk(child); child.replaceWith(...child.childNodes); continue; }
        if (!ALLOWED.has(name)) { child.remove(); continue; }
        walk(child);
      }
    };
    walk(root);
    for (const el of [root, ...root.querySelectorAll("*")]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        const local = name.replace(/^xlink:/, "");
        if (name.startsWith("on") || /javascript:|vbscript:/i.test(value)) el.removeAttribute(attr.name);
        else if (local === "href" || local === "src") {
          const keep = value.startsWith("#") || (el.localName.toLowerCase() === "image" && SAFE_IMAGE.test(value) && value.length < 200000);
          if (!keep) el.removeAttribute(attr.name);
        } else if (/url\(\s*['"]?(?!#)/i.test(value) || /@import|expression\(/i.test(value)) el.removeAttribute(attr.name);
      }
      if (el.localName.toLowerCase() === "image" && !el.getAttribute("href") && !el.getAttribute("xlink:href")) el.remove();
    }
    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(root);
  };
  // A <use href="#id"> of a sprite outside the logo: copy the referenced symbol in, as a nested svg.
  const inlineUses = (copy) => {
    for (const use of [...copy.querySelectorAll("use")]) {
      const ref = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      if (!ref.startsWith("#") || copy.querySelector(ref.replace(/([^\w#-])/g, "\\$1"))) continue;
      const target = document.getElementById(ref.slice(1));
      if (!target) continue;
      const nested = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const name of ["x", "y", "width", "height"]) if (use.hasAttribute(name)) nested.setAttribute(name, use.getAttribute(name));
      if (target.hasAttribute("viewBox")) nested.setAttribute("viewBox", target.getAttribute("viewBox"));
      for (const child of target.childNodes) nested.appendChild(child.cloneNode(true));
      use.replaceWith(nested);
    }
  };

  const regionOf = (el) => el.closest("header, nav, [role=banner], [role=navigation]");
  const named = (el) => /logo|brand/i.test([el.id, el.getAttribute("class") || "", el.getAttribute("alt") || "", el.getAttribute("aria-label") || "", el.getAttribute("src") || ""].join(" "));
  const homeLink = (el) => { const a = el.closest("a[href]"); if (!a) return false; try { const u = new URL(a.href); return u.origin === location.origin && (u.pathname === "/" || u.pathname === ""); } catch { return false; } };

  const measure = () => {
    const colors = new Map();
    const count = (value, role) => {
      const h = hex(value);
      if (!h) return;
      const entry = colors.get(h) || {};
      entry[role] = (entry[role] || 0) + 1;
      colors.set(h, entry);
    };
    const fonts = new Map();
    const body = document.body || document.documentElement;
    const all = [...body.querySelectorAll("*")].slice(0, 20000);
    for (const el of all) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      const text = ownText(el);
      if (text) {
        count(s.color, /^h[1-6]$/.test(tag) ? "heading" : tag === "a" ? "link" : "text");
        const stack = s.fontFamily;
        const entry = fonts.get(stack) || { stack, uses: 0, weights: {} };
        entry.uses++;
        entry.weights[s.fontWeight] = (entry.weights[s.fontWeight] || 0) + 1;
        fonts.set(stack, entry);
      }
      const button = tag === "button" || el.getAttribute("role") === "button" || (tag === "a" && /btn|button|cta/i.test(el.getAttribute("class") || ""));
      if (hex(s.backgroundColor)) count(s.backgroundColor, button ? "button" : "background");
      if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none") count(s.borderTopColor, "border");
    }
    const bodyStyle = getComputedStyle(body);
    const pageBackground = hex(bodyStyle.backgroundColor) || hex(getComputedStyle(document.documentElement).backgroundColor) || "#ffffff";
    const variables = {};
    const rootStyle = getComputedStyle(document.documentElement);
    let kept = 0;
    for (let i = 0; i < rootStyle.length && kept < 300; i++) {
      const name = rootStyle[i];
      if (!name.startsWith("--")) continue;
      const value = rootStyle.getPropertyValue(name).trim();
      if (value.length > 200) continue;
      variables[name] = value;
      kept++;
    }
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible).slice(0, 12).map(textStyle);
    const buttons = [...document.querySelectorAll("button, [role=button], a[class*=btn], a[class*=button], a[class*=cta]")].filter((el) => visible(el) && (el.innerText || "").trim()).slice(0, 12).map(textStyle);

    const logos = [];
    const seen = new Set();
    for (const svg of document.querySelectorAll("svg")) {
      if (logos.length >= 8 || svg.parentElement?.closest("svg") || !visible(svg)) continue;
      if (!(regionOf(svg) || named(svg) || named(svg.parentElement || svg) || homeLink(svg))) continue;
      const box = svg.getBoundingClientRect();
      if (box.width < 16 || box.height < 8) continue;
      const copy = svg.cloneNode(true);
      bake(copy, svg);
      inlineUses(copy);
      if (!copy.hasAttribute("viewBox")) copy.setAttribute("viewBox", "0 0 " + Math.round(box.width) + " " + Math.round(box.height));
      copy.setAttribute("width", String(Math.round(box.width)));
      copy.setAttribute("height", String(Math.round(box.height)));
      const markup = clean(copy);
      if (!markup || seen.has(markup)) continue;
      seen.add(markup);
      logos.push({ kind: "svg", markup, width: Math.round(box.width), height: Math.round(box.height) });
    }
    for (const img of document.querySelectorAll("img")) {
      if (logos.length >= 8 || !visible(img)) continue;
      if (!(named(img) || (regionOf(img) && homeLink(img)))) continue;
      const url = absolute(img.currentSrc || img.src);
      if (!web(url) || seen.has(url)) continue;
      seen.add(url);
      logos.push({ kind: "img", url, width: img.naturalWidth || Math.round(img.getBoundingClientRect().width), height: img.naturalHeight || Math.round(img.getBoundingClientRect().height) });
    }
    const icons = [...document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon], link[rel=apple-touch-icon-precomposed], link[rel=mask-icon]")]
      .map((link) => ({ url: absolute(link.getAttribute("href")), rel: link.getAttribute("rel"), sizes: link.getAttribute("sizes") }))
      .filter((icon) => web(icon.url))
      .slice(0, 6);
    const meta = (selector) => document.querySelector(selector)?.getAttribute("content") || null;
    const ogRaw = meta("meta[property='og:image']") || meta("meta[name='og:image']") || meta("meta[name='twitter:image']");
    const og = ogRaw ? absolute(ogRaw) : null;
    const videos = new Set();
    for (const video of document.querySelectorAll("video")) {
      for (const url of [video.currentSrc, video.getAttribute("src"), ...[...video.querySelectorAll("source")].map((s) => s.getAttribute("src"))]) {
        const full = url ? absolute(url) : null;
        if (web(full)) videos.add(full);
      }
    }
    const ogVideo = meta("meta[property='og:video']") || meta("meta[property='og:video:url']");
    if (ogVideo && web(absolute(ogVideo))) videos.add(absolute(ogVideo));
    return {
      title: document.title.trim() || null,
      siteName: meta("meta[property='og:site_name']"),
      pageBackground,
      textLength: (body.innerText || body.textContent || "").replace(/\s+/g, " ").trim().length,
      colors: [...colors].map(([h, roles]) => ({ hex: h, roles })),
      fonts: [...fonts.values()],
      variables,
      headings,
      buttons,
      logos,
      icons,
      og: web(og) ? og : null,
      videos: [...videos].slice(0, 20),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    };
  };

  const sanitizeSvg = (text) => {
    const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.localName !== "svg" || parsed.querySelector("parsererror")) return null;
    return clean(root);
  };

  // Fixed and sticky elements made static, so a full-page shot does not repeat headers and banners.
  const flatten = () => {
    for (const el of document.querySelectorAll("body *")) {
      const position = getComputedStyle(el).position;
      if (position === "fixed" || position === "sticky") el.style.setProperty("position", "static", "important");
    }
    return true;
  };

  globalThis.__frameshellBrand = { measure, sanitizeSvg, flatten };
  return true;
})()`;

/**
 * Why an SVG the page script returned must not be saved, or null. A second line behind the script's allowlist:
 * no script, no foreign content, no event handlers, no external reference, no DTD.
 */
export function svgProblems(svg: string): string | null {
  if (!/^<svg[\s>]/i.test(svg.trim())) return "not an SVG document";
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return "has a DTD";
  if (/<\s*(script|foreignObject|iframe|object|embed)\b/i.test(svg)) return "has script or foreign content";
  if (/\son[a-z]+\s*=/i.test(svg)) return "has an event handler";
  if (/javascript:|vbscript:/i.test(svg)) return "has a script URL";
  if (/(?:^|[\s:])href\s*=\s*["'](?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(svg)) return "has an external reference";
  if (/url\(\s*['"]?(?!#)/i.test(svg) || /@import/i.test(svg)) return "has an external url()";
  return null;
}
