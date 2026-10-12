// A terminal's recent output, kept by main so a view that mounts again (a tab moved to another window, ADR 0012)
// redraws the screen the program drew before.

/** Bounds of an {@link OutputRing}. */
export interface OutputRingLimits {
  /** Lines kept. */
  lines: number;
  /** Characters kept (UTF-16 code units: bytes, for the ASCII most terminal output is). */
  size: number;
}

/** About 10,000 lines, capped at 4 MiB (ADR 0012). */
export const OUTPUT_RING_LIMITS: OutputRingLimits = { lines: 10_000, size: 4 * 1024 * 1024 };

/**
 * The ring holds up to this share more than its limits before it trims back to them: trimming copies the text, so
 * it runs once per that much output, not on every chunk.
 */
const SLACK = 0.25;

/** DEC private mode sets and resets (`ESC [ ? n ; m h|l`): bracketed paste, alternate screen, cursor keys, mouse. */
// eslint-disable-next-line no-control-regex -- matching escape sequences is the point.
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;

/**
 * Recent output of one terminal, oldest dropped first. Trims at a line start
 * when it can, so a replay starts on a whole line. Modes the program set in
 * output already dropped (bracketed paste above all: an Ask agent reference
 * must not submit itself line by line) are replayed first, as they stood
 * where the kept output starts.
 */
export class OutputRing {
  #text = "";
  #lines = 0;
  /** Private modes as of the first kept character, in the order first seen. */
  readonly #modes = new Map<string, "h" | "l">();

  /** @param limits Lines and characters kept, each exceeded by at most a quarter before a trim. */
  constructor(private readonly limits: OutputRingLimits = OUTPUT_RING_LIMITS) {}

  /** Add output, in the order the program wrote it. */
  append(data: string): void {
    this.#text += data;
    this.#lines += count(data, 0, data.length);
    if (this.#lines > this.limits.lines * (1 + SLACK) || this.#text.length > this.limits.size * (1 + SLACK)) this.#trim();
  }

  /** What a fresh terminal must be fed to show this output: the dropped output's modes, then the kept output. */
  snapshot(): string {
    let prefix = "";
    for (const [mode, value] of this.#modes) prefix += `\x1b[?${mode}${value}`;
    return prefix + this.#text;
  }

  #trim(): void {
    const text = this.#text;
    let cut = 0;
    for (let excess = this.#lines - this.limits.lines; excess > 0 && cut < text.length; excess--) {
      const next = text.indexOf("\n", cut);
      if (next < 0) break;
      cut = next + 1;
    }
    if (text.length - cut > this.limits.size) {
      const least = text.length - this.limits.size;
      const line = text.indexOf("\n", least);
      // At the next line start when one is near, else exactly at the cap, never inside a surrogate pair.
      cut = line >= 0 && line - least < this.limits.size / 4 ? line + 1 : least;
      if (isLowSurrogate(text.charCodeAt(cut))) cut++;
    }
    const dropped = text.slice(0, cut);
    for (const [, modes, value] of dropped.matchAll(PRIVATE_MODES)) {
      for (const mode of modes!.split(";")) if (mode) this.#modes.set(mode, value as "h" | "l");
    }
    this.#text = text.slice(cut);
    this.#lines -= count(text, 0, cut);
  }
}

function count(text: string, from: number, to: number): number {
  let lines = 0;
  for (let at = text.indexOf("\n", from); at >= 0 && at < to; at = text.indexOf("\n", at + 1)) lines++;
  return lines;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
