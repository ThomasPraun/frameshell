import type { AssetInfo } from "@frameshell/protocol";
import { useSyncExternalStore } from "react";
import { transport } from "../preview/transport.js";

/** URL of the project-relative `path` under the window's media root (`frameshell-media://`). */
export function mediaSrc(mediaUrl: string, path: string): string {
  return mediaUrl + path.split("/").map(encodeURIComponent).join("/");
}

/** The voice playing now, one at a time: which button started it, and how to stop it. */
let playing: { key: string; stop: () => void } | null = null;
const listeners = new Set<() => void>();

function publish(next: { key: string; stop: () => void } | null): void {
  playing = next;
  for (const listener of listeners) listener();
}

/** Key of the voice playing now; null when none. */
export function usePlayingVoice(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => playing?.key ?? null,
  );
}

/** Stop the voice playing now, if any. */
export function stopVoice(): void {
  const current = playing;
  if (!current) return;
  publish(null);
  current.stop();
}

/**
 * Play source seconds `stretch` of `asset` from its PCM sidecar (the preview's own audio: s16le from source time 0,
 * read with an HTTP range, nothing written) through Web Audio of `view`, the window the button is in (ADR 0012).
 * Stops the voice playing before and pauses the timeline. Resolves once it plays; rejects with why it cannot.
 */
export async function playVoice(key: string, asset: Pick<AssetInfo, "sidecar">, stretch: { start: number; end: number }, mediaUrl: string, view: typeof window): Promise<void> {
  const sidecar = asset.sidecar;
  if (!sidecar) throw new Error("the file has no audio");
  stopVoice();
  if (transport.get().playing) transport.pause();
  let stop = () => {};
  const claim = { key, stop: () => stop() };
  publish(claim);
  try {
    const frame = sidecar.channels * 2;
    const first = Math.max(0, Math.floor(stretch.start * sidecar.sampleRate));
    const count = Math.max(1, Math.ceil((stretch.end - stretch.start) * sidecar.sampleRate));
    const response = await fetch(mediaSrc(mediaUrl, sidecar.path), { headers: { Range: `bytes=${first * frame}-${(first + count) * frame - 1}` } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Stopped, or another voice started, while the samples were read.
    if (playing !== claim) return;
    const frames = Math.floor(bytes.length / frame);
    if (frames === 0) throw new Error("no samples there");
    const context = new view.AudioContext({ sampleRate: sidecar.sampleRate });
    const buffer = context.createBuffer(sidecar.channels, frames, sidecar.sampleRate);
    const samples = new DataView(bytes.buffer, bytes.byteOffset, frames * frame);
    for (let channel = 0; channel < sidecar.channels; channel++) {
      const out = buffer.getChannelData(channel);
      for (let i = 0; i < frames; i++) out[i] = samples.getInt16((i * sidecar.channels + channel) * 2, true) / 32768;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    stop = () => {
      source.onended = null;
      source.stop();
      void context.close();
    };
    source.onended = () => {
      if (playing === claim) stopVoice();
    };
    source.start();
  } catch (error) {
    if (playing === claim) publish(null);
    throw error;
  }
}
