import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptionProvider } from "@frameshell/plugin-api";
import { describe, expect, it } from "vitest";
import { type RangeExtractor, type SessionTake, transcribeTake } from "../src/shoot/session.js";
import { tempDir } from "./helpers.js";

const FOLDER = "assets/shoot/20261028-111509";
const MIC = `${FOLDER}/mic.m4a`;

const take: SessionTake = {
  id: "t1",
  asset: MIC,
  scene: "hook",
  recordedAt: "2026-10-28T11:15:30.000Z",
  session: { id: "20261028-111509", start: 1, end: 3, sounds: [{ asset: MIC, offset: 0 }] },
};

const provider: TranscriptionProvider = {
  id: "fake",
  transcribe: async () => ({ model: "fake", words: [{ text: "hola", start: 0.1, end: 0.4 }] }),
};

const context = { ensureBinary: async () => "", ensureModel: async () => "", progress: () => {} };

function project(): string {
  const root = tempDir();
  mkdirSync(join(root, FOLDER), { recursive: true });
  writeFileSync(join(root, `${MIC}.part`), "recorded");
  return root;
}

describe("transcribeTake input", () => {
  it("reads the finished file when the session ends between choosing the .part and opening it", async () => {
    const root = project();
    const read: string[] = [];
    const extract: RangeExtractor = async (input, _from, _to, output) => {
      read.push(input);
      if (input.endsWith(".part")) {
        // End renames `.part` before ffmpeg opens it.
        renameSync(input, join(root, MIC));
        throw new Error(`ffmpeg could not cut ${input} (exit 254): Error opening input: No such file or directory`);
      }
      writeFileSync(output, "");
    };
    const words = await transcribeTake({ root, take, extract, providerId: "fake", provider, context });
    expect(read).toEqual([join(root, `${MIC}.part`), join(root, MIC)]);
    expect(words.sounds[0]!.words.map((word) => word.text)).toEqual(["hola"]);
  });

  it("reports a failure of a .part that is still there", async () => {
    const root = project();
    const extract: RangeExtractor = async () => {
      throw new Error("ffmpeg could not cut: Invalid data found when processing input");
    };
    await expect(transcribeTake({ root, take, extract, providerId: "fake", provider, context })).rejects.toThrow("Invalid data");
    expect(existsSync(join(root, MIC))).toBe(false);
  });
});
