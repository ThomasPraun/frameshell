import type { LiveStatus } from "../../../shared/api.js";

/** What the person is told about voice recognition, one word per state of {@link LiveStatus}. */
export type LiveWord = "listening" | "ready" | "starting" | "off" | "missing" | "unavailable";

/**
 * The word for `status`: `download` means nothing is installed yet, so it is `missing`. A ready recognizer listens
 * only while a shoot records (`recording`); before Start and after End it is `ready`, the microphone left alone.
 */
export function liveWord(status: LiveStatus, recording: boolean): LiveWord {
  switch (status.state) {
    case "ready":
      return recording ? "listening" : "ready";
    case "installing":
    case "warming":
      return "starting";
    case "download":
      return "missing";
    case "unavailable":
      return "unavailable";
    default:
      return "off";
  }
}

/**
 * Whether following should start the recognizer: it is wanted and the status is `off`, e.g. after main stopped the
 * idle server (10 minutes without audio). Never for `download`: that stays the person's click.
 */
export function shouldWake(status: LiveStatus, following: boolean): boolean {
  return following && status.state === "off";
}

/** Whether the recognizer gets the shoot's audio: it is ready and a session records. Never before Start or after End. */
export function shouldListen(status: LiveStatus, recording: boolean): boolean {
  return recording && status.state === "ready";
}
