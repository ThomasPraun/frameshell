import type { ModelListResult } from "@frameshell/protocol";
import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICE, modelChoices, modelIdFromFile } from "../src/renderer/src/transcript/model-choice.js";

const registered = (id: string, format: "ggml" | "onnx", state: "ok" | "missing" | "changed" = "ok") => ({
  id,
  file: `/models/${id}.bin`,
  format,
  sha256: "a".repeat(64),
  size: 10,
  addedAt: "2026-11-02T00:00:00.000Z",
  options: {},
  state,
});

function list(overrides: Partial<ModelListResult> = {}): ModelListResult {
  return {
    registry: "/config/models.json",
    models: [registered("es-small", "ggml"), registered("canary", "onnx", "missing")],
    defaults: {},
    providers: [
      {
        id: "whisper-cpp",
        defaultModel: "large-v3-turbo-q5_0",
        models: [
          { id: "large-v3-turbo-q5_0", size: 574_000_000, downloaded: true },
          { id: "large-v3-turbo-q8_0", size: 874_000_000, downloaded: false },
        ],
        userModels: { formats: ["ggml"], options: [{ key: "dtw", values: ["small", "large.v3"] }] },
      },
    ],
    providersError: null,
    project: { dir: "/p", provider: "whisper-cpp", model: null, effective: "large-v3-turbo-q5_0" },
    ...overrides,
  };
}

describe("modelChoices", () => {
  it("offers the provider's models, the registered files it reads, and Default as the provider's model", () => {
    const choices = modelChoices(list());
    expect(choices.current).toBe(DEFAULT_CHOICE);
    expect(choices.defaultModel).toBe("large-v3-turbo-q5_0");
    expect(choices.pinned.map((option) => [option.id, option.size, option.downloaded])).toEqual([
      ["large-v3-turbo-q5_0", 574_000_000, true],
      ["large-v3-turbo-q8_0", 874_000_000, false],
    ]);
    // The ONNX file is for another provider: whisper.cpp reads ggml only.
    expect(choices.registered.map((option) => option.id)).toEqual(["es-small"]);
    expect(choices.options).toEqual([{ key: "dtw", values: ["small", "large.v3"] }]);
    expect(choices.unknown).toBeNull();
  });

  it("names this machine's default as Default when it has one", () => {
    expect(modelChoices(list({ defaults: { "whisper-cpp": "es-small" } })).defaultModel).toBe("es-small");
  });

  it("selects the project's model, and marks one this machine does not know", () => {
    expect(modelChoices(list({ project: { dir: "/p", provider: "whisper-cpp", model: "es-small", effective: "es-small" } })).current).toBe("es-small");
    const missing = modelChoices(list({ project: { dir: "/p", provider: "whisper-cpp", model: "de-medium", effective: "de-medium" } }));
    expect(missing.current).toBe("de-medium");
    expect(missing.unknown).toMatchObject({ id: "de-medium", kind: "unknown" });
  });

  it("keeps every registered file and does not call a model unknown while the provider's list is missing", () => {
    const choices = modelChoices(
      list({ providers: [], providersError: "not trusted", project: { dir: "/p", provider: "whisper-cpp", model: "large-v3-turbo-q8_0", effective: "large-v3-turbo-q8_0" } }),
    );
    expect(choices.registered.map((option) => option.id)).toEqual(["es-small", "canary"]);
    expect(choices.unknown).toMatchObject({ id: "large-v3-turbo-q8_0", kind: "pinned" });
    expect(choices.defaultModel).toBeNull();
    expect(choices.options).toEqual([]);
  });
});

describe("modelIdFromFile", () => {
  it.each([
    ["/home/ana/ggml-es-small.bin", "es-small"],
    ["C:\\models\\Whisper Medium ES.bin", "Whisper-Medium-ES"],
    ["/m/canary-180m-flash.onnx", "canary-180m-flash"],
    ["/m/__weird__.gguf", "weird__"],
    ["/m/.bin", "model"],
  ])("%s → %s", (path, id) => {
    expect(modelIdFromFile(path)).toBe(id);
  });
});
