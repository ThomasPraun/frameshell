import { parseTranscript } from "@frameshell/schema";
import { useSyncExternalStore } from "react";
import type { FileNode } from "../../../shared/api.js";
import type { TranscriptSource } from "./model.js";

/** Project folder of transcript files (SPEC §5.4). */
const TRANSCRIPTS_DIR = "transcripts/";

/** True for a transcript file path, e.g. `transcripts/take.words.json`. */
export function isTranscriptPath(path: string): boolean {
  return path.startsWith(TRANSCRIPTS_DIR) && path.endsWith(".words.json");
}

/** The project's transcript files, live. */
export interface TranscriptsState {
  /** Valid transcript files, by path. */
  sources: TranscriptSource[];
  /** Transcript files that could not be read or failed schema validation. */
  broken: { path: string; message: string }[];
  /** Current content hash per asset path (`asset.list`), null until hashed; a transcript with another `assetHash` is stale. */
  hashes: ReadonlyMap<string, string | null>;
}

const EMPTY: TranscriptsState = { sources: [], broken: [], hashes: new Map() };

function transcriptPaths(nodes: readonly FileNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === "dir" ? transcriptPaths(node.children) : isTranscriptPath(node.path) ? [node.path] : []));
}

let state: TranscriptsState = EMPTY;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function publish(update: (current: TranscriptsState) => TranscriptsState): void {
  state = update(state);
  for (const listener of listeners) listener();
}

/**
 * Read every transcript file now and on each change under `transcripts/`,
 * and follow asset hashes. Reads never overlap: a change during a read
 * causes one more. Returns the stop function.
 */
function follow(): () => void {
  let live = true;
  let reading = false;
  let again = false;
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    do {
      again = false;
      const paths = transcriptPaths(await window.frameshell.files.tree());
      const sources: TranscriptSource[] = [];
      const broken: TranscriptsState["broken"] = [];
      await Promise.all(
        paths.map(async (path) => {
          try {
            const parsed = parseTranscript(JSON.parse(await window.frameshell.files.read(path)));
            if (parsed.ok) sources.push({ path, transcript: parsed.value });
            else broken.push({ path, message: parsed.error });
          } catch (error) {
            broken.push({ path, message: (error as Error).message });
          }
        }),
      );
      sources.sort((a, b) => a.path.localeCompare(b.path));
      if (live) publish((current) => ({ ...current, sources, broken }));
    } while (again && live);
    reading = false;
  };
  const offFiles = window.frameshell.files.onChanged((paths) => {
    if (paths.some((path) => path.startsWith(TRANSCRIPTS_DIR))) void read();
  });
  void read();

  // Listening first: an event during the initial read is replayed over it.
  const refresh = () =>
    void window.frameshell.media.assets().then(
      (assets) => live && publish((current) => ({ ...current, hashes: new Map(assets.map((asset) => [asset.path, asset.hash])) })),
      () => undefined,
    );
  const offAssets = window.frameshell.media.onChanged((change) => {
    if (change.path === null) return refresh();
    publish((current) => {
      const hashes = new Map(current.hashes);
      if (change.asset) hashes.set(change.path, change.asset.hash);
      else hashes.delete(change.path);
      return { ...current, hashes };
    });
  });
  refresh();
  return () => {
    live = false;
    offFiles();
    offAssets();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= follow();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stop?.();
    stop = null;
    state = EMPTY;
  };
}

/**
 * Every `transcripts/**.words.json` of the window's project, live, with the
 * current hash of each asset from the daemon's asset events. One feed shared
 * by every caller (transcript view, subtitles): one read per change. It
 * stops with its last caller.
 */
export function useTranscripts(): TranscriptsState {
  return useSyncExternalStore(subscribe, () => state);
}
