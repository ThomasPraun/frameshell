// Messages between the page's player and the engine worker, and the clock math both sides share.
import type { MixChunk } from "./mixer.js";
import type { Program } from "./program.js";

/**
 * One reading of the audio clock: context time `contextTime` was heard at
 * `epoch` (ms, `performance.timeOrigin + performance.now()`, comparable
 * across the page and its workers).
 */
export interface ClockSample {
  contextTime: number;
  epoch: number;
}

/** Program sample `sample` plays at context frame `frame`. */
export interface Anchor {
  frame: number;
  sample: number;
}

/** Context time heard at `nowEpoch`, extrapolated from `sample`. */
export function heardTime(sample: ClockSample, nowEpoch: number): number {
  return sample.contextTime + (nowEpoch - sample.epoch) / 1000;
}

/** Program sample heard at context time `contextTime` (fractional). */
export function programSample(anchor: Anchor, contextTime: number, sampleRate: number): number {
  return anchor.sample + contextTime * sampleRate - anchor.frame;
}

/** Engine counters, for diagnostics and the ADR 0001 measurements. */
export interface EngineStats {
  /** Frames the decoder returned. */
  decoded: number;
  /** Of those, dropped unseen: pre-roll, frames skipped by speed, stale after a restart. */
  discarded: number;
  /** Frames drawn to the canvas. */
  drawn: number;
  /** Display ticks while playing where the frame due was not decoded yet (the previous frame stayed). */
  starved: number;
  /** Decode pipeline restarts: seeks, program changes. */
  restarts: number;
  /** Audio chunks sent to the mixer. */
  audioChunks: number;
}

/** Page to engine worker. */
export type ToEngine =
  /** First message: the transferred canvas and the page's base URL for project media. */
  | { type: "init"; canvas: OffscreenCanvas; mediaUrl: string }
  /** Port to the program AudioWorklet (absent when audio is unavailable). */
  | { type: "audio"; port: MessagePort }
  | { type: "size"; width: number; height: number }
  | { type: "program"; program: Program }
  | { type: "clock"; sample: ClockSample }
  | { type: "play"; anchor: Anchor; clock: ClockSample }
  | { type: "pause"; frame: number }
  | { type: "seek"; frame: number };

/** Engine worker to page. */
export type FromEngine =
  /** Program frame now on the canvas; -1 for black (gap, placeholder, nothing decoded yet). */
  | { type: "shown"; frame: number }
  | { type: "stats"; stats: EngineStats }
  | { type: "error"; message: string };

/** Engine worker to the program AudioWorklet. */
export type ToMixer = { type: "chunk"; chunk: MixChunk } | { type: "cut"; at: number } | { type: "stop" };
