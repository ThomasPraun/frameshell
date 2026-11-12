// The player imports Vite worker modules; their types come from vite/client.
/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import type { FromEngine, ToEngine } from "../src/renderer/src/preview/engine-protocol.js";
import type { Program } from "../src/renderer/src/preview/program.js";

// Vite worker and worklet imports; node has no AudioContext, so the player sets up on a silent clock.
const workers: FakeWorker[] = [];
class FakeWorker {
  readonly sent: ToEngine[] = [];
  onmessage: ((event: { data: FromEngine }) => void) | null = null;
  constructor() {
    workers.push(this);
  }
  postMessage(message: ToEngine): void {
    this.sent.push(message);
  }
  terminate(): void {}
  reply(message: FromEngine): void {
    this.onmessage?.({ data: message });
  }
}
vi.mock("../src/renderer/src/preview/engine.worker.ts?worker", () => ({ default: FakeWorker }));
vi.mock("../src/renderer/src/preview/probe-recorder.worklet.ts?worker&url", () => ({ default: "probe.js" }));
vi.mock("../src/renderer/src/preview/program-audio.worklet.ts?worker&url", () => ({ default: "program.js" }));

const { PreviewPlayer } = await import("../src/renderer/src/preview/player.js");

function host(): HTMLElement {
  const canvas = { className: "", setAttribute() {}, transferControlToOffscreen: () => ({}), remove() {}, ownerDocument: {} };
  return { ownerDocument: { createElement: () => canvas }, prepend() {} } as unknown as HTMLElement;
}

const program = { frames: 10, fps: 30 } as unknown as Program;

describe("PreviewPlayer shown frames", () => {
  it("clears the shown frame on a new program and drops an earlier program's shown", () => {
    const shown: (number | null)[] = [];
    const player = new PreviewPlayer(host(), "media://", { onTime() {}, onShown: (frame) => shown.push(frame), onError() {} });
    const worker = workers.at(-1)!;

    player.setProgram(program);
    worker.reply({ type: "shown", frame: 4, program: 1 });
    player.setProgram(program);
    worker.reply({ type: "shown", frame: 4, program: 1 });
    worker.reply({ type: "shown", frame: 4, program: 2 });

    expect(shown).toEqual([null, 4, null, 4]);
    expect(worker.sent.filter((message) => message.type === "program")).toHaveLength(2);
    player.dispose();
  });
});
