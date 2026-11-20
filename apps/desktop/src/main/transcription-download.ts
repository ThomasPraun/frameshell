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
