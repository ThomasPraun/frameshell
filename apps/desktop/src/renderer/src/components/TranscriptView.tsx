import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { openAskMenu } from "../ask/ask-agent.js";
import { transport } from "../preview/transport.js";
import { SELECTION_TIMELINE, type SelectedWord, selection, unionRange, useSelection } from "../selection.js";
import { formatTimecode } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { type AssetTranscript, type TranscriptWord, buildTranscriptModel, isKept, paragraphs, restoreEdit, wordAt } from "../transcript/model.js";
import { useTranscripts } from "../transcript/useTranscripts.js";

/** Pseudo path of the transcript editor tab: never a project file (`:` is not in project paths). */
export const TRANSCRIPT_TAB = "frameshell:transcript";

/** After the user scrolls the transcript, playback leaves the scroll alone this long, ms. */
const USER_SCROLL_HOLD_MS = 2500;
/** How long a restore's feedback line stays, ms. */
const STATUS_MS = 5000;

/** A request to bring one transcript file into view; a new object per request. */
export interface TranscriptFocus {
  path: string;
}

/** Word press in progress: the anchor of a drag selection. */
interface Press {
  asset: AssetTranscript;
  anchor: number;
  pointer: number;
}

/**
 * Transcript editor tab (SPEC §10): the words of every asset the timeline
 * plays, in source order. The word under the shared playhead is marked as it
 * plays; words no clip keeps are struck through, and clicking one restores
 * it as a `ui` operation (rippled trim or insert, snapped to pauses; see
 * `restoreEdit`). Clicking or dragging over kept words selects them in the
 * shared selection store with their timeline range, which the timeline
 * highlights and the playhead jumps to, also while playing. Right-click opens
 * "Ask agent" on the selection (a kept word outside it is selected first).
 */
