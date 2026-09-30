import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineEdit } from "../../../shared/api.js";
import { SELECTION_TIMELINE, useSelection } from "../selection.js";
import { type ClipBox, type TrackRow, layoutTimeline } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { sendClipEdit } from "./clip-edits.js";

/** Gain range the field accepts, dB. */
const GAIN_MIN = -60;
const GAIN_MAX = 24;
/** Label drag: this many px per step. */
const SCRUB_PX = 3;

/** One numeric setting: how it shows and how an entry becomes the stored value. */
interface FieldSpec {
  label: string;
  title: string;
  unit: string;
  /** Stored value → shown number. */
  show: (stored: number) => number;
  /** Shown number → stored value; null when out of range. */
  store: (shown: number) => number | null;
  /** Arrow key and scrub step, in shown units. */
  step: number;
  decimals: number;
}

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

const FIELDS = {
  x: { label: "X", title: "Horizontal offset from center, project pixels", unit: "px", show: (v) => v, store: (v) => Math.round(v), step: 1, decimals: 0 },
  y: { label: "Y", title: "Vertical offset from center, project pixels", unit: "px", show: (v) => v, store: (v) => Math.round(v), step: 1, decimals: 0 },
  scale: {
    label: "Scale",
    title: "Size relative to fitting the frame",
    unit: "%",
    show: (v) => round(v * 100, 1),
    store: (v) => (v > 0 ? round(v / 100, 4) : null),
    step: 1,
    decimals: 1,
  },
  opacity: {
    label: "Opacity",
    title: "0 % is invisible, 100 % opaque",
    unit: "%",
    show: (v) => round(v * 100, 1),
    store: (v) => (v >= 0 && v <= 100 ? round(v / 100, 4) : null),
    step: 5,
    decimals: 1,
  },
  gain: {
    label: "Gain",
    title: `Volume change in decibels, ${GAIN_MIN} to +${GAIN_MAX}`,
    unit: "dB",
    show: (v) => round(v, 1),
    store: (v) => (v >= GAIN_MIN && v <= GAIN_MAX ? round(v, 1) : null),
    step: 0.5,
    decimals: 1,
  },
} satisfies Record<string, FieldSpec>;

type FieldName = keyof typeof FIELDS;

/**
 * Settings of the one selected clip (SPEC §10): placement on video tracks
 * (position, scale, opacity) and sound of media clips (gain, mute). Each
 * change is one `clip.set` by `ui`, saved at once and undoable from the
 * timeline; values shown are the saved ones, from the shared timeline feed.
 */
