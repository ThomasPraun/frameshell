/** One finding of {@link seekSafetyFindings}. */
export interface SeekFinding {
  rule: string;
  severity: "error" | "warning";
  message: string;
  fix: string;
  /** One-based position in the file. */
  line: number;
  column: number;
}

interface Rule {
  rule: string;
  severity: "error" | "warning";
  pattern: RegExp;
  message: string;
  fix: string;
}

/**
 * GSAP seek-safety rules that `@hyperframes/lint` has no rule for. The render
 * and the live preview seek the paused timeline to a frame instead of playing
 * it, so anything that depends on wall time, scroll, callbacks or state read
 * at first render shows a wrong frame (GSAP skills, `gsap.totalTime(t)`).
 * Text patterns on inline scripts: they flag what is worth a look, never prove
 * a bug, so all but ScrollTrigger are warnings. Randomness is not here: the
 * linter's `non_deterministic_code` already blocks `Math.random()` and
 * `gsap.utils.random()`, string form included.
 */
const RULES: readonly Rule[] = [
  {
    rule: "gsap_scrolltrigger",
    severity: "error",
    pattern: /\bScrollTrigger\b|\bscrollTrigger\s*:/g,
    message: "ScrollTrigger reacts to scrolling, and a clip never scrolls: its tweens would never run under a seek.",
    fix: "Remove it and place the tween on the paused timeline with a position parameter.",
  },
  {
    rule: "gsap_delay_chain",
    severity: "warning",
    pattern: /\bdelay\s*:/g,
    message: "Consider a position parameter instead of `delay`: a chain of delays breaks when one tween moves, and the seek time no longer reads from the timeline.",
    fix: 'Put every tween on one timeline and place it with a position parameter: `tl.to(a, {...}, "<")`, `"<0.2"` or `"label+=0.3"`.',
  },
  {
    rule: "gsap_callback_not_seek_safe",
    severity: "warning",
    pattern: /\bon(?:Complete|Update|Start|Repeat|ReverseComplete)\s*:/g,
    message: "Callbacks fire when the timeline plays through, not when it is seeked, so the frame depends on how the seek got there.",
    fix: "Put the change in a tween (`tl.set`, `tl.to`) at its position instead of a callback.",
  },
  {
    rule: "gsap_overwrite_reads_state",
    severity: "warning",
    pattern: /\boverwrite\s*:\s*(?:"auto"|'auto'|true)/g,
    message: "`overwrite` kills or trims other tweens depending on what runs first, so a seek to the middle can differ from a play-through.",
    fix: "Animate each property once, or use `fromTo` with absolute values and no `overwrite`.",
  },
];

/**
 * Banner of an inlined GSAP build (a `/*!` comment naming GreenSock, or an
 * `inlined: gsap/dist/gsap.min.js` marker comment): the library's own source holds
 * `delay:`, `ScrollTrigger` and the rest, so such a script is not author code.
 * The linter blanks the same builds (`blankInlinedGsapLibrary`).
 */
const GSAP_BUILD = /\/\*!(?:(?!\*\/)[\s\S]){0,600}\bGreenSock\b|\/\*\s*inlined:\s*\S*gsap(?:@[^/\s]+)?\/dist\/[^/\s]+\.js/;

/** Inline `<script>` blocks, comments blanked with spaces so offsets and lines stay the same. */
function inlineScripts(html: string): { text: string; offset: number }[] {
  const scripts: { text: string; offset: number }[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(match[1] ?? "")) continue;
    if (GSAP_BUILD.test(match[2] ?? "")) continue;
    const text = (match[2] ?? "").replace(/\/\*[\s\S]*?\*\/|(?<![:"'\\])\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
    scripts.push({ text, offset: match.index + match[0].indexOf(">") + 1 });
  }
  return scripts;
}

/** One-based line and column of `offset` in `html`. */
function position(html: string, offset: number): { line: number; column: number } {
  const before = html.slice(0, offset);
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** Seek-safety findings of one composition HTML file, in source order. */
export function seekSafetyFindings(html: string): SeekFinding[] {
  const findings: SeekFinding[] = [];
  for (const { text, offset } of inlineScripts(html)) {
    for (const rule of RULES) {
      for (const match of text.matchAll(rule.pattern)) {
        const { rule: id, severity, message, fix } = rule;
        findings.push({ rule: id, severity, message, fix, ...position(html, offset + match.index) });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}
