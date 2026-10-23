import type { ClipKey, ElementAdjust } from "@frameshell/schema";
import { keyedValueAt } from "@frameshell/schema/composite";
import { useEffect, useMemo, useState } from "react";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { askAgent } from "../ask/ask-agent.js";
import { filled, fragileSelector, idRequest } from "../preview/element-edit.js";
import { useElementMode } from "../preview/element-mode.js";
import { useTransport } from "../preview/transport.js";
import { useProjectKind } from "../preview/useProgram.js";
import { SELECTION_TIMELINE, useSelection } from "../selection.js";
import { type ClipBox, type TrackRow, layoutTimeline } from "../timeline/layout.js";
import { type EdgeState, KEY_PROPS, type KeyBox, type KeyProp, clipClock, edgeState, keyAt } from "../timeline/transitions.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { t } from "../i18n.js";
import { sendClipEdit } from "./clip-edits.js";
import { NumberField } from "./inspector-fields.js";
import { ShotInspector } from "./ShotInspector.js";

/**
 * Settings of the one selected clip (SPEC §10): placement on video tracks
 * (position, scale, opacity) and sound of media clips (gain, mute); a
 * shot's layout and angles in {@link ShotInspector}. Each
 * change is one `clip.set` by `ui`, saved at once and undoable from the
 * timeline; values shown are the saved ones, from the shared timeline feed.
 * Video projects add the clip's edge transitions and keyframes (ADR 0018):
 * a keyed property shows its value at the playhead, and editing it keys it there.
 * A generated clip lists its element adjustments (ADR 0021) while it has any
 * or the preview edits its elements.
 */
export function ClipInspector() {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const { clips } = useSelection();
  const { time: playhead, fps } = useTransport();
  const image = useProjectKind() === "image";
  const mode = useElementMode();
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const [error, setError] = useState<string | null>(null);
  const target = clips.length === 1 && layout ? find(layout.rows, clips[0]!) : null;

  useEffect(() => setError(null), [target?.clip.id]);

  if (!target) {
    return (
      <div className="clip-inspector is-empty" role="group" aria-label={t.inspector.clipSettings}>
        <span>{clips.length > 1 ? t.inspector.clipsSelected(clips.length) : t.inspector.selectClip}</span>
      </div>
    );
  }
  const { row, clip } = target;
  if (clip.shot && view) return <ShotInspector row={row} clip={clip} shot={clip.shot} view={view} />;
  const send = (edit: TimelineEdit, options?: EditOptions) => {
    setError(null);
    sendClipEdit(edit, options).catch((failure: unknown) => setError((failure as Error).message));
  };
  const transform = clip.transform ?? { x: 0, y: 0, scale: 1, opacity: 1 };
  // A keyed property follows its keys, so an entry there keys it at the playhead instead of changing the unused static value.
  const keyed = (prop: KeyProp) => keyedValueAt(clip.keys[prop] as ClipKey[] | undefined, clipClock(clip, playhead));
  const setKeyed = (prop: KeyProp, value: number) => send({ op: "clip.key", args: { clip: clip.id, prop, time: playhead, value } }, { label: "Change keyframe" });
  const setTransform = (name: "x" | "y" | "scale" | "opacity", value: number) =>
    clip.keys[name] ? setKeyed(name, value) : send({ op: "clip.set", args: { clip: clip.id, transform: { [name]: value } } });
  const placed = row.kind === "video";
  // An image project has no sound (ADR 0017).
  const audible = clip.kind === "media" && !image;
  const moved = transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.opacity !== 1;

  return (
    <div className="clip-inspector" role="group" aria-label={t.inspector.settingsOfClip(clip.name)} data-clip={clip.id}>
      <span className="clip-inspector-name" title={t.inspector.clipOnTrack(clip.id, row.label)}>
        <span className={`clip-inspector-track track-${row.kind}`}>{row.label}</span>
        {clip.name}
      </span>
      {placed && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.placement}>
          {(["x", "y", "scale", "opacity"] as const).map((name) => (
            <NumberField key={name} name={name} stored={keyed(name) ?? transform[name]} onCommit={(value) => setTransform(name, value)} />
          ))}
          <button
            className="clip-inspector-button"
            disabled={!moved}
            title={t.inspector.resetTitle}
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, transform: { x: 0, y: 0, scale: 1, opacity: 1 } } })}
          >
            {t.inspector.reset}
          </button>
          {clip.type === "media" && (
            <button
              className="clip-inspector-button clip-inspector-replace"
              title={t.inspector.replaceImageTitle}
              onClick={() => {
                setError(null);
                window.frameshell.timeline.replaceImage(SELECTION_TIMELINE, clip.id).catch((failure: unknown) => setError((failure as Error).message));
              }}
            >
              {t.inspector.replaceImage}
            </button>
          )}
        </div>
      )}
      {audible && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.sound}>
          <NumberField
            name="gain"
            stored={keyed("gain") ?? clip.gain}
            disabled={clip.muted}
            onCommit={(value) => (clip.keys.gain ? setKeyed("gain", value) : send({ op: "clip.set", args: { clip: clip.id, gain: value } }))}
          />
          <button
            className={`clip-inspector-button clip-inspector-mute${clip.muted ? " on" : ""}`}
            aria-pressed={clip.muted}
            title={clip.muted ? t.inspector.unmuteTitle : t.inspector.muteTitle}
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, muted: !clip.muted } })}
          >
            {t.inspector.mute}
          </button>
        </div>
      )}
      {!image && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.transitions}>
          {(["in", "out"] as const).map((side) => (
            <TransitionEdge key={side} side={side} state={edgeState(row, clip, side)} onSend={send} />
          ))}
        </div>
      )}
      {!image && (placed || audible) && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.keyframes}>
          {KEY_PROPS.filter((prop) => (prop === "gain" ? audible : placed)).map((prop) => (
            <KeyControl
              key={prop}
              prop={prop}
              keyed={clip.keys[prop] !== undefined}
              atKey={keyAt(clip, clip.keys[prop], playhead, fps)}
              outside={playhead < clip.start || playhead > clip.end}
              onSend={(args, label) => send({ op: "clip.key", args: { clip: clip.id, prop, time: playhead, ...args } }, { label })}
            />
          ))}
        </div>
      )}
      {clip.kind === "generated" && (mode.clip === clip.id || Object.keys(clip.elements).length > 0) && (
        <ElementAdjustments
          clip={clip.id}
          elements={clip.elements}
          editing={mode.clip === clip.id}
          counts={mode.clip === clip.id ? mode.counts : null}
          onSend={send}
        />
      )}
      {!placed && !audible && <span className="clip-inspector-hint">{t.inspector.nothingToAdjust}</span>}
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

