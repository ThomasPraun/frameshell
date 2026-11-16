// The one voiceover dialog's state (ADR 0034 decision 22): generate with progress and Cancel, the misread report, and
// placing the takes. One store outside the view, like the context menu, so a run goes on whatever the Explorer does.
import type { VoiceoverGenerateResult, VoiceoverPlaceResult } from "@frameshell/protocol";
import type { VoiceoverProgress } from "../../../shared/api.js";
import type { CheckAsked } from "./model.js";

/** Where the person is in a generation. `none`: the dialog was opened only to place. */
export type Run =
  | { kind: "none" }
  | { kind: "getting" }
  | { kind: "choose"; bytes: number }
  | { kind: "running"; progress: VoiceoverProgress | null; stopping: boolean }
  | { kind: "report"; result: VoiceoverGenerateResult; asked: CheckAsked }
  | { kind: "stopped"; kept: number }
  | { kind: "failed"; message: string };

/** The "Place on the timeline" form. */
export interface PlaceForm {
  /** What the person typed: seconds, a marker, `beat:N`; empty = after the voice track's last clip. */
  start: string;
  replace: boolean;
  busy: boolean;
  result: VoiceoverPlaceResult | null;
  error: string | null;
  /** Marker labels of the main timeline, offered as suggestions. */
  markers: string[];
}

/** What the dialog shows. */
export interface DialogState {
  /** Project-relative voiceover script. */
  script: string;
  /** Window the dialog shows in: the project window, or a detached panel's (ADR 0012). */
  view: Window;
  run: Run;
  /** The place form; null until a generation reported or place-only was asked. */
  place: PlaceForm | null;
}

let current: DialogState | null = null;
/** Identifies the dialog being shown: an answer that arrives after it closed or was replaced is dropped. */
let session = 0;
const listeners = new Set<() => void>();

function publish(next: DialogState | null): void {
  current = next;
  for (const listener of listeners) listener();
}

const api = () => window.frameshell.voiceover;
const messageOf = (error: unknown) => (error as Error).message ?? String(error);

/** Change the dialog of `id` (a no-op when it closed or another one opened). */
function update(id: number, change: (state: DialogState) => DialogState): void {
  if (id === session && current) publish(change(current));
}

const emptyForm = (markers: string[] = []): PlaceForm => ({ start: "", replace: false, busy: false, result: null, error: null, markers });

/** Marker labels for the place form; suggestions only, so failing to read them is not an error. */
function loadMarkers(id: number): void {
  void api().markers().then(
    (markers) => update(id, (state) => (state.place ? { ...state, place: { ...state.place, markers } } : state)),
    () => undefined,
  );
}

/** Run the generation. `asked` is whether the misread check was asked for. */
async function generate(id: number, script: string, verify: boolean, asked: CheckAsked): Promise<void> {
  update(id, (state) => ({ ...state, run: { kind: "running", progress: null, stopping: false } }));
  const off = api().onProgress((progress) => {
    update(id, (state) => (state.run.kind === "running" ? { ...state, run: { ...state.run, progress } } : state));
  });
  try {
    const run = await api().generate(script, verify);
    if (run.status === "declined") return id === session ? publish(null) : undefined;
    if (run.status === "canceled") return update(id, (state) => ({ ...state, run: { kind: "stopped", kept: run.kept } }));
    update(id, (state) => ({ ...state, run: { kind: "report", result: run.result, asked }, place: emptyForm() }));
    loadMarkers(id);
  } catch (error) {
    update(id, (state) => ({ ...state, run: { kind: "failed", message: messageOf(error) } }));
  } finally {
    off();
  }
}

/** The dialog's actions; {@link voiceoverDialog.get} is what it shows. */
export const voiceoverDialog = {
  /**
   * Generate the voiceover of `script` and show the report. When the misread check would first download transcription
   * tools the person is asked in the dialog; with no usable transcription it is left out and the report says so.
   */
  async generate(script: string, view: Window = window): Promise<void> {
    if (current?.run.kind === "running") return;
    const id = ++session;
    publish({ script, view, run: { kind: "getting" }, place: null });
    try {
      const plan = await api().verifyPlan();
      // Closed while the plan was being read: nothing runs.
      if (id !== session) return;
      if (plan.kind === "download") return update(id, (state) => ({ ...state, run: { kind: "choose", bytes: plan.bytes } }));
      await generate(id, script, plan.kind === "ready", plan.kind === "ready" ? "yes" : "unavailable");
    } catch (error) {
      update(id, (state) => ({ ...state, run: { kind: "failed", message: messageOf(error) } }));
    }
  },

  /** Answer the question of the download: generate and check (the download is agreed), or generate without checking. */
  async choose(check: boolean): Promise<void> {
    if (!current || current.run.kind !== "choose") return;
    await generate(session, current.script, check, check ? "yes" : "declined");
  },

  /** Open the dialog to place the takes `script` already has, without generating. */
  place(script: string, view: Window = window): void {
    if (current?.run.kind === "running") return;
    const id = ++session;
    publish({ script, view, run: { kind: "none" }, place: emptyForm() });
    loadMarkers(id);
  },

  /** Stop the running generation: the line being said is abandoned, the takes finished before it stay. */
  async stop(): Promise<void> {
    if (!current || current.run.kind !== "running" || current.run.stopping) return;
    const id = session;
    update(id, (state) => (state.run.kind === "running" ? { ...state, run: { ...state.run, stopping: true } } : state));
    await api().cancel().catch(() => undefined);
  },

  /** Edit the form. */
  edit(change: Partial<Pick<PlaceForm, "start" | "replace">>): void {
    if (current?.place) publish({ ...current, place: { ...current.place, ...change } });
  },

  /** Place the takes on the main timeline, in one transaction. */
  async submitPlace(): Promise<void> {
    if (!current?.place || current.place.busy) return;
    const id = session;
    const { script, place } = current;
    update(id, (state) => (state.place ? { ...state, place: { ...state.place, busy: true, error: null, result: null } } : state));
    try {
      const result = await api().place(script, place.start, place.replace);
      update(id, (state) => (state.place ? { ...state, place: { ...state.place, busy: false, result } } : state));
    } catch (error) {
      update(id, (state) => (state.place ? { ...state, place: { ...state.place, busy: false, error: messageOf(error) } } : state));
    }
  },

  /** Close the dialog; not while a generation runs (Stop it first). */
  close(): void {
    if (current && current.run.kind !== "running") {
      session++;
      publish(null);
    }
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): DialogState | null => current,
};
