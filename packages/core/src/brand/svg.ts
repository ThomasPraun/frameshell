// SVG allowlist sanitiser (ADR 0044 decision 5) in Node: a strict XML parse (no DTD, only the predefined entities),
// then the same rules the capture page script applies to inline logos (it reads SVG_ELEMENTS, SVG_UNWRAP and
// SAFE_IMAGE from here): unknown elements dropped, <a>/<switch> unwrapped, no event handlers, no reference that does
// not start with `#` except small `data:` rasters on <image>, no external url(). The output is checked by svgProblems.

/** Elements kept, lower case; everything else (script, style, foreignObject, iframe, animate…) is dropped. */
export const SVG_ELEMENTS: readonly string[] = [
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "defs", "lineargradient",
  "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "title", "desc", "image", "filter", "feblend",
  "fecolormatrix", "fecomponenttransfer", "fecomposite", "feflood", "fegaussianblur", "feoffset", "femerge", "femergenode",
  "fefunca", "fefuncb", "fefuncg", "fefuncr", "fedropshadow", "femorphology",
];

/** Elements replaced by their children: links and conditional groups. */
export const SVG_UNWRAP: readonly string[] = ["a", "switch"];

/** The only `href` an <image> may keep besides `#id`: a base64 raster. */
export const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i;

/** Longest `data:` raster a captured logo or icon keeps, characters. */
export const LOGO_IMAGE_CHARS = 200_000;

/** Limits of one sanitised file. */
export interface SvgLimits {
  /** Longest `data:` raster kept on an <image>, characters. */
  imageChars: number;
  /** Most elements in the file. */
  elements: number;
  /** Deepest element nesting. */
  depth: number;
}

/** A sanitised SVG and what it says about its size. */
export interface CleanSvg {
  svg: string;
  /** Size of the drawing in its own px: `width`/`height` when both are plain numbers or px, else the viewBox; null when neither. */
  width: number | null;
  height: number | null;
  /** What the allowlist removed, e.g. `2 script elements`, `1 event handler`; empty when nothing. */
  removed: string[];
}

type XmlNode = { kind: "element"; name: string; attrs: [string, string][]; children: XmlNode[] } | { kind: "text"; text: string };

const ELEMENTS = new Set(SVG_ELEMENTS);
const UNWRAP = new Set(SVG_UNWRAP);
const NAME = /[A-Za-z_:][\w.:-]*/y;
const SPACE = /\s*/y;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Thrown by the parser; its message says why the file is refused. */
class Refused extends Error {}

/** Sanitise one SVG document. Never throws: `problem` says why the file cannot be kept. */
export function sanitizeSvg(text: string, limits: SvgLimits): { ok: true; value: CleanSvg } | { ok: false; problem: string } {
  let root: Extract<XmlNode, { kind: "element" }>;
  try {
    root = parseXml(text.replace(/^\uFEFF/, ""), limits);
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.message };
    throw error;
  }
  if (root.name !== "svg") return { ok: false, problem: "is not an SVG document" };
  const removed = new Map<string, number>();
  const note = (what: string) => removed.set(what, (removed.get(what) ?? 0) + 1);
  const children = cleanChildren(root.children, limits, note);
  const attrs = cleanAttrs(root, limits, note);
  const xlink = usesXlink(attrs) || hasXlink(children);
  const head: [string, string][] = [["xmlns", "http://www.w3.org/2000/svg"], ...(xlink ? [["xmlns:xlink", "http://www.w3.org/1999/xlink"] as [string, string]] : [])];
  const svg = serialize({ kind: "element", name: root.name, attrs: [...head, ...attrs], children });
  const problem = svgProblems(svg);
  if (problem) return { ok: false, problem };
  const size = svgSize(attrs);
  return {
    ok: true,
    value: { svg, ...size, removed: [...removed].map(([what, count]) => `${count} ${what}${count === 1 ? "" : "s"}`) },
  };
}

