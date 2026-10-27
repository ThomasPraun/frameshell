// Live recognition in the renderer (ADR 0024 decision 5): the recognizer's status, and the audio tap that sends the
// mic (mixed with system audio) to main at 16 kHz. Main runs whisper-server; its words reach the teleprompter's
// follower (teleprompter/follow.ts). Nothing here is written to the project.
import { useSyncExternalStore } from "react";
import type { LiveHeard, LiveStatus } from "../../../shared/api.js";
import tapUrl from "./live-tap.worklet.ts?worker&url";

let status: LiveStatus = { state: "off", model: null, detail: null, progress: null };
const listeners = new Set<() => void>();
let following = false;
/** A warm-up request is in flight: another click or status change does not send a second. */
let asking = false;
let tap: { context: AudioContext; tracks: readonly MediaStreamTrack[]; stop: () => void } | null = null;

function setStatus(next: LiveStatus): void {
  status = next;
  for (const listener of [...listeners]) listener();
}

/** The recognizer's status and the audio tap, shared by the Shoot view and the teleprompter. */
export const live = {
  status(): LiveStatus {
    return status;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  /**
   * Start and warm the recognizer, as the Shoot view does when it opens, so it is ready before Start (the first
   * Metal run takes about 16 s). Downloads what is missing only with `install` (the person's click); again after it
   * was unavailable, a download may work now.
   */
  warm(install = false): void {
    if (!following) {
      following = true;
      window.frameshell.shoot.onLiveStatus(setStatus);
    }
    if (status.state === "ready" || status.state === "installing" || status.state === "warming") return;
    if (asking && !install) return;
    asking = true;
    void window.frameshell.shoot
      .liveWarm(install)
      .then(setStatus)
      .finally(() => (asking = false));
  },
  /** Called with the words of each recognized window. Returns the function that stops it. */
  onHeard(listener: (heard: LiveHeard) => void): () => void {
    return window.frameshell.shoot.onLiveHeard(listener);
  },
  /**
   * Send `tracks` to the recognizer while non-empty; an empty list stops. The same tracks keep the running tap.
   * Silent: the tap's context plays nothing.
   */
  listen(tracks: readonly MediaStreamTrack[]): void {
    if (tap && tap.tracks.length === tracks.length && tap.tracks.every((track, index) => track === tracks[index])) return;
    tap?.stop();
    tap = null;
    window.frameshell.shoot.liveReset();
    if (tracks.length === 0) return;
    const context = new AudioContext({ sampleRate: 16_000 });
    let stopped = false;
    const nodes: AudioNode[] = [];
    tap = {
      context,
      tracks,
      stop: () => {
        stopped = true;
        for (const node of nodes) node.disconnect();
        void context.close().catch(() => undefined);
      },
    };
    void context.audioWorklet
      .addModule(tapUrl)
      .then(() => {
        if (stopped) return;
        const node = new AudioWorkletNode(context, "frameshell-live-tap", { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
        node.port.onmessage = (event: MessageEvent<Int16Array>) => window.frameshell.shoot.liveAudio(event.data);
        for (const track of tracks) {
          const source = context.createMediaStreamSource(new MediaStream([track]));
          source.connect(node);
          nodes.push(source);
        }
        // A worklet runs only when pulled: through a muted gain to the output.
        const mute = context.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(context.destination);
        nodes.push(node, mute);
        void context.resume().catch(() => undefined);
      })
      .catch(() => undefined);
  },
};

/** The recognizer's status, live. */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(live.subscribe, live.status);
}
