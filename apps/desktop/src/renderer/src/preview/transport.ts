// The playhead: one store the timeline panel, the preview controls and the player read and drive.
import { useSyncExternalStore } from "react";

/** Playhead and play state. */
export interface TransportState {
  /** Playhead, program seconds: a frame boundary while paused, the audio clock while playing. */
  time: number;
  playing: boolean;
  /** Program length in frames; the playhead ranges over `[0, frames / fps]`. */
  frames: number;
  fps: number;
}

/** What plays the program: the preview's player. Times are program seconds. */
export interface TransportPlayer {
  /** Start playing at `from`. */
  play(from: number): void;
  /** Stop; returns the time reached. */
  pause(): number;
  /** Move to `time`: show its frame when paused, continue from it when playing. */
  seek(time: number): void;
}

/**
 * Create a transport store. The app has one ({@link transport}); tests make
 * their own. Commands work without a player (the playhead still moves).
 */
export function createTransport() {
  let state: TransportState = { time: 0, playing: false, frames: 0, fps: 30 };
  let player: TransportPlayer | null = null;
  const listeners = new Set<() => void>();

  const set = (next: Partial<TransportState>) => {
    const merged = { ...state, ...next };
    if (merged.time === state.time && merged.playing === state.playing && merged.frames === state.frames && merged.fps === state.fps) return;
    state = merged;
    for (const listener of listeners) listener();
  };
  const duration = () => state.frames / state.fps;
  const onFrame = (seconds: number) => Math.min(state.frames, Math.max(0, Math.floor(seconds * state.fps + 1e-6))) / state.fps;

  const store = {
    /** Current state; the same object until it changes. */
    get: (): TransportState => state,
    /** Call `listener` after every change. Returns an unsubscribe function. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** New program length (timeline changed); a playhead past the new end moves to it. */
    setProgram(frames: number, fps: number): void {
      set({ frames, fps });
      if (state.time > duration()) store.seek(duration());
    },
    /** Move the playhead to the frame at `seconds` (clamped to the program). */
    seek(seconds: number): void {
      const time = onFrame(seconds);
      if (time === state.time) return;
      set({ time });
      player?.seek(time);
    },
    /** Move the playhead by `frames` frames. */
    step(frames: number): void {
      if (state.playing) store.pause();
      store.seek(state.time + frames / state.fps + 1e-9);
    },
    /** Play from the playhead; from the start when it is at the end. */
    play(): void {
      if (state.playing || state.frames === 0) return;
      const from = state.time >= duration() ? 0 : state.time;
      set({ playing: true, time: from });
      player?.play(from);
    },
    /** Stop where the player's clock is. */
    pause(): void {
      if (!state.playing) return;
      const reached = player ? player.pause() : state.time;
      set({ playing: false, time: Math.min(duration(), Math.max(0, reached)) });
    },
    toggle(): void {
      if (state.playing) store.pause();
      else store.play();
    },
    /** Player side: the clock reached `time` while playing; at the end, stops there. */
    report(time: number): void {
      if (!state.playing) return;
      if (time >= duration()) {
        player?.pause();
        set({ playing: false, time: duration() });
        return;
      }
      set({ time: Math.max(0, time) });
    },
    /** Make `next` the player; returns a detach function. */
    attach(next: TransportPlayer): () => void {
      player = next;
      return () => {
        if (player !== next) return;
        player = null;
        set({ playing: false });
      };
    },
  };
  return store;
}

/** The app's playhead. */
export const transport = createTransport();

/** Current transport state; re-renders the caller on every change (every frame while playing). */
export function useTransport(): TransportState {
  return useSyncExternalStore(transport.subscribe, transport.get);
}
