import { type TemplateVariable, kitScript } from "./kit.js";
import type { BrandTokens } from "./tokens.js";
import { WINDOW_DOTS_CSS, WINDOW_DOTS_HTML } from "./ui-parts.js";

/**
 * Shared parts of the code templates (#466): `code-typing`, `code-diff` and
 * `code-morph` draw one editor window. The tokenizer is small on purpose (one
 * line at a time, no dependency): keywords, strings, numbers, comments and calls
 * are coloured, the rest is plain. It is page script, so a render needs no network.
 */

/** Languages the tokenizer colours; `plain` colours nothing. */
export const CODE_LANGUAGES = [
  { value: "js", label: "JavaScript or TypeScript" },
  { value: "python", label: "Python" },
  { value: "shell", label: "Shell" },
  { value: "json", label: "JSON" },
  { value: "plain", label: "Plain text" },
] as const;

/** The props every code template shares: the language, how coloured it is, the title bar, line numbers, colours and size. */
export function codeVariables(tokens: BrandTokens, title: string): TemplateVariable[] {
  return [
    { id: "language", type: "enum", label: "Language that is coloured", default: "js", options: CODE_LANGUAGES.map((language) => ({ ...language })) },
    { id: "highlight", type: "enum", label: "Syntax colours: full, or quiet (keywords and comments only)", default: "full", options: [{ value: "full", label: "Full" }, { value: "quiet", label: "Quiet" }] },
    { id: "title", type: "string", label: "File name in the title bar; empty for none", default: title, maxLength: 40 },
    { id: "numbers", type: "enum", label: "Line numbers", default: "on", options: [{ value: "on", label: "On" }, { value: "off", label: "Off" }] },
    { id: "card", type: "color", label: "Window colour", default: tokens.colors.card ?? "#0e1424" },
    { id: "accent", type: "color", label: "Keyword and caret colour", default: tokens.colors.accent ?? "#ffb400" },
    { id: "size", type: "number", label: "Type size, 1 = the format's default", default: 1, min: 0.5, max: 1.6, step: 0.05 },
  ];
}

/** CSS of the editor window: the system monospace face (`style.json` has no monospace role), rows, gutter and tokens. */
export const CODE_CSS = `
      ${WINDOW_DOTS_CSS}
      .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; font-variant-ligatures: none; }
      #content { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      #win { position: relative; overflow: hidden; border-radius: 0.7em; box-shadow: 0 0.8em 2.2em rgba(0, 0, 0, 0.4); }
      #bar { position: relative; display: flex; align-items: center; }
      #win-title { position: absolute; left: 0; right: 0; text-align: center; font-size: 0.8em; opacity: 0.6; }
      #lines { position: relative; }
      .ln { position: relative; display: flex; align-items: center; white-space: pre; }
      .no { flex: none; text-align: right; opacity: 0.38; }
      .sg { flex: none; text-align: center; font-weight: 700; }
      .tx { flex: 1; white-space: pre; }
      .wash { position: absolute; top: 0; bottom: 0; left: 0; right: 0; }
      .edge { position: absolute; top: 0; bottom: 0; left: 0; width: 0.25em; }
      .cut { position: absolute; top: 50%; height: 0.09em; margin-top: -0.045em; transform-origin: 0 50%; }
      #layer, #caret { position: absolute; top: 0; left: 0; }
      .tk { position: absolute; top: 0; left: 0; white-space: pre; }
      #caret { width: 0.12em; }`;

/** The editor window, inside `#content`: a title bar and the rows (`#rows`), then the moving parts (`#layer`, `#caret`). */
export const CODE_WINDOW_HTML = `<div id="win" class="mono">
            <div id="bar">${WINDOW_DOTS_HTML}<span id="win-title"></span></div>
            <div id="body"><div id="lines"><div id="rows"></div><div id="layer"></div><i id="caret"></i></div></div>
          </div>`;

/**
 * Page-script math and window builder of the code templates; needs `COLOR_HELPERS` first.
 * `codeLines`/`codeRows` (code to tokens), `align` (order-keeping match of two lists: lines for
 * a diff, tokens for a morph), `codeColors`, `monoRatio`, `codeLayout` and `codeWindow`.
 */
