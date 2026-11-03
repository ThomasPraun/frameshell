import { createHash } from "node:crypto";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "@frameshell/protocol";
import { MODEL_REGISTRY_FILE, ModelRegistry, detectModelFormat } from "../src/index.js";
import { tempDir } from "./helpers.js";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A tiny file that starts like a whisper.cpp ggml model. */
function ggmlFile(dir: string, name = "ggml-mine.bin", body = "weights"): string {
  const path = join(dir, name);
  writeFileSync(path, `lmgg${body}`);
  return path;
}

describe("detectModelFormat", () => {
  it("reads ggml, gguf and ONNX from the first bytes", async () => {
    const dir = tempDir();
    expect(await detectModelFormat(ggmlFile(dir))).toBe("ggml");
    writeFileSync(join(dir, "m.gguf"), "GGUF\x03\x00");
    expect(await detectModelFormat(join(dir, "m.gguf"))).toBe("gguf");
    writeFileSync(join(dir, "canary.onnx"), Buffer.from([0x08, 0x07, 0x12, 0x00]));
    expect(await detectModelFormat(join(dir, "canary.onnx"))).toBe("onnx");
  });

  it.each([
    ["model.nemo", "anything"],
    ["model.pt", "PK\x03\x04rest"],
    ["model.ckpt", "x"],
    ["weights.bin", "\x80\x04\x95rest"],
    ["weights.bin", "PK\x03\x04rest"],
  ])("refuses pickle-based %s", async (name, content) => {
    const dir = tempDir();
    writeFileSync(join(dir, name), Buffer.from(content, "latin1"));
    await expect(detectModelFormat(join(dir, name))).rejects.toMatchObject({ code: ErrorCode.UnsupportedModelFormat, data: { reason: "pickle" } });
  });

  it("refuses a file that is no model it knows", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "notes.txt"), "hello");
    await expect(detectModelFormat(join(dir, "notes.txt"))).rejects.toMatchObject({ code: ErrorCode.UnsupportedModelFormat, data: { reason: "unknown" } });
  });
});

describe("ModelRegistry", () => {
  it("registers a file with its SHA-256 in <configDir>/models.json and resolves it", async () => {
    const config = tempDir();
    const file = ggmlFile(tempDir());
    const registry = new ModelRegistry(config);
    const stages: (string | undefined)[] = [];
    const { model, replaced } = await registry.add("mine", file, { dtw: "small" }, (p) => stages.push(p.stage));
    expect(replaced).toBe(false);
    expect(model).toMatchObject({ id: "mine", file, format: "ggml", sha256: sha256("lmggweights"), size: 11, options: { dtw: "small" }, state: "ok" });
    expect(stages).toContain("model-hash");
    const stored = JSON.parse(readFileSync(join(config, MODEL_REGISTRY_FILE), "utf8"));
    expect(stored.models.mine).toMatchObject({ file, sha256: sha256("lmggweights") });

    expect(await registry.resolve("mine", ["ggml"])).toEqual({
      id: "mine",
      path: file,
      format: "ggml",
      sha256: sha256("lmggweights"),
      changed: false,
      options: { dtw: "small" },
    });
    expect((await registry.add("mine", file, {})).replaced).toBe(true);
  });

  it("says when the file changed since it was registered, and uses its new hash", async () => {
    const registry = new ModelRegistry(tempDir());
    const file = ggmlFile(tempDir());
    await registry.add("mine", file, {});
    writeFileSync(file, "lmggretrained!");
    expect((await registry.list()).models[0]!.state).toBe("changed");
    expect(await registry.resolve("mine", ["ggml"])).toMatchObject({ changed: true, sha256: sha256("lmggretrained!") });
  });

  it("does not flag a file only touched: same bytes", async () => {
    const registry = new ModelRegistry(tempDir());
    const file = ggmlFile(tempDir());
    await registry.add("mine", file, {});
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(await registry.resolve("mine", ["ggml"])).toMatchObject({ changed: false });
  });

  it("fails with ModelNotRegistered naming the id and how to register it", async () => {
    const registry = new ModelRegistry(tempDir());
    const error = await registry.resolve("es-small", ["ggml"]).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.ModelNotRegistered, data: { id: "es-small", reason: "unknown" } });
    expect((error as Error).message).toMatch(/"es-small" is not registered.*frameshell model add es-small <file>/);
  });

  it("fails when the registered file is gone or its format is not one the provider reads", async () => {
    const registry = new ModelRegistry(tempDir());
    const dir = tempDir();
    writeFileSync(join(dir, "c.onnx"), Buffer.from([0x08, 0x07]));
    await registry.add("canary", join(dir, "c.onnx"), {});
    await expect(registry.resolve("canary", ["ggml"])).rejects.toMatchObject({ code: ErrorCode.ModelNotRegistered, data: { reason: "format" } });
    const file = ggmlFile(dir, "gone.bin");
    await registry.add("gone", file, {});
    rmSync(file);
    expect((await registry.list()).models.find((m) => m.id === "gone")!.state).toBe("missing");
    await expect(registry.resolve("gone", ["ggml"])).rejects.toMatchObject({ code: ErrorCode.ModelNotRegistered, data: { reason: "missing-file" } });
  });

  it("keeps a default per provider, cleared when its model is removed", async () => {
    const registry = new ModelRegistry(tempDir());
    await registry.add("mine", ggmlFile(tempDir()), {});
    expect(await registry.setDefault("whisper-cpp", "mine")).toBeNull();
    expect(await registry.setDefault("other", "large-v3-turbo")).toBeNull();
    expect(await registry.defaultFor("whisper-cpp")).toBe("mine");
    const { defaults } = await registry.remove("mine");
    expect(defaults).toEqual(["whisper-cpp"]);
    expect((await registry.list()).defaults).toEqual({ other: "large-v3-turbo" });
    await expect(registry.remove("mine")).rejects.toMatchObject({ code: ErrorCode.ModelNotRegistered });
  });

  it("refuses to register a pickle file and leaves the registry alone", async () => {
    const config = tempDir();
    const dir = tempDir();
    writeFileSync(join(dir, "canary.nemo"), "tar");
    await expect(new ModelRegistry(config).add("canary", join(dir, "canary.nemo"), {})).rejects.toMatchObject({ code: ErrorCode.UnsupportedModelFormat });
    expect((await new ModelRegistry(config).list()).models).toEqual([]);
  });

  it("reports a broken registry file as InvalidGlobalConfig", async () => {
    const config = tempDir();
    writeFileSync(join(config, MODEL_REGISTRY_FILE), "{ nope");
    await expect(new ModelRegistry(config).list()).rejects.toMatchObject({ code: ErrorCode.InvalidGlobalConfig });
  });
});
