import { useEffect, useRef, useState } from "react";

/**
 * One slider of an inspector section (Colour, Finish): dragging moves a local value, and the browser's `change` (the
 * release, or a key press) saves it through `onCommit`, so a drag is one edit and one undo step. The value stays until
 * the saved one changes, so the thumb does not jump back while the edit travels. `data` goes on the label as `data-*`
 * attributes, for tests and styling.
 */
export function ReleaseSlider({
  label,
  title,
  ariaLabel = label,
  min,
  max,
  step,
  stored,
  disabled = false,
  data,
  onCommit,
}: {
  label: string;
  /** Tooltip (`data-tip`). */
  title: string;
  /** Accessible name when it adds a unit to the label. */
  ariaLabel?: string;
  min: number;
  max: number;
  step: number;
  stored: number;
  disabled?: boolean;
  data: Record<string, string>;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef({ stored, onCommit });
  latest.current = { stored, onCommit };

  useEffect(() => setDraft(null), [stored]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const released = () => {
      const value = Number(element.value);
      if (value !== latest.current.stored) latest.current.onCommit(value);
      else setDraft(null);
    };
    element.addEventListener("change", released);
    return () => element.removeEventListener("change", released);
  }, []);

  const value = draft ?? stored;
  const attributes = Object.fromEntries(Object.entries(data).map(([name, text]) => [`data-${name}`, text]));
  return (
    <label className="clip-field colour-slider" data-tip={title} {...attributes}>
      <span className="clip-field-label is-static">{label}</span>
      <input
        ref={input}
        type="range"
        className="colour-slider-input"
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
      />
      <output className="colour-slider-value">{value.toFixed(2)}</output>
    </label>
  );
}