function parseXml(text: string, limits: SvgLimits): Extract<XmlNode, { kind: "element" }> {
  const stack: Extract<XmlNode, { kind: "element" }>[] = [];
  let root: Extract<XmlNode, { kind: "element" }> | null = null;
  let elements = 0;
  let i = 0;
  const fail = (why: string): never => {
    throw new Refused(why);
  };
  const malformed = () => fail("is not well-formed XML");
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    const end = lt === -1 ? text.length : lt;
    if (end > i) {
      const chunk = decode(text.slice(i, end));
      const parent = stack.at(-1);
      if (parent) parent.children.push({ kind: "text", text: chunk });
      else if (chunk.trim() !== "") malformed();
    }
    if (lt === -1) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      const close = text.indexOf("-->", i + 4);
      if (close === -1) malformed();
      i = close + 3;
    } else if (text.startsWith("<![CDATA[", i)) {
      const close = text.indexOf("]]>", i + 9);
      const parent = stack.at(-1);
      if (close === -1 || !parent) malformed();
      parent!.children.push({ kind: "text", text: text.slice(i + 9, close) });
      i = close + 3;
    } else if (text.startsWith("<!", i)) {
      // DOCTYPE and ENTITY declarations: entity expansion and external entities are refused outright.
      fail("has a DTD");
    } else if (text.startsWith("<?", i)) {
      const close = text.indexOf("?>", i + 2);
      if (close === -1) malformed();
      i = close + 2;
    } else if (text.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const match = NAME.exec(text);
      if (!match) malformed();
      i = NAME.lastIndex;
      SPACE.lastIndex = i;
      SPACE.exec(text);
      i = SPACE.lastIndex;
      const open = stack.pop();
      if (text[i] !== ">" || !open || open.name !== match![0]) malformed();
      i++;
    } else {
      NAME.lastIndex = i + 1;
      const match = NAME.exec(text);
      if (!match) malformed();
      i = NAME.lastIndex;
      const node: Extract<XmlNode, { kind: "element" }> = { kind: "element", name: match![0], attrs: [], children: [] };
      if (++elements > limits.elements) fail(`has more than ${limits.elements} elements`);
      let closed = false;
      for (;;) {
        SPACE.lastIndex = i;
        const gap = SPACE.exec(text)![0];
        i = SPACE.lastIndex;
        if (text.startsWith("/>", i)) {
          closed = true;
          i += 2;
          break;
        }
        if (text[i] === ">") {
          i++;
          break;
        }
        if (gap === "") malformed();
        NAME.lastIndex = i;
        const attr = NAME.exec(text);
        if (!attr) malformed();
        i = NAME.lastIndex;
        SPACE.lastIndex = i;
        SPACE.exec(text);
        i = SPACE.lastIndex;
        if (text[i] !== "=") malformed();
        SPACE.lastIndex = i + 1;
        SPACE.exec(text);
        i = SPACE.lastIndex;
        const quote = text[i];
        if (quote !== '"' && quote !== "'") malformed();
        const close = text.indexOf(quote!, i + 1);
        if (close === -1) malformed();
        const raw = text.slice(i + 1, close);
        if (raw.includes("<")) malformed();
        if (node.attrs.some(([name]) => name === attr![0])) malformed();
        node.attrs.push([attr![0], decode(raw)]);
        i = close + 1;
      }
      const parent = stack.at(-1);
      if (parent) parent.children.push(node);
      else if (root) malformed();
      else root = node;
      if (!closed) {
        stack.push(node);
        if (stack.length > limits.depth) fail(`nests elements more than ${limits.depth} deep`);
      }
    }
  }
  if (!root || stack.length > 0) malformed();
  return root!;
}

/** Text with the five predefined entities and character references resolved; any other entity is refused. */
function decode(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&\s]*);?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) throw new Refused("is not well-formed XML");
    const named = ENTITIES[name];
    if (named) return named;
    const number = /^#x([0-9a-f]+)$/i.exec(name)?.[1];
    const decimal = /^#([0-9]+)$/.exec(name)?.[1];
    const code = number ? Number.parseInt(number, 16) : decimal ? Number.parseInt(decimal, 10) : Number.NaN;
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Refused(`uses an undeclared entity &${name};`);
    return String.fromCodePoint(code);
  });
}