export const CODE_MATH = kitScript(String.raw`
      // Words each language colours as keywords, space separated. A backtick is written as TICK: this text sits inside a template string.
      var WORDS = { js: "const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super static yield void delete interface type enum implements public private readonly as true false null undefined", python: "def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield async await None True False self global nonlocal assert del", shell: "if then else elif fi for do done while case esac function in export echo cd sudo", json: "true false null", plain: "" };
      var TICK = String.fromCharCode(96);
      // One line of code as tokens {k: kind, s: text, c: column}: kw, str, num, com (comment), fn (name before a parenthesis), id, op (one punctuation character), ws. Unterminated strings and block comments end with the line.
      function tokenize(text, lang) {
        var words = " " + (WORDS[lang] || "") + " ";
        var mark = lang === "python" || lang === "shell" ? "#" : lang === "js" ? "//" : "";
        var out = [];
        var i = 0;
        while (i < text.length) {
          var ch = text.charAt(i);
          var j = i + 1;
          var kind = "op";
          if (ch === " ") {
            while (text.charAt(j) === " ") j++;
            kind = "ws";
          } else if (mark && text.substr(i, mark.length) === mark) {
            j = text.length;
            kind = "com";
          } else if (lang === "js" && text.substr(i, 2) === "/*") {
            var shut = text.indexOf("*/", i + 2);
            j = shut < 0 ? text.length : shut + 2;
            kind = "com";
          } else if (ch === '"' || ch === "'" || (ch === TICK && lang === "js")) {
            while (j < text.length && text.charAt(j) !== ch) j += text.charAt(j) === "\\" ? 2 : 1;
            j = Math.min(text.length, j + 1);
            kind = "str";
          } else if (/[0-9]/.test(ch)) {
            while (/[0-9a-fA-FxX._]/.test(text.charAt(j))) j++;
            kind = "num";
          } else if (/[A-Za-z_$]/.test(ch)) {
            while (/[\w$]/.test(text.charAt(j))) j++;
            kind = words.indexOf(" " + text.slice(i, j) + " ") >= 0 ? "kw" : /^ *\(/.test(text.slice(j)) ? "fn" : "id";
          }
          out.push({ k: kind, s: text.slice(i, j), c: i });
          i = j;
        }
        return out;
      }
      // The lines of a code prop: tabs as two spaces, trailing empty lines dropped, at most max lines, never none.
      function codeLines(code, max) {
        var lines = String(code).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
        while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
        return lines.slice(0, max);
      }
      // Each line of a code prop with its tokens: {text, tokens}.
      function codeRows(code, lang, max) {
        return codeLines(code, max).map(function (text) { return { text: text, tokens: tokenize(text, lang) }; });
      }
      function esc(text) {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }
      // Tokens as coloured spans; with upto, only the first upto characters of the line (the colour of a half-typed word is the colour it will have).
      function tokenHtml(tokens, colors, upto) {
        var html = "";
        for (var i = 0; i < tokens.length; i++) {
          var token = tokens[i];
          if (upto !== undefined && token.c >= upto) break;
          var text = upto === undefined ? token.s : token.s.slice(0, upto - token.c);
          html += '<span style="color:' + colors[token.k] + '">' + esc(text) + "</span>";
        }
        return html;
      }
      // Order-keeping match of lists a and b (longest common subsequence under same(x, y)), as rows {k: "ctx" | "del" | "add", a: index in a, b: index in b}; a deletion comes before the addition that replaces it.
      function align(a, b, same) {
        var n = a.length;
        var m = b.length;
        var best = [];
        var i;
        var j;
        for (i = 0; i <= n; i++) {
          best.push([]);
          for (j = 0; j <= m; j++) best[i].push(0);
        }
        for (i = n - 1; i >= 0; i--) {
          for (j = m - 1; j >= 0; j--) best[i][j] = same(a[i], b[j]) ? best[i + 1][j + 1] + 1 : Math.max(best[i + 1][j], best[i][j + 1]);
        }
        var rows = [];
        i = 0;
        j = 0;
        while (i < n || j < m) {
          if (i < n && j < m && same(a[i], b[j])) {
            rows.push({ k: "ctx", a: i, b: j });
            i++;
            j++;
          } else if (i < n && (j >= m || best[i + 1][j] >= best[i][j + 1])) {
            rows.push({ k: "del", a: i, b: -1 });
            i++;
          } else {
            rows.push({ k: "add", a: -1, b: j });
            j++;
          }
        }
        return rows;
      }
      // Colour of each token kind on the window colour: dark and light windows each get a palette that reads on them; quiet leaves only keywords and comments coloured.
      function codeColors(card, accent, quiet) {
        var ink = onColor(card);
        var dark = ink === "#ffffff";
        return {
          ws: ink,
          id: ink,
          op: alpha(ink, 0.66),
          kw: accent,
          com: alpha(ink, 0.45),
          str: quiet ? ink : dark ? "#8fd694" : "#17803d",
          num: quiet ? ink : dark ? "#f2a65a" : "#b45309",
          fn: quiet ? ink : dark ? "#7cb7ff" : "#1d5fbf"
        };
      }
      // Width of one monospace character in ems, measured on the machine that renders (a 200 character probe; offsetWidth ignores transforms).
      function monoRatio() {
        var probe = document.createElement("span");
        probe.className = "mono";
        probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:pre;font-size:100px";
        probe.textContent = new Array(201).join("M");
        document.body.appendChild(probe);
        var ratio = probe.offsetWidth / 200 / 100;
        document.body.removeChild(probe);
        return ratio;
      }
      // Sizes of the window in pixels. o: cols and count (longest line, rows), digits (width of the line numbers, 0 for none), sign (em of a +/- column), ratio (monoRatio), fs (type size as a fraction of unit), w (window width as a fraction of W), scale (the size prop), W, H, unit. The type shrinks until the longest line and all rows fit; the window is at least half its width.
      function codeLayout(o) {
        var gutter = o.digits ? o.digits * o.ratio + 1.4 : 0;
        var emW = 2.4 + gutter + o.sign + Math.max(o.cols, 12) * o.ratio;
        var emH = 4.3 + o.count * 1.6;
        var fs = Math.min(o.fs * o.unit * o.scale, o.w * o.W / emW, 0.84 * o.H / emH);
        return { fs: fs, cw: fs * o.ratio, lh: fs * 1.6, pad: fs * 1.2, gw: fs * gutter, sg: fs * o.sign, bar: fs * 2.6, w: Math.max(fs * emW, 0.5 * o.w * o.W), h: fs * emH };
      }
      function cell(row, tag, cls) {
        var element = document.createElement(tag);
        element.className = cls;
        row.appendChild(element);
        return element;
      }
      // Paints the window of CODE_WINDOW_HTML at layout lay and builds count rows. A row is {row, no, sg, tx} and, when diff, also {wash, edge, cut}. Line numbers are filled by the template.
      function codeWindow(lay, card, title, count, diff) {
        var ink = onColor(card);
        var win = document.getElementById("win");
        win.style.cssText += "width:" + lay.w + "px;font-size:" + lay.fs + "px;line-height:" + lay.lh + "px;background:" + card + ";color:" + ink;
        document.getElementById("bar").style.cssText += "height:" + lay.bar + "px;padding:0 " + lay.pad + "px;background:" + mix(card, ink, 0.08);
        document.getElementById("win-title").textContent = title;
        document.getElementById("body").style.cssText += "padding:" + lay.pad * 0.7 + "px 0";
        var holder = document.getElementById("rows");
        var parts = [];
        for (var i = 0; i < count; i++) {
          var row = cell(holder, "div", "ln");
          row.style.cssText += "height:" + lay.lh + "px;padding:0 " + lay.pad + "px";
          var part = { row: row };
          if (diff) {
            part.wash = cell(row, "i", "wash");
            part.edge = cell(row, "i", "edge");
            part.cut = cell(row, "i", "cut");
          }
          part.no = cell(row, "span", "no");
          part.no.style.cssText += "width:" + lay.gw + "px;padding-right:" + lay.fs * 1.4 + "px";
          part.sg = cell(row, "span", "sg");
          part.sg.style.cssText += "width:" + lay.sg + "px";
          part.tx = cell(row, "span", "tx");
          parts.push(part);
        }
        return parts;
      }`);
