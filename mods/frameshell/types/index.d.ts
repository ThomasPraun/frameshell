/** One background job of the project, as `frameshell status --json` lists it. */
export type Job = { id: string; kind: string; asset: string; state: string; progress: number }

/** The open review proposal, when review mode holds one. */
export type Proposal = { label: string | null; author: string; state: string; operations: number }

/** What the last poll of the daemon read. */
export type Snapshot = {
  /** Project name and folder; null when the session's folder is in no Frameshell project. */
  project: { name: string; dir: string } | null
  daemonVersion: string | null
  jobs: Job[]
  review: boolean
  proposal: Proposal | null
  /** Why the poll failed (no `frameshell` on PATH, a daemon error); null when it read. */
  error: string | null
}

/** The last frame captured with `/frameshell frame <s>`. */
export type Frame = { at: number; file: string; png: string | null; generation: number }

declare module 'claude-code' {
  interface PluginState {
    frameshell: { snapshot: Shaped<Snapshot | null>; frame: Shaped<Frame | null> }
  }
}
