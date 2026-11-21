// What the inspector says about a generated clip's renders (#746): pure, from one `clip.renders` entry.
import type { ClipRenderInfo } from "@frameshell/protocol";

/** State of the sharp (draft) render as the inspector words it; `unknown` until `clip.renders` answered. */
export type GeneratedState = ClipRenderInfo["state"] | "unknown";

/** State of the blurred render (ADR 0041) as the inspector words it. */
export type BlurState = NonNullable<ClipRenderInfo["final"]>["state"] | "refused";

/** One generated clip's renders, ready to show. */
export interface GeneratedStatus {
  state: GeneratedState;
  /** 0..100 of the running render. */
  percent: number;
  /** Why it failed or cannot render, in full; null otherwise. */
  error: string | null;
  /** True when it cannot render because the project's plugins are not trusted: the fix is the Plugins view. */
  untrusted: boolean;
  /** The blurred render of a clip with `motionBlur`; null without one, or for a plugin's own final (Blender). */
  blur: { state: BlurState; percent: number; error: string | null } | null;
}

/** True when a render is `unavailable` because the project's plugins are not trusted (the host's refusal names it). */
export function untrustedRender(state: string, error: string | null): boolean {
  return state === "unavailable" && /not trusted/i.test(error ?? "");
}

/** {@link GeneratedStatus} of `info`, or the unknown status while there is none yet. */
export function generatedStatus(info: ClipRenderInfo | undefined): GeneratedStatus {
  if (!info) return { state: "unknown", percent: 0, error: null, untrusted: false, blur: null };
  const final = info.final && !info.final.onDemand ? info.final : null;
  return {
    state: info.state,
    percent: Math.round(info.progress * 100),
    error: info.state === "failed" || info.state === "unavailable" ? info.error : null,
    untrusted: untrustedRender(info.state, info.error),
    blur: final
      ? {
          state: final.state === "failed" && final.refused ? "refused" : final.state,
          percent: Math.round(final.progress * 100),
          error: final.state === "failed" ? final.error : null,
        }
      : null,
  };
}
