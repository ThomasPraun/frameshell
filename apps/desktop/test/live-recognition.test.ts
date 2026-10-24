import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIVE_SLOW_MS,
  LiveRecognizer,
  PcmRing,
  heardWords,
  nextModel,
  serverArgs,
  wavFile,
} from "../src/main/live-recognition.js";
import type { LiveHeard, LiveStatus } from "../src/shared/api.js";

// Seam under test: main's live recognizer (#393, ADR 0024 decision 5) with a fake whisper-server.

describe("live recognition pieces", () => {
  it("keeps the newest seconds of audio and counts what came since the last window", () => {
    const ring = new PcmRing(1, 10);
    ring.append(Int16Array.from([1, 2, 3, 4, 5, 6]));
    ring.append(Int16Array.from([7, 8, 9, 10, 11, 12]));
    expect(ring.fresh).toBe(12);
    expect([...ring.take(0.5, 10)]).toEqual([8, 9, 10, 11, 12]);
    expect(ring.fresh).toBe(0);
    expect([...ring.take(5, 10)]).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("writes a 16 kHz mono 16-bit WAV", () => {
    const wav = wavFile(Int16Array.from([0, 1000, -1000]));
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(46, true)).toBe(1000);
  });

  it("reads words from a verbose_json reply, without marks, and the silence after them", () => {
    const reply = {
      language: "es",
      segments: [
        { text: " Hola", start: 0.2, end: 0.6 },
        { text: " [BLANK_AUDIO]", start: 0.6, end: 1 },
        { text: ",", start: 1, end: 1.1 },
        { text: " todos.", start: 1.1, end: 1.9 },
      ],
    };
    expect(heardWords(reply, 3.5)).toEqual({ words: ["Hola", "todos."], silence: 1.6, language: "es" });
    expect(heardWords({}, 3.5)).toEqual({ words: [], silence: 3.5, language: null });
  });

  it("runs the server greedy, without fallback, with the short encoder context, on loopback", () => {
    expect(serverArgs("/m/small.bin", "es", 4321, 4)).toEqual(
      ["-m", "/m/small.bin", "-l", "es", "-t", "4", "-bs", "1", "-bo", "1", "-nf", "-ac", "400", "--host", "127.0.0.1", "--port", "4321"],
    );
  });

  it("steps down to base-q5_1 only when small-q5_1 is too slow", () => {
    expect(nextModel("ggml-small-q5_1", LIVE_SLOW_MS + 1)).toBe("ggml-base-q5_1");
    expect(nextModel("ggml-small-q5_1", 150)).toBe("ggml-small-q5_1");
    expect(nextModel("ggml-base-q5_1", 2000)).toBe("ggml-base-q5_1");
  });
});

/** A whisper-server stand-in: answers `/` once started, and `/inference` after `delay(model)` ms with `words`. */
function fakeServer(delay: (model: string) => number, words: string[] = []) {
  const started: string[] = [];
  let model = "";
  const spawn = ((_file: string, args: string[]) => {
    model = args[1]!;
    started.push(model);
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: () => child.emit("exit", null) });
    return child;
  }) as never;
  const fetch = (async (url: string) => {
    if (!url.endsWith("/inference")) return new Response("ok");
    await new Promise((resolve) => setTimeout(resolve, delay(model)));
    return Response.json({ segments: words.map((text, index) => ({ text, start: index * 0.3, end: index * 0.3 + 0.25 })) });
  }) as typeof globalThis.fetch;
  return { spawn, fetch, started };
}

describe("live recognizer", () => {
  it("installs, warms, measures, steps down when slow, and remembers the choice", async () => {
    const choiceFile = join(await mkdtemp(join(tmpdir(), "fs-live-")), "shoot", "live-model.json");
    const server = fakeServer((model) => (model.includes("small") ? LIVE_SLOW_MS + 100 : 5));
    const seen: LiveStatus["state"][] = [];
    const recognizer = new LiveRecognizer({
      server: async () => "/bin/whisper-server",
      model: async (id) => `/models/${id}.bin`,
      missing: async () => 0,
      choiceFile,
      spawn: server.spawn,
      fetch: server.fetch,
    });
    recognizer.onStatus((status) => seen.push(status.state));
    const status = await recognizer.warm("es");
    expect(status).toMatchObject({ state: "ready", model: "ggml-base-q5_1" });
    expect(server.started).toEqual(["/models/ggml-small-q5_1.bin", "/models/ggml-base-q5_1.bin"]);
    expect(seen).toContain("installing");
    expect(seen).toContain("warming");
    expect(JSON.parse(await readFile(choiceFile, "utf8"))).toMatchObject({ model: "ggml-base-q5_1" });
    recognizer.dispose();

    // The next start takes the remembered model straight away, without measuring.
    const again = fakeServer(() => 5);
    const next = new LiveRecognizer({ server: async () => "/bin/whisper-server", model: async (id) => `/models/${id}.bin`, missing: async () => 0, choiceFile, spawn: again.spawn, fetch: again.fetch });
    expect(await next.warm("es")).toMatchObject({ state: "ready", model: "ggml-base-q5_1" });
    expect(again.started).toEqual(["/models/ggml-base-q5_1.bin"]);
    next.dispose();
  });

  it("recognizes the newest window once half a second of new audio came, one call at a time", async () => {
    const choiceFile = join(await mkdtemp(join(tmpdir(), "fs-live-")), "live-model.json");
    const server = fakeServer(() => 5, ["Hola", "a", "todos"]);
    const recognizer = new LiveRecognizer({ server: async () => "/s", model: async (id) => id, missing: async () => 0, choiceFile, spawn: server.spawn, fetch: server.fetch });
    await recognizer.warm("auto");
    const heard: LiveHeard[] = [];
    recognizer.onHeard((words) => heard.push(words));
    recognizer.audio(new Int16Array(4000));
    expect(heard).toEqual([]);
    recognizer.audio(new Int16Array(4000));
    recognizer.audio(new Int16Array(8000));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ words: ["Hola", "a", "todos"] });
    recognizer.dispose();
  });

  it("downloads nothing until asked: says how much it takes, then installs when told to", async () => {
    const server = fakeServer(() => 5);
    let installed = false;
    const recognizer = new LiveRecognizer({
      server: async () => {
        installed = true;
        return "/s";
      },
      model: async (id) => id,
      missing: async () => (installed ? 0 : 250_000_000),
      choiceFile: join(await mkdtemp(join(tmpdir(), "fs-live-")), "live-model.json"),
      spawn: server.spawn,
      fetch: server.fetch,
    });
    expect(await recognizer.warm("es")).toMatchObject({ state: "download", bytes: 250_000_000 });
    expect(installed).toBe(false);
    expect(await recognizer.warm("es", true)).toMatchObject({ state: "ready" });
    recognizer.dispose();
  });

  it("says it is unavailable when there is no server build, and why", async () => {
    const recognizer = new LiveRecognizer({
      server: async () => {
        throw new Error("No managed whisper-server build for freebsd-x64");
      },
      model: async (id) => id,
      missing: async () => 0,
      choiceFile: join(tmpdir(), "never-written.json"),
    });
    expect(await recognizer.warm("es")).toEqual({ state: "unavailable", model: null, detail: "No managed whisper-server build for freebsd-x64", progress: null });
  });
});
