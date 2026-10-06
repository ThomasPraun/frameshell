import { type MouseEvent, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineView } from "@frameshell/protocol";
import { openAskMenu } from "../ask/ask-agent.js";
import { transport } from "../preview/transport.js";
import { SELECTION_TIMELINE, type SelectedWord, selection, unionRange, useSelection } from "../selection.js";
import { formatTimecode, layoutTimeline } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import {
  type AssetTranscript,
  type TranscriptModel,
  type TranscriptWord,
  buildTranscriptModel,
  isKept,
  paragraphs,
  restorePlan,
  struckRun,
  withWordText,
  wordAt,
} from "../transcript/model.js";
import { useTranscripts } from "../transcript/useTranscripts.js";
import type { MenuItem } from "./ContextMenu.js";

/** Pseudo path of the transcript editor tab: never a project file (`:` is not in project paths). */
export const TRANSCRIPT_TAB = "frameshell:transcript";

/** Shortcut that opens the transcript view, as menus and tooltips show it (View > Transcript). */
export const TRANSCRIPT_SHORTCUT = navigator.userAgent.includes("Mac") ? "⌘⇧T" : "Ctrl+Shift+T";

/** After the user scrolls the transcript, playback leaves the scroll alone this long, ms. */
const USER_SCROLL_HOLD_MS = 2500;
/** How long a restore's feedback line stays, ms. */
const STATUS_MS = 5000;
/** A held-track warning stays longer: it asks the user to check sync. */
const WARNING_MS = 12000;

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

/** Words of one asset a drag or Shift-click spanned, by index: kept and struck alike. */
interface Marked {
  path: string;
  from: number;
  to: number;
}

/**
 * Transcript editor tab (SPEC §10): the words of every asset the timeline
 * plays, in source order. The word under the shared playhead is marked as it
 * plays; words no clip keeps are struck through.
 *
 * - Clicking a struck word restores it as a `ui` operation (rippled trim or
 *   insert, snapped to pauses; see `restorePlan`). The ↺ button before a cut
 *   passage, the toolbar button for struck words in a drag, and the context
 *   menu restore several words at once: one transaction, one undo step.
 *   A restore never opens gaps on other tracks: tracks it cannot move
 *   cleanly stay in place and the status line names them.
 * - Clicking or dragging over kept words selects them in the shared
 *   selection store with their timeline range, which the timeline highlights
 *   and the playhead jumps to, also while playing.
 * - Double-click, F2 on one selected word, or the context menu edit a word's
 *   text: saved as a transcript `edits` entry, which subtitles show.
 * - Right-click opens "Ask agent" on the selection (a kept word outside it is
 *   selected first) with the word commands above.
 */