export function ClipInspector() {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const { clips } = useSelection();
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const [error, setError] = useState<string | null>(null);
  const target = clips.length === 1 && layout ? find(layout.rows, clips[0]!) : null;

  useEffect(() => setError(null), [target?.clip.id]);

  if (!target) {
    return (
      <div className="clip-inspector is-empty" role="group" aria-label="Clip settings">
        <span>{clips.length > 1 ? `${clips.length} clips selected: select one to adjust it` : "Select a clip to adjust its placement and sound"}</span>
      </div>
    );
  }
  const { row, clip } = target;
  const send = (edit: TimelineEdit) => {
    setError(null);
    sendClipEdit(edit).catch((failure: unknown) => setError((failure as Error).message));
  };
  const transform = clip.transform ?? { x: 0, y: 0, scale: 1, opacity: 1 };
  const setTransform = (name: "x" | "y" | "scale" | "opacity", value: number) =>
    send({ op: "clip.set", args: { clip: clip.id, transform: { [name]: value } } });
  const placed = row.kind === "video";
  const audible = clip.kind === "media";
  const moved = transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.opacity !== 1;

  return (
    <div className="clip-inspector" role="group" aria-label={`Settings of clip ${clip.name}`} data-clip={clip.id}>
      <span className="clip-inspector-name" title={`${clip.id} on ${row.label}`}>
        <span className={`clip-inspector-track track-${row.kind}`}>{row.label}</span>
        {clip.name}
      </span>
      {placed && (
        <div className="clip-inspector-group" role="group" aria-label="Placement">
          {(["x", "y", "scale", "opacity"] as const).map((name) => (
            <NumberField key={name} name={name} stored={transform[name]} onCommit={(value) => setTransform(name, value)} />
          ))}
          <button
            className="clip-inspector-button"
            disabled={!moved}
            title="Center, fit and make opaque again"
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, transform: { x: 0, y: 0, scale: 1, opacity: 1 } } })}
          >
            Reset
          </button>
        </div>
      )}
      {audible && (
        <div className="clip-inspector-group" role="group" aria-label="Sound">
          <NumberField name="gain" stored={clip.gain} disabled={clip.muted} onCommit={(value) => send({ op: "clip.set", args: { clip: clip.id, gain: value } })} />
          <button
            className={`clip-inspector-button clip-inspector-mute${clip.muted ? " on" : ""}`}
            aria-pressed={clip.muted}
            title={clip.muted ? "Unmute this clip" : "Mute this clip"}
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, muted: !clip.muted } })}
          >
            Mute
          </button>
        </div>
      )}
      {!placed && !audible && <span className="clip-inspector-hint">Nothing to adjust on this clip</span>}
      {error && (
        <span className="clip-inspector-error" role="status" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function find(rows: readonly TrackRow[], id: string): { row: TrackRow; clip: ClipBox } | null {
  for (const row of rows) {
    const clip = row.clips.find((candidate) => candidate.id === id);
    if (clip) return { row, clip };
  }
  return null;
}

/**
 * A numeric setting: type and press Enter (or leave the field), Escape
 * restores the saved value, arrows step it (Shift: ten steps). Dragging the
 * label left or right scrubs the value; release saves it.
 */
function NumberField({ name, stored, disabled, onCommit }: { name: FieldName; stored: number; disabled?: boolean; onCommit: (value: number) => void }) {
  const spec: FieldSpec = FIELDS[name];
  const shown = spec.show(stored);
  const [text, setText] = useState(String(shown));
  const [invalid, setInvalid] = useState(false);
  const scrub = useRef<{ pointer: number; x: number; from: number } | null>(null);

  // A new saved value (this edit, the agent's, an undo) replaces what the field shows.
  useEffect(() => {
    setText(String(shown));
    setInvalid(false);
  }, [shown]);

  const commit = (value: number) => {
    const next = spec.store(value);
    if (next === null || !Number.isFinite(value)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setText(String(round(value, spec.decimals)));
    if (next !== stored) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commit(Number(text));
    else if (event.key === "Escape") {
      setText(String(shown));
      setInvalid(false);
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const base = Number.isFinite(Number(text)) ? Number(text) : shown;
      commit(round(base + (event.key === "ArrowUp" ? 1 : -1) * spec.step * (event.shiftKey ? 10 : 1), spec.decimals));
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onScrubStart = (event: PointerEvent<HTMLLabelElement>) => {
    if (disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrub.current = { pointer: event.pointerId, x: event.clientX, from: shown };
  };
  const scrubbed = (event: PointerEvent<HTMLLabelElement>) => {
    const active = scrub.current;
    if (!active || active.pointer !== event.pointerId) return null;
    const steps = Math.round((event.clientX - active.x) / SCRUB_PX);
    return round(active.from + steps * spec.step, spec.decimals);
  };

  return (
    <label
      className={`clip-field${invalid ? " is-invalid" : ""}`}
      title={spec.title}
      onPointerDown={onScrubStart}
      onPointerMove={(event) => {
        const value = scrubbed(event);
        if (value !== null) setText(String(value));
      }}
      onPointerUp={(event) => {
        const value = scrubbed(event);
        scrub.current = null;
        if (value !== null && value !== shown) commit(value);
      }}
      onLostPointerCapture={() => (scrub.current = null)}
    >
      <span className="clip-field-label">{spec.label}</span>
      <input
        className="clip-field-input"
        aria-label={`${spec.label} (${spec.unit})`}
        inputMode="decimal"
        spellCheck={false}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (text !== String(shown)) commit(Number(text));
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <span className="clip-field-unit">{spec.unit}</span>
    </label>
  );
}
