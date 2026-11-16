import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, CODE_MATH } from "../src/templates/code-kit.js";
import { COLOR_HELPERS } from "../src/templates/kit.js";
import { TEMPLATES, type Template, type TemplateVariable } from "../src/templates/index.js";

interface Token {
  k: string;
  s: string;
  c: number;
}
interface Pair {
  k: "ctx" | "del" | "add";
  a: number;
  b: number;
}
interface Layout {
  fs: number;
  cw: number;
  lh: number;
  pad: number;
  gw: number;
  w: number;
  h: number;
}
interface Kit {
  tokenize(text: string, lang: string): Token[];
  codeLines(code: string, max: number): string[];
  tokenHtml(tokens: Token[], colors: Record<string, string>, upto?: number): string;
  align<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): Pair[];
  codeColors(card: string, accent: string, quiet: boolean): Record<string, string>;
  codeLayout(options: Record<string, number>): Layout;
}

// The same script text the templates carry, run in Node (the DOM-touching functions are defined, never called).
const kit = new Function(
  `${COLOR_HELPERS}\n${CODE_MATH}; return { tokenize, codeLines, tokenHtml, align, codeColors, codeLayout };`,
)() as Kit;

const kinds = (text: string, lang = "js") => kit.tokenize(text, lang).filter((t) => t.k !== "ws").map((t) => `${t.k}:${t.s}`);
const same = (x: string, y: string) => x === y;

describe("the code tokenizer (#466)", () => {
  it("colours keywords, calls, strings and numbers of a JavaScript line, and keeps every character", () => {
    const line = 'const total = await price("a", 2.5);';
    expect(kinds(line)).toEqual(["kw:const", "id:total", "op:=", "kw:await", "fn:price", "op:(", 'str:"a"', "op:,", "num:2.5", "op:)", "op:;"]);
    expect(kit.tokenize(line, "js").map((t) => t.s).join("")).toBe(line);
  });

  it("gives each token its column", () => {
    expect(kit.tokenize("a = 1", "js").map((t) => [t.s, t.c])).toEqual([["a", 0], [" ", 1], ["=", 2], [" ", 3], ["1", 4]]);
  });

  it("ends a comment, an unterminated string and a block comment with the line, and honours escapes", () => {
    expect(kinds("x // note here")).toEqual(["id:x", "com:// note here"]);
    expect(kinds('s = "never closed')).toEqual(["id:s", "op:=", 'str:"never closed']);
    expect(kinds("a /* b */ c")).toEqual(["id:a", "com:/* b */", "id:c"]);
    expect(kinds('"a\\"b" + 1')).toEqual(['str:"a\\"b"', "op:+", "num:1"]);
    expect(kinds("t = `x`")).toEqual(["id:t", "op:=", "str:`x`"]);
  });

  it("knows Python and shell comments, and treats a hash in JavaScript as punctuation", () => {
    expect(kinds("def add(a): # sum", "python")).toEqual(["kw:def", "fn:add", "op:(", "id:a", "op:)", "op::", "com:# sum"]);
    expect(kinds("echo hi # x", "shell")).toEqual(["kw:echo", "id:hi", "com:# x"]);
    expect(kinds("#id", "js")).toEqual(["op:#", "id:id"]);
  });

  it("colours only strings, numbers and literals of JSON, and nothing of plain text", () => {
    expect(kinds('{ "a": [1, true] }', "json")).toEqual(["op:{", 'str:"a"', "op::", "op:[", "num:1", "op:,", "kw:true", "op:]", "op:}"]);
    expect(kinds("const x", "plain")).toEqual(["id:const", "id:x"]);
  });

  it("declares every language the template menus offer", () => {
    expect(CODE_LANGUAGES.map((l) => l.value)).toEqual(["js", "python", "shell", "json", "plain"]);
  });
});

