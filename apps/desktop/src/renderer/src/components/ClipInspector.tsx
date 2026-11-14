import {
  type Backdrop,
  type ClipFormatOverride,
  type ClipKey,
  DEFAULT_GRID_COLUMNS,
  DEFAULT_SLATS,
  type ElementAdjust,
  TRANSITION_DIRECTIONS,
  TRANSITION_SHAPE_KINDS,
  type TransitionDirection,
  type TransitionShapeKind,
  clipInFormat,
  glassOf,
} from "@frameshell/schema";
import type { TimelineView } from "@frameshell/protocol";
import { type Placement, keyedValueAt } from "@frameshell/schema/composite";
import { BACKDROP_LIMITS } from "@frameshell/schema/effects";
import { useEffect, useMemo, useState } from "react";
import type { EditOptions, TimelineEdit } from "../../../shared/api.js";
import { askAgent } from "../ask/ask-agent.js";
import { filled, fragileSelector, idRequest } from "../preview/element-edit.js";
import { useElementMode } from "../preview/element-mode.js";
import { useTransport } from "../preview/transport.js";
import { useProjectKind } from "../preview/useProgram.js";
import { SELECTION_TIMELINE, useSelection } from "../selection.js";
import { VoiceControl } from "./VoiceControl.js";
import { type ClipBox, type TrackRow, layoutTimeline } from "../timeline/layout.js";
import { type EdgeState, KEY_PROPS, type KeyBox, type KeyProp, clipClock, edgeState, keyAt } from "../timeline/transitions.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { projectStyle } from "../project-style.js";
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
 * A media clip's voice chain (ADR 0031) is edited in {@link VoiceControl}.
 * Video projects add the clip's edge transitions and keyframes (ADR 0018):
 * a keyed property shows its value at the playhead, and editing it keys it there.
 * A generated clip lists its element adjustments (ADR 0021) while it has any
 * or the preview edits its elements.
 * With `format` (the preview shows a format other than the primary, ADR 0027)
 * placement and keys show and set the clip in that format, which it can also
 * be hidden in or set back to the primary; sound and transitions are shared.
 * `fillOf` gives the placement that fills the format's frame for footage
 * covering it, which has no placement of its own there yet.
 */
export function ClipInspector({ format = null, fillOf = null }: { format?: string | null; fillOf?: ((clip: string) => Placement | null) | null }) {
  const { view: stored } = useTimelineView(SELECTION_TIMELINE);
  const { clips } = useSelection();
  const { time: playhead, fps } = useTransport();
  const image = useProjectKind() === "image";
  const mode = useElementMode();
  const view = useMemo(() => (stored && format ? clipsInFormat(stored, format) : stored), [stored, format]);
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
  // Covering footage shows, and its first edit stores, the whole placement that fills the frame: one field alone
  // would make it a placed clip, fitted (letterboxed) with that one value.
  const fill = format !== null && fillOf ? fillOf(clip.id) : null;
  const transform = fill ?? clip.transform ?? { x: 0, y: 0, scale: 1, opacity: 1 };
  // Placement and picture keys go to the format shown; gain and everything else is every format's.
  const inFormat = (prop: KeyProp) => (format !== null && prop !== "gain" ? { format } : {});
  // A keyed property follows its keys, so an entry there keys it at the playhead instead of changing the unused static value.
  const keyed = (prop: KeyProp) => keyedValueAt(clip.keys[prop] as ClipKey[] | undefined, clipClock(clip, playhead));
  const setKeyed = (prop: KeyProp, value: number) =>
    send({ op: "clip.key", args: { clip: clip.id, prop, time: playhead, value, ...inFormat(prop) } }, { label: "Change keyframe" });
  const setTransform = (name: "x" | "y" | "scale" | "opacity", value: number) =>
    clip.keys[name] ? setKeyed(name, value) : send({ op: "clip.set", args: { clip: clip.id, transform: { ...fill, [name]: value }, ...inFormat(name) } });
  const placed = row.kind === "video";
  const override = format !== null ? storedOverride(stored, clip.id, format) : null;
  // An image project has no sound (ADR 0017).
  const audible = clip.kind === "media" && !image;
  const moved = fill === null && (transform.x !== 0 || transform.y !== 0 || transform.scale !== 1 || transform.opacity !== 1);

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
            data-tip={t.inspector.resetTitle}
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, transform: { x: 0, y: 0, scale: 1, opacity: 1 }, ...inFormat("x") } })}
          >
            {t.inspector.reset}
          </button>
          {format !== null && !clip.id.includes("/") && (
            <>
              <span className="clip-inspector-format" data-testid="inspector-format" data-tip={t.inspector.inFormatTitle(format)}>
                {t.inspector.inFormat(format)}
              </span>
              <button
                className={`clip-inspector-button${override?.hidden === true ? " on" : ""}`}
                aria-pressed={override?.hidden === true}
                data-testid="inspector-hide-in-format"
                data-tip={t.inspector.hideInFormatTitle(format)}
                onClick={() => send({ op: "clip.set", args: { clip: clip.id, format, hidden: override?.hidden !== true } })}
              >
                {t.inspector.hideInFormat(format)}
              </button>
              <button
                className="clip-inspector-button"
                disabled={override === null}
                data-testid="inspector-use-primary"
                data-tip={t.inspector.usePrimaryTitle(format)}
                onClick={() => send({ op: "clip.set", args: { clip: clip.id, format, reset: true } })}
              >
                {t.inspector.usePrimary}
              </button>
            </>
          )}
          {clip.type === "media" && (
            <button
              className="clip-inspector-button clip-inspector-replace"
              data-tip={t.inspector.replaceImageTitle}
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
            data-tip={clip.muted ? t.inspector.unmuteTitle : t.inspector.muteTitle}
            onClick={() => send({ op: "clip.set", args: { clip: clip.id, muted: !clip.muted } })}
          >
            {t.inspector.mute}
          </button>
        </div>
      )}
      {audible && <VoiceControl clip={clip.id} effects={clip.audioEffects} onSend={send} onError={setError} />}
      {!image && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.transitions}>
          {(["in", "out"] as const).map((side) => (
            <TransitionEdge key={side} side={side} row={row} state={edgeState(row, clip, side)} onSend={send} />
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
              onSend={(args, label) => send({ op: "clip.key", args: { clip: clip.id, prop, time: playhead, ...args, ...inFormat(prop) } }, { label })}
            />
          ))}
        </div>
      )}
      {clip.kind === "generated" && placed && !image && <GlassControl clip={clip.id} backdrop={clip.backdrop} onSend={send} onError={setError} />}
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

