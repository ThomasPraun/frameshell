import { SUBTITLE_POSITIONS, type SubtitlePosition, type SubtitlePresetId, resolveSubtitleStyle } from "@frameshell/schema/subtitles";
import { useEffect, useMemo, useState } from "react";
import type { TimelineEdit } from "../../../shared/api.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { useSubtitles } from "../subtitles/useSubtitles.js";
import { layoutTimeline } from "../timeline/layout.js";
import { useTimelineView } from "../timeline/useTimelineView.js";
import { sendClipEdit } from "./clip-edits.js";

/** Preset names as the user reads them. */
const PRESET_LABELS: Record<SubtitlePresetId, { label: string; title: string }> = {
  "big-keyword": { label: "Big keyword", title: "A few large words, the spoken one highlighted" },
  plain: { label: "Plain", title: "Sentence-length lines, no highlight" },
};

const POSITION_LABELS: Record<SubtitlePosition, string> = { top: "Top", center: "Center", bottom: "Bottom" };

/**
 * Settings of the selected subtitle track (SPEC §5.3): the track whose words
 * it shows, its style preset and position. Each change is one `track.set` by
 * `ui`, saved at once and undoable from the timeline; the preview and export
 * both follow it.
 */
export function SubtitleInspector({ track }: { track: string }) {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const layout = useMemo(() => (view ? layoutTimeline(view) : null), [view]);
  const { tracks } = useSubtitles();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [track]);

  const row = layout?.rows.find((candidate) => candidate.id === track);
  const stored = view?.tracks.find((candidate) => candidate.id === track);
  if (!row || !stored || stored.kind !== "subtitles" || !layout) return null;
  const { style } = resolveSubtitleStyle(stored.style);
  const missing = tracks.find((candidate) => candidate.track === track)?.missing ?? [];
  const send = (args: Extract<TimelineEdit, { op: "track.set" }>["args"]) => {
    setError(null);
    sendClipEdit({ op: "track.set", args }).catch((failure: unknown) => setError((failure as Error).message));
  };
  const sources = layout.rows.filter((candidate) => candidate.kind !== "subtitles");

  return (
    <div className="clip-inspector subtitle-inspector" role="group" aria-label={`Settings of subtitle track ${row.label}`} data-track={track}>
      <span className="clip-inspector-name" title={track}>
        <span className="clip-inspector-track track-subtitles">{row.label}</span>
        {row.name ?? "Subtitles"}
      </span>
      <label className="clip-field" title="Track whose clips' transcript words show">
        <span className="clip-field-label is-static">Words of</span>
        <select className="clip-field-select" aria-label="Words of" value={stored.follows ?? ""} onChange={(event) => send({ track, follows: event.target.value })}>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name ? `${source.label} ${source.name}` : source.label}
            </option>
          ))}
        </select>
      </label>
      <Choice
        label="Style"
        options={Object.entries(PRESET_LABELS).map(([id, { label, title }]) => ({ id, label, title }))}
        value={style.preset}
        onPick={(preset) => send({ track, style: { preset: preset as SubtitlePresetId } })}
      />
      <Choice
        label="Position"
        options={SUBTITLE_POSITIONS.map((id) => ({ id, label: POSITION_LABELS[id], title: `Show the words at the ${id === "center" ? "center" : id} of the frame` }))}
        value={style.position}
        onPick={(position) => send({ track, style: { position: position as SubtitlePosition } })}
      />
      {missing.length > 0 && (
        <span className="clip-inspector-hint" title={missing.join("\n")}>
          {`No transcript for ${missing.length === 1 ? missing[0] : `${missing.length} clips' assets`}: run frameshell transcribe`}
        </span>
      )}
      {error && (
        <span className="clip-inspector-error" role="status" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

/** Segmented single choice: the current value pressed, a click saves another. */
function Choice({
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