describe("code lines and html", () => {
  it("expands tabs, drops trailing empty lines, caps the count and never returns none", () => {
    expect(kit.codeLines("a\n\tb\r\nc\n\n  \n", 10)).toEqual(["a", "  b", "c"]);
    expect(kit.codeLines("1\n2\n3\n4", 2)).toEqual(["1", "2"]);
    expect(kit.codeLines("", 5)).toEqual([""]);
    expect(kit.codeLines("\n\n", 5)).toEqual([""]);
  });

  it("escapes markup and cuts a token at the typed length", () => {
    const tokens = kit.tokenize("if (a<b) go()", "js");
    const colors = { kw: "K", id: "I", op: "O", fn: "F", ws: "W", str: "S", num: "N", com: "C" };
    expect(kit.tokenHtml(tokens, colors)).toContain("&lt;");
    expect(kit.tokenHtml(tokens, colors)).not.toContain("<b");
    expect(kit.tokenHtml(kit.tokenize("function", "js"), colors, 3)).toBe('<span style="color:K">fun</span>');
    expect(kit.tokenHtml(tokens, colors, 0)).toBe("");
  });
});

describe("align (the match behind a diff and a morph)", () => {
  it("keeps the order, and puts a removed line before the one that replaces it", () => {
    const before = ["f", "user", "name1", "if", "render", "}"];
    const after = ["f", "user", "name2", "render", "log", "}"];
    expect(kit.align(before, after, same).map((r) => `${r.k}:${r.a}:${r.b}`)).toEqual(["ctx:0:0", "ctx:1:1", "del:2:-1", "del:3:-1", "add:-1:2", "ctx:4:3", "add:-1:4", "ctx:5:5"]);
  });

  it("is all context for equal lists, all removed then all added for disjoint ones, and handles an empty side", () => {
    expect(kit.align(["a", "b"], ["a", "b"], same).map((r) => r.k)).toEqual(["ctx", "ctx"]);
    expect(kit.align(["a"], ["b"], same).map((r) => r.k)).toEqual(["del", "add"]);
    expect(kit.align([], ["a"], same).map((r) => r.k)).toEqual(["add"]);
    expect(kit.align(["a"], [], same)).toEqual([{ k: "del", a: 0, b: -1 }]);
  });

  it("matches tokens by kind and text, so a morph moves the tokens the two snippets share", () => {
    const tokens = (text: string) => kit.tokenize(text, "js").filter((t) => t.k !== "ws");
    const a = tokens("const sum = a + b;");
    const b = tokens("function add(a, b) { const sum = a + b; }");
    const rows = kit.align(a, b, (x, y) => x.k === y.k && x.s === y.s);
    // Every token of the first snippet is found again in the second.
    expect(rows.filter((r) => r.k === "ctx")).toHaveLength(a.length);
    expect(rows.filter((r) => r.k === "del")).toEqual([]);
    expect(rows.filter((r) => r.k === "add").map((r) => b[r.b]!.s)).toEqual(["function", "add", "(", "a", ",", "b", ")", "{", "}"]);
  });
});

