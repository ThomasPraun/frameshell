import type { AssetInfo } from "@frameshell/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AngleTile, programRows, turnsKey, viewerModel, viewerRow } from "../angles/model.js";
import { useTurns } from "../angles/useTurns.js";
import { t } from "../i18n.js";
import { useAssets } from "../preview/useProgram.js";
import { useTransport } from "../preview/transport.js";
import { SELECTION_TIMELINE } from "../selection.js";
import { cutToAngle } from "../timeline/angle-cut.js";
import { useTranscripts } from "../transcript/useTranscripts.js";
import { useTimelineView } from "../timeline/useTimelineView.js";

/** While playing, an angle's video is put back on the playhead when it is this far off, s. */
const DRIFT_MAX = 0.3;
/** While paused, a video already this close to the playhead is left alone, s: under one frame at any usual rate. */
const SEEK_EPSILON = 0.015;

/**
 * Multicam viewer (#243, ADR 0016 decision 5): every angle of the program track's group in a grid, at the
 * playhead. The angles the current shot shows are outlined, the angles speaking now are marked; a click cuts to
 * the angle as its number key does, Shift+click adds it to the shot. Each angle plays its low-res proxy in a muted
 * `<video>` kept on the playhead (one decoder per angle, only while the viewer is shown), so it works in a
 * detached window as in the sidebar (ADR 0012) without sharing the preview's engine.
 */
export function AngleViewer({ mediaUrl }: { mediaUrl: string }) {
  const { view } = useTimelineView(SELECTION_TIMELINE);
  const { time, playing } = useTransport();
  const assets = useAssets(view?.revision ?? null);
  const rows = useMemo(() => (view ? programRows(view) : []), [view]);
  const groupId = view ? (viewerRow(rows, view.fps, time)?.group ?? null) : null;
  const group = view?.groups?.find((candidate) => candidate.id === groupId);
  const { sources, hashes } = useTranscripts();
  const key = useMemo(() => (group ? turnsKey(group.angles, sources, hashes, group.mics, group.painted) : null), [group, sources, hashes]);
  const { turns, error: turnsError } = useTurns(groupId, key);
  const [notice, setNotice] = useState<string | null>(null);

  const model = useMemo(
    () => (view ? viewerModel(rows, view.groups, view.fps, time, turns) : null),
    [rows, view, time, turns],
  );
  if (!view || !model) return <p className="empty">{t.angles.noGroup}</p>;

  const cut = (tile: AngleTile, additive: boolean) => {
    setNotice(null);
    void cutToAngle(tile.number, additive).then(
      (outcome) => {
        if (outcome.kind === "no-shot") setNotice(t.angles.noGap);
        else if (outcome.kind === "no-angle") setNotice(t.workspace.angleNoAngle(outcome.number, outcome.count));
      },
      (error: Error) => setNotice(error.message),
    );
  };

  return (
    <div className="angle-viewer" data-testid="angle-viewer" data-decoders={model.tiles.filter((tile) => proxyOf(assets, tile)).length}>
      <p className="angle-hint">{t.angles.hint}</p>
      <div className="angle-grid" role="group" aria-label={t.angles.grid}>
        {model.tiles.map((tile) => (
          <AngleTileView key={tile.id} tile={tile} asset={assets?.get(tile.asset)} mediaUrl={mediaUrl} playing={playing} onCut={cut} />
        ))}
      </div>
      {(notice ?? (turnsError ? t.angles.turnsFailed(turnsError) : null)) && (
        <p className="angle-notice" role="status">
          {notice ?? t.angles.turnsFailed(turnsError!)}
        </p>
      )}
    </div>
  );
}

/** Project-relative proxy of the angle's asset once it has one. */
function proxyOf(assets: ReadonlyMap<string, AssetInfo> | null, tile: AngleTile): string | null {
  return assets?.get(tile.asset)?.proxy ?? null;
}

/** Ingest failed, or finished with no picture (audio-only): the tile will never get a video. */
function noPicture(asset: AssetInfo | undefined): boolean {
  return asset?.state === "failed" || (asset?.state === "ready" && !asset.proxy);
}

function AngleTileView({
  tile,
  asset,
  mediaUrl,
  playing,
  onCut,
}: {
  tile: AngleTile;
  asset: AssetInfo | undefined;
  mediaUrl: string;
  playing: boolean;
  onCut: (tile: AngleTile, additive: boolean) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const proxy = asset?.proxy ?? null;
  const src = proxy ? mediaUrl + proxy.split("/").map(encodeURIComponent).join("/") : null;

  // Keep the angle's picture on the playhead: seek while paused, play along and fix drift while playing.
  useEffect(() => {
    const element = video.current;
    if (!element || !src) return;
    element.muted = true;
    if (playing) {
      if (Math.abs(element.currentTime - tile.sourceTime) > DRIFT_MAX) element.currentTime = tile.sourceTime;
      if (element.paused) void element.play().catch(() => undefined);
    } else {
      if (!element.paused) element.pause();
      if (Math.abs(element.currentTime - tile.sourceTime) > SEEK_EPSILON) element.currentTime = tile.sourceTime;
    }
  }, [src, tile.sourceTime, playing]);

  return (
    <button
      className={`angle-tile${tile.inShot ? " is-in-shot" : ""}${tile.speaking ? " is-speaking" : ""}`}
      style={{ "--angle-color": `var(--angle-${tile.color + 1})` } as React.CSSProperties}
      data-testid="angle-tile"
      data-angle={tile.id}
      data-number={tile.number}
      data-in-shot={tile.inShot}
      data-speaking={tile.speaking}
      aria-label={t.angles.tile(tile.number, tile.name)}
      title={tile.inShot ? t.angles.inShot : undefined}
      aria-pressed={tile.inShot}
      // A mouse press must not focus the tile: Space/Enter would then re-activate it (cut) instead of playing.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => onCut(tile, event.shiftKey)}
    >
      {src ? (
        <video
          ref={video}
          src={src}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          // Chromium's `object-view-box` shows only the crop, still letterboxed by `object-fit: contain`; React's CSS types lack it.
          style={tile.viewBox ? ({ objectViewBox: tile.viewBox } as React.CSSProperties) : undefined}
        />
      ) : <span className="angle-empty">{noPicture(asset) ? t.angles.unavailable : t.angles.preparing}</span>}
      <span className="angle-label">
        <span className="angle-number">{tile.number}</span>
        <span className="angle-name">{tile.name}</span>
        {tile.speaking && (
          <span className="angle-speaking" title={t.angles.speaking} role="img" aria-label={t.angles.speaking} />
        )}
      </span>
    </button>
  );
}
