import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const constant = async (file: string, name: string) => {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  return text.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];
};

describe("whisper-cpp default model", () => {
  it("main sizes the download of the model the plugin uses by default", async () => {
    const plugin = await constant("../../../plugins/whisper-cpp/src/provider.ts", "DEFAULT_MODEL");
    expect(plugin).toBeDefined();
    expect(await constant("../src/main/index.ts", "WHISPER_DEFAULT_MODEL")).toBe(plugin);
  });
});
