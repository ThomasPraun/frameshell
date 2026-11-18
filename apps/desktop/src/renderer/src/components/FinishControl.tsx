import { GRAIN_LIMITS, VIGNETTE_LIMITS, grainSeed } from "@frameshell/schema/finish";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { GRAIN_SLIDERS, type ShownGrain, type ShownVignette, VIGNETTE_SLIDERS } from "../finish/model.js";
import { t } from "../i18n.js";
import { NumberField } from "./inspector-fields.js";
import { ReleaseSlider } from "./ReleaseSlider.js";

const VIGNETTE_TEXT: Record<(typeof VIGNETTE_SLIDERS)[number]["name"], () => { label: string; title: string }> = {
  strength: () => ({ label: t.inspector.vignetteStrength, title: t.inspector.vignetteStrengthTitle }),
  radius: () => ({ label: t.inspector.vignetteRadius, title: t.inspector.vignetteRadiusTitle }),
  softness: () => ({ label: t.inspector.vignetteSoftness, title: t.inspector.vignetteSoftnessTitle }),
};

const GRAIN_TEXT: Record<(typeof GRAIN_SLIDERS)[number]["name"], () => { label: string; title: string }> = {
  amount: () => ({ label: t.inspector.grainAmount, title: t.inspector.grainAmountTitle }),
  size: () => ({ label: t.inspector.grainSize, title: t.inspector.grainSizeTitle }),
};

/**
 * A media or generated clip's film finish (ADR 0043): a Vignette group (strength, radius, softness) and a Grain
 * group (amount, size, seed), each with a switch that turns it on with the schema's defaults (`clip.set {}`) or removes it
 * (`null`), and one Reset for both. A slider's release is one `clip.set` that changes that number only, so a drag is one
 * undo step and the agent's other numbers stay. Both belong to the clip, never to a format: in a format being edited
 * the section edits the shared values and says so. The grain note repeats the skill's rule: footage only.
 */
export function FinishControl({
  clip,
  vignette,
  grain,
  inFormat,
  onSend,
}: {
  clip: string;
  vignette: ShownVignette | null;
  grain: ShownGrain | null;
  /** The preview shows a format other than the primary: the numbers shown are every format's. */
  inFormat: boolean;
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
}) {
  const send = (fields: Record<string, unknown>, label: string) => onSend({ op: "clip.set", args: { clip, ...fields } }, { label });
  return (
    <div className="clip-inspector-group colour-grade finish-control" role="group" aria-label={t.inspector.finish} data-testid="finish-control">
      <span className="colour-grade-head">
        <span className="key-control-label">{t.inspector.finish}</span>
        <button
          className="clip-inspector-button"
          disabled={vignette === null && grain === null}
          data-tip={t.inspector.finishResetTitle}
          onClick={() => send({ vignette: null, grain: null }, "Reset finish")}
        >
          {t.inspector.reset}
        </button>
        {inFormat && (
          <span className="clip-inspector-hint" data-testid="finish-shared" data-tip={t.inspector.finishSharedTitle}>
            {t.inspector.finishShared}
          </span>
        )}
      </span>
      <div className="colour-grade-sliders" role="group" aria-label={t.inspector.vignette}>
        <button
          className={`clip-inspector-button clip-inspector-switch${vignette ? " on" : ""}`}
          aria-pressed={vignette !== null}
          data-tip={vignette ? t.inspector.vignetteOffTitle : t.inspector.vignetteOnTitle}
          onClick={() => send({ vignette: vignette ? null : {} }, vignette ? "Remove vignette" : "Add vignette")}
        >
          {t.inspector.vignette}
        </button>
        {vignette &&
          VIGNETTE_SLIDERS.map(({ name, step }) => {
            const { label, title } = VIGNETTE_TEXT[name]();
            const limit = VIGNETTE_LIMITS[name];
            return (
              <ReleaseSlider
                key={name}
                label={label}
                title={title}
                min={limit.min}
                max={limit.max}
                step={step}
                stored={vignette[name]}
                data={{ finish: `vignette-${name}` }}
                onCommit={(value) => send({ vignette: { [name]: value } }, "Change vignette")}
              />
            );
          })}
      </div>
      <div className="colour-grade-sliders" role="group" aria-label={t.inspector.grain}>
        <button
          className={`clip-inspector-button clip-inspector-switch${grain ? " on" : ""}`}
          aria-pressed={grain !== null}
          data-tip={grain ? t.inspector.grainOffTitle : t.inspector.grainOnTitle}
          onClick={() => send({ grain: grain ? null : {} }, grain ? "Remove grain" : "Add grain")}
        >
          {t.inspector.grain}
        </button>
        {grain &&
          GRAIN_SLIDERS.map(({ name, step }) => {
            const { label, title } = GRAIN_TEXT[name]();
            const limit = GRAIN_LIMITS[name];
            return (
              <ReleaseSlider
                key={name}
                label={label}
                title={title}
                min={limit.min}
                max={limit.max}
                step={step}
                stored={grain[name]}
                data={{ finish: `grain-${name}` }}
                onCommit={(value) => send({ grain: { [name]: value } }, "Change grain")}
              />
            );
          })}
        {grain && <NumberField name="seed" stored={grain.seed ?? grainSeed(clip)} onCommit={(value) => send({ grain: { seed: value } }, "Change grain")} />}
        <span className="clip-inspector-hint" data-tip={t.inspector.grainNoteTitle}>
          {t.inspector.grainNote}
        </span>
      </div>
    </div>
  );
}
