import type { ClipRenderInfo } from "@frameshell/protocol";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { openInEditor, useCanOpenInEditor } from "../editor-opener.js";
import { generatedStatus } from "../generated-status.js";
import { t } from "../i18n.js";

/**
 * The top of a generated clip's inspector (#746): its plugin type and render state (live, with the whole error of a
 * failed render and where to trust the plugins), its composition with Open, and motion blur (ADR 0041) as a switch
 * that writes `motionBlur: {}` or removes it, with the blurred render's state while it has one.
 */
export function GeneratedControl({
  clip,
  type,
  source,
  render,
  motionBlur,
  onSend,
}: {
  clip: string;
  /** Adapter clip type, e.g. `hyperframes`. */
  type: string;
  /** Project-relative composition entry; null when the clip has none. */
  source: string | null;
  /** The clip's `clip.renders` entry; undefined until known. */
  render: ClipRenderInfo | undefined;
  /** True when the clip stores `motionBlur`. */
  motionBlur: boolean;
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
}) {
  const status = generatedStatus(render);
  const canOpen = useCanOpenInEditor();
  const states = t.inspector.generatedStates;
  const stateText = status.state === "rendering" ? states.rendering(status.percent) : states[status.state];
  const blur = status.blur;
  const blurText = blur ? (blur.state === "rendering" ? t.inspector.blurStates.rendering(blur.percent) : t.inspector.blurStates[blur.state]) : null;
  return (
    <div className="clip-inspector-group generated-control" role="group" aria-label={t.inspector.generated} data-testid="generated-control">
      <span className="colour-grade-head">
        <span className="key-control-label">{t.inspector.generated}</span>
        <code className="generated-type">{type}</code>
        <span className="generated-state" role="status" data-state={status.state} data-testid="generated-state">
          {stateText}
        </span>
      </span>
      {status.error && (
        <p className="generated-error" data-testid="generated-error">
          {status.untrusted ? t.inspector.untrustedHint : status.error}
          {!status.untrusted && <span className="clip-inspector-hint">{` ${t.inspector.renderRetryHint}`}</span>}
        </p>
      )}
      {source && (
        <span className="clip-field generated-source">
          <span className="clip-field-label is-static">{t.inspector.composition}</span>
          <code className="generated-path">{source}</code>
          {canOpen && (
            <button className="clip-inspector-button" data-tip={t.inspector.openCompositionTitle} onClick={() => openInEditor(source)}>
              {t.inspector.openComposition}
            </button>
          )}
        </span>
      )}
      <span className="generated-blur">
        <button
          className={`clip-inspector-button${motionBlur ? " on" : ""}`}
          aria-pressed={motionBlur}
          data-tip={motionBlur ? t.inspector.motionBlurOffTitle : t.inspector.motionBlurOnTitle}
          onClick={() =>
            onSend({ op: "clip.set", args: { clip, motionBlur: motionBlur ? null : {} } }, { label: motionBlur ? "Remove motion blur" : "Add motion blur" })
          }
        >
          {t.inspector.motionBlur}
        </button>
        {motionBlur && blurText && (
          <span className="clip-inspector-hint" data-testid="generated-blur-state" data-state={blur!.state}>
            {blurText}
          </span>
        )}
      </span>
    </div>
  );
}