describe("the window colours and layout", () => {
  it("uses a bright palette on a dark window and a deep one on a light window, and only keywords and comments when quiet", () => {
    const dark = kit.codeColors("#0e1424", "#ffb400", false);
    const light = kit.codeColors("#f6f6f0", "#c2410c", false);
    expect(dark.id).toBe("#ffffff");
    expect(light.id).toBe("#0b1020");
    expect(dark.str).not.toBe(light.str);
    expect(dark.kw).toBe("#ffb400");
    const quiet = kit.codeColors("#0e1424", "#ffb400", true);
    expect([quiet.str, quiet.num, quiet.fn]).toEqual([quiet.id, quiet.id, quiet.id]);
    expect(quiet.kw).toBe("#ffb400");
    expect(quiet.com).not.toBe(quiet.id);
  });

  const options = { cols: 40, count: 6, digits: 1, sign: 0, ratio: 0.6, fs: 0.036, w: 0.74, scale: 1, W: 1920, H: 1080, unit: 1080 };

  it("takes the format's type size when everything fits, and keeps the window inside its width and height", () => {
    const lay = kit.codeLayout(options);
    expect(lay.fs).toBeCloseTo(0.036 * 1080, 6);
    expect(lay.w).toBeLessThanOrEqual(0.74 * 1920 + 1e-6);
    expect(lay.h).toBeLessThanOrEqual(0.84 * 1080);
    expect(lay.cw).toBeCloseTo(lay.fs * 0.6, 9);
    expect(lay.lh).toBeCloseTo(lay.fs * 1.6, 9);
  });

  it("shrinks the type for a long line and for many rows, and grows it with the size prop", () => {
    const wide = kit.codeLayout({ ...options, cols: 120 });
    expect(wide.fs).toBeLessThan(0.036 * 1080);
    expect(wide.w).toBeLessThanOrEqual(0.74 * 1920 + 1e-6);
    const tall = kit.codeLayout({ ...options, count: 30 });
    expect(tall.h).toBeLessThanOrEqual(0.84 * 1080 + 1e-6);
    expect(kit.codeLayout({ ...options, scale: 1.5 }).fs).toBeGreaterThan(kit.codeLayout(options).fs);
  });

  it("never makes the window narrower than half its width, and leaves no gutter without line numbers", () => {
    const short = kit.codeLayout({ ...options, cols: 2, digits: 0 });
    expect(short.w).toBeCloseTo(0.5 * 0.74 * 1920, 6);
    expect(short.gw).toBe(0);
  });
});

describe("the code templates", () => {
  const find = (id: string) => TEMPLATES.find((t) => t.id === id) as Template;
  const variables = (id: string): TemplateVariable[] => {
    const template = find(id);
    return template.variables({ id: "spot", width: 1920, height: 1080, duration: template.defaultDuration, tokens: { colors: {}, brand: {}, used: [], problem: null } });
  };

  it.each(["code-diff", "code-morph", "code-typing"])("%s is transparent over footage and declares the shared code props", (id) => {
    expect(find(id).overlay).toBe(true);
    expect(variables(id).map((v) => v.id)).toEqual(expect.arrayContaining(["language", "highlight", "title", "numbers", "card", "accent", "size", "bg", "backdrop"]));
  });

  it.each(["code-diff", "code-morph", "code-typing"])("%s takes the window colour and accent from style.json", (id) => {
    const template = find(id);
    const tokens = { colors: { card: "#202830", accent: "#33aaff" }, brand: {}, used: [], problem: null };
    const declared = template.variables({ id: "spot", width: 1920, height: 1080, duration: 5, tokens });
    expect(declared.find((v) => v.id === "card")!.default).toBe("#202830");
    expect(declared.find((v) => v.id === "accent")!.default).toBe("#33aaff");
  });

  it("every default snippet fits its declared limits and the line cap of its template", () => {
    const text = (id: string, prop: string) => String(variables(id).find((v) => v.id === prop)!.default);
    for (const [id, prop, lines] of [["code-typing", "code", 14], ["code-diff", "before", 10], ["code-diff", "after", 10], ["code-morph", "before", 12], ["code-morph", "after", 12]] as const) {
      const variable = variables(id).find((v) => v.id === prop) as Extract<TemplateVariable, { type: "string" }>;
      expect(text(id, prop).length, `${id}.${prop}`).toBeLessThanOrEqual(variable.maxLength!);
      expect(text(id, prop).split("\n").length, `${id}.${prop}`).toBeLessThanOrEqual(lines);
    }
  });

  it("the diff defaults change something and the morph defaults share tokens", () => {
    const value = (id: string, prop: string) => String(variables(id).find((v) => v.id === prop)!.default);
    const rows = kit.align(value("code-diff", "before").split("\n"), value("code-diff", "after").split("\n"), same);
    expect(rows.filter((r) => r.k !== "ctx").length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.k === "ctx").length).toBeGreaterThan(1);
    const tokens = (code: string) => kit.tokenize(code, "js").filter((t) => t.k !== "ws");
    const moved = kit.align(tokens(value("code-morph", "before")), tokens(value("code-morph", "after")), (x, y) => x.k === y.k && x.s === y.s);
    expect(moved.filter((r) => r.k === "ctx").length).toBeGreaterThan(5);
  });
});
