// Fields the inspectors share: numeric settings, text, and a segmented single choice.
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { t } from "../i18n.js";

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

/** A crop side: stored as a fraction of the picture, shown in percent, below 100. */
const crop = (label: string, title: string): FieldSpec => ({
  label,
  title,
  unit: "%",
  show: (v) => round(v * 100, 1),
  store: (v) => (v >= 0 && v < 100 ? round(v / 100, 4) : null),
  step: 1,
  decimals: 1,
});

/** A reframe point: stored as a fraction of the picture, shown in percent, 0 to 100. */
const point = (label: string, title: string): FieldSpec => ({
  label,
  title,
  unit: "%",
  show: (v) => round(v * 100, 1),
  store: (v) => (v >= 0 && v <= 100 ? round(v / 100, 4) : null),
  step: 1,
  decimals: 1,
});

const FIELDS = {
  x: { label: t.inspector.fieldX, title: t.inspector.fieldXTitle, unit: "px", show: (v) => v, store: (v) => Math.round(v), step: 1, decimals: 0 },
  y: { label: t.inspector.fieldY, title: t.inspector.fieldYTitle, unit: "px", show: (v) => v, store: (v) => Math.round(v), step: 1, decimals: 0 },
  scale: {
    label: t.inspector.fieldScale,
    title: t.inspector.fieldScaleTitle,
    unit: "%",
    show: (v) => round(v * 100, 1),
    store: (v) => (v > 0 ? round(v / 100, 4) : null),
    step: 1,
    decimals: 1,
  },
  opacity: {
    label: t.inspector.fieldOpacity,
    title: t.inspector.fieldOpacityTitle,
    unit: "%",
    show: (v) => round(v * 100, 1),
    store: (v) => (v >= 0 && v <= 100 ? round(v / 100, 4) : null),
    step: 5,
    decimals: 1,
  },
  gain: {
    label: t.inspector.fieldGain,
    title: t.inspector.fieldGainTitle(GAIN_MIN, GAIN_MAX),
    unit: "dB",
    show: (v) => round(v, 1),
    store: (v) => (v >= GAIN_MIN && v <= GAIN_MAX ? round(v, 1) : null),
    step: 0.5,
    decimals: 1,
  },
  length: {
    label: t.inspector.fieldLength,
    title: t.inspector.fieldLengthTitle,
    unit: "s",
    show: (v) => round(v, 3),
    store: (v) => (v > 0 ? round(v, 3) : null),
    step: 0.1,
    decimals: 2,
  },
  offset: {
    label: t.inspector.fieldOffset,
    title: t.inspector.fieldOffsetTitle,
    unit: "s",
    show: (v) => round(v, 3),
    store: (v) => (v >= 0 ? round(v, 3) : null),
    step: 0.01,
    decimals: 3,
  },
  cropLeft: crop(t.inspector.fieldCropLeft, t.inspector.fieldCropTitle(t.inspector.sideLeft)),
  cropTop: crop(t.inspector.fieldCropTop, t.inspector.fieldCropTitle(t.inspector.sideTop)),
  cropRight: crop(t.inspector.fieldCropRight, t.inspector.fieldCropTitle(t.inspector.sideRight)),
  cropBottom: crop(t.inspector.fieldCropBottom, t.inspector.fieldCropTitle(t.inspector.sideBottom)),
  reframeX: point(t.inspector.fieldReframeX, t.inspector.fieldReframeXTitle),
  reframeY: point(t.inspector.fieldReframeY, t.inspector.fieldReframeYTitle),
} satisfies Record<string, FieldSpec>;

/** A numeric setting {@link NumberField} knows how to show and store. */
export type FieldName = keyof typeof FIELDS;

/**
 * Saves a field's entry. A promise that resolves false means the daemon refused
 * it: the saved value is unchanged, so the field shows it again.
 */
export type FieldCommit<T> = (value: T) => void | Promise<boolean>;

/** Calls `onCommit`; on a refusal shows the saved value of that moment (`latest`) again. */
function commitOrRestore<T>(onCommit: FieldCommit<T>, value: T, latest: { current: string }, setText: (text: string) => void): void {
  void onCommit(value)?.then((ok) => {
    if (!ok) setText(latest.current);
  });
}

/**
 * A numeric setting: type and press Enter (or leave the field), Escape
 * restores the saved value, arrows step it (Shift: ten steps). Dragging the
 * label left or right scrubs the value; release saves it. An entry the
 * daemon refuses gives way to the saved value again.
 */
export function NumberField({ name, stored, disabled, onCommit }: { name: FieldName; stored: number; disabled?: boolean; onCommit: FieldCommit<number> }) {
  const spec: FieldSpec = FIELDS[name];
  const shown = spec.show(stored);
  const [text, setText] = useState(String(shown));
  const [invalid, setInvalid] = useState(false);
  const scrub = useRef<{ pointer: number; x: number; from: number } | null>(null);
  const latest = useRef(String(shown));
  latest.current = String(shown);

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
    if (next !== stored) commitOrRestore(onCommit, next, latest, setText);
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

/**
 * A text setting: Enter or leaving the field saves it, Escape restores the saved text; empty is refused.
 * An entry the daemon refuses gives way to the saved text again.
 */
export function TextField({ label, title, stored, onCommit }: { label: string; title: string; stored: string; onCommit: FieldCommit<string> }) {
  const [text, setText] = useState(stored);
  const [invalid, setInvalid] = useState(false);
  const latest = useRef(stored);
  latest.current = stored;
  useEffect(() => {
    setText(stored);
    setInvalid(false);
  }, [stored]);
  const commit = () => {
    const value = text.trim();
    if (value === "") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (value !== stored) commitOrRestore(onCommit, value, latest, setText);
  };
  return (
    <label className={`clip-field${invalid ? " is-invalid" : ""}`} title={title}>
      <span className="clip-field-label is-static">{label}</span>
      <input
        className="clip-field-input is-text"
        aria-label={label}
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") {
            setText(stored);
            setInvalid(false);
          } else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onBlur={() => {
          if (text !== stored) commit();
        }}
      />
    </label>
  );
}

/** Segmented single choice: the current value pressed, a click saves another. */
export function Choice({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: { id: string; label: string; title: string }[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="clip-inspector-group segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          className={`segmented-option${option.id === value ? " on" : ""}`}
          role="radio"
          aria-checked={option.id === value}
          title={option.title}
          onClick={() => option.id !== value && onPick(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
