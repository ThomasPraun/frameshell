import type { LogHint } from "@frameshell/schema";
import { GRADE_LIMITS, type NormalizedGrade, logFootageHint } from "@frameshell/schema/grade";
import { useEffect, useRef, useState } from "react";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { cubeFiles } from "../grade/luts.js";
import { t } from "../i18n.js";

/** The correction numbers, in the order the grade applies them (ADR 0031: correct first, then style). */
const SLIDERS = [
  { name: "exposure", step: 0.05 },
  { name: "temperature", step: 0.01 },
  { name: "tint", step: 0.01 },
  { name: "contrast", step: 0.01 },
  { name: "saturation", step: 0.01 },
] as const;

type SliderName = (typeof SLIDERS)[number]["name"] | "lutMix";

const LABELS: Record<SliderName, () => { label: string; title: string; unit: string }> = {
  exposure: () => ({ label: t.inspector.gradeExposure, title: t.inspector.gradeExposureTitle, unit: t.inspector.gradeStops }),
  temperature: () => ({ label: t.inspector.gradeTemperature, title: t.inspector.gradeTemperatureTitle, unit: "" }),
  tint: () => ({ label: t.inspector.gradeTint, title: t.inspector.gradeTintTitle, unit: "" }),
  contrast: () => ({ label: t.inspector.gradeContrast, title: t.inspector.gradeContrastTitle, unit: "" }),
  saturation: () => ({ label: t.inspector.gradeSaturation, title: t.inspector.gradeSaturationTitle, unit: "" }),
  lutMix: () => ({ label: t.inspector.gradeLutMix, title: t.inspector.gradeLutMixTitle, unit: "" }),
};

const NEUTRAL: NormalizedGrade = {
  exposure: GRADE_LIMITS.exposure.default,
  temperature: GRADE_LIMITS.temperature.default,
  tint: GRADE_LIMITS.tint.default,
  contrast: GRADE_LIMITS.contrast.default,
  saturation: GRADE_LIMITS.saturation.default,
  lut: null,
  lutMix: GRADE_LIMITS.lutMix.default,
};

/**
 * A media clip's colour grade (ADR 0031, #384): five sliders for the correction (exposure, white balance, contrast,
 * saturation), a project `.cube` LUT with its mix, and a reset. Dragging a slider shows its value; the release is one
 * `clip.set grade` that changes that number only, so a drag is one undo step and the agent's other numbers stay.
 * LUTs are the `.cube` files the project holds, listed through the window's file tree. A note says when the footage
 * looks like LOG or HDR (`logFootageHint`): grading it is allowed, but Rec.709 looks and white balance do not fit it.
 */
export function ColourControl({
  clip,
  asset,
  grade,
  onSend,
}: {
  clip: string;
  asset: string | null;
  grade: NormalizedGrade | null;
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
}) {
  const shown = grade ?? NEUTRAL;
  const luts = useCubeFiles();
  const hint = useLogHint(asset);
  const set = (fields: Record<string, unknown>) => onSend({ op: "clip.set", args: { clip, grade: fields } }, { label: "Change grade" });
  // A LUT the project no longer holds stays listed, so the select shows what the clip stores.
  const choices = shown.lut !== null && !luts.includes(shown.lut) ? [...luts, shown.lut].sort() : luts;
  return (
    <div className="clip-inspector-group colour-grade" role="group" aria-label={t.inspector.colour}>
      <span className="colour-grade-head">
        <span className="key-control-label">{t.inspector.colour}</span>
        <button
          className="clip-inspector-button"
          disabled={grade === null}
          data-tip={t.inspector.gradeResetTitle}
          onClick={() => onSend({ op: "clip.set", args: { clip, grade: null } }, { label: "Reset grade" })}
        >
          {t.inspector.reset}
        </button>
        {hint && (
          <span className="colour-grade-log" role="status" data-testid="grade-log-warning" data-tip={t.inspector.gradeLogTitle}>
            {t.inspector.gradeLog(hint.kind, hint.value)}
          </span>
        )}
      </span>
      <span className="colour-grade-sliders">
        {SLIDERS.map(({ name, step }) => (
          <GradeSlider key={name} name={name} step={step} stored={shown[name]} onCommit={(value) => set({ [name]: value })} />
        ))}
      </span>
      <span className="colour-grade-lut">
        <label className="clip-field" data-tip={t.inspector.gradeLutTitle}>
          <span className="clip-field-label is-static">{t.inspector.gradeLut}</span>
          <select
            className="clip-field-select"
            aria-label={t.inspector.gradeLut}
            value={shown.lut ?? ""}
            onChange={(event) => set({ lut: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{t.inspector.gradeLutNone}</option>
            {choices.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
        {shown.lut !== null && (
          <GradeSlider name="lutMix" step={0.01} stored={shown.lutMix} onCommit={(value) => set({ lutMix: value })} />
        )}
        {luts.length === 0 && shown.lut === null && <span className="clip-inspector-hint">{t.inspector.gradeLutHint}</span>}
      </span>
    </div>
  );
}

/**
 * One slider: dragging moves a local value, and the browser's `change` (the release, or a key press) saves it through
 * `onCommit`. The value stays until the saved one changes, so the thumb does not jump back while the edit travels.
 */
function GradeSlider({ name, step, stored, onCommit }: { name: SliderName; step: number; stored: number; onCommit: (value: number) => void }) {
  const { label, title, unit } = LABELS[name]();
  const limit = GRADE_LIMITS[name];
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
  return (
    <label className="clip-field colour-slider" data-tip={title} data-grade={name}>
      <span className="clip-field-label is-static">{label}</span>
      <input
        ref={input}
        type="range"
        className="colour-slider-input"
        aria-label={unit ? `${label} (${unit})` : label}
        min={limit.min}
        max={limit.max}
        step={step}
        value={value}
        onChange={(event) => setDraft(Number(event.target.value))}
      />
      <output className="colour-slider-value">{value.toFixed(2)}</output>
    </label>
  );
}

/** The project's `.cube` files, again when files change. */
function useCubeFiles(): string[] {
  const [luts, setLuts] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    const read = () => {
      window.frameshell.files.tree().then(
        (tree) => !disposed && setLuts((known) => same(known, cubeFiles(tree))),
        () => undefined,
      );
    };
    read();
    const off = window.frameshell.files.onChanged((paths) => {
      if (paths.some((path) => path.toLowerCase().endsWith(".cube") || !path.includes("."))) read();
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);
  return luts;
}

/** `next`, or `known` itself when it lists the same files, so a re-read does not redraw. */
function same(known: string[], next: string[]): string[] {
  return known.length === next.length && known.every((path, index) => path === next[index]) ? known : next;
}

/** Whether `asset` looks like LOG or HDR footage (`logFootageHint` on its probe from `asset.list`); null while unknown. */
function useLogHint(asset: string | null): LogHint | null {
  const [hint, setHint] = useState<LogHint | null>(null);
  useEffect(() => {
    setHint(null);
    if (asset === null) return;
    let disposed = false;
    window.frameshell.media.assets().then(
      (list) => {
        const probe = list.find((entry) => entry.path === asset)?.media;
        if (!disposed && !probe?.video?.still) setHint(logFootageHint(asset, probe?.video));
      },
      () => undefined,
    );
    return () => {
      disposed = true;
    };
  }, [asset]);
  return hint;
}