function cleanChildren(children: XmlNode[], limits: SvgLimits, note: (what: string) => void): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of children) {
    if (child.kind === "text") {
      out.push(child);
      continue;
    }
    const name = child.name.toLowerCase();
    if (UNWRAP.has(name) && !child.name.includes(":")) {
      out.push(...cleanChildren(child.children, limits, note));
      continue;
    }
    if (!ELEMENTS.has(name) || child.name.includes(":")) {
      note(`${child.name} element`);
      continue;
    }
    const kept: XmlNode = { kind: "element", name: child.name, attrs: [], children: cleanChildren(child.children, limits, note) };
    kept.attrs = cleanAttrs(child, limits, note);
    // An <image> left without a source draws nothing.
    if (name === "image" && !kept.attrs.some(([attr]) => attr === "href" || attr === "xlink:href")) continue;
    out.push(kept);
  }
  return out;
}

function cleanAttrs(el: Extract<XmlNode, { kind: "element" }>, limits: SvgLimits, note: (what: string) => void): [string, string][] {
  const out: [string, string][] = [];
  const image = el.name.toLowerCase() === "image";
  for (const [name, value] of el.attrs) {
    const lower = name.toLowerCase();
    // Namespace declarations are written again by the serialiser; editor namespaces (inkscape:, sketch:…) go.
    if (lower === "xmlns" || lower.startsWith("xmlns:")) continue;
    if (lower.includes(":") && lower !== "xlink:href" && lower !== "xml:space" && lower !== "xml:lang") continue;
    // Browsers ignore whitespace and control characters inside a URL scheme (`java\tscript:`).
    const compact = [...value].filter((char) => char > " " && !/\s/.test(char)).join("");
    if (lower.startsWith("on")) note("event handler");
    else if (/javascript:|vbscript:/i.test(compact)) note("script URL");
    else if (lower === "href" || lower === "xlink:href" || lower === "src") {
      if (value.startsWith("#") && lower !== "src") out.push([name, value]);
      else if (image && SAFE_IMAGE.test(value)) {
        if (value.length <= limits.imageChars) out.push([name, value]);
        else note("oversized embedded image");
      } else note("external reference");
    } else if (value.includes("\\")) note("CSS escape");
    else if (/url\(\s*['"]?(?!#)/i.test(compact) || /@import|expression\(/i.test(compact)) note("external url()");
    else out.push([name, value]);
  }
  return out;
}

function usesXlink(attrs: [string, string][]): boolean {
  return attrs.some(([name]) => name.toLowerCase().startsWith("xlink:"));
}

function hasXlink(nodes: XmlNode[]): boolean {
  return nodes.some((node) => node.kind === "element" && (usesXlink(node.attrs) || hasXlink(node.children)));
}

function serialize(node: XmlNode): string {
  if (node.kind === "text") return node.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const attrs = node.attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  if (node.children.length === 0) return `<${node.name}${attrs}/>`;
  return `<${node.name}${attrs}>${node.children.map(serialize).join("")}</${node.name}>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}

/** Drawing size from the root's `width`/`height` (unitless or px), else its viewBox. */
function svgSize(attrs: [string, string][]): { width: number | null; height: number | null } {
  const get = (name: string) => attrs.find(([attr]) => attr === name)?.[1]?.trim();
  const length = (value: string | undefined) => {
    const match = value ? /^(\d+(?:\.\d+)?|\.\d+)(?:px)?$/.exec(value) : null;
    const number = match ? Number(match[1]) : Number.NaN;
    return number > 0 ? number : null;
  };
  const width = length(get("width"));
  const height = length(get("height"));
  if (width !== null && height !== null) return { width, height };
  const box = get("viewBox")?.split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! };
  return { width: null, height: null };
}

/**
 * Why a sanitised SVG must not be saved, or null. A second line behind the allowlist: no script, no foreign
 * content, no event handlers, no external reference, no DTD, no CSS escape inside an attribute.
 */
export function svgProblems(svg: string): string | null {
  if (!/^<svg[\s>]/i.test(svg.trim())) return "not an SVG document";
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return "has a DTD";
  if (/<\s*(script|foreignObject|iframe|object|embed)\b/i.test(svg)) return "has script or foreign content";
  if (/\son[a-z]+\s*=/i.test(svg)) return "has an event handler";
  if (/javascript:|vbscript:/i.test(svg)) return "has a script URL";
  if (/(?:^|[\s:])href\s*=\s*["'](?!#|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(svg)) return "has an external reference";
  if (/url\(\s*['"]?(?!#)/i.test(svg) || /@import/i.test(svg)) return "has an external url()";
  if (/\s[\w:-]+\s*=\s*"[^"]*\\/.test(svg)) return "has a CSS escape";
  return null;
}
