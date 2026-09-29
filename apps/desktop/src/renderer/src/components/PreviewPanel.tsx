import { PanelHeader } from "./PanelHeader.js";

/** Placeholder until the player lands (#15): the program frame with title-safe guides and the playhead timecode. */
export function PreviewPanel() {
  return (
    <>
      <PanelHeader>
        <span className="panel-title">Preview</span>
        <span className="timecode" aria-label="Playhead">
          00:00:00:00
        </span>
      </PanelHeader>
      <div className="preview-stage">
        <div className="preview-frame" role="img" aria-label="Empty program monitor">
          <div className="safe-area action" />
          <div className="safe-area title" />
          <p className="preview-caption">Nothing on the timeline yet</p>
        </div>
      </div>
    </>
  );
}
