import { mkdtempSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type KeyCipher, OpenAiKeyStore, STAND_IN_CIPHER } from "../src/main/openai-key.js";

// The OpenAI key kept by the app (ADR 0050): encrypted on disk, the environment wins, never in an error.

const KEY = "sk-proj-abcdef0123456789";
const file = () => join(realpathSync(mkdtempSync(join(tmpdir(), "frameshell-key-"))), "config", "openai-key.bin");

describe("OpenAiKeyStore", () => {
  it("saves the key encrypted and reads it back", async () => {
    const path = file();
    const store = new OpenAiKeyStore(path, () => STAND_IN_CIPHER, {});
    expect(await store.state()).toEqual({ source: "none", storable: true });
    await store.save(`  ${KEY}\n`);
    expect(readFileSync(path, "utf8")).not.toContain(KEY);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o077).toBe(0);
    expect(await store.read()).toBe(KEY);
    expect(await store.state()).toEqual({ source: "app", storable: true });
    await store.remove();
    expect(await store.read()).toBeNull();
    expect(await store.state()).toEqual({ source: "none", storable: true });
  });

  it("says the environment wins", async () => {
    const store = new OpenAiKeyStore(file(), () => STAND_IN_CIPHER, { OPENAI_API_KEY: "sk-env" });
    await store.save(KEY);
    expect(await store.state()).toEqual({ source: "environment", storable: true });
  });

  it("keeps nothing where the system cannot really encrypt", async () => {
    const plainText: KeyCipher = { ...STAND_IN_CIPHER, getSelectedStorageBackend: () => "basic_text" };
    const unavailable: KeyCipher = { ...STAND_IN_CIPHER, isEncryptionAvailable: () => false };
    for (const cipher of [plainText, unavailable]) {
      const path = file();
      const store = new OpenAiKeyStore(path, () => cipher, {});
      expect(store.storable()).toBe(false);
      const error = await store.save(KEY).catch((caught: Error) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(KEY);
      expect(() => statSync(path)).toThrow();
    }
  });

  it("refuses an empty key or one with spaces, without echoing it", async () => {
    const store = new OpenAiKeyStore(file(), () => STAND_IN_CIPHER, {});
    await expect(store.save("   ")).rejects.toThrow("empty");
    const error = await store.save(`${KEY} extra`).catch((caught: Error) => caught);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("treats a key it cannot decrypt as none", async () => {
    const path = file();
    await new OpenAiKeyStore(path, () => STAND_IN_CIPHER, {}).save(KEY);
    const broken: KeyCipher = { ...STAND_IN_CIPHER, decryptString: () => { throw new Error("keychain reset"); } };
    expect(await new OpenAiKeyStore(path, () => broken, {}).state()).toEqual({ source: "none", storable: true });
  });
});
