// What the person is asked before a new project downloads transcription: a native box in main, like the
// cloud ask (`transcribe-ask.ts`). No dialog code here, so the decision is testable.

/** The person's answer: download and transcribe, or make the project without a transcript. */
export type DownloadChoice = "transcribe" | "skip";

/**
 * Whether the person transcribes a new project. `bytes` is what is still to download (`transcriptionDownload`
 * in `index.ts`); with nothing to download there is nothing to decide and `ask` is never called.
 */
export async function chooseDownload(bytes: number, ask: (bytes: number) => Promise<DownloadChoice>): Promise<DownloadChoice> {
  return bytes > 0 ? ask(bytes) : "transcribe";
}

/** `bytes` as a rounded size for a download box: `~620 MB` below a gigabyte, else `~1.2 GB`. */
export function downloadSize(bytes: number): string {
  return bytes < 1e9 ? `~${Math.max(1, Math.round(bytes / 1e6))} MB` : `~${(bytes / 1e9).toFixed(1)} GB`;
}
