import { describe, expect, it } from "vitest";
import { createCreditsFile, creditLine, licenceInfo, parseCreditsFile } from "../src/index.js";

const HASH = `sha256:${"ab".repeat(32)}`;
const entry = (extra: Record<string, unknown> = {}) => ({ asset: "assets/rain.ogg", hash: HASH, addedAt: "2026-11-10", ...extra });
const file = (...assets: unknown[]) => ({ schemaVersion: 1, assets });

describe("credits.json", () => {
  it("round-trips an entry unchanged and fills in an empty ledger", () => {
    const full = entry({ sourceUrl: "https://openverse.org/audio/9f2c", licence: "CC-BY-4.0", author: "Ana Pérez", title: "Rain", credit: "Rain by Ana" });
    const parsed = parseCreditsFile(file(full));
    expect(parsed).toEqual({ ok: true, value: file(full) });
    expect(parseCreditsFile({ schemaVersion: 1 })).toEqual({ ok: true, value: file() });
    expect(parseCreditsFile(createCreditsFile()).ok).toBe(true);
  });

  it("refuses paths outside assets/, bad hashes, non-http sources, unknown fields and duplicate assets", () => {
    for (const bad of [
      file(entry({ asset: "exports/rain.ogg" })),
      file(entry({ asset: "assets/" })),
      file(entry({ hash: "abc" })),
      file(entry({ sourceUrl: "file:///etc/passwd" })),
      file(entry({ sourceUrl: "javascript:alert(1)" })),
      file(entry({ licence: "" })),
      file(entry({ addedAt: "yesterday" })),
      file(entry({ note: "x" })),
      file(entry(), entry()),
    ]) {
      expect(parseCreditsFile(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("licenceInfo", () => {
  it("reads missing and unverified licences as unverified", () => {
    for (const text of [undefined, "", "  ", "unknown", "Unverified", "n/a", "?"]) expect(licenceInfo(text).duty, String(text)).toBe("unverified");
  });

  it("needs no credit for CC0, public domain, the person's own work and Unlicense, in any spelling", () => {
    for (const text of ["CC0-1.0", "cc0", "CC0 1.0", "public domain", "PDM-1.0", "own", "Own work", "Unlicense"]) expect(licenceInfo(text).duty, text).toBe("none");
    expect(licenceInfo("cc0").id).toBe("CC0-1.0");
  });

  it("canonicalises Creative Commons licences and links their deed", () => {
    expect(licenceInfo("CC BY 4.0")).toEqual({ id: "CC-BY-4.0", label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/", duty: "credit" });
    expect(licenceInfo("cc-by-sa-3.0")).toMatchObject({ id: "CC-BY-SA-3.0", label: "CC BY SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" });
    expect(licenceInfo("CC-BY-NC-ND-4.0")).toMatchObject({ id: "CC-BY-NC-ND-4.0", url: "https://creativecommons.org/licenses/by-nc-nd/4.0/" });
    expect(licenceInfo("CC-BY")).toMatchObject({ id: "CC-BY", url: null, duty: "credit" });
  });

  it("treats a licence it does not know as needing credit, never as free", () => {
    expect(licenceInfo("Pixabay Content License")).toEqual({ id: "Pixabay Content License", label: "Pixabay Content License", url: null, duty: "credit" });
    expect(licenceInfo("OFL-1.1").duty).toBe("credit");
  });
});

describe("creditLine", () => {
  it("builds title, author, licence with deed and source", () => {
    expect(creditLine({ asset: "assets/rain.ogg", title: "Rain", author: "Ana Pérez", licence: "CC-BY-4.0", sourceUrl: "https://openverse.org/audio/9f2c" })).toBe(
      '"Rain" by Ana Pérez, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), https://openverse.org/audio/9f2c',
    );
  });

  it("names the file when there is no title, and skips what is missing", () => {
    expect(creditLine({ asset: "assets/sfx/rain.ogg", author: "Ana", licence: "CC-BY" })).toBe('"rain" by Ana, CC BY');
  });

  it("uses an explicit credit as written, and is null with nobody to name", () => {
    expect(creditLine({ asset: "assets/a.mp3", credit: "Music: Ana", author: "Other" })).toBe("Music: Ana");
    expect(creditLine({ asset: "assets/a.mp3", licence: "CC-BY-4.0", sourceUrl: "https://x.example/a" })).toBeNull();
  });
});