const EDGE_LABELS = { in: () => t.inspector.transitionStart, out: () => t.inspector.transitionEnd };
const PROP_LABELS: Record<KeyProp, () => string> = {
  x: () => t.inspector.fieldX,
  y: () => t.inspector.fieldY,
  scale: () => t.inspector.fieldScale,
  opacity: () => t.inspector.fieldOpacity,
  gain: () => t.inspector.fieldGain,
};
/** Seconds a new transition plays over (the daemon's default). */
const DEFAULT_TRANSITION_S = 0.5;

/**
 * One edge's transition: kind (none, dissolve, fade; a dissolve needs a cut) and length. The daemon applies it to
 * every video and audio track with an edge at that time, as `transition.set` does without `tracks`.
 */
function TransitionEdge({ side, state, onSend }: { side: "in" | "out"; state: EdgeState; onSend: (edit: TimelineEdit, options: EditOptions) => void }) {
  const edge = EDGE_LABELS[side]();
  const kinds = [
    { id: "none", label: t.inspector.transitionNone },
    ...(state.butted || state.kind === "dissolve" ? [{ id: "dissolve", label: t.inspector.transitionDissolve }] : []),
    { id: "fade", label: t.inspector.transitionFade },
  ];
  const set = (kind: "dissolve" | "fade", duration: number, label: string) => onSend({ op: "transition.set", args: { at: state.at, kind, duration } }, { label });
  return (
    <span className="transition-edge" data-edge={side}>
      <select
        className="clip-field-select"
        aria-label={t.inspector.transitionEdge(edge)}
        title={t.inspector.transitionEdgeTitle(edge)}
        value={state.kind ?? "none"}
        onChange={(event) => {
          const kind = event.target.value;
          if (kind === "none") onSend({ op: "transition.remove", args: { at: state.at } }, { label: "Remove transition" });
          else set(kind as "dissolve" | "fade", state.length > 0 ? state.length : DEFAULT_TRANSITION_S, kind === "dissolve" ? "Add dissolve" : "Add fade");
        }}
      >
        {kinds.map((kind) => (
          <option key={kind.id} value={kind.id}>{`${edge}: ${kind.label}`}</option>
        ))}
      </select>
      {state.kind && <NumberField name="length" stored={state.length} onCommit={(value) => set(state.kind!, value, "Change transition length")} />}
    </span>
  );
}

