// A set of takes on disk (WAVs + manifest.json under OUT/quality/<tag>/), made by Kokoro or by a command baseline.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Lang } from "./lines.ts";
import { OUT } from "./paths.ts";

export interface TakeEntry {
  id: string;
  lang: Lang;
  display: string;
  spoken: string;
  phonemes: string | null;
  file: string;
  audioS: number;
  ms: number;
  cpuMs: number | null;
}

export interface TakeSet {
  tag: string;
  maker: string;
  lines: TakeEntry[];
}

export const setDir = (tag: string) => join(OUT, "quality", tag);

export async function saveSet(set: TakeSet): Promise<void> {
  await mkdir(setDir(set.tag), { recursive: true });
  await writeFile(join(setDir(set.tag), "manifest.json"), `${JSON.stringify(set, null, 2)}\n`);
}

export async function loadSet(tag: string): Promise<TakeSet> {
  return JSON.parse(await readFile(join(setDir(tag), "manifest.json"), "utf8")) as TakeSet;
}
