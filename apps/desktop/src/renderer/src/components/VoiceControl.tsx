import { voiceChainOf } from "@frameshell/schema";
import type { NormalizedAudioEffect } from "@frameshell/schema/effects";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { t } from "../i18n.js";
import { projectStyle } from "../project-style.js";
import { EFFECT_PARAMS, type EffectKind, bypass, missingKinds, movedEarlier, paramOf, withEffect, withParam, withoutEffect } from "../voice/model.js";
import { NumberField } from "./inspector-fields.js";

const EFFECT_NAMES: Record<EffectKind, () => { name: string; title: string }> = {
  highpass: () => ({ name: t.inspector.effectHighpass, title: t.inspector.effectHighpassTitle }),
  denoise: () => ({ name: t.inspector.effectDenoise, title: t.inspector.effectDenoiseTitle }),
  compressor: () => ({ name: t.inspector.effectCompressor, title: t.inspector.effectCompressorTitle }),
};

/**
 * A media clip's voice chain (ADR 0031): a switch that sets the style's voice chain or bypasses the chain, and
 * while there is one, each effect in processing order with its numbers, a move-earlier and a remove button, and a
 * menu to add a kind the chain lacks. Every change writes the whole list through `clip.set audioEffects`; a bypassed
 * chain comes back from this window's memory (`bypass`), the saved clip holds no flag.
 */
export function VoiceControl({
  clip,
  effects,
  onSend,
  onError,
}: {
  clip: string;
  effects: readonly NormalizedAudioEffect[];
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
  onError: (message: string) => void;
}) {
  const write = (list: readonly NormalizedAudioEffect[] | null, label: string) =>
    onSend({ op: "clip.set", args: { clip, audioEffects: list ? [...list] : null } }, { label });
  const styleChain = (label: string) =>
    projectStyle().then(
      (style) => write(voiceChainOf(style.sound.voice), label),
      (failure: unknown) => onError((failure as Error).message),
    );
  const on = effects.length > 0;
  const addable = missingKinds(effects);
  return (
    <div className="clip-inspector-group voice-chain" role="group" aria-label={t.inspector.voice}>
      <span className="voice-chain-head">
        <button
          className={`clip-inspector-button clip-inspector-switch${on ? " on" : ""}`}
          aria-pressed={on}
          data-tip={on ? t.inspector.voiceOffTitle : t.inspector.voiceOnTitle}
          onClick={() => {
            if (on) {
              bypass.keep(clip, effects);
              write(null, "Bypass voice chain");
              return;
            }
            const kept = bypass.recall(clip);
            if (kept) write(kept, "Add voice chain");
            else void styleChain("Add voice chain");
          }}
        >
          {t.inspector.voice}
        </button>
        {on && (
          <>
            <button className="clip-inspector-button" data-tip={t.inspector.voicePresetTitle} onClick={() => void styleChain("Set voice chain")}>
              {t.inspector.voicePreset}
            </button>
            {addable.length > 0 && (
              <select
                className="clip-field-select"
                aria-label={t.inspector.voiceAdd}
                value=""
                onChange={(event) => write(withEffect(effects, event.target.value as EffectKind), "Add voice effect")}
              >
                <option value="">{t.inspector.voiceAddNone}</option>
                {addable.map((kind) => (
                  <option key={kind} value={kind}>
                    {EFFECT_NAMES[kind]().name}
                  </option>
                ))}
              </select>
            )}
            <span className="clip-inspector-hint">{t.inspector.voiceHint}</span>
          </>
        )}
      </span>
      {effects.map((effect, index) => {
        const { name, title } = EFFECT_NAMES[effect.kind]();
        return (
          <span key={`${effect.kind}-${index}`} className="voice-effect" data-effect={effect.kind}>
            <span className="key-control-label voice-effect-name" data-tip={title}>
              {name}
            </span>
            {EFFECT_PARAMS[effect.kind].map((param) => (
              <NumberField
                key={param}
                name={param}
                stored={paramOf(effect, param)!}
                onCommit={(value) => {
                  const next = withParam(effects, index, param, value);
                  if (next) write(next, "Change voice effect");
                }}
              />
            ))}
            {index > 0 && (
              <button
                className="clip-inspector-button"
                aria-label={t.inspector.voiceEarlier(name)}
                data-tip={t.inspector.voiceEarlier(name)}
                onClick={() => write(movedEarlier(effects, index), "Reorder voice effects")}
              >
                ↑
              </button>
            )}
            <button
              className="clip-inspector-button"
              aria-label={t.inspector.voiceRemove(name)}
              data-tip={t.inspector.voiceRemove(name)}
              onClick={() => write(withoutEffect(effects, index), "Remove voice effect")}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
