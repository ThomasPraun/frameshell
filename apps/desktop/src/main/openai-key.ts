import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OpenAiKeyState } from "../shared/api.js";

/** Environment variable the OpenAI plugins read; a value there wins over a saved key (ADR 0050 decision 4). */
export const OPENAI_KEY_VARIABLE = "OPENAI_API_KEY";

/** The subset of Electron's `safeStorage` the key store uses; tests and the e2e stand-in pass their own. */
export interface KeyCipher {
  isEncryptionAvailable(): boolean;
  /** Linux only in Electron: `basic_text` means a fixed key, so nothing is stored (ADR 0050 decision 2). */
  getSelectedStorageBackend?(): string;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Reversible stand-in for `safeStorage`, for e2e only (`FRAMESHELL_KEYCHAIN_STAND_IN=1`): CI machines have no
 * keyring. It protects nothing.
 */
export const STAND_IN_CIPHER: KeyCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`stand-in:${Buffer.from(plain, "utf8").toString("base64")}`, "utf8"),
  decryptString: (encrypted) => {
    const text = encrypted.toString("utf8");
    if (!text.startsWith("stand-in:")) throw new Error("not a stand-in key");
    return Buffer.from(text.slice("stand-in:".length), "base64").toString("utf8");
  },
};

/** Why a key was not saved, in the app's language. */
export interface KeyMessages {
  empty: string;
  spaces: string;
  cannotEncrypt: string;
}

const ENGLISH: KeyMessages = {
  empty: "The key is empty.",
  spaces: "The key has spaces or line breaks in it: paste only the key.",
  cannotEncrypt: "This computer cannot encrypt the key, so it is not saved.",
};

/**
 * The OpenAI key typed in the Plugins view (ADR 0050): encrypted by `cipher` into `file` (in `configDir`), decrypted
 * only here in main and handed to the daemon. Never returns the key to the renderer and never puts it in an error.
 */
export class OpenAiKeyStore {
  constructor(
    private readonly file: string,
    private readonly cipher: () => KeyCipher,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly messages: () => KeyMessages = () => ENGLISH,
  ) {}

  /** Whether this machine can keep a key safely: real encryption, not Linux's `basic_text` fallback. */
  storable(): boolean {
    const cipher = this.cipher();
    if (!cipher.isEncryptionAvailable()) return false;
    return cipher.getSelectedStorageBackend?.() !== "basic_text";
  }

  /** What the Plugins view shows: where the key comes from, never the key. */
  async state(): Promise<OpenAiKeyState> {
    const storable = this.storable();
    if ((this.env[OPENAI_KEY_VARIABLE] ?? "").trim() !== "") return { source: "environment", storable };
    return { source: (await this.read()) === null ? "none" : "app", storable };
  }

  /** The saved key, or null when none is saved or it cannot be decrypted (another user, a reset keychain). */
  async read(): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch {
      return null;
    }
    try {
      const key = this.cipher().decryptString(encrypted).trim();
      return key === "" ? null : key;
    } catch {
      return null;
    }
  }

  /** Encrypt and keep `key`, replacing any saved one. Rejects (with no key in the message) when it cannot be kept. */
  async save(key: string): Promise<void> {
    const value = key.trim();
    const said = this.messages();
    if (value === "") throw new Error(said.empty);
    if (/\s/.test(value)) throw new Error(said.spaces);
    if (!this.storable()) throw new Error(said.cannotEncrypt);
    const encrypted = this.cipher().encryptString(value);
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, encrypted, { mode: 0o600 });
    await rename(temp, this.file);
  }

  /** Forget the saved key. */
  async remove(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
