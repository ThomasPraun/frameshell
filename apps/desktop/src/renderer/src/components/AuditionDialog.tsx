import type { AssetInfo } from "@frameshell/protocol";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n.js";
import { dbText, matchGains, matchTarget, spectrogramColour } from "../audition/model.js";
import { type AuditionResult, type AuditionState, auditionDialog, playKey } from "../audition/store.js";
import { playVoice, stopVoice, usePlayingVoice } from "../people/voice-play.js";
import { useAssets } from "../preview/useProgram.js";
import { useModal } from "./modal.js";

const said = t.audition;

type Item = AuditionResult["items"][number];

/**
 * The app's Audition dialog (ADR 0038): the sounds side by side, each with play/stop, its spectrogram, its loudness and
 * what made it, and "Match loudness" to hear them at one level. Read-only: "Use this" selects the file. Mount once, in
 * the project window; a dialog opened from a detached panel's window is drawn there through a portal.
 */
export function AuditionDialogHost({ mediaUrl }: { mediaUrl: string }) {
  const state = useSyncExternalStore(auditionDialog.subscribe, auditionDialog.get);
  if (!state) return null;
  const element = <AuditionDialog state={state} mediaUrl={mediaUrl} />;
  return state.view === window ? element : createPortal(element, state.view.document.body);
}

function AuditionDialog({ state, mediaUrl }: { state: AuditionState; mediaUrl: string }) {
  const title = useId();
  const matchId = useId();
  const box = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(box, state.view, () => auditionDialog.close());
  const assets = useAssets(null);
  const [error, setError] = useState<string | null>(null);
  const { read } = state;
  const items = read.kind === "ready" ? read.result.items : [];
  const lufs = items.map((item) => item.lufs);
  const gains = matchGains(lufs, state.match);
  const target = matchTarget(lufs);
  return (
    <div className="voiceover-backdrop audition-backdrop" data-testid="audition-backdrop">
      <div
        ref={box}
        className="voiceover-dialog audition-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        data-testid="audition-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={title} className="voiceover-title">
          {said.title(state.files.length)}
        </h2>
        {read.kind === "reading" && <p className="voiceover-note">{said.reading}</p>}
        {read.kind === "failed" && (
          <section className="voiceover-section" role="alert" data-testid="audition-failed">
            <h3 className="voiceover-heading">{said.failed}</h3>
            <p className="voiceover-error">{read.message}</p>
          </section>
        )}
        {read.kind === "ready" && (
          <>
            <div className="audition-match">
              <label htmlFor={matchId} className="voiceover-check">
                <input
                  id={matchId}
                  type="checkbox"
                  data-testid="audition-match"
                  checked={state.match}
                  disabled={target === null}
                  onChange={(event) => auditionDialog.setMatch(event.target.checked)}
                />
                {said.matchLabel}
              </label>
              <p className="voiceover-hint" data-testid="audition-match-note">
                {target === null ? said.matchNone : state.match ? said.matchOn(dbText(target)) : said.matchOff}
              </p>
            </div>
            <ul className="audition-rows">
              {items.map((item, index) => (
                <Row key={item.asset} item={item} gain={gains[index]!} matched={state.match} asset={assets?.get(item.asset)} mediaUrl={mediaUrl} onFailed={setError} />
              ))}
            </ul>
            {read.result.skipped.length > 0 && (
              <ul className="voiceover-warnings" data-testid="audition-skipped">
                {read.result.skipped.map((skip) => (
                  <li key={skip.asset}>{said.skipped(nameOf(skip.asset), skip.reason)}</li>
                ))}
              </ul>
            )}
          </>
        )}
        {error && (
          <p className="voiceover-error" role="alert">
            {error}
          </p>
        )}
        <div className="voiceover-actions">
          <button className="button" data-testid="audition-close" onClick={() => auditionDialog.close()}>
            {said.close}
          </button>
        </div>
      </div>
    </div>
  );
}

const nameOf = (path: string) => path.split("/").pop() ?? path;

function Row({
  item,
  gain,
  matched,
  asset,
  mediaUrl,
  onFailed,
}: {
  item: Item;
  /** Playback gain, dB. */
  gain: number;
  matched: boolean;
  asset: AssetInfo | undefined;
  mediaUrl: string;
  onFailed: (message: string | null) => void;
}) {
  const key = playKey(item.asset);
  const playing = usePlayingVoice() === key;
  const name = nameOf(item.asset);
  const ready = Boolean(asset?.sidecar);
  const label = playing ? said.stop(name) : said.play(name);
  const { take } = item;
  return (
    <li className="audition-row" data-testid="audition-row" data-asset={item.asset}>
      <button
        className="icon-button audition-play"
        data-testid="audition-play"
        data-playing={playing}
        disabled={!ready}
        aria-label={label}
        data-tip={ready ? label : said.preparing}
        onClick={(event) => {
          if (playing) return stopVoice();
          if (!asset) return;
          onFailed(null);
          const view = event.currentTarget.ownerDocument.defaultView ?? window;
          // Without a known length the range runs to the end of the sidecar (the server clamps it).
          playVoice(key, asset, { start: 0, end: item.duration ?? 3600 }, mediaUrl, view, gain).catch((error: Error) => onFailed(said.notPlayed(error.message)));
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {playing ? <rect x="4.5" y="4.5" width="7" height="7" fill="currentColor" /> : <path d="M5 3.5V12.5L12.5 8Z" fill="currentColor" />}
        </svg>
      </button>
      <div className="audition-body">
        <div className="audition-head">
          <span className="audition-name" data-tip={item.asset}>
            {name}
          </span>
          {take && (
            <span className="audition-take" data-testid="audition-take">
              {take.kind === "music" ? said.musicTake(take.preset ?? "", take.bpm ?? 0, take.seed) : said.sfxTake(take.kind, take.variant ?? 1, take.seed)}
            </span>
          )}
          <span className="audition-level" data-testid="audition-lufs">
            {item.lufs === null ? said.silent : said.lufs(dbText(item.lufs))}
            {item.truePeak !== null && ` · ${said.peak(dbText(item.truePeak))}`}
          </span>
          {matched && (
            <span className="audition-gain" data-testid="audition-gain">
              {said.gain(dbText(gain))}
            </span>
          )}
        </div>
        {item.spectrogram && <SpectrogramView picture={item.spectrogram} label={said.spectrogram(name)} />}
      </div>
      <button className="button" data-testid="audition-use" data-tip={said.useHint} onClick={() => auditionDialog.use(item.asset)}>
        {said.use}
      </button>
    </li>
  );
}

/** A spectrogram painted one pixel a cell, low frequencies at the bottom; CSS stretches it to the row. */
function SpectrogramView({ picture, label }: { picture: NonNullable<Item["spectrogram"]>; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const width = Math.max(1, picture.columns.length);
    element.width = width;
    element.height = picture.rows;
    const image = context.createImageData(width, picture.rows);
    picture.columns.forEach((column, x) => {
      column.forEach((db, row) => {
        const [r, g, b] = spectrogramColour(db, picture.floorDb);
        const at = ((picture.rows - 1 - row) * width + x) * 4;
        image.data[at] = r;
        image.data[at + 1] = g;
        image.data[at + 2] = b;
        image.data[at + 3] = 255;
      });
    });
    context.putImageData(image, 0, 0);
  }, [picture]);
  return <canvas ref={canvas} className="audition-spectrogram" data-testid="audition-spectrogram" role="img" aria-label={label} />;
}
