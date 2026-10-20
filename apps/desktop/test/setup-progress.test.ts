import { describe, expect, it } from "vitest";
import { describeProgress } from "../src/main/setup-progress.js";
import { strings } from "../src/shared/i18n/index.js";

const en = strings("en").app.setup.progress;
const es = strings("es").app.setup.progress;

const cases: Array<[string, { message: string; stage: string; values?: Record<string, string | number> }, string]> = [
  ["binary", { message: "Preparing whisper.cpp", stage: "binary", values: { name: "whisper.cpp" } }, "Preparando whisper.cpp"],
  [
    "binary-download",
    { message: "Downloading whisper-cpp 1.7.6 (50 MB)", stage: "binary-download", values: { name: "whisper-cpp", version: "1.7.6", size: 50 } },
    "Descargando whisper-cpp 1.7.6 (50 MB)",
  ],
  [
    "model-download",
    { message: "Downloading model ggml-large-v3-turbo-q5_0 (574 MB, one time)", stage: "model-download", values: { model: "ggml-large-v3-turbo-q5_0", size: 574 } },
    "Descargando el modelo ggml-large-v3-turbo-q5_0 (574 MB, solo la primera vez)",
  ],
  ["model-load", { message: "Loading model", stage: "model-load" }, "Cargando el modelo"],
  [
    "gpu-compile",
    { message: "Compiling Metal GPU shaders (first run after install only, 15-25 s)", stage: "gpu-compile" },
    "Compilando los sombreadores de la GPU Metal (solo la primera vez tras instalar, 15-25 s)",
  ],
  ["transcribe", { message: "Transcribing (metal)", stage: "transcribe", values: { device: "metal" } }, "Transcribiendo (metal)"],
  ["hash", { message: "Hashing assets/a.mp4", stage: "hash", values: { asset: "assets/a.mp4" } }, "Calculando la huella de assets/a.mp4"],
];

describe("describeProgress", () => {
  it.each(cases)("says the %s stage in Spanish and reads as the daemon's message in English", (_stage, update, spanish) => {
    expect(describeProgress(update, en)).toBe(update.message);
    expect(describeProgress(update, es)).toBe(spanish);
  });

  it("keeps the daemon's message for an unknown or missing stage", () => {
    expect(describeProgress({ message: "Doing a new thing", stage: "future-stage" }, es)).toBe("Doing a new thing");
    expect(describeProgress({ message: "Plain line" }, es)).toBe("Plain line");
  });
});
