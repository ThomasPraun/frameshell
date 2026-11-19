import { describe, expect, it } from "vitest";
import { strings } from "../src/shared/i18n/index.js";
import { otioNotice } from "../src/renderer/src/otio-notice.js";

describe("otioNotice", () => {
  it("names the file, with the count of what it leaves out only when there is something", () => {
    const said = strings("en").workspace;
    expect(otioNotice({ path: "C:\\p\\exports\\main.otio", warnings: [] }, said)).toBe("Exported main.otio.");
    expect(otioNotice({ path: "/p/exports/main.otio", warnings: ["a"] }, said)).toBe(
      "Exported main.otio. 1 thing is not in the file: run frameshell export otio --out <file>.otio in a terminal to list it.",
    );
    expect(otioNotice({ path: "/p/exports/main.otio", warnings: ["a", "b", "c"] }, said)).toBe(
      "Exported main.otio. 3 things are not in the file: run frameshell export otio --out <file>.otio in a terminal to list them.",
    );
  });

  it("speaks Spanish", () => {
    const said = strings("es").workspace;
    expect(otioNotice({ path: "/p/main.otio", warnings: [] }, said)).toBe("Se exportó main.otio.");
    expect(otioNotice({ path: "/p/main.otio", warnings: ["a", "b"] }, said)).toBe(
      "Se exportó main.otio. Hay 2 cosas que no están en el archivo: ejecuta frameshell export otio --out <archivo>.otio en una terminal para verlas.",
    );
    expect(otioNotice({ path: "/p/main.otio", warnings: ["a"] }, said)).toBe(
      "Se exportó main.otio. Hay 1 cosa que no está en el archivo: ejecuta frameshell export otio --out <archivo>.otio en una terminal para verla.",
    );
  });
});