/**
 * One property's keyframe at the playhead: a diamond that adds one there (value: what plays now) or, when there is
 * one, removes it, and the ease the value leaves it by. The diamond is outlined once the property has any key.
 */
function KeyControl({
  prop,
  keyed,
  atKey,
  outside,
  onSend,
}: {
  prop: KeyProp;
  keyed: boolean;
  atKey: KeyBox | null;
  outside: boolean;
  onSend: (args: { ease?: KeyBox["ease"]; remove?: boolean }, label: string) => void;
}) {
  const label = PROP_LABELS[prop]();
  const name = label.toLowerCase();
  return (
    <span className={`key-control${keyed ? " is-keyed" : ""}`} data-prop={prop}>
      <span className="key-control-label">{label}</span>
      <button
        className={`clip-inspector-button key-button${atKey ? " on" : ""}`}
        aria-pressed={atKey !== null}
        aria-label={atKey ? t.inspector.keyRemove(name) : t.inspector.keyAdd(name)}
        title={atKey ? t.inspector.keyRemove(name) : t.inspector.keyAdd(name)}
        disabled={outside && !atKey}
        onClick={() => (atKey ? onSend({ remove: true }, "Remove keyframe") : onSend({}, "Add keyframe"))}
      >
        <svg viewBox="0 0 10 10" aria-hidden="true">
          <path d="M5 1 9 5 5 9 1 5Z" fill={atKey ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      {atKey && (
        <select
          className="clip-field-select"
          aria-label={t.inspector.keyEase(name)}
          title={t.inspector.keyEaseTitle}
          value={atKey.ease ?? "linear"}
          onChange={(event) => onSend({ ease: event.target.value as KeyBox["ease"] }, "Change keyframe")}
        >
          {Object.entries(t.inspector.keyEases).map(([id, text]) => (
            <option key={id} value={id}>
              {text}
            </option>
          ))}
        </select>
      )}
    </span>
  );
}

/**
 * A generated clip's element adjustments (ADR 0021), one row each: selector,
 * move and scale, a reset, and notes for a selector that may not follow code
 * edits (with Ask agent for an id) or that matches nothing at the shown frame
 * (`counts`, from the clip's live page while its elements are edited).
 */
function ElementAdjustments({
  clip,
  elements,
  editing,
  counts,
  onSend,
}: {
  clip: string;
  elements: Readonly<Record<string, ElementAdjust>>;
  editing: boolean;
  counts: Readonly<Record<string, number>> | null;
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
}) {
  const entries = Object.entries(elements).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    <div className="clip-inspector-group element-adjustments" role="group" aria-label={t.inspector.elements}>
      <span className="element-adjustments-head">
        <span className="key-control-label">{t.inspector.elements}</span>
        {editing && <span className="clip-inspector-hint">{t.inspector.elementsEditing}</span>}
        {!editing && <span className="clip-inspector-hint">{t.inspector.elementsHint}</span>}
        {entries.length > 1 && (
          <button
            className="clip-inspector-button"
            title={t.inspector.elementsResetAllTitle}
            onClick={() => onSend({ op: "clip.set", args: { clip, elements: null } }, { label: "Reset elements" })}
          >
            {t.inspector.elementsResetAll}
          </button>
        )}
      </span>
      {entries.map(([selector, stored]) => {
        const { x, y, scale } = filled(stored);
        const unmatched = counts?.[selector] === 0;
        return (
          <span key={selector} className="element-adjustment" data-testid="element-adjustment" data-selector={selector} data-unmatched={unmatched || undefined}>
            <code className="element-selector" title={selector}>
              {selector}
            </code>
            <span className="element-values">{t.inspector.elementValues(x, y, scale)}</span>
            {unmatched && (
              <span className="element-note is-warning" title={t.inspector.elementUnmatchedTitle}>
                {t.inspector.elementUnmatched}
              </span>
            )}
            {fragileSelector(selector) && (
              <>
                <span className="element-note" title={t.inspector.elementFragileTitle}>
                  {t.inspector.elementFragile}
                </span>
                <button className="clip-inspector-button" title={t.inspector.elementAskIdTitle} onClick={() => askAgent.run([idRequest(clip, selector)])}>
                  {t.inspector.elementAskId}
                </button>
              </>
            )}
            <button
              className="clip-inspector-button"
              title={t.inspector.elementResetTitle(selector)}
              aria-label={t.inspector.elementResetTitle(selector)}
              onClick={() => onSend({ op: "clip.set", args: { clip, elements: { [selector]: null } } }, { label: "Reset element" })}
            >
              {t.inspector.reset}
            </button>
          </span>
        );
      })}
    </div>
  );
}