/** `view` with every clip as it shows in `format` (`clipInFormat`); hidden clips keep their own opacity, unlike in the preview. */
function clipsInFormat(view: TimelineView, format: string): TimelineView {
  return { ...view, tracks: view.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clipInFormat(clip, format)) })) };
}

/** Stored override of clip `id` in `format` (ADR 0027); null when it has none there. */
function storedOverride(view: TimelineView | null, id: string, format: string): ClipFormatOverride | null {
  const clip = view?.tracks.flatMap((track) => track.clips).find((candidate) => candidate.id === id);
  const formats = clip?.["formats"] as Record<string, ClipFormatOverride> | undefined;
  return formats?.[format] ?? null;
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

/** What an edge can take, as its menu lists it (ADR 0018, ADR 0030). */
type EdgeChoice = "none" | "dissolve" | TransitionShapeKind | "fade" | "dip-cut";

const SHAPE_LABELS: Record<TransitionShapeKind, () => string> = {
  wipe: () => t.inspector.transitionWipe,
  push: () => t.inspector.transitionPush,
  iris: () => t.inspector.transitionIris,
  zoom: () => t.inspector.transitionZoom,
  slats: () => t.inspector.transitionSlats,
  grid: () => t.inspector.transitionGrid,
};

/**
 * One edge's transition: kind and length, a wipe's, push's or slats' direction and a slats' or grid's count. Where
 * clips meet it can dissolve or take any shape (on video tracks) or, on the bottom video track, dip cut; any edge can
 * fade. The daemon applies it to every video and audio track with an edge at that time, as `transition.set` does
 * without `tracks`. An iris or zoom keeps the `origin` it has (the agent sets it, from `inspect.point`); one chosen
 * here opens from the frame's centre (an iris) or dives into the middle half (a zoom).
 */
function TransitionEdge({
  side,
  row,
  state,
  onSend,
}: {
  side: "in" | "out";
  row: TrackRow;
  state: EdgeState;
  onSend: (edit: TimelineEdit, options: EditOptions) => void;
}) {
  const edge = EDGE_LABELS[side]();
  const cut = state.butted || state.kind === "dissolve";
  const shapes = cut && row.kind === "video" ? TRANSITION_SHAPE_KINDS.map((kind) => ({ id: kind, label: SHAPE_LABELS[kind]() })) : [];
  const kinds: { id: EdgeChoice; label: string }[] = [
    { id: "none", label: t.inspector.transitionNone },
    ...(cut ? [{ id: "dissolve" as const, label: t.inspector.transitionDissolve }] : []),
    ...shapes,
    { id: "fade", label: t.inspector.transitionFade },
    ...((state.butted && row.bottom) || state.kind === "dip-cut" ? [{ id: "dip-cut" as const, label: t.inspector.transitionDipCut }] : []),
  ];
  const length = state.length > 0 ? state.length : DEFAULT_TRANSITION_S;
  const set = (args: Record<string, unknown>, label: string) => onSend({ op: "transition.set", args: { at: state.at, ...args } }, { label });
  const choose = (choice: EdgeChoice) => {
    if (choice === "none") onSend({ op: "transition.remove", args: { at: state.at } }, { label: "Remove transition" });
    else if (choice === "dip-cut") set({ kind: choice }, "Add dip cut");
    else if (choice === "iris" || choice === "zoom" || choice === "grid") set({ kind: choice, duration: length }, `Add ${choice}`);
    else if (choice === "wipe" || choice === "push" || choice === "slats") set({ kind: choice, duration: length, direction: state.shape?.direction ?? "left" }, `Add ${choice}`);
    else set({ kind: choice, duration: length }, choice === "dissolve" ? "Add dissolve" : "Add fade");
  };
  const { shape } = state;
  return (
    <span className="transition-edge" data-edge={side}>
      <select
        className="clip-field-select"
        aria-label={t.inspector.transitionEdge(edge)}
        data-tip={t.inspector.transitionEdgeTitle(edge)}
        value={shape?.kind ?? state.kind ?? "none"}
        onChange={(event) => choose(event.target.value as EdgeChoice)}
      >
        {kinds.map((kind) => (
          <option key={kind.id} value={kind.id}>{`${edge}: ${kind.label}`}</option>
        ))}
      </select>
      {shape && (shape.kind === "wipe" || shape.kind === "push" || shape.kind === "slats") && (
        <select
          className="clip-field-select"
          aria-label={t.inspector.transitionDirection(edge)}
          data-tip={t.inspector.transitionDirectionTitle}
          value={shape.direction ?? "left"}
          onChange={(event) =>
            set({ ...shape, direction: event.target.value as TransitionDirection, duration: state.length }, "Change transition direction")
          }
        >
          {TRANSITION_DIRECTIONS.map((direction) => (
            <option key={direction} value={direction}>
              {t.inspector.transitionDirections[direction]}
            </option>
          ))}
        </select>
      )}
      {shape && (shape.kind === "slats" || shape.kind === "grid") && (
        <NumberField
          name="count"
          stored={shape.count ?? (shape.kind === "slats" ? DEFAULT_SLATS : DEFAULT_GRID_COLUMNS)}
          onCommit={(value) => set({ ...shape, count: value, duration: state.length }, "Change transition count")}
        />
      )}
      {state.kind && state.kind !== "dip-cut" && (
        <NumberField
          name="length"
          stored={state.length}
          onCommit={(value) =>
            // A shaped dissolve keeps its shape (an iris its origin).
            set({ ...(shape ?? { kind: state.kind }), duration: value }, "Change transition length")
          }
        />
      )}
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
        data-tip={atKey ? t.inspector.keyRemove(name) : t.inspector.keyAdd(name)}
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
          data-tip={t.inspector.keyEaseTitle}
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

/** The project's glass numbers (`style.json` `glass`, ADR 0028), the motion kit's without a style file. */
async function styleGlass(): Promise<Required<Backdrop>> {
  return glassOf((await projectStyle()).glass);
}

/**
 * A generated clip's glass (ADR 0031): a switch that sets the style's glass numbers or removes the backdrop, and the
 * three numbers while it has one. Glass is a style choice, never a default: the switch starts off.
 */
function GlassControl({
  clip,
  backdrop,
  onSend,
  onError,
}: {
  clip: string;
  backdrop: Backdrop | null;
  onSend: (edit: TimelineEdit, options?: EditOptions) => void;
  onError: (message: string) => void;
}) {
  const set = (fields: Partial<Backdrop>) => onSend({ op: "clip.set", args: { clip, backdrop: fields } }, { label: "Change glass" });
  return (
    <div className="clip-inspector-group" role="group" aria-label={t.inspector.glass}>
      <button
        className={`clip-inspector-button${backdrop ? " on" : ""}`}
        aria-pressed={backdrop !== null}
        data-tip={backdrop ? t.inspector.glassOffTitle : t.inspector.glassOnTitle}
        onClick={() => {
          if (backdrop) onSend({ op: "clip.set", args: { clip, backdrop: null } }, { label: "Remove glass" });
          else styleGlass().then((glass) => onSend({ op: "clip.set", args: { clip, backdrop: glass } }, { label: "Add glass" }), (failure: unknown) => onError((failure as Error).message));
        }}
      >
        {t.inspector.glass}
      </button>
      {backdrop && (
        <>
          <NumberField name="blur" stored={backdrop.blur} onCommit={(value) => set({ blur: value })} />
          <NumberField name="saturate" stored={backdrop.saturate ?? BACKDROP_LIMITS.saturate.default} onCommit={(value) => set({ saturate: value })} />
          <NumberField name="dim" stored={backdrop.dim ?? BACKDROP_LIMITS.dim.default} onCommit={(value) => set({ dim: value })} />
        </>
      )}
    </div>
  );
}

/**
 * A generated clip's element adjustments (ADR 0021), one row each: selector,
 * move and scale, a reset, and notes for a selector that may not follow code
 * edits (with Chat about this for an id) or that matches nothing at the shown frame
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
            data-tip={t.inspector.elementsResetAllTitle}
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
                <button className="clip-inspector-button" data-tip={t.inspector.elementAskIdTitle} onClick={() => askAgent.run([idRequest(clip, selector)])}>
                  {t.inspector.elementAskId}
                </button>
              </>
            )}
            <button
              className="clip-inspector-button"
              data-tip={t.inspector.elementResetTitle(selector)}
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
