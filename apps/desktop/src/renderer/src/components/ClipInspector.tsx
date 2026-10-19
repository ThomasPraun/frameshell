import { useEffect, useMemo, useState } from "react";
import type { TimelineEdit } from "../../../shared/api.js";
import { SELECTION_TIMELINE, useSelection } from "../selection.js";
import { type ClipBox, type TrackRow, layoutTimeline } from "../timeline/layout.js";
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
      <div className="clip-inspector is-empty" role="group" aria-label={t.inspector.clipSettings}>
        <span>{clips.length > 1 ? t.inspector.clipsSelected(clips.length) : t.inspector.selectClip}</span>
      </div>
    );
  }
  const { row, clip } = target;
  if (clip.shot && view) return <ShotInspector row={row} clip={clip} shot={clip.shot} view={view} />;
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
    <div className="clip-inspector" role="group" aria-label={t.inspector.settingsOfClip(clip.name)} data-clip={clip.id}>
      <span className="clip-inspector-name" title={t.inspector.clipOnTrack(clip.id, row.label)}>
        <span className={`clip-inspector-track track-${row.kind}`}>{row.label}</span>
        {clip.name}
      </span>
      {placed && (
        <div className="clip-inspector-group" role="group" aria-label={t.inspector.placement}>
          {(["x", "y", "scale", "opacity"] as const).map((name) => (
            <NumberField key={name} name={name} stored={transform[name]} onCommit={(value) => setTransform(name, value)} />
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
          <NumberField name="gain" stored={clip.gain} disabled={clip.muted} onCommit={(value) => send({ op: "clip.set", args: { clip: clip.id, gain: value } })} />
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
