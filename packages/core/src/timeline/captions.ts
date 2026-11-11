import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ErrorCode, RpcError } from "@frameshell/protocol";
import { type CaptionPhrase, SUBTITLE_ENTRIES, type SubtitleEntry, type SubtitleWord, normalizeToken } from "@frameshell/schema";

/** One line of the captions text: chunks of tokens, at most one keyword, an optional entry. */
export interface ParsedPhrase {
  /** 1-based line of the text. */
  line: number;
  /** Words as typed, per chunk (keyword marks removed). */
  chunks: string[][];
  /** Index of the keyword among all the line's words. */
  keyword?: number;
  entry?: SubtitleEntry;
}

/**
 * Parse the captions text: one phrase per line, chunks separated by `|`, the
 * phrase's one keyword written `*word*`, an optional `[chars]`, `[words]`,
 * `[line]` or `[none]` before the line for that phrase's entry. Blank lines
 * and lines starting with `#` are skipped. Throws InvalidOperation naming the
 * line for an empty chunk, a second keyword or an unknown entry.
 */
export function parseCaptionText(text: string): ParsedPhrase[] {
  const phrases: ParsedPhrase[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    let body = raw.trim();
    if (body === "" || body.startsWith("#")) return;
    let entry: SubtitleEntry | undefined;
    const tag = /^\[([a-z]+)\]\s*/.exec(body);
    if (tag) {
      if (!SUBTITLE_ENTRIES.includes(tag[1] as SubtitleEntry)) throw bad(`line ${line}: entry [${tag[1]}] is not one of ${SUBTITLE_ENTRIES.join(", ")}.`);
      entry = tag[1] as SubtitleEntry;
      body = body.slice(tag[0].length);
    }
    const chunks: string[][] = [];
    let keyword: number | undefined;
    let count = 0;
    for (const part of body.split("|")) {
      const tokens: string[] = [];
      for (const token of part.split(/\s+/).filter((candidate) => candidate !== "")) {
        const marked = /^\*([^*]+)\*([^\p{L}\p{N}*]*)$/u.exec(token);
        if (marked) {
          if (keyword !== undefined) throw bad(`line ${line}: a phrase has one keyword; "${token}" is a second one. Put it in its own line.`);
          keyword = count;
        }
        tokens.push(marked ? `${marked[1]}${marked[2]}` : token);
        count++;
      }
      if (tokens.length === 0) throw bad(`line ${line}: an empty chunk between two "|".`);
      chunks.push(tokens);
    }
    phrases.push({ line, chunks, ...(keyword === undefined ? {} : { keyword }), ...(entry === undefined ? {} : { entry }) });
  });
  return phrases;
}

/** Phrases resolved onto transcript words, with what to tell the caller. */
export interface ResolvedCaptions {
  phrases: CaptionPhrase[];
  /** Words the phrases cover. */
  words: number;
  warnings: string[];
}

/**
 * Map `phrases` onto `words` (the words a subtitle track shows in the range
 * being captioned, in order) by position: the n-th typed word is the n-th
 * word, so a text that drops or repeats a word is refused. Typed text that
 * differs from the transcript's after normalising (case, accents,
 * punctuation) is only warned about: spelling and numbers are the writer's.
 * `seconds` gives a word's start for messages. Throws InvalidOperation.
 */
export function resolveCaptions(phrases: readonly ParsedPhrase[], words: readonly SubtitleWord[], seconds: (word: SubtitleWord) => number): ResolvedCaptions {
  const typed = phrases.flatMap((phrase) => phrase.chunks.flat());
  if (typed.length !== words.length) {
    let same = 0;
    while (same < typed.length && same < words.length && normalizeToken(typed[same]!) === normalizeToken(words[same]!.text)) same++;
    const next = words[same];
    const there = same < typed.length ? `"${typed[same]}"` : "nothing";
    throw bad(
      `the text has ${typed.length} words but the track shows ${words.length} in that range; no word may be lost or repeated. ` +
        `They first differ at word ${same + 1}: the text has ${there}, the track shows ${next ? `"${next.text}" at ${seconds(next).toFixed(2)} s` : "nothing"}. ` +
        "Check the words with `timeline show` and the transcript, or narrow the range with `from` and `to`.",
    );
  }
  const out: CaptionPhrase[] = [];
  const warnings: string[] = [];
  let at = 0;
  for (const phrase of phrases) {
    const size = phrase.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const slice = words.slice(at, at + size);
    const assets = [...new Set(slice.map((word) => word.asset))];
    if (assets.length > 1) {
      throw bad(`line ${phrase.line} spans ${assets.join(" and ")}: split it where the footage changes.`);
    }
    out.push({
      asset: assets[0]!,
      words: slice.map((word) => word.id),
      chunks: phrase.chunks.map((chunk) => chunk.length),
      ...(phrase.keyword === undefined ? {} : { keyword: phrase.keyword }),
      ...(phrase.entry === undefined ? {} : { entry: phrase.entry }),
    });
    at += size;
  }
  const differing = typed.flatMap((token, i) => (normalizeToken(token) === normalizeToken(words[i]!.text) ? [] : [`"${token}" for "${words[i]!.text}" at ${seconds(words[i]!).toFixed(2)} s`]));
  if (differing.length > 0) {
    const shown = differing.slice(0, 3).join(", ");
    warnings.push(`${differing.length} typed word(s) differ from the transcript (matched by position): ${shown}${differing.length > 3 ? ", …" : ""}. Correct the transcript if its text is wrong.`);
  }
  return { phrases: out, words: typed.length, warnings };
}

/** Text of a project file (absolute, or relative to `cwd`) for `captions.set`. Throws OutsideProject or InvalidOperation. */
export async function readCaptionFile(root: string, cwd: string, file: string): Promise<string> {
  const path = resolve(cwd, file);
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RpcError(ErrorCode.OutsideProject, `captions.set: ${file} is not inside the project ${root}.`, { path: file });
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new RpcError(ErrorCode.InvalidOperation, `captions.set: no file ${rel.split(sep).join("/")}.`, { op: "captions.set", reason: "file missing", field: "file" });
  }
}

function bad(message: string): RpcError {
  return new RpcError(ErrorCode.InvalidOperation, `captions.set: ${message}`, { op: "captions.set", reason: "text", field: "text" });
}