export function TranscriptView({ onOpenFile, focus }: { onOpenFile: (path: string) => void; focus: TranscriptFocus | null }) {
  const { view, error } = useTimelineView(SELECTION_TIMELINE);
  const { sources, broken, hashes } = useTranscripts();
  const model = useMemo(() => (view ? buildTranscriptModel(view, sources) : null), [view, sources]);
  const { words: selectedWords } = useSelection();
  const selected = useMemo(() => new Set(selectedWords.map((word) => `${word.transcript}#${word.word}`)), [selectedWords]);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const lastUserScroll = useRef(0);
  const latest = useRef({ model, view, sources });
  latest.current = { model, view, sources };

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // The playhead moves every frame while playing: mark the current word outside React.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !model) return;
    let shown: string | null = null;
    const elements = new Map<string, HTMLElement>();
    for (const element of box.querySelectorAll<HTMLElement>("[data-key]")) elements.set(element.dataset["key"]!, element);
    const update = () => {
      const { time, playing } = transport.get();
      const key = wordAt(model, time);
      if (key === shown) return;
      if (shown) elements.get(shown)?.classList.remove("is-current");
      shown = key;
      box.dataset["current"] = key ?? "";
      const element = key ? elements.get(key) : undefined;
      if (!element) return;
      element.classList.add("is-current");
      if (playing && performance.now() - lastUserScroll.current > USER_SCROLL_HOLD_MS) keepInView(box, element);
    };
    update();
    return transport.subscribe(update);
  }, [model]);

  // Opening a transcript file from the explorer scrolls to its asset.
  useEffect(() => {
    if (!focus || !scroller.current) return;
    scroller.current.querySelector<HTMLElement>(`[data-transcript="${CSS.escape(focus.path)}"]`)?.scrollIntoView({ block: "start" });
  }, [focus, model]);

  const selectRange = (asset: AssetTranscript, from: number, to: number, reveal: boolean) => {
    const [first, last] = from <= to ? [from, to] : [to, from];
    const words = asset.words.slice(first, last + 1).filter((word) => word.placements.length > 0);
    const range = unionRange(words.map((word) => word.placements[0]!));
    selection.selectWords(words.map((word) => selectedWord(asset, word)), range, "transcript", { reveal });
  };

  const restore = async (key: string, word: TranscriptWord) => {
    const current = latest.current;
    if (!current.view || !current.model || restoring) return;
    const plan = restoreEdit(current.view, current.model, key);
    if (!plan) return;
    setRestoring(key);
    try {
      await window.frameshell.timeline.edit(SELECTION_TIMELINE, [plan.edit]);
      // Trust the timeline, not the plan: a restore that left the word cut is undone and reported.
      const after = await window.frameshell.timeline.show(SELECTION_TIMELINE);
      if (!isKept(after, current.sources, key)) {
        await window.frameshell.timeline.undo(SELECTION_TIMELINE);
        setStatus({ tone: "error", text: `“${word.text}” not restored: the edit left it cut, so it was undone.` });
        return;
      }
      setStatus({ tone: "info", text: `Restored “${word.text}”: ${plan.how === "extend" ? `extended ${plan.clip}` : `inserted after ${plan.clip}`}` });
    } catch (failure) {
      setStatus({ tone: "error", text: `“${word.text}” not restored: ${(failure as Error).message}` });
    } finally {
      setRestoring(null);
    }
  };

  const onPointerDown = (event: PointerEvent, asset: AssetTranscript, index: number) => {
    const word = asset.words[index]!;
    if (event.button !== 0 || word.placements.length === 0) return;
    event.preventDefault();
    const anchor = event.shiftKey && press.current?.asset === asset ? press.current.anchor : index;
    press.current = { asset, anchor, pointer: event.pointerId };
    selectRange(asset, anchor, index, true);
  };

  const onPointerEnter = (event: PointerEvent, asset: AssetTranscript, index: number) => {
    const current = press.current;
    if (!current || current.pointer !== event.pointerId || current.asset !== asset || (event.buttons & 1) === 0) return;
    selectRange(asset, current.anchor, index, false);
  };

  const onContextMenu = (event: MouseEvent, asset: AssetTranscript, index: number) => {
    const word = asset.words[index]!;
    if (word.placements.length > 0 && !selected.has(word.key)) selectRange(asset, index, index, false);
    openAskMenu(event);
  };

  const fps = view?.fps ?? 30;
  let body: ReactNode;
  if (!model) {
    body = <div className="empty editor-empty">{error ?? "Reading the timeline…"}</div>;
  } else if (model.assets.length === 0 && model.missing.length === 0) {
    body = (
      <div className="empty editor-empty">
        <p>No media on the timeline yet.</p>
        <p className="hint">Clips from assets/ show their spoken words here once transcribed.</p>
      </div>
    );
  } else {
    body = (
      <>
        {model.assets.map((asset) => (
          <AssetSection
            key={asset.path}
            asset={asset}
            fps={fps}
            stale={isStale(asset, sources, hashes)}
            selected={selected}
            restoring={restoring}
            onOpenFile={onOpenFile}
            onPointerDown={onPointerDown}
            onPointerEnter={onPointerEnter}
            onContextMenu={onContextMenu}
            onRestore={(word) => void restore(word.key, word)}
          />
        ))}
        {model.missing.map((asset) => (
          <section key={asset} className="transcript-asset transcript-missing">
            <header className="transcript-asset-head">
              <span className="transcript-asset-name">{asset}</span>
            </header>
            <p className="hint">
              Not transcribed yet. Run <code>frameshell transcribe {asset}</code> in the terminal.
            </p>
          </section>
        ))}
        {broken.map(({ path, message }) => (
          <div key={path} className="editor-notice is-error" role="alert">
            {`${path} cannot be read: ${message}`}
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="transcript-view">
      <div className="transcript-toolbar">
        <span className="hint">Click a word to jump to it, a struck word to restore it. Drag across words to select them on the timeline.</span>
        <span className={`timeline-status${status?.tone === "error" ? " timeline-status-error" : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
      </div>
      <div
        ref={scroller}
        className="transcript-scroll"
        data-testid="transcript"
        tabIndex={0}
        role="region"
        aria-label="Transcript. Click a struck word to restore it; click or drag over words to select them; Escape clears."
        onWheel={() => (lastUserScroll.current = performance.now())}
        onKeyDown={(event) => {
          if (event.key === "Escape") selection.clear();
        }}
        onContextMenu={(event) => {
          if (!event.defaultPrevented) openAskMenu(event);
        }}
        onPointerUp={() => (press.current = press.current ? { ...press.current, pointer: -1 } : null)}
      >
        {body}
      </div>
    </div>
  );
}

function AssetSection({
  asset,
  fps,
  stale,
  selected,
  restoring,
  onOpenFile,
  onPointerDown,
  onPointerEnter,
  onContextMenu,
  onRestore,
}: {
  asset: AssetTranscript;
  fps: number;
  stale: boolean;
  selected: ReadonlySet<string>;
  restoring: string | null;
  onOpenFile: (path: string) => void;
  onPointerDown: (event: PointerEvent, asset: AssetTranscript, index: number) => void;
  onPointerEnter: (event: PointerEvent, asset: AssetTranscript, index: number) => void;
  onContextMenu: (event: MouseEvent, asset: AssetTranscript, index: number) => void;
  onRestore: (word: TranscriptWord) => void;
}) {
  const index = useMemo(() => new Map(asset.words.map((word, i) => [word.key, i])), [asset]);
  const kept = asset.words.filter((word) => word.placements.length > 0).length;
  return (
    <section className="transcript-asset" data-transcript={asset.path}>
      <header className="transcript-asset-head">
        <span className="transcript-asset-name">{asset.asset}</span>
        <span className="panel-meta">{`${kept} of ${asset.words.length} words on the timeline`}</span>
        <button className="link" onClick={() => onOpenFile(asset.path)}>
          Open JSON
        </button>
      </header>
      {stale && (
        <div className="editor-notice" role="status">
          {`${asset.asset} changed after it was transcribed: words may sit at the wrong times. Run frameshell transcribe ${asset.asset} again.`}
        </div>
      )}
      {paragraphs(asset.words).map((words) => {
        const first = words.find((word) => word.placements.length > 0)?.placements[0];
        return (
          <p key={words[0]!.key} className="transcript-para">
            <span className="transcript-time" aria-hidden="true">
              {first ? formatTimecode(first.from, fps) : "cut"}
            </span>
            <span className="transcript-words">
              {words.map((word) => {
                const i = index.get(word.key)!;
                const struck = word.placements.length === 0;
                const classes = [
                  "tw",
                  struck ? "is-struck" : "",
                  word.speechInside ? "has-speech-inside" : "",
                  selected.has(word.key) ? "is-selected" : "",
                  restoring === word.key ? "is-restoring" : "",
                ];
                const hidden = word.speechInside ? " Holds more speech than this word; do not cut inside it." : "";
                return (
                  <span key={word.key}>
                    <span
                      className={classes.filter(Boolean).join(" ")}
                      data-key={word.key}
                      data-word={word.id}
                      data-state={struck ? "struck" : "kept"}
                      title={(struck ? "Cut from the timeline. Click to restore." : formatTimecode(word.placements[0]!.from, fps)) + hidden}
                      onPointerDown={(event) => onPointerDown(event, asset, i)}
                      onPointerEnter={(event) => onPointerEnter(event, asset, i)}
                      onContextMenu={(event) => onContextMenu(event, asset, i)}
                      onClick={struck ? () => onRestore(word) : undefined}
                    >
                      {word.text}
                    </span>{" "}
                  </span>
                );
              })}
            </span>
          </p>
        );
      })}
    </section>
  );
}

/** A transcript word as the selection store keeps it. */
function selectedWord(asset: AssetTranscript, word: TranscriptWord): SelectedWord {
  return { transcript: asset.path, asset: asset.asset, word: word.id, text: word.text, start: word.start, end: word.end };
}

/** A transcript whose asset's current hash differs from the one it was made from; unknown hashes are trusted. */
function isStale(asset: AssetTranscript, sources: readonly { path: string; transcript: { assetHash: string } }[], hashes: ReadonlyMap<string, string | null>): boolean {
  const hash = hashes.get(asset.asset);
  const source = sources.find((candidate) => candidate.path === asset.path);
  return !!hash && !!source && source.transcript.assetHash !== hash;
}

/** Scroll `element` into the middle third of `box` when it left it. */
function keepInView(box: HTMLElement, element: HTMLElement): void {
  const outer = box.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  if (inner.top >= outer.top + outer.height / 6 && inner.bottom <= outer.bottom - outer.height / 6) return;
  box.scrollTop += inner.top - outer.top - outer.height / 3;
}
