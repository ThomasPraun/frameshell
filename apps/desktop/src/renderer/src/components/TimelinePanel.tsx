import { PanelHeader } from "./PanelHeader.js";

/** Default track stack of a Case B edit (SPEC §10): overlays above picture, then audio and subtitles. */
const TRACKS = [
  { id: "V2", kind: "video", label: "Overlays" },
  { id: "V1", kind: "video", label: "Picture" },
  { id: "A1", kind: "audio", label: "Voice" },
  { id: "S1", kind: "subtitle", label: "Subtitles" },
] as const;

/** Ruler ticks every 5 s over the first minute. */
const TICKS = Array.from({ length: 13 }, (_, i) => i * 5);

/** Placeholder until the canvas timeline lands: empty tracks, ruler and playhead. */
export function TimelinePanel({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <>
      <PanelHeader
        onCollapse={onToggle}
        collapseLabel={collapsed ? "Show timeline" : "Hide timeline"}
        collapseSide={collapsed ? "up" : "down"}
      >
        <span className="panel-title">Timeline</span>
        <span className="panel-meta">main</span>
      </PanelHeader>
      {!collapsed && (
        <div className="timeline-body">
          <div className="timeline-heads">
            <div className="ruler-spacer" />
            {TRACKS.map((track) => (
              <div key={track.id} className={`track-head track-${track.kind}`}>
                <span className="track-id">{track.id}</span>
                <span className="track-label">{track.label}</span>
              </div>
            ))}
          </div>
          <div className="timeline-lanes">
            <div className="ruler" aria-hidden="true">
              {TICKS.map((seconds) => (
                <span key={seconds} className="tick" style={{ left: `${(seconds / 60) * 100}%` }}>
                  {`00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`}
                </span>
              ))}
            </div>
            {TRACKS.map((track) => (
              <div key={track.id} className={`lane lane-${track.kind}`} />
            ))}
            <div className="playhead" aria-hidden="true" />
            <div className="timeline-empty">
              <p>
                Ask the agent in the terminal to cut your footage, or drop media into <code>assets/</code>.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