export function TranscriptView({ onOpenFile, focus }: { onOpenFile: (path: string) => void; focus: TranscriptFocus | null }) {
  const { view, error } = useTimelineView(SELECTION_TIMELINE);
  const { sources, broken, hashes } = useTranscripts();
  const model = useMemo(() => (view ? buildTranscriptModel(view, sources) : null), [view, sources]);
  const { words: selectedWords, origin } = useSelection();
  const selected = useMemo(() => new Set(selectedWords.map((word) => `${word.transcript}#${word.word}`)), [selectedWords]);
  const [status, setStatus] = useState<{ text: string; tone: "info" | "error" | "warning" } | null>(null);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const [marked, setMarked] = useState<Marked | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const press = useRef<Press | null>(null);
  const lastUserScroll = useRef(0);
  const latest = useRef({ model, view, sources });
  latest.current = { model, view, sources };

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), status.tone === "warning" ? WARNING_MS : STATUS_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Another panel took the selection: the drag range here no longer means anything.
  useEffect(() => {
    if (origin !== null && origin !== "transcript") setMarked(null);
  }, [origin]);

  // Struck words of the drag range, in source order: what the toolbar's restore button brings back.
  const markedStruck = useMemo(() => {
    const asset = marked && model?.assets.find((candidate) => candidate.path === marked.path);
    if (!marked || !asset) return [];
    return asset.words.slice(marked.from, marked.to + 1).filter((word) => word.placements.length === 0);
  }, [marked, model]);

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
  }, [model, editing]);

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
    setMarked({ path: asset.path, from: first, to: last });
  };

  /** Restore the struck words among `keys` as one transaction; reported on the toolbar. */
  const restore = async (keys: readonly string[]) => {
    const current = latest.current;
    if (!current.view || !current.model || restoring.size > 0) return;
    const plan = restorePlan(current.view, current.model, keys);
    if (!plan) return;
    const texts = plan.keys.map((key) => textOf(current.model!, key));
    const what = texts.length === 1 ? `“${texts[0]}”` : `${texts.length} words`;
    setRestoring(new Set(plan.keys));
    try {
      await window.frameshell.timeline.edit(SELECTION_TIMELINE, plan.edits);
      // Trust the timeline, not the plan: a restore that left a word cut is undone and reported.
      const after = await window.frameshell.timeline.show(SELECTION_TIMELINE);
      const left = plan.keys.filter((key) => !isKept(after, current.sources, key));
      if (left.length > 0) {
        await window.frameshell.timeline.undo(SELECTION_TIMELINE);
        const which = left.map((key) => `“${textOf(current.model!, key)}”`).join(", ");
        setStatus({ tone: "error", text: `${what} not restored: the edit left ${which} cut, so it was undone.` });
        return;
      }
      const [step] = plan.steps;
      const how = plan.steps.length === 1 ? `: ${step!.how === "extend" ? `extended ${step!.clip}` : `inserted after ${step!.clip}`}` : "";
      const held =
        plan.held.length === 0
          ? ""
          : `. ${trackLabels(current.view, plan.held)} kept in place so no gap opened: check their sync after this point.`;
      setStatus({ tone: held ? "warning" : "info", text: `Restored ${what}${how}${held}` });
      setMarked(null);
    } catch (failure) {
      setStatus({ tone: "error", text: `${what} not restored: ${(failure as Error).message}` });
    } finally {
      setRestoring(new Set());
    }
  };

  /** Save `text` as word `word`'s correction in transcript `path` (null: cancelled). */
  const saveText = async (path: string, word: TranscriptWord, text: string | null) => {
    setEditing(null);
    scroller.current?.focus();
    if (text === null || text.trim() === word.text) return;
    try {
      const content = await window.frameshell.files.read(path);
      await window.frameshell.files.write(path, withWordText(content, word.id, text));
      setStatus(
        text.trim() === ""
          ? { tone: "info", text: `“${word.text}” reads as transcribed again.` }
          : { tone: "info", text: `Corrected “${word.text}” to “${text.trim()}”.` },
      );
    } catch (failure) {
      setStatus({ tone: "error", text: `“${word.text}” not corrected: ${(failure as Error).message}` });
    }
  };

  const onPointerDown = (event: PointerEvent, asset: AssetTranscript, index: number) => {
    if (event.button !== 0 || editing) return;
    event.preventDefault();
    const struck = asset.words[index]!.placements.length === 0;
    const extend = event.shiftKey && press.current?.asset === asset;
    const anchor = extend ? press.current!.anchor : index;
    press.current = { asset, anchor, pointer: event.pointerId };
    // A plain press on a struck word is a click that restores it; it selects only once dragged.
    if (!struck || extend) selectRange(asset, anchor, index, true);
  };

  const onPointerEnter = (event: PointerEvent, asset: AssetTranscript, index: number) => {
    const current = press.current;
    if (!current || current.pointer !== event.pointerId || current.asset !== asset || (event.buttons & 1) === 0) return;
    selectRange(asset, current.anchor, index, false);
  };

  const onContextMenu = (event: MouseEvent, asset: AssetTranscript, index: number) => {
    const word = asset.words[index]!;
    const struck = word.placements.length === 0;
    const inMarked = marked?.path === asset.path && index >= marked.from && index <= marked.to;
    if (!struck && !selected.has(word.key)) selectRange(asset, index, index, false);
    const items: MenuItem[] = [];
    if (inMarked && markedStruck.length > 1) {
      items.push({ label: `Restore ${markedStruck.length} cut words`, run: () => void restore(markedStruck.map((w) => w.key)) });
    } else if (struck) {
      const run = struckRun(asset.words, index);
      items.push({ label: `Restore “${word.text}”`, run: () => void restore([word.key]) });
      if (run.length > 1) items.push({ label: `Restore cut passage (${run.length} words)`, run: () => void restore(run) });
    }
    items.push({ label: "Edit text…", shortcut: "F2", run: () => setEditing(word.key) });
    openAskMenu(event, items);
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
            marked={marked?.path === asset.path ? marked : null}
            restoring={restoring}
            editing={editing}
            onOpenFile={onOpenFile}
            onPointerDown={onPointerDown}
            onPointerEnter={onPointerEnter}
            onContextMenu={onContextMenu}
            onRestore={(keys) => void restore(keys)}
            onEdit={(word) => setEditing(word.key)}
            onSaveText={(word, text) => void saveText(asset.path, word, text)}
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
        {markedStruck.length > 0 ? (
          <button className="link transcript-restore-marked" disabled={restoring.size > 0} onClick={() => void restore(markedStruck.map((word) => word.key))}>
            {`Restore ${markedStruck.length} cut ${markedStruck.length === 1 ? "word" : "words"}`}
          </button>
        ) : (
          <span className="hint">
            Click a struck word to restore it, ↺ for a whole cut passage. Click or drag to select; double-click a word to fix its text.
          </span>
        )}
        <span
          className={`timeline-status${status?.tone === "error" ? " timeline-status-error" : status?.tone === "warning" ? " timeline-status-warning" : ""}`}
          role="status"
          aria-live="polite"
        >
          {status?.text ?? ""}
        </span>
      </div>
      <div
        ref={scroller}
        className="transcript-scroll"
        data-testid="transcript"
        tabIndex={0}
        role="region"
        aria-label="Transcript. Click a struck word to restore it; click or drag over words to select them; F2 edits the selected word; Escape clears."
        onWheel={() => (lastUserScroll.current = performance.now())}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            selection.clear();
            setMarked(null);
          } else if (event.key === "F2" && selectedWords.length === 1 && !editing) {
            const [only] = selectedWords;
            setEditing(`${only!.transcript}#${only!.word}`);
          }
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
  marked,
  restoring,
  editing,
  onOpenFile,
  onPointerDown,
  onPointerEnter,
  onContextMenu,
  onRestore,
  onEdit,
  onSaveText,
}: {
  asset: AssetTranscript;
  fps: number;
  stale: boolean;
  selected: ReadonlySet<string>;
  marked: Marked | null;
  restoring: ReadonlySet<string>;
  editing: string | null;
  onOpenFile: (path: string) => void;
  onPointerDown: (event: PointerEvent, asset: AssetTranscript, index: number) => void;
  onPointerEnter: (event: PointerEvent, asset: AssetTranscript, index: number) => void;
  onContextMenu: (event: MouseEvent, asset: AssetTranscript, index: number) => void;
  onRestore: (keys: string[]) => void;
  onEdit: (word: TranscriptWord) => void;
  onSaveText: (word: TranscriptWord, text: string | null) => void;
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
                // A cut passage of several words starts with one button that restores all of it.
                const run = struck && asset.words[i - 1]?.placements.length !== 0 ? struckRun(asset.words, i) : [];
                if (editing === word.key) {
                  return (
                    <span key={word.key}>
                      <WordEditor text={word.text} onDone={(text) => onSaveText(word, text)} />{" "}
                    </span>
                  );
                }
                const inMarked = marked !== null && i >= marked.from && i <= marked.to;
                const classes = [
                  "tw",
                  struck ? "is-struck" : "",
                  selected.has(word.key) ? "is-selected" : "",
                  struck && inMarked ? "is-marked" : "",
                  restoring.has(word.key) ? "is-restoring" : "",
                ];
                return (
                  <span key={word.key}>
                    {run.length > 1 && (
                      <button
                        className="transcript-restore-run"
                        aria-label={`Restore ${run.length} cut words`}
                        title={`Restore these ${run.length} cut words in one step`}
                        disabled={restoring.size > 0}
                        onClick={() => onRestore(run)}
                      >
                        ↺
                      </button>
                    )}
                    <span
                      className={classes.filter(Boolean).join(" ")}
                      data-key={word.key}
                      data-word={word.id}
                      data-state={struck ? "struck" : "kept"}
                      title={struck ? "Cut from the timeline. Click to restore." : `${formatTimecode(word.placements[0]!.from, fps)} · double-click to fix the text`}
                      onPointerDown={(event) => onPointerDown(event, asset, i)}
                      onPointerEnter={(event) => onPointerEnter(event, asset, i)}
                      onContextMenu={(event) => onContextMenu(event, asset, i)}
                      onClick={struck ? (event) => !event.shiftKey && onRestore([word.key]) : undefined}
                      onDoubleClick={struck ? undefined : () => onEdit(word)}
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

/** Inline text field for one word: Enter or leaving it saves, Escape cancels. Reports once. */
function WordEditor({ text, onDone }: { text: string; onDone: (text: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <input
      ref={input}
      className="tw-edit"
      aria-label={`Text of “${text}”`}
      defaultValue={text}
      size={Math.max(text.length + 2, 6)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        else if (event.key === "Escape") finish(null);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

/** Text of word `key` as the view shows it. */
function textOf(model: TranscriptModel, key: string): string {
  for (const asset of model.assets) {
    const word = asset.words.find((candidate) => candidate.key === key);
    if (word) return word.text;
  }
  return key;
}

/** Tracks as the timeline labels them, e.g. `V1, A2 (music)`. */
function trackLabels(view: TimelineView, ids: readonly string[]): string {
  const rows = layoutTimeline(view).rows;
  return ids
    .map((id) => {
      const row = rows.find((candidate) => candidate.id === id);
      return row ? (row.name ? `${row.label} (${row.name})` : row.label) : id;
    })
    .join(", ");
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
